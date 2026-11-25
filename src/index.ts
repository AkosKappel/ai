import { buildSystemPrompt, InvalidRequest, loadKnowledge, parseChatRequest } from "./chat";
import { MODELS, streamAnswer } from "./models";

const error = (message: string, status: number) => Response.json({ error: message }, { status });

async function handleChat(request: Request, env: Env): Promise<Response> {
  let chat: ReturnType<typeof parseChatRequest>;
  try {
    chat = parseChatRequest(await request.json());
  } catch (cause) {
    if (cause instanceof InvalidRequest) return error(cause.message, 400);
    return error("Body must be valid JSON", 400);
  }

  let knowledge: string;
  try {
    knowledge = await loadKnowledge(env.KNOWLEDGE_URL);
  } catch (cause) {
    console.error({ event: "knowledge_failed", message: String(cause) });
    return error("The assistant is unavailable right now", 503);
  }

  // Prompts and answers are never logged, only which model answered or failed and how.
  const answer = await streamAnswer(
    MODELS,
    env,
    buildSystemPrompt(knowledge, chat.locale),
    chat.messages,
  );
  if (!answer) return error("The assistant is busy, please try again in a minute", 503);

  // Compression would buffer the stream and deliver the whole answer at once, and
  // `no-transform` turns it off on Cloudflare's edge. `wrangler dev` compresses anyway.
  return new Response(answer, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, no-transform",
    },
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    if (request.method === "POST" && pathname === "/chat") {
      return handleChat(request, env);
    }

    return error("Not found", 404);
  },
} satisfies ExportedHandler<Env>;
