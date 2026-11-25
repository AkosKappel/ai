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

`POST /chat` with JSON `{ "messages": [{ "role": "user", "content": "..." }], "locale": "en", "turnstileToken": "..." }`. Locales: `en`, `de`, `sk`, `cs`, `hu`. Up to 10 messages, 1,000 characters each, 6,000 in total, the last one from the user. Only allowed origins may call it, at most 5 times a minute per IP, and every request needs a fresh Turnstile token.

The answer streams back as `text/plain`, with the model that wrote it in `X-Assistant-Model`. Optional `page` (the path the visitor is reading) and `mode: "recruiter"` (one job description of up to 5,000 characters, compared with the whole portfolio). A chat question first picks the pages it needs through function calling; `X-Assistant-Sources` names them. `GET /evals` serves the weekly eval history. `POST /feedback` with `{ "model": "...", "rating": "up" }` records a thumbs up or down. Errors are JSON `{ "error": "..." }`. Details, including every status code, are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Locally, `.dev.vars` uses Cloudflare's test secret, which accepts any token:

```bash
curl -N localhost:8787/chat -H 'Origin: http://localhost:3000' \
  -d '{"turnstileToken":"test","messages":[{"role":"user","content":"What does he work on?"}]}'
```
