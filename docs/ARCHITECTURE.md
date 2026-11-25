# Architecture

How the portfolio assistant works today. The roadmap and the reasons behind the main choices are in [PLAN.md](../PLAN.md).

## Overview

```text
Browser (akoskappel.dev)                     Portfolio (Next.js on Vercel)
  │  POST /chat                                ▲  GET /llms-full.txt
  ▼                                            │  (static, rebuilt on every portfolio deploy)
Worker: portfolio-assistant ───────────────────┘
  │  POST /openai/v1/chat/completions (stream)
  ▼
Groq (free tier)
```

The Worker is stateless. It has no database and stores no conversations: every request carries the whole conversation, and the Worker sends it on with the system prompt and streams the answer back.

## Request flow

1. **Validate** the JSON body ([src/chat.ts](../src/chat.ts) `parseChatRequest`). Anything invalid gets a 400 before any upstream call.
2. **Load the knowledge** from `KNOWLEDGE_URL` ([src/chat.ts](../src/chat.ts) `loadKnowledge`). Cloudflare caches the response for an hour, so most requests never reach the portfolio. If it fails, the answer is a 503.
3. **Build the system prompt** (`buildSystemPrompt`): an introduction, the knowledge inside `<portfolio>` tags, the rules, and last the reply language. The long part comes first and never changes between requests, so providers that cache prompt prefixes can reuse it.
4. **Call the model** ([src/models.ts](../src/models.ts) `streamCompletion`) with the system prompt and the visitor's messages, `stream: true` and an output cap. A non-2xx answer becomes a `ProviderError`, and the Worker answers 503.
5. **Stream the answer** ([src/stream.ts](../src/stream.ts) `sseToText`): the provider's server-sent events are turned into plain text as they arrive. Only `choices[0].delta.content` is kept, so hidden reasoning never reaches the browser.

## API

| Route         | Response                            |
| ------------- | ----------------------------------- |
| `GET /health` | `{ "status": "ok" }`                |
| `POST /chat`  | The answer as a `text/plain` stream |
| anything else | 404                                 |

`POST /chat` body:

```json
{ "messages": [{ "role": "user", "content": "Where does he work?" }], "locale": "en" }
```

| Rule           | Limit                                                            |
| -------------- | ---------------------------------------------------------------- |
| Messages       | 1 to 10, roles `user` or `assistant`, the last one from the user |
| Message length | 1,000 characters each, 6,000 in total                            |
| Locale         | `en` (default), `de`, `sk`, `cs`, `hu`                           |
| Answer         | at most 1,000 output tokens, including any hidden reasoning      |

Errors are JSON `{ "error": "..." }`: 400 for an invalid request, 503 when the knowledge or the model is unavailable. A stream that breaks after it started simply ends early.

## Models

| Provider | Model                 | Settings                  | Free tier (November 2026)                                                               |
| -------- | --------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| Groq     | `openai/gpt-oss-120b` | `reasoning_effort: "low"` | About 30 requests and 8,000 tokens per minute, 1,000 requests per day, per organization |

Every provider is called through its OpenAI-compatible chat completions endpoint, so a model is one entry in `MODELS`: provider name, URL, model ID, where its API key comes from, and any provider-specific fields. Only the first entry is used until the fallback loop lands (phase 3).

**Adding a model:** add the entry to `MODELS`, its key name to `.dev.vars.example`, run `pnpm types`, and set the secret with `wrangler secret put <NAME>`.

**Token budget:** one question costs about 5,000 input tokens (the knowledge is about 4,500) plus the answer. With Groq's per-minute limit that is roughly one question a minute; the fallback in phase 3 covers bursts.

## Knowledge

The portfolio generates two files from its typed content in `src/content/` ([portfolio `src/lib/llms.ts`](https://github.com/AkosKappel/portfolio/blob/main/src/lib/llms.ts)), following the [llms.txt](https://llmstxt.org) convention:

- `/llms.txt`: a short index of the pages and projects.
- `/llms-full.txt`: the profile the assistant reads. It covers the intro, contact links, availability, languages, about, experience with highlights, education, skills, and a summary per project with its links.

Rules enforced by the portfolio's tests:

- English only. The model answers in the visitor's language.
- At most 20,000 characters (about 5,000 tokens), to fit the free tiers' per-minute limits.
- No e-mail address or phone number. The site keeps the e-mail out of its bundles against scrapers, so the assistant points visitors to the contact page instead.

A portfolio deploy reaches the assistant within an hour (the cache time), without redeploying the Worker.

## System prompt rules

The assistant answers only from the portfolio content and says when something is not there, never invents details, talks about Ákos in the third person, declines unrelated tasks, treats visitor messages as untrusted, and keeps answers short. The full text is in `buildSystemPrompt`.

## Logging and privacy

- The Worker never logs prompts or answers. Errors are logged as `{ event, provider, status }` through Workers observability.
- Visitor messages are sent to the model provider. Free tiers may keep or use them under their own terms, which is why the chat UI must say so (see PLAN.md, section 7).

## Configuration

| Name            | Kind     | Where                                                    | Purpose                                               |
| --------------- | -------- | -------------------------------------------------------- | ----------------------------------------------------- |
| `KNOWLEDGE_URL` | variable | `wrangler.jsonc`                                         | Where the knowledge file is fetched from              |
| `GROQ_API_KEY`  | secret   | `.dev.vars` locally, `wrangler secret put` in production | Groq API key from an account without a payment method |

`worker-configuration.d.ts` holds the generated `Env` type. `pnpm types` regenerates it from `wrangler.jsonc` and the names in `.dev.vars.example`.

## Testing

- `pnpm test`: Vitest unit tests for validation, prompt building, stream parsing and the `/chat` route, with `fetch` replaced by fakes. No test calls a real provider.
- Manual end-to-end check: run the portfolio (`pnpm dev` there) and the Worker with `pnpm exec wrangler dev --var KNOWLEDGE_URL:http://localhost:3000/llms-full.txt`, then send questions with curl. Wait a minute between questions to stay inside Groq's per-minute limit.
