# Architecture

How the portfolio assistant works today. The roadmap and the reasons behind the main choices are in [PLAN.md](../PLAN.md).

## Overview

```text
Browser (akoskappel.dev)                     Portfolio (Next.js on Vercel)
  │  POST /chat                                ▲  GET /llms-full.txt
  ▼                                            │  (static, rebuilt on every portfolio deploy)
Worker: portfolio-assistant ───────────────────┘
  │  first model that starts answering, in order:
  ├─▶ Groq            openai/gpt-oss-120b
  ├─▶ Workers AI      @cf/google/gemma-4-26b-a4b-it  (binding, no key)
  ├─▶ Google AI Studio gemini-3.5-flash-lite
  ├─▶ Groq            qwen/qwen3.8-27b
  └─▶ OpenRouter      nvidia/nemotron-3.5-lightning:free
```

The Worker is stateless apart from in-memory cooldowns. It has no database and stores no conversations: every request carries the whole conversation, and the Worker sends it on with the system prompt and streams the answer back.

## Request flow

1. **Validate** the JSON body ([src/chat.ts](../src/chat.ts) `parseChatRequest`). Anything invalid gets a 400 before any upstream call.
2. **Load the knowledge** from `KNOWLEDGE_URL` ([src/chat.ts](../src/chat.ts) `loadKnowledge`). Cloudflare caches the response for an hour, so most requests never reach the portfolio. If it fails, the answer is a 503.
3. **Build the system prompt** (`buildSystemPrompt`): an introduction, the knowledge inside `<portfolio>` tags, the rules, and last the reply language. The long part comes first and never changes between requests, so providers that cache prompt prefixes can reuse it.
4. **Find a model that answers** ([src/models.ts](../src/models.ts) `streamAnswer`): try each model in `MODELS` order until one sends answer text (see Fallback).
5. **Stream the answer** as plain text. [src/stream.ts](../src/stream.ts) `sseToText` turns the provider's server-sent events into text as they arrive. Only the answer is kept (`choices[0].delta.content`, or `response` from Workers AI), so hidden reasoning never reaches the browser. A stream counts as complete only once it sends a `finish_reason` or `[DONE]`; one that just stops errors instead (see Fallback).

## Fallback

| Situation                                            | What happens                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Error status (429, 5xx, any 4xx) or network error    | Next model. Visitor input was already validated, so a provider error is never the visitor's fault.                                |
| Error event in the stream, or an answer without text | Next model                                                                                                                        |
| Stream stops without a `finish_reason` or `[DONE]`   | Before any text: next model. After text started: the answer is cut off (row below). Gemini does this to about one stream in five. |
| No answer text within 8 s                            | Abort the request, next model                                                                                                     |
| Answer text has started                              | No more fallback. If the stream then breaks, the response is aborted so the browser sees a cut-off answer.                        |
| 20 s passed since the first attempt                  | No new attempts                                                                                                                   |
| Every model failed or was skipped                    | 503 "The assistant is busy, please try again in a minute"                                                                         |

A model that failed cools down and is skipped until then: after a 429 for its `Retry-After` (60 s when missing, at most 10 minutes), after anything else for 30 s. The cooldowns are an in-memory map per Worker isolate, so they are best effort: another isolate may still try a cooling model once.

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

Errors are JSON `{ "error": "..." }`: 400 for an invalid request, 503 when the knowledge or every model is unavailable.

The answer is sent with `Cache-Control: no-store, no-transform`. Compression would hold the stream back until the end, and `no-transform` turns it off on Cloudflare's edge. `wrangler dev` compresses anyway when the client accepts gzip, so streaming can only be checked locally with `Accept-Encoding: identity`.

## Models

All free tiers. No account has a payment method, so nothing can be billed. The order, set on 2026-11-25, follows the eval pass rate first (see Evals), then reliability and how much free quota is left for visitors.

| #   | Provider         | Model                                | Settings                                           | Evals          | Time to first text | Free tier (November 2026)                                                         |
| --- | ---------------- | ------------------------------------ | -------------------------------------------------- | -------------- | ------------------ | --------------------------------------------------------------------------------- |
| 1   | Groq             | `openai/gpt-oss-120b`                | `reasoning_effort: "low"`                          | 29/30, 97 %    | 0.4 to 1 s         | Per model: about 30 requests and 8,000 tokens a minute, 1,000 requests a day      |
| 2   | Workers AI       | `@cf/google/gemma-4-26b-a4b-it`      | `chat_template_kwargs: { enable_thinking: false }` | 30/30, 100 %   | 0.4 s              | 10,000 neurons a day for the account, about 230 questions (about 43 neurons each) |
| 3   | Google AI Studio | `gemini-3.5-flash-lite`              |                                                    | 28/30, 93 %    | 0.6 to 6 s         | Per project, not published. Prompts may be used to improve Google's products.     |
| 4   | Groq             | `qwen/qwen3.8-27b`                   |                                                    | 15/15 answered | 0.7 to 1.4 s       | Smaller than model 1: it returned 429 for the other 15 questions after retries    |
| 5   | OpenRouter       | `nvidia/nemotron-3.5-lightning:free` |                                                    | 21/30, 70 %    | 2 to 3.5 s         | 50 free requests a day (account without credits), 20 a minute                     |

Why this order:

- **Groq `gpt-oss-120b`** is the fastest and nearly perfect. Its one miss named only one of two Elixir projects.
- **Workers AI Gemma** passed everything and has the largest daily allowance, so it takes over when Groq's per-minute limit runs out.
- **Gemini** answers well, but its free tier closed 2 of 10 streams mid-answer in a direct test, and both eval misses were such cut-off answers.
- **Qwen** answered correctly, but its free quota ran out after 15 questions in a row.
- **OpenRouter Nemotron** returned 7 empty answers out of 30 and missed a fact, so it is the last resort.

One question costs about 5,000 input tokens (the knowledge is about 4,500) plus the answer. Groq's per-minute token limit allows roughly one question a minute, so bursts move on to Workers AI.

Models tried and left out on 2026-11-25:

- `gemini-3.5-flash` and `gemini-3.1-flash-lite`: 8 to 40 s to first text on the free tier.
- `gemini-flash-latest`, `gemma-4-31b-it` (Gemini), `google/gemma-4-31b-it:free` and `inclusionai/ling-3.2-flash:free` (OpenRouter): 503 or 429 from overload.
- `nvidia/nemotron-3.5-super-vl:free`: over 8 s with default reasoning, 3.5 s with low effort, slower than Lightning.
- Workers AI Gemma with its default reasoning: 14 s to first text, so reasoning is turned off.

Every HTTP provider is called through its OpenAI-compatible chat completions endpoint (`openAiCompatible`), and Workers AI through the `AI` binding (`workersAi`). Both return the provider's SSE stream, so `streamAnswer` treats them the same.

**Adding a model:** add an entry to `MODELS`. For a new provider, add its key name to `.dev.vars.example`, run `pnpm types`, and set the secret with `wrangler secret put <NAME>`. OpenRouter model IDs must end in `:free` (a unit test checks this).

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

- The Worker never logs prompts or answers. It logs, through Workers observability:
  - `model_used`: provider, model, number of attempts and time to first text
  - `model_failed`: provider, model and the reason (status code, timeout, empty answer)
  - `stream_broken`, `all_models_failed` and `knowledge_failed`
- Visitor messages are sent to the model providers. Free tiers may keep or use them under their own terms, which is why the chat UI must say so (see PLAN.md, section 7).

## Configuration

| Name                 | Kind     | Where                                                    | Purpose                                  |
| -------------------- | -------- | -------------------------------------------------------- | ---------------------------------------- |
| `KNOWLEDGE_URL`      | variable | `wrangler.jsonc`                                         | Where the knowledge file is fetched from |
| `AI`                 | binding  | `wrangler.jsonc`                                         | Workers AI                               |
| `GROQ_API_KEY`       | secret   | `.dev.vars` locally, `wrangler secret put` in production | Groq                                     |
| `GEMINI_API_KEY`     | secret   | same                                                     | Google AI Studio                         |
| `OPENROUTER_API_KEY` | secret   | same                                                     | OpenRouter                               |

Every key comes from an account without a payment method. `worker-configuration.d.ts` holds the generated `Env` type. `pnpm types` regenerates it from `wrangler.jsonc` and the names in `.dev.vars.example`.

The Workers AI binding always runs on Cloudflare, even in `wrangler dev`, which needs `wrangler login` and a `workers.dev` subdomain on the account (`kappelakos.workers.dev`).

## Evals

`pnpm eval` ([evals/run.ts](../evals/run.ts)) asks every case in [evals/cases.json](../evals/cases.json) of every model directly, without fallback, and prints a pass rate per model.

- **Cases (30):** facts from the profile, a follow-up question, contact details without the e-mail or phone number, salary, an invented project and employer, an off-topic coding task, prompt injection, a request to print the system prompt, "are you Ákos?", and questions in Hungarian, Slovak, German and Czech.
- **Checks** ([evals/check.ts](../evals/check.ts)) are deterministic: regular expressions that must or must not match, after turning typographic hyphens and apostrophes into ASCII. For non-English cases, the answer must not be clearly English, Slovak must not contain Czech letters (ě, ř, ů), and Czech must contain them.
- **Rate limits:** a 429 or a dropped stream waits and retries up to four times, so it is reported as an error, not as a wrong answer. Errors are left out of the pass rate. After three errors in a row the model's remaining cases are skipped, since its daily quota is most likely used up.
- **Gate:** the first model in `MODELS` must pass 90 %, or the run exits with an error.
- **Options:** `--model <part>` (repeatable) and `--case <part>` filter by name, and `--knowledge <url or file>` replaces `KNOWLEDGE_URL`, for example with a local portfolio build.
- **Workers AI** runs through Wrangler's `getPlatformProxy`, so a local run needs `wrangler login`.
- **Weekly run:** [.github/workflows/eval.yml](../.github/workflows/eval.yml) runs on Sundays at 21:00 UTC and on demand, and writes the table to the job summary. It uses the same free daily quotas as visitors, so it runs on the quietest day, three hours before OpenRouter's and Workers AI's daily quotas reset at midnight UTC. It needs the GitHub secrets `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

A full run takes a while on free tiers: Groq's per-minute limit makes each Groq model wait between questions (5 minutes for `gpt-oss-120b` on 2026-11-25; Qwen took over an hour, mostly retrying after its quota ran out, which the skip rule now cuts short). Running models one at a time with `--model` keeps the load on the home server low.

## Testing

- `pnpm test`: Vitest unit tests for validation, prompt building, stream parsing, the fallback rules (with fake models), the `/chat` route (with `fetch` replaced) and the eval checks. No test calls a real provider.
- `pnpm eval`: answer quality against the real models (see Evals).
- Manual end-to-end check: run the portfolio (`pnpm dev` there) and the Worker with `pnpm exec wrangler dev --var KNOWLEDGE_URL:http://localhost:3000/llms-full.txt`, then send questions with curl. Several questions in a row exercise the fallback, because Groq's per-minute limit runs out after one or two and Workers AI takes over.
