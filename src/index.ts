import { buildSystemPrompt, InvalidRequest, loadKnowledge, parseChatRequest } from "./chat";
import {
  allowedOrigin,
  bodyTooLarge,
  clientIp,
  corsHeaders,
  TurnstileUnavailable,
  verifyTurnstile,
} from "./guard";
import { key, MODELS, streamAnswer } from "./models";

const error = (message: string, status: number, headers: Record<string, string> = {}) =>
  Response.json({ error: message }, { status, headers });

// The checks run cheapest first, so a request that fails one never costs a Turnstile check or
// any model quota.
async function handleChat(request: Request, env: Env, cors: Record<string, string>) {
  const fail = (message: string, status: number, extra: Record<string, string> = {}) =>
    error(message, status, { ...cors, ...extra });

  if (bodyTooLarge(request)) return fail("Request is too large", 413);

  const ip = clientIp(request);
  const { success: withinLimit } = await env.CHAT_RATE_LIMITER.limit({ key: ip });
  if (!withinLimit) {
    return fail("Too many messages, please wait a minute", 429, { "retry-after": "60" });
  }

  let chat: ReturnType<typeof parseChatRequest>;
  try {
    chat = parseChatRequest(await request.json());
  } catch (cause) {
    if (cause instanceof InvalidRequest) return fail(cause.message, 400);
    return fail("Body must be valid JSON", 400);
  }

  try {
    if (!(await verifyTurnstile(chat.turnstileToken, ip, env))) {
      return fail("The bot check failed, please reload the page", 403);
    }
  } catch (cause) {
    if (!(cause instanceof TurnstileUnavailable)) throw cause;
    console.error({ event: "turnstile_unavailable", message: cause.message });
    return fail("The assistant is unavailable right now", 503);
  }

  let knowledge: string;
  try {
    knowledge = await loadKnowledge(env.KNOWLEDGE_URL);
  } catch (cause) {
    console.error({ event: "knowledge_failed", message: String(cause) });
    return fail("The assistant is unavailable right now", 503);
  }

  // Prompts and answers are never logged, only which model answered or failed and how.
  const answer = await streamAnswer(
    MODELS,
    env,
    buildSystemPrompt(knowledge, chat.locale),
    chat.messages,
  );
  if (!answer) return fail("The assistant is busy, please try again in a minute", 503);

  // Compression would buffer the stream and deliver the whole answer at once, and
  // `no-transform` turns it off on Cloudflare's edge. `wrangler dev` compresses anyway.
  return new Response(answer.body, {
    headers: {
      ...cors,
      // Lets the visitor rate the answer; the rating names the model, never the text.
      "x-assistant-model": answer.model,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, no-transform",
    },
  });
}

const RATED_MODELS = new Set(MODELS.map(key));

/** A thumbs up or down on one answer. Only the model and the rating are logged. */
async function handleFeedback(request: Request, env: Env, cors: Record<string, string>) {
  const fail = (message: string, status: number) => error(message, status, cors);
  if (bodyTooLarge(request)) return fail("Request is too large", 413);

  const { success: withinLimit } = await env.CHAT_RATE_LIMITER.limit({
    key: `feedback:${clientIp(request)}`,
  });
  if (!withinLimit) return fail("Too many ratings, please wait a minute", 429);

  const { model, rating } = ((await request.json().catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;
  if (
    typeof model !== "string" ||
    !RATED_MODELS.has(model) ||
    (rating !== "up" && rating !== "down")
  ) {
    return fail("Send a known model and a rating of up or down", 400);
  }
  console.log({ event: "feedback", model, rating });
  return new Response(null, { status: 204, headers: cors });
}

const ROUTES = new Map([
  ["/chat", handleChat],
  ["/feedback", handleFeedback],
]);

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // Uptime monitors often send HEAD; the runtime leaves out the body for it.
    if ((request.method === "GET" || request.method === "HEAD") && pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    const handle = ROUTES.get(pathname);
    if (handle && (request.method === "POST" || request.method === "OPTIONS")) {
      // Only the portfolio may use the chat. CORS alone does not stop scripts outside a browser,
      // which is what Turnstile and the rate limit are for.
      const origin = allowedOrigin(request, env);
      if (!origin) return error("Origin not allowed", 403);
      const cors = corsHeaders(origin);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      return handle(request, env, cors);
    }

    return error("Not found", 404);
  },
} satisfies ExportedHandler<Env>;
