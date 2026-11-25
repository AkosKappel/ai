# Portfolio Assistant

A Cloudflare Worker behind the "ask about me" chat on [akoskappel.dev](https://akoskappel.dev). It answers questions from the portfolio's public content using free model tiers, with streaming and fallback across providers.

Status: foundation only (`GET /health`). The plan and the next phases are in [PLAN.md](PLAN.md).

## Development

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm dev          # wrangler dev on http://localhost:8787
pnpm test
pnpm lint
pnpm typecheck
```

`worker-configuration.d.ts` is generated from `wrangler.jsonc` by `pnpm types`. Run it after changing bindings or the compatibility date, and commit the result.

Local secrets go in `.dev.vars` (ignored by git); `.dev.vars.example` lists the names once they exist.
