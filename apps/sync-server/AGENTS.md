# Sync Server Rules

Cloudflare Worker (`@memry/sync-server`). D1 + R2 + Durable Objects. Root `AGENTS.md` applies; this file adds sync-server rules.

## Layout

- `src/routes` — HTTP handlers. Thin; validate, delegate, respond.
- `src/services` — business logic. Where the real work lives.
- `src/durable-objects` — stateful coordination (sync sessions, rate limits).
- `src/middleware` — auth, rate limiting, request context.
- `src/emails` — transactional mail.
- `migrations/` — D1 SQL. `schema/` — schema source.

## Commands

```bash
pnpm dev:sync-server                        # from repo root
pnpm --filter @memry/sync-server typecheck
pnpm --filter @memry/sync-server test
pnpm test:sync-server
```

- Never run `deploy`, `deploy:staging`, `deploy:production`, or `reset:staging` unless the user explicitly asks.
- `reset:staging` destroys staging data. Treat it as a production-grade action; confirm before every run.

## Zero Knowledge

The server never sees plaintext. This is the product.

- Encrypted payloads go to R2; metadata goes to D1. Never inline a payload into a D1 row: the 1MB limit will bite and it leaks size structure into the metadata store.
- Do not add a route, log line, metric, or error message that could expose note content, titles, or derived plaintext.
- Never log request bodies, encryption keys, tokens, or full user identifiers.

## Compatibility

Older app versions are live in the field and will keep talking to this Worker.

- The sync protocol is a public contract. Additive changes only; never repurpose or remove a field an older client reads.
- D1 migrations are forward-only and additive. No destructive migration against production data.
- Before any protocol or schema change, state the compat plan and what an old client does when it hits the new server.
- Version-gate new behavior behind an explicit capability or version field, not behind "clients will have updated by then".

## Local State

`.wrangler/state` holds the miniflare D1 + R2 + Durable Objects dev data and is linked across worktrees by `scripts/link-env.mjs`. Migrate or seed it once in the main worktree and every tree sees it. `.dev.vars` is gitignored and linked the same way; run `pnpm env:link` if a worktree predates that.

## Tests

- Tests run against miniflare via `vitest.config.ts` / `wrangler.test.ts`. No real Cloudflare account, no production bindings.
- If you create or modify a test, run it and iterate until it passes.
- Add a regression test for every fixed sync bug; note the issue number in a comment.

## Docs

Sync-server changes are docs-relevant. Before push or PR, run `pnpm docs:ai-update --base <base_commit>` or update `apps/docs/src` by hand, then `pnpm docs:impact --base <base_commit> --strict` and `pnpm docs:build`. Protocol changes also go in `docs/protocol`.
