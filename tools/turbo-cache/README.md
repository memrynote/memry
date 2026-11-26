# Turbo remote cache

A Cloudflare Worker that serves turbo's remote cache API from the R2 bucket `memry-turbo-cache`, so
CI replays a typecheck whose inputs a trusted run already checked. It is a separate Worker from the
sync server and shares nothing with it.

## Trust model

- `READ_TOKEN` reads. `WRITE_TOKEN` reads and writes. Any other request gets 401, and a `PUT` with
  the read token gets 403.
- Only the `write` job of `.github/workflows/turbo-cache.yml` holds the write token: it runs on a
  push to `feat/tauri-v2`, in the `turbo-cache-write` environment. Pull request and merge-group runs
  use the read token. A fork's pull request gets no token and no remote cache.
- turbo signs every artifact with `TURBO_REMOTE_CACHE_SIGNATURE_KEY` (HMAC-SHA256, `remoteCache.signature`
  in `turbo.json`) and drops a downloaded artifact whose signature does not verify. The Worker never
  holds that key. It refuses an unsigned upload.
- A hit is only as correct as the task hash. `check-task-inputs.mjs` proves every file a cached
  typecheck's TypeScript programs load is hashed, and runs before every write. Files a task reads
  outside its TypeScript programs (the desktop `pretypecheck` scripts) are listed by hand in
  `apps/desktop/turbo.json` and `apps/desktop-tauri/turbo.json`.

## Deploy

Run from this directory with a Cloudflare login for the account that owns `memry-turbo-cache`:

```bash
pnpm exec wrangler deploy
pnpm exec wrangler secret put READ_TOKEN
pnpm exec wrangler secret put WRITE_TOKEN
```

Tokens must be at least 32 characters; a shorter one is treated as unset. Then set the GitHub
repository variable `TURBO_API` to the Worker URL. With `TURBO_API` unset, CI runs without a remote
cache.

## Test

```bash
pnpm exec vitest run --root tools/turbo-cache
node tools/turbo-cache/check-task-inputs.mjs
```
