# Portfolio Assistant

A Cloudflare Worker behind the "ask about me" chat on [akoskappel.dev](https://akoskappel.dev). It answers questions from the portfolio's public content using free model tiers, with streaming and fallback across providers.

Status: `POST /chat` streams answers from five free models, falling back from one to the next when a provider is busy, behind an origin allowlist, a per-IP rate limit and Turnstile. An eval suite checks answer quality per model. The chat UI lives in the portfolio (`src/components/assistant/`). The Worker runs on `https://ai.akoskappel.dev` and deploys from CI on every push to `main`. How it works is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the plan and the next phases in [PLAN.md](PLAN.md).

## Development

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm dev          # wrangler dev on http://localhost:8787
pnpm test
pnpm lint
pnpm typecheck
pnpm eval          # answer quality per model, against the real providers (slow)
```

`worker-configuration.d.ts` is generated from `wrangler.jsonc` and the secret names in `.dev.vars.example` by `pnpm types`. Run it after changing bindings, secrets or the compatibility date, and commit the result.

Local secrets go in `.dev.vars` (ignored by git). Copy `.dev.vars.example` and add keys for Groq, Google AI Studio and OpenRouter from accounts without a payment method. Workers AI needs `pnpm exec wrangler login` and a `workers.dev` subdomain on the Cloudflare account. Until the portfolio's `/llms-full.txt` is live, point the Worker at a local portfolio instead (see Testing in the architecture doc).

## API

`POST /chat` with JSON `{ "messages": [{ "role": "user", "content": "..." }], "locale": "en", "turnstileToken": "..." }`. `locale` is any language code (`en`, `pt-BR`); the portfolio sends `en`, `de`, `sk`, `cs` or `hu`. Up to 10 messages, 1,000 characters each, 6,000 in total, the last one from the user. Only allowed origins may call it, at most 5 times a minute per IP, and every request needs a fresh Turnstile token.

The answer streams back as `text/plain`, with the model that wrote it in `X-Assistant-Model`. Optional `page` (the path the visitor is reading) and `mode: "recruiter"` (one job description of up to 5,000 characters, compared with the whole site). A chat question first picks the pages it needs through function calling; `X-Assistant-Sources` names them. `GET /evals` serves the weekly eval history. `POST /feedback` with `{ "model": "...", "rating": "up" }` records a thumbs up or down. Errors are JSON `{ "error": "..." }`. Details, including every status code, are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Locally, `.dev.vars` uses Cloudflare's test secret, which accepts any token:

```bash
curl -N localhost:8787/chat -H 'Origin: http://localhost:3000' \
  -d '{"turnstileToken":"test","messages":[{"role":"user","content":"What does he work on?"}]}'
```

## Using it for another site

Nothing in the Worker is specific to the portfolio. Another site deploys its own copy with its own `wrangler.jsonc` values (`KNOWLEDGE_URL`, `ALLOWED_ORIGINS`, the route) and its own Turnstile secret, and publishes a knowledge file in this shape (the [llms.txt](https://llmstxt.org) format, as the portfolio's [`/llms-full.txt`](https://akoskappel.dev/llms-full.txt) does):

```markdown
# Jane Doe

> One line about the site. Everything before the first section goes with every question.

## About

Page: https://jane.example/

A section becomes one page, at its Page link (here /) or else at /<heading slug>.

## Writing

### Raised beds

How to build one. The first sentence is its summary.

Page: https://jane.example/blog/raised-beds
```

The H1 names the site, and the assistant talks about it in the third person. A section whose entries (`###`) have their own `Page:` links is a list: every entry becomes a page, and the section's page (`/blog`, the entries' parent path) lists them in one line each. Page paths are what the answer names as its sources, so they should be real pages. The eval cases in `evals/cases.json` are about the portfolio; another site needs its own.
