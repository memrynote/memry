/**
 * Resolve the sync server URL from the environment, lazily, per call.
 *
 * Read at call time — never captured in a module-level `const`. The main
 * process loads `.env.<environment>` via dotenv in `index.ts` *after* the IPC
 * handler modules are imported, so a top-level
 * `const URL = process.env.SYNC_SERVER_URL || 'http://localhost:8787'` freezes
 * to the fallback before the env file is applied. In `dev` the fallback equals
 * `.env.dev`'s value so the bug is invisible; in `dev:staging` it silently
 * pinned OAuth/sync to localhost. Mirrors `http-client.ts`'s lazy resolution.
 */
export function resolveSyncServerUrl(): string {
  return process.env.SYNC_SERVER_URL || 'http://localhost:8787'
}
