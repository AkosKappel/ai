import type { ChatMessage } from "./chat";

export type Model = {
  provider: string;
  url: string;
  model: string;
  apiKey: (env: Env) => string;
  // Provider-specific request fields, such as reasoning settings.
  extra?: Record<string, unknown>;
};

// Reasoning models spend part of this on hidden reasoning, so it is higher than the visible answer.
const MAX_OUTPUT_TOKENS = 1000;

export const MODELS: Model[] = [
  {
    provider: "groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-120b",
    apiKey: (env) => env.GROQ_API_KEY,
    extra: { reasoning_effort: "low" },
  },
];

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`${provider} responded with ${status}`);
  }
}

export async function streamCompletion(
  model: Model,
  system: string,
  messages: ChatMessage[],
  env: Env,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(model.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${model.apiKey(env)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model.model,
      messages: [{ role: "system", content: system }, ...messages],
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
      ...model.extra,
    }),
  });

  if (!response.ok || !response.body) throw new ProviderError(model.provider, response.status);
  return response.body;
}
