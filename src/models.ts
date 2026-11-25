import type { ChatMessage } from "./chat";
import { sseToText } from "./stream";

// Reasoning models spend part of this on hidden reasoning, so it is higher than the visible answer.
const MAX_OUTPUT_TOKENS = 1000;
// A model that has not produced any answer text by then is skipped.
const FIRST_TEXT_TIMEOUT_MS = 8000;
// No new attempt starts after this, so a visitor never waits on every model timing out in turn.
const TOTAL_DEADLINE_MS = 20_000;

type Request = { system: string; messages: ChatMessage[]; signal: AbortSignal };

export type Model = {
  provider: string;
  model: string;
  /** Starts a streaming completion and returns the provider's SSE body. */
  open: (env: Env, request: Request) => Promise<ReadableStream<Uint8Array>>;
};

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Provider responded with ${status}`);
  }
}

function openAiCompatible(
  provider: string,
  url: string,
  model: string,
  apiKey: (env: Env) => string,
  extra: Record<string, unknown> = {},
): Model {
  return {
    provider,
    model,
    async open(env, { system, messages, signal }) {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey(env)}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, ...messages],
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
          ...extra,
        }),
        signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get("retry-after"));
        throw new ProviderError(response.status, retryAfter > 0 ? retryAfter : undefined);
      }
      return response.body;
    },
  };
}

function workersAi(model: string, extra: Record<string, unknown> = {}): Model {
  return {
    provider: "workers-ai",
    model,
    // The binding takes no abort signal, so a request that timed out keeps running (and using
    // neurons) on Cloudflare until it finishes.
    async open(env, { system, messages }) {
      const stream = await env.AI.run(
        model as keyof AiModels,
        {
          messages: [{ role: "system", content: system }, ...messages],
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
          ...extra,
        } as never,
      );
      return stream as unknown as ReadableStream<Uint8Array>;
    },
  };
}

// How long a page picker may take before the next one is tried.
const PICK_TIMEOUT_MS = 6000;
// Most questions need one or two pages; more would bring back the cost of the whole file.
export const MAX_PAGES = 4;

/** A model that answers with a function call naming the pages a question needs. */
export type PagePicker = Pick<Model, "provider" | "model"> & {
  pick: (env: Env, request: Request & { paths: string[] }) => Promise<string[]>;
};

function openAiCompatiblePicker(
  provider: string,
  url: string,
  model: string,
  apiKey: (env: Env) => string,
  extra: Record<string, unknown> = {},
): PagePicker {
  return {
    provider,
    model,
    async pick(env, { system, messages, signal, paths }) {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey(env)}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, ...messages],
          tools: [
            {
              type: "function",
              function: {
                name: "get_pages",
                description: "Loads pages of Ákos Kappel's portfolio site.",
                parameters: {
                  type: "object",
                  properties: {
                    paths: {
                      type: "array",
                      items: { type: "string", enum: paths },
                      description: `1 to ${MAX_PAGES} page paths that contain what the answer needs`,
                    },
                  },
                  required: ["paths"],
                },
              },
            },
          ],
          tool_choice: "required",
          max_tokens: 500,
          ...extra,
        }),
        signal,
      });
      if (!response.ok) {
        const retryAfter = Number(response.headers.get("retry-after"));
        throw new ProviderError(response.status, retryAfter > 0 ? retryAfter : undefined);
      }
      const data = (await response.json()) as {
        choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
      };
      const call = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
      if (!call) throw new Error("no get_pages call");
      const chosen = (JSON.parse(call) as { paths?: unknown }).paths;
      if (!Array.isArray(chosen)) throw new Error("get_pages call without paths");
      return chosen.filter((path): path is string => paths.includes(path)).slice(0, MAX_PAGES);
    },
  };
}

/**
 * Tried in this order, set on 2026-11-25 from the eval pass rates, speed and free quota (details
 * in docs/ARCHITECTURE.md). Only free tiers: no account has a payment method, and OpenRouter IDs
 * must end in `:free`.
 */
export const MODELS: Model[] = [
  // 97 % in the evals, fastest.
  openAiCompatible(
    "groq",
    "https://api.groq.com/openai/v1/chat/completions",
    "openai/gpt-oss-120b",
    (env) => env.GROQ_API_KEY,
    { reasoning_effort: "low" },
  ),
  // 100 %, about 230 questions a day. Gemma reasons by default, which took 14 s to first text.
  workersAi("@cf/google/gemma-4-26b-a4b-it", { chat_template_kwargs: { enable_thinking: false } }),
  // 93 %, but drops about one stream in five before the answer is complete.
  openAiCompatible(
    "gemini",
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "gemini-3.5-flash-lite",
    (env) => env.GEMINI_API_KEY,
  ),
  // Correct answers, but its free quota ran out after 15 questions.
  openAiCompatible(
    "groq",
    "https://api.groq.com/openai/v1/chat/completions",
    "qwen/qwen3.8-27b",
    (env) => env.GROQ_API_KEY,
  ),
  // 70 %, with several empty answers; only 50 free requests a day.
  openAiCompatible(
    "openrouter",
    "https://openrouter.ai/api/v1/chat/completions",
    "nvidia/nemotron-3.5-lightning:free",
    (env) => env.OPENROUTER_API_KEY,
  ),
];

// Models that failed recently, by `provider/model`, with the time they may be tried again.
// Kept per Worker isolate, so it is best effort: another isolate may still try a model once.
export const cooldowns = new Map<string, number>();

export const key = (model: Pick<Model, "provider" | "model">) => `${model.provider}/${model.model}`;

function cooldownSeconds(cause: unknown) {
  if (cause instanceof ProviderError && cause.status === 429) {
    return Math.min(cause.retryAfterSeconds ?? 60, 600);
  }
  return 30;
}

/**
 * Streams the answer text from the first model that starts answering. A model is skipped on any
 * error or when no text arrives in time; once text has reached the visitor there is no fallback.
 * Returns undefined when every model failed.
 */
export async function streamAnswer(
  models: Model[],
  env: Env,
  system: string,
  messages: ChatMessage[],
): Promise<{ body: ReadableStream<Uint8Array>; model: string } | undefined> {
  const started = Date.now();
  let attempts = 0;

  for (const model of models) {
    if ((cooldowns.get(key(model)) ?? 0) > Date.now()) continue;
    if (Date.now() - started > TOTAL_DEADLINE_MS) break;
    attempts++;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no answer text in time")), FIRST_TEXT_TIMEOUT_MS);
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const firstText = async () => {
      const body = await model.open(env, { system, messages, signal: controller.signal });
      reader = sseToText(body).getReader();
      return reader.read();
    };

    try {
      const first = await Promise.race([firstText(), timeout]);
      clearTimeout(timer);
      if (first.done || !reader) throw new Error("empty answer");

      console.log({ event: "model_used", ...describe(model), attempts, ms: Date.now() - started });
      return { body: continueStream(first.value, reader, model), model: key(model) };
    } catch (cause) {
      clearTimeout(timer);
      controller.abort();
      reader?.cancel().catch(() => {});
      cooldowns.set(key(model), Date.now() + cooldownSeconds(cause) * 1000);
      console.error({ event: "model_failed", ...describe(model), reason: reason(cause) });
    }
  }

  console.error({ event: "all_models_failed", attempts, ms: Date.now() - started });
  return undefined;
}

function continueStream(
  first: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  model: Model,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(first);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (cause) {
        // Erroring the stream drops the connection, so the browser can tell the answer was cut off.
        console.error({ event: "stream_broken", ...describe(model), reason: reason(cause) });
        controller.error(cause);
      }
    },
    cancel(cause) {
      return reader.cancel(cause);
    },
  });
}

const describe = (model: Pick<Model, "provider" | "model">) => ({
  provider: model.provider,
  model: model.model,
});

const reason = (cause: unknown) =>
  cause instanceof ProviderError ? `status ${cause.status}` : String(cause).slice(0, 200);

/** The page pickers, tried in order. They share quotas and cooldowns with the answering models. */
export const PAGE_PICKERS: PagePicker[] = [
  openAiCompatiblePicker(
    "groq",
    "https://api.groq.com/openai/v1/chat/completions",
    "openai/gpt-oss-120b",
    (env) => env.GROQ_API_KEY,
    { reasoning_effort: "low" },
  ),
  openAiCompatiblePicker(
    "gemini",
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "gemini-3.5-flash-lite",
    (env) => env.GEMINI_API_KEY,
  ),
];

/**
 * Asks the pickers in order which pages the conversation needs. Returns undefined when none
 * answers, and the caller then sends the whole knowledge file instead.
 */
export async function pickPages(
  pickers: PagePicker[],
  env: Env,
  system: string,
  messages: ChatMessage[],
  paths: string[],
): Promise<{ paths: string[]; picker: string } | undefined> {
  for (const picker of pickers) {
    if ((cooldowns.get(key(picker)) ?? 0) > Date.now()) continue;
    const started = Date.now();
    try {
      const chosen = await picker.pick(env, {
        system,
        messages,
        paths,
        signal: AbortSignal.timeout(PICK_TIMEOUT_MS),
      });
      if (chosen.length === 0) throw new Error("no known page chosen");
      console.log({
        event: "pages_picked",
        ...describe(picker),
        pages: chosen,
        ms: Date.now() - started,
      });
      return { paths: chosen, picker: key(picker) };
    } catch (cause) {
      cooldowns.set(key(picker), Date.now() + cooldownSeconds(cause) * 1000);
      console.error({ event: "pick_failed", ...describe(picker), reason: reason(cause) });
    }
  }
  return undefined;
}
