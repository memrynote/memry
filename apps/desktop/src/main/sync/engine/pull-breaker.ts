import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { ItemCorruptEvent } from '@memry/contracts/ipc-events'
import type { DecryptionFailure } from '@memry/sync-client/worker-protocol'
import { trackMainEvent } from '../../telemetry/track'
import type { SyncContext } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'
import type { CorruptItemTracker } from './corrupt-item-tracker'

const log = createLogger('PullCoordinator')

/**
 * Trip the pull circuit breaker for a slice whose every item failed crypto
 * while the account key check said 'match' (or was unavailable), extracted
 * from PullCoordinator. The payloads are undecryptable with the CORRECT key —
 * server-side poisoned data that no amount of re-pulling can fix — so each
 * item is recorded in the corrupt tracker (cooldown) and surfaced, and the
 * page's cursor may then advance without silently losing track of what
 * failed.
 */
export function tripPullBreaker(
  deps: { ctx: SyncContext; stateManager: SyncStateManager; corruptTracker: CorruptItemTracker },
  failures: DecryptionFailure[],
  cryptoFailCount: number
): void {
  const { ctx, stateManager, corruptTracker } = deps
  ctx.lastError =
    'All items failed with crypto errors — possible vault key mismatch. ' +
    `${cryptoFailCount} item(s) could not be decrypted.`
  ctx.lastErrorInfo = {
    category: 'crypto_failure',
    message: ctx.lastError,
    retryable: false
  }
  stateManager.setState('error')
  log.error('Pull: circuit breaker tripped — all items failed crypto', { cryptoFailCount })
  // 2026-07-18 poisoned-payload incident class: previously only a log line
  // and a renderer event with no listener — invisible until a support
  // email. The run ends 'refused' (no throw), so emit from here.
  trackMainEvent('sync_error', {
    surface: 'sync',
    action: 'pull_breaker_tripped',
    result: 'failed',
    errorCode: 'crypto_breaker',
    metrics: { itemCount: cryptoFailCount },
    source: 'pull',
    dimensions: { transport: 'record' }
  })
  for (const failure of failures) {
    if (!failure.isCryptoError) continue
    corruptTracker.markFailed({ id: failure.id, type: failure.type })
    ctx.deps.emitToRenderer(EVENT_CHANNELS.ITEM_CORRUPT, {
      itemId: failure.id,
      type: failure.type,
      error: failure.error
    } satisfies ItemCorruptEvent)
  }
}
