# Portfolio Assistant: V1 Plan

_Rewritten 2026-11-25 from the first "AI Gateway" draft._

## 1. Goal

An "ask about me" chat on [akoskappel.dev](https://akoskappel.dev) that answers questions about my experience, skills, projects and education from the public portfolio content, with streaming answers.

V1 runs on free model tiers only, with zero recurring cost and no way to be billed.

It also covers backlog items S-09 ("ask about me" assistant) and part of S-21 (streaming, rate limits, cost cap, eval suite) in the portfolio repository.

## 2. Decisions

| Decision                                                     | Why                                                                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A small Cloudflare Worker for one app, not a general gateway | One client today. A gateway (API keys, aliases, an OpenAI-compatible API, per-app quotas) is extracted only when a second app needs AI.                                              |
| Free tiers from several providers, tried in order            | Each free tier has low per-minute and per-day limits. Falling back across providers keeps the chat available.                                                                        |
| Zero cost by having no payment method on any account         | A hard guarantee that needs no code. Free tiers return errors when exhausted, which the fallback handles.                                                                            |
| No Cloudflare AI Gateway (dropped 2026-11-25)                | Its logs store full prompts and answers, against the rule that visitor messages are never stored. The Worker's own logs record which model answered, how fast and why others failed. |
| Knowledge comes from the portfolio's own content             | The portfolio publishes `/llms-full.txt` generated from `src/content/`, so the assistant never drifts from the site. No hand-written copy.                                           |
| No database, no RAG, no vector store                         | The knowledge is small enough to send in full.                                                                                                                                       |
| No framework (Hono) and no Zod                               | Two routes and one small request shape. A plain `fetch` handler is enough.                                                                                                           |

## 3. Architecture

```text
Browser (akoskappel.dev chat)
  │  POST /chat  { messages, locale, turnstileToken }
  ▼
Worker  ai.akoskappel.dev
  1. Check origin, request size, per-IP rate limit (Workers rate-limit binding)
  2. Validate the body and verify the Turnstile token
  3. Build the prompt: system rules + /llms-full.txt (cached 1 h) + visitor messages
  4. Try each enabled model in order until one starts streaming
  5. Stream plain text back
  │
  ▼
Groq · Google AI Studio · OpenRouter :free · Workers AI
```

All four providers offer an OpenAI-compatible chat completions endpoint, so one `fetch` call with a base URL, a key and a model ID covers them. No adapter classes.

## 4. Free models

Limits as reported in November 2026. Check each provider's console before enabling a model, since free tiers change often.

| Order | Provider                        | Free tier                                                                                              | Notes                                                                                                                                                   |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Groq                            | Per model and per organization, around 30 requests and 8,000 tokens per minute, 1,000 requests per day | Fastest. The token limit allows about one chat per minute with a 5,000-token prompt.                                                                    |
| 2     | Google AI Studio (Gemini)       | Per project, figures no longer published                                                               | Free-tier prompts may be used to improve Google's products and read by reviewers. Acceptable for public content, but visitors must be told (section 7). |
| 3     | OpenRouter, `:free` models only | 20 requests per minute, 50 per day (1,000 per day after a one-time $10 credit purchase)                | Use only model IDs ending in `:free`. A negative balance blocks even free models.                                                                       |
| 4     | Workers AI                      | 10,000 neurons per day, shared by all models                                                           | Native binding, no API key. On the Free plan it errors instead of billing. Some models now require the Paid plan.                                       |

The model list lives in one config array (`provider`, `model`, `enabled`). Order is decided by the eval results (section 8), not guessed.

## 5. Request flow and fallback

- Fallback happens only before any answer text reaches the browser. A model is skipped on any error status, a network error, an error event in the stream, an empty answer, or no answer text within 8 s.
- Visitor input is validated before any provider is called, so a provider error is never the visitor's fault and always moves on to the next model.
- A failed model cools down for 30 s, or after a 429 for its `Retry-After` (60 s by default, at most 10 min). Cooldowns live in memory per Worker isolate, so they are best effort.
- No new attempt starts after 20 s, so a visitor never waits on every model timing out in turn.
- If a stream breaks mid-answer, the response is aborted so the browser can tell, and the UI shows "the answer was cut off, please try again".
- If every model fails, return 503 with a "busy, try again in a minute" message.

The model order as of 2026-11-25 (fastest first, measured with the full prompt) is in `docs/ARCHITECTURE.md`. Section 4 lists the providers' free tiers.

## 6. Knowledge

The portfolio gets a static route `/llms-full.txt` (and a short `/llms.txt` index, following the [llms.txt](https://llmstxt.org) convention) that renders `src/content/` to Markdown in English: profile, experience, education, skills, and a short summary per project with its link.

- Target under 5,000 tokens, so it fits Groq's per-minute limit with room for the conversation. A portfolio test fails when it grows past the budget.
- Only content already shown on the site. Nothing from `CV-NOTES.md`, job applications or private repositories.
- The model answers in the visitor's language (the request carries the site locale).

The Worker fetches the file with a one-hour cache, so a portfolio deploy updates the assistant within the hour without redeploying the Worker.

## 7. Security, limits and privacy

- **Turnstile** on every request, verified server-side. The invisible widget makes this unnoticeable.
- **Rate limit** per IP: 5 requests per minute (Workers rate-limit binding, free).
- **Request limits:** at most 10 messages, 1,000 characters each, 6,000 in total. Output capped at 1,000 tokens, part of which reasoning models spend on hidden reasoning.
- **Origin allowlist:** `https://akoskappel.dev` and `http://localhost:3000`. CORS is not authentication; Turnstile and the rate limit are.
- **Server-controlled prompt and model.** The browser sends only messages and a locale.
- **System prompt rules:** answer only from the provided content, say when something is not in it, stay on topic, treat visitor messages as untrusted, never claim to be me.
- **Secrets** (provider keys, Turnstile secret) live in Worker secrets, never in the browser.
- **Privacy:** prompts and answers are not stored by the Worker. The Worker's logs keep only metadata (which model answered, attempts, time, failure reasons). The chat UI says that messages are processed by third-party AI providers and should not contain personal data. Update the privacy section on `/colophon`.

## 8. Evals

The quality gate for prompt and model changes, and the reason the model order is what it is.

- `evals/cases.json`: about 30 questions with checks: facts that must appear (employer names, dates, technologies), facts that must not appear (invented projects), refusals (salary, private contact details, off-topic tasks, prompt injection), and a few non-English questions.
- `pnpm eval` runs every case against each enabled model and prints a pass rate per model. Checks are deterministic (string and regex matches). An LLM judge comes later if string checks prove too blunt.
- Runs on demand and weekly in GitHub Actions (Sundays at 21:00 UTC, before the daily quotas reset), not on every push, to stay inside the free quotas.

## 9. Repository layout

```text
ai/
├── src/
│   ├── index.ts          # routes: GET /health, POST /chat, OPTIONS
│   ├── chat.ts           # validation, prompt building
│   ├── models.ts         # model list and the fallback loop
│   └── stream.ts         # provider SSE to plain text
├── test/                 # Vitest unit tests (fallback, validation, stream parsing)
├── evals/
│   ├── cases.json
│   ├── check.ts
│   └── run.ts
├── .github/workflows/        # ci.yml, eval.yml
├── wrangler.jsonc
├── .dev.vars.example
├── PLAN.md
└── README.md
```

The chat UI, the Turnstile widget and `/llms-full.txt` live in the portfolio repository.

## 10. Phases

1. **Foundation** (done 2026-11-25): repository, Worker with `GET /health`, Biome, Vitest, CI checks.
2. **Chat endpoint** (done 2026-11-25): knowledge fetch, prompt, one provider (Groq, `openai/gpt-oss-120b`), plain-text streaming.
3. **Fallback** (done 2026-11-25): the other providers, timeouts, cooldowns, 503 handling, unit tests with fake models.
4. **Evals** (done 2026-11-25): 30 cases and a runner with a pass rate per model; the model order follows from the results (`docs/ARCHITECTURE.md`, Evals and Models).
5. **Protection** (done 2026-11-25): origin allowlist and CORS, body size limit, rate-limit binding, Turnstile verification. AI Gateway dropped (see Decisions).
6. **Portfolio** (done 2026-11-25): `/llms.txt` and `/llms-full.txt` with the size test, a floating "Ask about me" chat (streaming, loading, error, busy and cut-off states, provider notice, Turnstile), privacy text on `/colophon`. Hidden until the Worker URL and Turnstile site key are set.
7. **Deploy** (done 2026-11-25): custom domain `ai.akoskappel.dev`, `deploy` job in CI with a Cloudflare API token, entry in `infra/apps/README.md`. The chat is live on akoskappel.dev.

## 11. Done when

- The chat on akoskappel.dev streams answers in every site language.
- The eval pass rate is at least 90 % for the first model in the list.
- Exhausting one provider falls back to the next; exhausting all shows the busy message.
- No account involved has a payment method.
- Requests without a valid Turnstile token, from other origins or over the limits are rejected.
- The README documents setup, secrets, local development and how to add a model.

## 12. Later

- **A paid model with a hard cap** if the free models fail the evals: Claude Haiku 5.5 with prepaid credit and auto-reload off, as the first or last entry in the list.
- **Tools** (`get_project`, `get_experience`) instead of sending all the knowledge, when it outgrows the token budget. This also shows agent work for S-21.
- **A shared gateway** when a second app needs AI.
- **RAG** in a separate project whose data actually needs it (S-21).
