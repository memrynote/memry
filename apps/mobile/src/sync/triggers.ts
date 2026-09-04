import { getEditorSession } from '../editor/session'
import { createLogger } from '../lib/logger'
import { getSyncEngine } from './engine'
import { requestSync, type SyncReason } from './request-sync'

const log = createLogger('SyncTriggers')

/**
 * Drain the write queue. Failures are logged, never thrown: a drain that
 * rejects into an AppState listener is an unhandled rejection, and the rows it
 * could not send are still queued for the next pass.
 */
export async function drainOutbox(vaultId: string): Promise<void> {
  try {
    const session = await getEditorSession(vaultId)
    await session.flush()
  } catch (err) {
    log.warn('Outbox drain failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/** `requestSync` bound to the real drain and the real engine. */
export function requestVaultSync(vaultId: string, reason: SyncReason): Promise<void> {
  return requestSync(
    {
      drain: drainOutbox,
      sync: (id) => getSyncEngine(id).sync()
    },
    vaultId,
    reason
  )
}
