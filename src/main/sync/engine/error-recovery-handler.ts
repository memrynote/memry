import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@shared/contracts/ipc-events'
import type { CertificatePinFailedEvent, DeviceRevokedEvent } from '@shared/contracts/ipc-events'
import type { SyncErrorCategory } from '@shared/contracts/ipc-sync-ops'
import { RateLimitError } from '../http-client'
import { classifyError } from '../sync-errors'
import type { SyncContext } from './sync-context'
import { MAX_RATE_LIMIT_BACKOFF_MS, BASE_RATE_LIMIT_BACKOFF_MS } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'

const log = createLogger('SyncEngine')

export class ErrorRecoveryHandler {
  private ctx: SyncContext
  private stateManager: SyncStateManager
  private rateLimitResumeTimer: ReturnType<typeof setTimeout> | null = null
  private onFullSync: () => void

  constructor(ctx: SyncContext, stateManager: SyncStateManager, onFullSync: () => void) {
    this.ctx = ctx
    this.stateManager = stateManager
    this.onFullSync = onFullSync
  }

  async handleCoordinatorError(error: unknown): Promise<void> {
    if (error instanceof DOMException && error.name === 'AbortError') return

    const errorInfo = classifyError(error)
    if (errorInfo.category === 'device_revoked') {
      this.handleDeviceRevoked()
      return
    }
    if (errorInfo.category === 'auth_expired') {
      await this.handleAuthExpired()
      return
    }
    if (errorInfo.category === 'network_offline') {
      log.info('Sync failed: device offline, transitioning to offline state')
      this.stateManager.setState('offline')
      return
    }
    if (error instanceof RateLimitError) {
      this.handleRateLimited(error)
      return
    }
  }

  handleDeviceRevoked(): void {
    log.warn('Device has been revoked by another device')
    this.ctx.abortController?.abort()
    this.ctx.lastErrorInfo = {
      category: 'device_revoked',
      message: 'This device has been removed',
      retryable: false
    }
    this.ctx.lastError = 'This device has been removed'
    this.stateManager.setState('error')
    this.ctx.deps.ws.disconnect()

    const unsyncedCount = this.ctx.deps.queue.getPendingCount()
    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.DEVICE_REMOVED, {
      unsyncedCount
    } satisfies DeviceRevokedEvent)
  }

  handleCertPinFailed(event: CertificatePinFailedEvent): void {
    log.error('SECURITY: Certificate pin failed — sync permanently paused', {
      hostname: event.hostname
    })
    this.ctx.lastError = 'Certificate pin verification failed. Restart the app to retry.'
    this.ctx.lastErrorInfo = {
      category: 'certificate_pin_failed' as SyncErrorCategory,
      message: this.ctx.lastError,
      retryable: false
    }
    this.stateManager.setState('error')
    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.CERTIFICATE_PIN_FAILED, event)
  }

  clearRateLimitState(): void {
    this.ctx.rateLimitConsecutive = 0
    if (this.rateLimitResumeTimer) {
      clearTimeout(this.rateLimitResumeTimer)
      this.rateLimitResumeTimer = null
    }
  }

  private async handleAuthExpired(): Promise<void> {
    if (!this.ctx.deps.refreshAccessToken) {
      this.ctx.lastErrorInfo = {
        category: 'auth_expired',
        message: 'Session expired',
        retryable: false
      }
      this.ctx.lastError = 'Session expired'
      this.stateManager.setState('error')
      return
    }

    log.info('Auth expired during sync, attempting token refresh')
    const refreshed = await this.ctx.deps.refreshAccessToken()
    if (refreshed) {
      log.info('Token refreshed successfully, scheduling full sync')
      this.onFullSync()
    } else {
      this.ctx.lastErrorInfo = {
        category: 'auth_expired',
        message: 'Session expired',
        retryable: false
      }
      this.ctx.lastError = 'Session expired'
      this.stateManager.setState('error')
    }
  }

  private handleRateLimited(error: RateLimitError): void {
    this.ctx.rateLimitConsecutive++
    const serverBackoffMs = error.retryAfterMs
    const expBackoffMs = Math.min(
      BASE_RATE_LIMIT_BACKOFF_MS * Math.pow(2, this.ctx.rateLimitConsecutive - 1),
      MAX_RATE_LIMIT_BACKOFF_MS
    )
    const pauseMs = Math.min(Math.max(serverBackoffMs, expBackoffMs), MAX_RATE_LIMIT_BACKOFF_MS)

    log.warn('Rate limited — pausing sync', {
      retryAfterMs: error.retryAfterMs,
      consecutiveHits: this.ctx.rateLimitConsecutive,
      pauseMs
    })

    this.ctx.lastError = `Rate limited. Resuming in ${Math.ceil(pauseMs / 1000)}s.`
    this.ctx.lastErrorInfo = {
      category: 'rate_limited',
      message: this.ctx.lastError,
      retryable: true
    }
    this.stateManager.setState('error')

    if (this.rateLimitResumeTimer) clearTimeout(this.rateLimitResumeTimer)
    this.rateLimitResumeTimer = setTimeout(() => {
      this.rateLimitResumeTimer = null
      log.info('Rate limit pause expired — resuming sync')
      this.ctx.lastError = undefined
      this.ctx.lastErrorInfo = undefined
      this.stateManager.setState('idle')
      this.onFullSync()
    }, pauseMs)
  }
}
