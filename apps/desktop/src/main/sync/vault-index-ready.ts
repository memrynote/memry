import { getStatus as getVaultStatus, onVaultStatusChanged } from '../vault/index'

/**
 * Resolves once the open vault is not running an index build (immediately when
 * none is running), or as soon as `signal` aborts.
 *
 * Status listeners are suppressed during app shutdown, so the abort is what
 * releases a waiter on quit: stopSyncRuntime aborts the runtime signal before
 * it awaits the work that called this.
 */
export function waitForVaultIndexBuild(signal: AbortSignal): Promise<void> {
  if (signal.aborted || !getVaultStatus().isIndexing) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      unsubscribe()
      signal.removeEventListener('abort', done)
      resolve()
    }
    const unsubscribe = onVaultStatusChanged((status) => {
      if (!status.isIndexing || !status.isOpen) done()
    })
    signal.addEventListener('abort', done, { once: true })
  })
}
