import { createLogger } from '../../lib/logger'
import { trackMainEvent } from '../../telemetry/track'
import { RateLimitError } from '../http-client'
import { syncErrorTelemetry } from '../sync-error-telemetry'
import { classifyError } from '../sync-errors'
import type { SyncContext } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'

const log = createLogger('PullCoordinator')

/**
 * A pull's error, extracted from PullCoordinator: an abort is quiet, an auth,
 * offline or rate-limit error rethrows to the engine, and anything else puts
 * the engine in the error state with a history row.
 */
export function handlePullError(
  deps: { ctx: SyncContext; stateManager: SyncStateManager },
  error: unknown,
  startedAt: number
): void {
  if (error instanceof DOMException && error.name === 'AbortError') {
    log.debug('Pull aborted (likely network change)')
    return
  }

  const errorInfo = classifyError(error)
  deps.ctx.lastErrorInfo = errorInfo
  deps.ctx.lastError = errorInfo.message
  if (
    errorInfo.category === 'device_revoked' ||
    errorInfo.category === 'auth_expired' ||
    errorInfo.category === 'network_offline' ||
    error instanceof RateLimitError
  ) {
    throw error
  }

  // Swallowed here, so engine.pull() records sync_run_completed success —
  // the sync_error for this terminal outcome must be emitted from inside
  // this handler.
  trackMainEvent('sync_error', {
    surface: 'sync',
    action: 'pull_failed',
    result: 'failed',
    ...syncErrorTelemetry(errorInfo),
    metrics: { durationMs: Date.now() - startedAt },
    source: 'pull',
    dimensions: { transport: 'record' }
  })
  deps.stateManager.setState('error')
  deps.stateManager.recordHistory('error', 0, Date.now() - startedAt, errorInfo.message)
}
