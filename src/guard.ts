// Checks a chat request has to pass before it may use the free model quotas.

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// A conversation within the message limits is far smaller; anything bigger is not from the chat.
export const MAX_BODY_BYTES = 32 * 1024;

/** The request's origin when it is on the allowlist; CORS headers are only sent for these. */
export function allowedOrigin(request: Request, env: Env): string | undefined {
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  return env.ALLOWED_ORIGINS.split(",").some((allowed) => allowed.trim() === origin)
    ? origin
    : undefined;
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "access-control-expose-headers": "x-assistant-model",
    vary: "Origin",
  };
}

/** The visitor's IP, which Cloudflare sets on every request; the rate limit is keyed on it. */
export const clientIp = (request: Request) => request.headers.get("cf-connecting-ip") ?? "unknown";

export function bodyTooLarge(request: Request) {
  return Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES;
}

export class TurnstileUnavailable extends Error {}

/**
 * Asks Cloudflare whether the Turnstile token is valid. Tokens are single-use, so the chat UI
 * gets a fresh one for every message. Throws TurnstileUnavailable when Cloudflare cannot answer,
 * so the caller fails closed instead of letting the request through unchecked.
 */
export async function verifyTurnstile(token: string, ip: string, env: Env): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
    });
  } catch (cause) {
    throw new TurnstileUnavailable(String(cause));
  }
  if (!response.ok) throw new TurnstileUnavailable(`siteverify responded with ${response.status}`);
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}
