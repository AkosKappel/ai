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

1. **Guard** ([src/guard.ts](../src/guard.ts)), cheapest check first, so a rejected request never costs a Turnstile check or any model quota:
   1. The `Origin` header must be on `ALLOWED_ORIGINS`, or the answer is 403. Requests without one (curl, scripts) are rejected too.
   2. A body over 32 KB gets a 413.
   3. At most 5 requests a minute per IP (`CF-Connecting-IP`) through the `CHAT_RATE_LIMITER` binding, or a 429 with `Retry-After: 60`.
   4. The JSON body is validated ([src/chat.ts](../src/chat.ts) `parseChatRequest`): anything invalid gets a 400.
   5. The Turnstile token is verified with Cloudflare's siteverify API, together with the visitor's IP. A rejected token gets a 403. If siteverify cannot be reached, the answer is a 503: the check fails closed rather than letting requests through.
2. **Load the knowledge** from `KNOWLEDGE_URL` ([src/chat.ts](../src/chat.ts) `loadKnowledge`). Cloudflare caches the response for an hour, so most requests never reach the portfolio. If it fails, the answer is a 503.
3. **Pick the pages** ([src/context.ts](../src/context.ts) `prepareAnswer`, see Page picking): a small function call chooses which pages of the knowledge the question needs.
4. **Build the system prompt** (`buildSystemPrompt`): an introduction, the picked pages (or the whole knowledge) inside `<portfolio>` tags, the page the visitor is reading, the rules, and last the reply language. Recruiter mode uses `buildRecruiterPrompt` with the whole knowledge instead.
5. **Find a model that answers** ([src/models.ts](../src/models.ts) `streamAnswer`): try each model in `MODELS` order until one sends answer text (see Fallback).
6. **Stream the answer** as plain text, with the model in `X-Assistant-Model` and the picked pages in `X-Assistant-Sources`. [src/stream.ts](../src/stream.ts) `sseToText` turns the provider's server-sent events into text as they arrive. Only the answer is kept (`choices[0].delta.content`, or `response` from Workers AI), so hidden reasoning never reaches the browser. A stream counts as complete only once it sends a `finish_reason` or `[DONE]`; one that just stops errors instead (see Fallback).

## Page picking

Sending the whole knowledge (about 18,000 characters, 6,000 tokens) with every question used up Groq's free daily token quota after a few dozen questions. So a chat question first goes to a page picker, through function calling:

- [src/pages.ts](../src/pages.ts) splits `/llms-full.txt` into the site's pages: `/contact`, `/about`, `/experience`, `/education`, `/skills`, one page per project (`/projects/<slug>`, from its `Page:` link), and `/projects`, a one-line list of every project with its stack, for questions across projects.
- The picker gets a table of contents (one line per page, about 3,000 characters) and the conversation, and must call `get_pages` with 1 to 4 paths (`tool_choice: "required"`, the paths as an `enum`). Unknown paths are dropped.
- Pickers in order (`PAGE_PICKERS`): Groq `openai/gpt-oss-120b` (about 0.5 to 0.8 s), then Gemini `gemini-3.5-flash-lite` (about 1 s). Each gets 6 s and shares its cooldown with the answering model of the same name.
- The answer then sees the introduction, the picked pages and the page the visitor is reading. The picked pages are its sources.
- When no picker answers (quota, timeout, an unclear message like "Thanks!"), the answer gets the whole knowledge and no sources, as before. A question never fails because of the picker.

On 2026-11-25, Gemma answered 33 of 34 eval cases from picked pages (97 %), the same miss as with the whole knowledge.

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

## The chat in the portfolio

The portfolio shows a floating "Ask about me" button on every page ([portfolio `src/components/assistant/`](https://github.com/AkosKappel/portfolio/tree/main/src/components/assistant)).

- The panel, the Turnstile script and the chat logic load only when a visitor first opens the chat (`next/dynamic`), so pages pay for the button alone.
- Every message gets a fresh Turnstile token. The widget runs invisibly and shows a checkbox only when Cloudflare is unsure about the visitor.
- Before sending, the conversation is trimmed to the Worker's limits (the last 10 messages and 6,000 characters, starting with a visitor message).
- The answer streams into the panel and is rendered from a small, safe Markdown subset: paragraphs, lists, bold text and HTTPS links, never raw HTML.
- The last line of an answer (`>> question | question`) becomes up to three follow-up buttons under the newest answer. The conversation is sent back without these lines.
- Links to `https://akoskappel.dev/...` open in the same tab, in the visitor's language, and close the panel. Other links open in a new tab.
- Each answer has copy, thumbs up and thumbs down buttons. A rating goes to `POST /feedback` with the model from the `X-Assistant-Model` header, never the text.
- While an answer streams, the send button becomes a stop button. Stopping keeps what already arrived.
- Under each answer, its sources link to the pages it was written from (menu names in the visitor's language, project titles otherwise).
- Each question carries the page the visitor is on.
- "Compare a job description" switches the input to recruiter mode for one message: a longer text field (5,000 characters), shown in the chat as "Job description" and its first line. Later questions send a short note in its place, since the comparison already says what matters.
- The conversation is kept in `sessionStorage` (this tab only) and survives reloads and language switches.
- Error states map the Worker's status codes: 429 "too many questions", 503 "busy", 403 "bot check failed", a broken stream "the answer was cut off", anything else "something went wrong". Every state except the rate limit and the bot check offers "Try again".
- The chat is hidden until `NEXT_PUBLIC_ASSISTANT_URL` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` are set in the portfolio. Only then does its Content Security Policy allow the Worker and Turnstile, and `/colophon` explain where questions go.

## API

| Route                                | Response                                               |
| ------------------------------------ | ------------------------------------------------------ |
| `GET /health`                        | `{ "status": "ok" }`                                   |
| `POST /chat`                         | The answer as a `text/plain` stream                    |
| `POST /feedback`                     | 204; logs a rating of one answer                       |
| `OPTIONS /chat`, `OPTIONS /feedback` | CORS preflight: 204 for allowed origins, 403 otherwise |
| anything else                        | 404                                                    |

`POST /chat` body:

```json
{
  "messages": [{ "role": "user", "content": "Where does he work?" }],
  "locale": "en",
  "turnstileToken": "<token from the Turnstile widget>"
}
```

| Rule            | Limit                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------- |
| Messages        | 1 to 10, roles `user` or `assistant`, the last one from the user                            |
| Message length  | 1,000 characters each, 6,000 in total                                                       |
| Locale          | `en` (default), `de`, `sk`, `cs`, `hu`                                                      |
| Turnstile token | required, at most 2,048 characters, single-use: the chat gets a fresh one for every message |
| Body            | at most 32 KB                                                                               |
| Rate            | 5 requests a minute per IP                                                                  |
| Answer          | at most 1,000 output tokens, including any hidden reasoning                                 |

Errors are JSON `{ "error": "..." }`: 400 for an invalid request, 403 for a disallowed origin or a failed bot check, 413 for a too large body, 429 over the rate limit, 503 when Turnstile, the knowledge or every model is unavailable. Every `/chat` response to an allowed origin carries `Access-Control-Allow-Origin` with that origin and `Vary: Origin`.

The answer's response names the model that wrote it in `X-Assistant-Model` (for example `groq/openai/gpt-oss-120b`), exposed to the browser, like `X-Assistant-Sources`, through `Access-Control-Expose-Headers`.

Optional body fields:

- `page`: the site page the visitor is reading, without the language prefix (`/projects/skysense`). That page is always in the prompt, so "this project" works.
- `mode: "recruiter"`: the only message is a job description (up to 5,000 characters). The answer compares it with the whole portfolio: overall fit, matches, partial matches, and what the portfolio does not show.

`X-Assistant-Sources` lists the pages the answer was written from, as URL-encoded JSON (`[{"path":"/experience","title":"Experience"}]`); it is `[]` when the whole knowledge was used.

`POST /feedback` body: `{ "model": "groq/openai/gpt-oss-120b", "rating": "up" }`. The model must be one in `MODELS` and the rating `up` or `down` (400 otherwise). It has its own 5-a-minute rate limit per IP and needs no Turnstile token, since it costs no model quota.

CORS only stops other websites' scripts in a browser. Scripts outside a browser can send any `Origin`, which is why Turnstile and the rate limit do the real protection.

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

The assistant answers only from the portfolio content and says when something is not there, never invents details, talks about Ákos in the third person, declines unrelated tasks, treats visitor messages as untrusted, and keeps answers short. It links projects and pages with the URLs from the knowledge file, and ends every answer with a line of two or three follow-up questions (`>> First? | Second?`) that the chat shows as buttons. The evals check answers without that line and count how often a model writes it (Follow-ups column). The full text is in `buildSystemPrompt`.

## Logging and privacy

- The Worker never logs prompts or answers. It logs, through Workers observability:
  - `model_used`: provider, model, number of attempts and time to first text
  - `model_failed`: provider, model and the reason (status code, timeout, empty answer)
  - `pages_picked`: picker, pages and time; `pick_failed`: picker and the reason
  - `feedback`: model and rating (`up` or `down`), to compare models on real questions
  - `stream_broken`, `all_models_failed`, `knowledge_failed` and `turnstile_unavailable`
- There is no Cloudflare AI Gateway in front of the providers: its logs would store full prompts and answers.
- Visitor messages are sent to the model providers. Free tiers may keep or use them under their own terms, which is why the chat UI must say so (see PLAN.md, section 7).

## Configuration

| Name                   | Kind     | Where                                                                 | Purpose                                                                                                                                                   |
| ---------------------- | -------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KNOWLEDGE_URL`        | variable | `wrangler.jsonc`                                                      | Where the knowledge file is fetched from                                                                                                                  |
| `ALLOWED_ORIGINS`      | variable | `wrangler.jsonc`                                                      | Comma-separated origins that may call `/chat`                                                                                                             |
| `AI`                   | binding  | `wrangler.jsonc`                                                      | Workers AI                                                                                                                                                |
| `CHAT_RATE_LIMITER`    | binding  | `wrangler.jsonc`                                                      | 5 requests a minute per IP                                                                                                                                |
| `TURNSTILE_SECRET_KEY` | secret   | same as the keys below                                                | Turnstile widget secret. Locally Cloudflare's test secret `1x0000000000000000000000000000000AA`, which accepts every token (`2x…AA` rejects every token). |
| `GROQ_API_KEY`         | secret   | `.dev.vars` locally, `wrangler secret put` in production (see Deploy) | Groq                                                                                                                                                      |
| `GEMINI_API_KEY`       | secret   | same                                                                  | Google AI Studio                                                                                                                                          |
| `OPENROUTER_API_KEY`   | secret   | same                                                                  | OpenRouter                                                                                                                                                |

Every key comes from an account without a payment method. `worker-configuration.d.ts` holds the generated `Env` type. `pnpm types` regenerates it from `wrangler.jsonc` and the names in `.dev.vars.example`.

The Workers AI binding always runs on Cloudflare, even in `wrangler dev`, which needs `wrangler login` and a `workers.dev` subdomain on the account (`kappelakos.workers.dev`).

## Deploy

- **Where:** Cloudflare Workers, Worker `portfolio-assistant`, served only on `https://ai.akoskappel.dev` (a custom domain in `wrangler.jsonc`; Cloudflare manages its DNS record and certificate). The `workers.dev` address and preview URLs are off.
- **How:** the `deploy` job in [.github/workflows/ci.yml](../.github/workflows/ci.yml) runs `wrangler deploy` after the checks pass on every push to `main`, one deploy at a time. It uses the GitHub secrets `CLOUDFLARE_API_TOKEN` (from the "Edit Cloudflare Workers" template plus Workers AI Edit, limited to the account and the `akoskappel.dev` zone) and `CLOUDFLARE_ACCOUNT_ID`.
- **Secrets** are set once with `wrangler secret put <NAME>` (or `wrangler secret bulk`) and survive deploys. A deploy never touches them.
- **Rollback:** `pnpm exec wrangler rollback` returns to the previous version.
- **Logs:** Cloudflare dashboard → Workers → `portfolio-assistant` → Observability, or `pnpm exec wrangler tail` live.

## Evals

`pnpm eval` ([evals/run.ts](../evals/run.ts)) asks every case in [evals/cases.json](../evals/cases.json) of every model directly, without fallback, and prints a pass rate per model.

- **Cases (34):** facts from the profile, a follow-up question, contact details without the e-mail or phone number, salary, an invented project and employer, an off-topic coding task, prompt injection, a request to print the system prompt, "are you Ákos?", questions in Hungarian, Slovak, German and Czech, "this project" asked on a project page, and recruiter mode with a job description and with something that is not one.
- **Checks** ([evals/check.ts](../evals/check.ts)) are deterministic: regular expressions that must or must not match, after turning typographic hyphens and apostrophes into ASCII. For non-English cases, the answer must not be clearly English, Slovak must not contain Czech letters (ě, ř, ů), and Czech must contain them.
- **Rate limits:** a 429 or a dropped stream waits and retries up to four times, so it is reported as an error, not as a wrong answer. Errors are left out of the pass rate. After three errors in a row the model's remaining cases are skipped, since its daily quota is most likely used up.
- **Gate:** the first model in `MODELS` must pass 90 %, or the run exits with an error.
- **Options:** `--model <part>` (repeatable) and `--case <part>` filter by name, `--knowledge <url or file>` replaces `KNOWLEDGE_URL`, for example with a local portfolio build, and `--full` skips page picking.
- **Same path as the Worker:** each case's prompt is built once with `prepareAnswer` (page picker first, cooldowns cleared per case) and every model answers from it. The run prints for how many cases pages were picked. Cases can set `page` and `mode: "recruiter"`.
- **Workers AI** runs through Wrangler's `getPlatformProxy`, so a local run needs `wrangler login`.
- **Weekly run:** [.github/workflows/eval.yml](../.github/workflows/eval.yml) runs on Sundays at 21:00 UTC and on demand, and writes the table to the job summary. It uses the same free daily quotas as visitors, so it runs on the quietest day, three hours before OpenRouter's and Workers AI's daily quotas reset at midnight UTC. It needs the GitHub secrets `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

A full run takes a while on free tiers: Groq's per-minute limit makes each Groq model wait between questions (5 minutes for `gpt-oss-120b` on 2026-11-25; Qwen took over an hour, mostly retrying after its quota ran out, which the skip rule now cuts short). Running models one at a time with `--model` keeps the load on the home server low.

## Testing

- `pnpm test`: Vitest unit tests for validation, prompt building, stream parsing, the fallback rules (with fake models), the `/chat` route (with `fetch` replaced) and the eval checks. No test calls a real provider.
- `pnpm eval`: answer quality against the real models (see Evals).
- Manual end-to-end check: run the portfolio (`pnpm dev` there) and the Worker with `pnpm exec wrangler dev --var KNOWLEDGE_URL:http://localhost:3000/llms-full.txt`, then send questions with curl. Several questions in a row exercise the fallback, because Groq's per-minute limit runs out after one or two and Workers AI takes over.
