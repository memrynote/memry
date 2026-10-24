const AGENT_BOOTSTRAP_ATTEMPTS = 40
const AGENT_BOOTSTRAP_RETRY_MS = 250

/**
 * Mirrors `AGENT_RUNTIME_STARTING_CODE` in main/ipc/agent-lazy-handlers.ts —
 * the two processes cannot share a module, so keep the literals in sync. The
 * lazy agent handlers reject with this code while the runtime boots; it is a
 * stable i18n key, never display text, so the retry match below survives
 * translation.
 */
const AGENT_RUNTIME_STARTING_CODE = 'errors:agent.runtimeStarting'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Matches the *raw* rejection message, not `extractErrorMessage()`: that helper
 * translates an `errors:` key into the user's language, which would erase the
 * code this predicate keys on and strand the caller in every non-English locale.
 * 'No handler registered' is Electron's own English text for an invoke that
 * arrives before `ipcMain.handle` runs — not ours to localize.
 */
function shouldRetryAgentBootstrap(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return raw.includes('No handler registered') || raw.includes(AGENT_RUNTIME_STARTING_CODE)
}

/**
 * Runs an agent IPC invoke, retrying while the lazy agent runtime is still
 * starting. Rejects with the last error once retries run out or on any other
 * failure, so callers must still attach a `.catch`.
 */
export async function invokeWhenAgentReady<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < AGENT_BOOTSTRAP_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!shouldRetryAgentBootstrap(error)) break
      await sleep(AGENT_BOOTSTRAP_RETRY_MS)
    }
  }
  throw lastError
}
