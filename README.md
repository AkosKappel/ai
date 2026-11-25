# Portfolio Assistant

A Cloudflare Worker behind the "ask about me" chat on [akoskappel.dev](https://akoskappel.dev). It answers questions from the portfolio's public content using free model tiers, with streaming and fallback across providers.

Status: `POST /chat` streams answers from one provider (Groq). Fallback, evals and abuse protection are next. How it works is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the plan and the next phases in [PLAN.md](PLAN.md).

## Development

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm dev          # wrangler dev on http://localhost:8787
pnpm test
pnpm lint
pnpm typecheck
```

`worker-configuration.d.ts` is generated from `wrangler.jsonc` and the secret names in `.dev.vars.example` by `pnpm types`. Run it after changing bindings, secrets or the compatibility date, and commit the result.

Local secrets go in `.dev.vars` (ignored by git). Copy `.dev.vars.example` and add a [Groq API key](https://console.groq.com/keys) from an account without a payment method. Until the portfolio's `/llms-full.txt` is live, point the Worker at a local portfolio instead (see Testing in the architecture doc).

## API

`POST /chat` with JSON `{ "messages": [{ "role": "user", "content": "..." }], "locale": "en" }`. Locales: `en`, `de`, `sk`, `cs`, `hu`. Up to 10 messages, 1,000 characters each, 6,000 in total, the last one from the user.

The answer streams back as `text/plain`. Errors are JSON `{ "error": "..." }` with status 400 (invalid request), 404 or 503 (knowledge or model unavailable).

```bash
curl -N localhost:8787/chat -d '{"messages":[{"role":"user","content":"What does he work on?"}]}'
```
