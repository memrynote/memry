/**
 * Resolve the sync server URL from the environment, lazily, per call.
 *
 * Read at call time — never captured in a module-level `const`. The main
 * process loads `.env.<environment>` via dotenv in `index.ts` *after* the IPC
 * handler modules are imported, so a top-level
 * `const URL = readEnv('SYNC_SERVER_URL') || 'http://localhost:8787'` freezes
 * to the fallback before the env file is applied. In `dev` the fallback equals
 * `.env.dev`'s value so the bug is invisible; in `dev:staging` it silently
 * pinned OAuth/sync to localhost. `http-client.ts` used to carry its own copy of
 * this resolution; it now calls in here, so every sync-adjacent consumer —
 * sync HTTP, OAuth sign-in, canvas assets, attachments — reads one policy.
 */
import { readEnv } from './env.ts'

const DEV_FALLBACK_URL = 'http://localhost:8787'

export function resolveSyncServerUrl(): string {
  const configured = readEnv('SYNC_SERVER_URL')
  if (configured) return normalizeSyncServerUrl(configured)

  // The localhost fallback is a *development* convenience, not a runtime
  // default. This module used to fall back unconditionally, which meant the two
  // call sites that do NOT go through http-client — the OAuth sign-in URL
  // (ipc/auth-oauth-handlers.ts) and the canvas asset service
  // (canvas/assets/asset-service-context.ts) — silently pointed a real user's
  // packaged app at http://localhost:8787 while sync HTTP was already failing
  // loudly with a config error. One env var must not have two contradictory
  // policies.
  //
  // NODE_ENV is 'development' under `electron-vite dev` and undefined at
  // runtime in packaged Electron (see the applyPackagedLogLevels comment in
  // src/main/index.ts), so a packaged build lands on the throw.
  //
  // 'test' is accepted alongside 'development' — the same predicate
  // certificate-pinning.ts uses for its dev bypass — because vitest and the
  // Playwright Electron harness (tests/e2e/utils/electron-lifecycle.ts sets
  // NODE_ENV: 'test') run an UNPACKAGED build that often has no
  // SYNC_SERVER_URL. Excluding it would turn a green harness into a hard
  // failure without making a shipped build any safer.
  //
  // Compat, http-client: adopting this resolver widened sync HTTP's dev-only
  // predicate to include 'test', so an unconfigured harness now dials
  // localhost:8787 instead of throwing a config error. That combination —
  // NODE_ENV==='test' with no SYNC_SERVER_URL — cannot occur in a packaged
  // build (NODE_ENV is undefined there), so no shipped install changes
  // behaviour; and the rest of the sync surface (attachments, canvas assets,
  // OAuth) already resolved to localhost under 'test', so sync HTTP was the
  // outlier, not the standard.
  //
  // Compat, packaged builds: this throw is unreachable for an app that was
  // built normally. scripts/build-packaged-app.js refuses to package without
  // apps/desktop/.env.production, asserts the value is a valid non-local HTTPS
  // URL (assertProductionSyncServerUrl in build-packaged-app-utils.cjs), and
  // stages it as `app-config`, which every electron-builder config copies into
  // Resources. There is no packaging path that legitimately omits it. If
  // app-config is nevertheless absent or corrupt at runtime, sync HTTP was
  // ALREADY dead — http-client.ts throws this exact error — so no working
  // configuration becomes a hard failure here. The only change is that OAuth
  // and canvas assets now report the same explicit config error instead of
  // dialing a localhost port nothing is listening on.
  if (readEnv('NODE_ENV') === 'development' || readEnv('NODE_ENV') === 'test') {
    return DEV_FALLBACK_URL
  }

  throw new Error('SYNC_SERVER_URL environment variable is not configured')
}

/**
 * Every caller builds paths as `${url}/auth/...`, so a trailing slash in the
 * env yields `https://host//auth/...`. Cloudflare Workers routes that as a
 * different path, so the request 404s instead of reaching the handler.
 *
 * Only trailing slashes are stripped: scheme, host, port and any base path are
 * left verbatim so a typo still fails loudly at the call site rather than being
 * silently rewritten into something that "works". A value that is nothing but
 * slashes is returned unchanged rather than collapsed to '', which would turn
 * an absolute URL into a relative path.
 */
function normalizeSyncServerUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '')
  return trimmed || url
}
