import { buildSystemPrompt, InvalidRequest, loadKnowledge, parseChatRequest } from "./chat";
import { MODELS, ProviderError, streamCompletion } from "./models";
import { sseToText } from "./stream";

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

  // Prompts and answers are never logged, only which provider failed and how.
  try {
    const stream = await streamCompletion(
      MODELS[0],
      buildSystemPrompt(knowledge, chat.locale),
      chat.messages,
      env,
    );
    return new Response(sseToText(stream), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (cause) {
    const status = cause instanceof ProviderError ? cause.status : undefined;
    console.error({ event: "provider_failed", provider: MODELS[0].provider, status });
    return error("The assistant is busy, please try again in a minute", 503);
  }
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
