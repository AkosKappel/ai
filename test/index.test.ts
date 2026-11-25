import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { cooldowns } from "../src/models";

const env = {
  GROQ_API_KEY: "test-key",
  GEMINI_API_KEY: "gemini-key",
  OPENROUTER_API_KEY: "openrouter-key",
  KNOWLEDGE_URL: "https://akoskappel.dev/llms-full.txt",
  AI: {
    run: async () => {
      throw new Error("Workers AI unavailable");
    },
  },
} as unknown as Env;

const call = (path: string, init?: RequestInit) =>
  worker.fetch(
    new Request(`https://ai.example${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
    env,
  );

const chat = (body: unknown) =>
  call("/chat", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

const sse = (...parts: string[]) =>
  `${parts
    .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    .join("")}data: [DONE]\n\n`;

// Routes the knowledge URL and the provider URL to canned responses.
function mockUpstream(provider: () => Response, knowledge = () => new Response("Works at IGT.")) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    String(input) === env.KNOWLEDGE_URL ? knowledge() : provider(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cooldowns.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("routes", () => {
  it("reports health", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown routes", async () => {
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/health", { method: "POST" })).status).toBe(404);
  });
});

describe("POST /chat", () => {
  const messages = [{ role: "user", content: "Where does he work?" }];

  it("streams the answer as plain text", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = mockUpstream(() => new Response(sse("At ", "IGT.")));

    const response = await chat({ messages, locale: "de" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("At IGT.");

    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Works at IGT.");
    expect(body.messages[0].content).toContain("Reply in German");
    expect(body.messages.slice(1)).toEqual(messages);
  });

  it("rejects invalid JSON and invalid requests without calling upstream", async () => {
    const fetchMock = mockUpstream(() => new Response(sse("never")));
    expect((await chat("{")).status).toBe(400);
    expect((await chat({ messages: [] })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 when the knowledge cannot be loaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpstream(
      () => new Response(sse("never")),
      () => new Response("Not found", { status: 404 }),
    );
    expect((await chat({ messages })).status).toBe(503);
  });

  it("returns 503 when every model fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpstream(() => new Response("rate limited", { status: 429 }));

    const response = await chat({ messages });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The assistant is busy, please try again in a minute",
    });
  });
});
