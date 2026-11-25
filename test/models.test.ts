import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cooldowns,
  MODELS,
  type Model,
  PAGE_PICKERS,
  ProviderError,
  pickPages,
  streamAnswer,
} from "../src/models";

const env = { GROQ_API_KEY: "groq-key" } as Env;
const messages = [{ role: "user" as const, content: "Hi" }];

const encoder = new TextEncoder();
const event = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

/** An SSE body that sends the given events, then ends, errors or never ends. */
function sse(events: string[], end: "close" | "error" | "hang" = "close") {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      if (end === "close") controller.close();
    },
    // Fails only once the queued events were read, like a connection dropping mid-answer.
    pull(controller) {
      if (end === "error") controller.error(new Error("connection reset"));
    },
  });
}

function fakeModel(name: string, open: Model["open"]): Model & { open: ReturnType<typeof vi.fn> } {
  return { provider: "fake", model: name, open: vi.fn(open) };
}

const answering = (name: string, ...parts: string[]) =>
  fakeModel(name, async () => sse([...parts.map(event), "data: [DONE]\n\n"]));
const failing = (name: string, status: number, retryAfter?: number) =>
  fakeModel(name, async () => {
    throw new ProviderError(status, retryAfter);
  });

const read = (answer: { body: ReadableStream<Uint8Array> } | undefined) =>
  new Response(answer?.body).text();

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cooldowns.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("streamAnswer", () => {
  it("streams from the first model that answers and leaves the rest untouched", async () => {
    const second = answering("b", "never");
    const answer = await streamAnswer(
      [answering("a", "Hello", " there"), second],
      env,
      "sys",
      messages,
    );
    expect(answer?.model).toBe("fake/a");
    expect(await read(answer)).toBe("Hello there");
    expect(second.open).not.toHaveBeenCalled();
  });

  it("falls back on provider errors and puts the failed models in cooldown", async () => {
    const now = Date.now();
    const answer = await streamAnswer(
      [failing("a", 429, 120), failing("b", 503), answering("c", "From c")],
      env,
      "sys",
      messages,
    );
    expect(await read(answer)).toBe("From c");
    expect(cooldowns.get("fake/a")).toBeGreaterThanOrEqual(now + 120_000);
    expect(cooldowns.get("fake/b")).toBeGreaterThanOrEqual(now + 30_000);
    expect(cooldowns.get("fake/b")).toBeLessThan(now + 60_000);
  });

  it("skips models that are cooling down", async () => {
    const first = answering("a", "never");
    cooldowns.set("fake/a", Date.now() + 60_000);
    const answer = await streamAnswer([first, answering("b", "From b")], env, "sys", messages);
    expect(await read(answer)).toBe("From b");
    expect(first.open).not.toHaveBeenCalled();
  });

  it("falls back when a model sends no text in time", async () => {
    vi.useFakeTimers();
    const pending = streamAnswer(
      [fakeModel("slow", async () => sse([], "hang")), answering("b", "From b")],
      env,
      "sys",
      messages,
    );
    await vi.advanceTimersByTimeAsync(8000);
    expect(await read(await pending)).toBe("From b");
  });

  it("falls back on an empty answer or an error event before any text", async () => {
    const answer = await streamAnswer(
      [
        answering("empty"),
        fakeModel("error-event", async () => sse(['data: {"error":{"code":502}}\n\n'])),
        answering("c", "From c"),
      ],
      env,
      "sys",
      messages,
    );
    expect(await read(answer)).toBe("From c");
  });

  it("returns undefined when every model fails", async () => {
    expect(await streamAnswer([failing("a", 500), failing("b", 429)], env, "sys", messages)).toBe(
      undefined,
    );
  });

  it("does not fall back after text was sent, and errors the stream instead", async () => {
    const second = answering("b", "never");
    const answer = await streamAnswer(
      [fakeModel("a", async () => sse([event("Half an")], "error")), second],
      env,
      "sys",
      messages,
    );
    await expect(read(answer)).rejects.toThrow();
    expect(second.open).not.toHaveBeenCalled();
  });
});

describe("OpenAI-compatible models", () => {
  it("send the system prompt, the messages and the provider settings", async () => {
    const fetchMock = vi.fn(async () => new Response(sse([event("Hi")])));
    vi.stubGlobal("fetch", fetchMock);

    await MODELS[0].open(env, { system: "sys", messages, signal: new AbortController().signal });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer groq-key");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "openai/gpt-oss-120b",
      stream: true,
      reasoning_effort: "low",
      messages: [{ role: "system", content: "sys" }, ...messages],
    });
  });

  it("turn an error status into a ProviderError with Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("slow down", { status: 429, headers: { "retry-after": "42" } }),
      ),
    );
    const opening = MODELS[0].open(env, {
      system: "sys",
      messages,
      signal: new AbortController().signal,
    });
    await expect(opening).rejects.toMatchObject({ status: 429, retryAfterSeconds: 42 });
  });

  it("only use free OpenRouter models", () => {
    for (const model of MODELS.filter((m) => m.provider === "openrouter")) {
      expect(model.model).toMatch(/:free$/);
    }
  });
});

describe("page pickers", () => {
  it("offer get_pages with the known paths and keep only known paths from the call", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                { function: { arguments: JSON.stringify({ paths: ["/about", "/nope"] }) } },
              ],
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const paths = await PAGE_PICKERS[0].pick(env, {
      system: "sys",
      messages,
      paths: ["/about", "/contact"],
      signal: new AbortController().signal,
    });

    expect(paths).toEqual(["/about"]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.tool_choice).toBe("required");
    expect(body.tools[0].function.name).toBe("get_pages");
    expect(body.tools[0].function.parameters.properties.paths.items.enum).toEqual([
      "/about",
      "/contact",
    ]);
  });

  it("falls back to the next picker and cools down the failed one", async () => {
    const failing = {
      provider: "fake",
      model: "a",
      pick: vi.fn(async () => {
        throw new ProviderError(429, 90);
      }),
    };
    const working = { provider: "fake", model: "b", pick: vi.fn(async () => ["/contact"]) };
    const picked = await pickPages([failing, working], env, "sys", messages, ["/contact"]);
    expect(picked).toEqual({ paths: ["/contact"], picker: "fake/b" });
    expect(cooldowns.get("fake/a")).toBeGreaterThan(Date.now() + 80_000);
  });
});
