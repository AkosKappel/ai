import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { cooldowns } from "../src/models";

const env = {
  GROQ_API_KEY: "test-key",
  GEMINI_API_KEY: "gemini-key",
  OPENROUTER_API_KEY: "openrouter-key",
  KNOWLEDGE_URL: "https://akoskappel.dev/llms-full.txt",
  ALLOWED_ORIGINS: "https://akoskappel.dev,http://localhost:3000",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  CHAT_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
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

const ORIGIN = "https://akoskappel.dev";
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const chat = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
  call("/chat", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.7", ...headers },
    body:
      typeof body === "string"
        ? body
        : JSON.stringify({ turnstileToken: "token", ...(body as object) }),
  });

const sse = (...parts: string[]) =>
  `${parts
    .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    .join("")}data: [DONE]\n\n`;

// Routes Turnstile, the knowledge URL and the provider URL to canned responses.
function mockUpstream(
  provider: () => Response,
  knowledge = () => new Response("Works at IGT."),
  turnstile = () => Response.json({ success: true }),
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === TURNSTILE_URL) return turnstile();
    return String(input) === env.KNOWLEDGE_URL ? knowledge() : provider();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cooldowns.clear();
  vi.mocked(env.CHAT_RATE_LIMITER.limit).mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("routes", () => {
  it("reports health", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect((await call("/health", { method: "HEAD" })).status).toBe(200);
  });

  it("returns 404 for unknown routes", async () => {
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/health", { method: "POST" })).status).toBe(404);
    expect((await call("/constructor", { method: "POST" })).status).toBe(404);
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
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await response.text()).toBe("At IGT.");
    expect(response.headers.get("x-assistant-model")).toBe("groq/openai/gpt-oss-120b");
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "x-assistant-model, x-assistant-sources",
    );

    const [turnstileUrl, turnstileInit] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(turnstileUrl).toBe(TURNSTILE_URL);
    expect(JSON.parse(String(turnstileInit.body))).toEqual({
      secret: "turnstile-secret",
      response: "token",
      remoteip: "203.0.113.7",
    });
    expect(env.CHAT_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });

    const [, init] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
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
    expect((await chat({ messages, turnstileToken: "" })).status).toBe(400);
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

  it("rejects requests without an allowed origin before anything else", async () => {
    const fetchMock = mockUpstream(() => new Response(sse("never")));
    expect((await chat({ messages }, {})).status).toBe(403);
    expect((await chat({ messages }, { origin: "https://evil.example" })).status).toBe(403);
    expect(env.CHAT_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers the CORS preflight for allowed origins only", async () => {
    const preflight = (origin: string) => call("/chat", { method: "OPTIONS", headers: { origin } });
    const allowed = await preflight("http://localhost:3000");
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(allowed.headers.get("access-control-allow-methods")).toContain("POST");
    expect((await preflight("https://evil.example")).status).toBe(403);
  });

  it("returns 429 over the rate limit, without a Turnstile check", async () => {
    const fetchMock = mockUpstream(() => new Response(sse("never")));
    vi.mocked(env.CHAT_RATE_LIMITER.limit).mockResolvedValueOnce({ success: false });

    const response = await chat({ messages });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized body", async () => {
    const response = await chat({ messages }, { origin: ORIGIN, "content-length": "40000" });
    expect(response.status).toBe(413);
  });

  it("returns 403 when Turnstile rejects the token, without asking a model", async () => {
    const fetchMock = mockUpstream(
      () => new Response(sse("never")),
      undefined,
      () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
    );
    expect((await chat({ messages })).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed with 503 when Turnstile cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = mockUpstream(
      () => new Response(sse("never")),
      undefined,
      () => new Response("unavailable", { status: 500 }),
    );
    expect((await chat({ messages })).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /feedback", () => {
  const rate = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
    call("/feedback", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.7", ...headers },
      body: JSON.stringify(body),
    });

  it("logs the model and the rating, nothing else", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await rate({ model: "groq/openai/gpt-oss-120b", rating: "down" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(log).toHaveBeenCalledWith({
      event: "feedback",
      model: "groq/openai/gpt-oss-120b",
      rating: "down",
    });
    expect(env.CHAT_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: "feedback:203.0.113.7" });
  });

  it("rejects unknown models, other ratings and other origins", async () => {
    expect((await rate({ model: "made/up", rating: "up" })).status).toBe(400);
    expect((await rate({ model: "groq/openai/gpt-oss-120b", rating: "meh" })).status).toBe(400);
    expect(
      (await rate({ model: "groq/openai/gpt-oss-120b", rating: "up" }, { origin: "https://x.dev" }))
        .status,
    ).toBe(403);
  });
});
