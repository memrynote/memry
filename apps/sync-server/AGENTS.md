# Sync server guide

This directory owns the Cloudflare Worker (`@memry/sync-server`), a Hono app on D1, R2, Durable Objects, and a pack-compaction queue. It stores ciphertext and routing metadata for every client, and every client build still in the field keeps talking to it.

## Layout

- `src/routes` holds thin HTTP handlers that validate, delegate to a service, and respond. `src/services` holds the business logic.
- `src/durable-objects` holds `UserSyncState`, `LinkingSession`, and `RateLimiter`. `src/middleware` holds auth, rate limiting, and request context. `src/emails` holds transactional mail.
- `migrations/` is the canonical D1 schema, and `migrations/README.md` owns its rules. `schema/d1.test.ts` checks the schema the migrations produce.

## Zero knowledge

The server never sees plaintext. That is the product.

- Encrypted payloads go to R2, and metadata goes to D1. Inlining a payload into a D1 row hits the 1 MB row limit and leaks size structure into the metadata store.
- Routes, log lines, metrics, and error messages expose no note content, titles, or plaintext derived from them.
- Logs carry no request bodies, keys, tokens, or full user identifiers.

## Compatibility

- The sync protocol in `docs/protocol/` is a public contract. Changes are additive. A field an older client reads keeps its name and meaning.
- The protocol has no negotiated version. Gate new behavior on the client identity header and its server-side version floor (`src/services/client-policies.ts`, chapter 11) or on a per-format version byte (§0.2), and build no other negotiation.
- Before a protocol or schema change, state the compat plan and what an old client does when it meets the new server.
- Both deploy workflows apply D1 migrations before `wrangler deploy`, so each migration must work with the Worker already running. Never edit an applied migration. Add the next `NNNN_description.sql`, keep it additive, and remove a column by expand-then-contract across two releases.
- Keep semicolons out of trailing `-- comments` in migrations. The `tests/sync-harness` runner splits on `;`, and a stray one breaks every harness-backed desktop integration test with `D1_ERROR: incomplete input`.

## Deploys and data

- A push to `main` that touches this Worker, a package it bundles, or the root manifests and lockfile runs `sync-server-deploy-staging.yml`, which applies migrations to remote staging and deploys staging. Production deploys only through the manual `sync-server-deploy-production.yml` dispatch.
- Run `deploy`, `deploy:staging`, `deploy:production`, `wrangler` with `--remote`, `reset:staging`, or `staging:user` only when Kaan asks. `reset:staging` wipes staging, and `staging:user` deletes a staging account or grants it an entitlement, so confirm before every run.
- Production D1 and R2 are read-only for agents.

## Local state

`.wrangler/state` holds miniflare's local D1, R2, and Durable Object data, and the root `scripts/link-env.mjs` links it across worktrees. Migrate or seed it once in the main worktree and every tree sees it. `.dev.vars` is gitignored and linked the same way. Run `pnpm env:link` if a worktree predates that. `pnpm sync:init-db` applies migrations locally, and `pnpm sync:reset` wipes the local state.

## Tests

- `pnpm --filter @memry/sync-server test` runs Vitest against miniflare through `vitest.config.ts` and `wrangler.test.ts`, with no real Cloudflare account or production bindings. `pnpm --filter @memry/sync-server typecheck` is the type gate. Root ESLint skips this app.
- A change that touches the wire also runs `pnpm test:sync-harness` and desktop's `test:main-integration`, the real desktop client against the real Worker. Unit suites on both sides mocked that seam and stayed green through a 58-day attachment upload outage.
- Every fixed sync bug gets a regression test that names its issue number in a comment.
- CI validates the bundle with `wrangler deploy --dry-run --outdir .wrangler/ci --env staging`.

## Docs

Sync-server changes are docs-relevant. Before pushing, follow the [docs gate](../docs/AGENTS.md#docs-gate), and update `docs/protocol/` for protocol changes.
