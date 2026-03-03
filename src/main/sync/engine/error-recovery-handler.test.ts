import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SyncContext } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../http-client', () => {
  class RateLimitError extends Error {
    retryAfterMs: number
    constructor(retryAfter?: number) {
      super('Too many requests')
      this.name = 'RateLimitError'
      this.retryAfterMs = (retryAfter ?? 60) * 1000
    }
  }
  return { RateLimitError }
})

vi.mock('../sync-errors', () => ({
  classifyError: vi.fn((err: unknown) => {
    if (err && typeof err === 'object' && 'category' in err) return err
    return { category: 'unknown', message: 'unknown', retryable: true }
  })
}))

import { ErrorRecoveryHandler } from './error-recovery-handler'
import { classifyError } from '../sync-errors'
import { RateLimitError } from '../http-client'

function createCtx(overrides?: Partial<SyncContext>): SyncContext {
  return {
    deps: {
      ws: { disconnect: vi.fn() },
      queue: { getPendingCount: vi.fn().mockReturnValue(0) },
      emitToRenderer: vi.fn(),
      refreshAccessToken: vi.fn()
    },
    abortController: null,
    lastError: undefined,
    lastErrorInfo: undefined,
    rateLimitConsecutive: 0,
    ...overrides
  } as unknown as SyncContext
}

function createStateManager(): SyncStateManager {
  return { setState: vi.fn() } as unknown as SyncStateManager
}

describe('ErrorRecoveryHandler', () => {
  let ctx: SyncContext
  let stateManager: SyncStateManager
  let onFullSync: ReturnType<typeof vi.fn>
  let handler: ErrorRecoveryHandler

  beforeEach(() => {
    ctx = createCtx()
    stateManager = createStateManager()
    onFullSync = vi.fn()
    handler = new ErrorRecoveryHandler(ctx, stateManager, onFullSync)
  })

  describe('handleCoordinatorError', () => {
    it('#given AbortError #when handleCoordinatorError #then ignores it', async () => {
      const abort = new DOMException('Aborted', 'AbortError')

      await handler.handleCoordinatorError(abort)

      expect(stateManager.setState).not.toHaveBeenCalled()
    })

    it('#given device_revoked error #when handleCoordinatorError #then delegates to handleDeviceRevoked', async () => {
      const err = { category: 'device_revoked', message: 'revoked', retryable: false }
      vi.mocked(classifyError).mockReturnValueOnce(err)

      await handler.handleCoordinatorError(err)

      expect(ctx.deps.ws.disconnect).toHaveBeenCalled()
    })

    it('#given auth_expired error #when handleCoordinatorError #then delegates to handleAuthExpired', async () => {
      const err = { category: 'auth_expired', message: 'expired', retryable: false }
      vi.mocked(classifyError).mockReturnValueOnce(err)
      vi.mocked(ctx.deps.refreshAccessToken!).mockResolvedValueOnce(true)

      await handler.handleCoordinatorError(err)

      expect(ctx.deps.refreshAccessToken).toHaveBeenCalled()
    })

    it('#given network_offline error #when handleCoordinatorError #then sets state to offline', async () => {
      const err = { category: 'network_offline', message: 'offline', retryable: true }
      vi.mocked(classifyError).mockReturnValueOnce(err)

      await handler.handleCoordinatorError(err)

      expect(stateManager.setState).toHaveBeenCalledWith('offline')
    })

    it('#given RateLimitError #when handleCoordinatorError #then routes to handleRateLimited', async () => {
      const err = new RateLimitError(10)
      vi.mocked(classifyError).mockReturnValueOnce({
        category: 'rate_limited',
        message: 'rate limited',
        retryable: true
      })

      await handler.handleCoordinatorError(err)

      expect(ctx.rateLimitConsecutive).toBe(1)
    })
  })

  describe('handleDeviceRevoked', () => {
    it('#when handleDeviceRevoked #then disconnects WS and emits DEVICE_REMOVED', () => {
      handler.handleDeviceRevoked()

      expect(ctx.deps.ws.disconnect).toHaveBeenCalled()
      expect(ctx.deps.emitToRenderer).toHaveBeenCalledWith(
        'sync:device-removed',
        expect.objectContaining({ unsyncedCount: 0 })
      )
    })

    it('#when handleDeviceRevoked #then sets error state with device_revoked info', () => {
      handler.handleDeviceRevoked()

      expect(stateManager.setState).toHaveBeenCalledWith('error')
      expect(ctx.lastErrorInfo).toEqual({
        category: 'device_revoked',
        message: 'This device has been removed',
        retryable: false
      })
    })
  })

  describe('handleCertPinFailed', () => {
    it('#when handleCertPinFailed #then sets error state and emits event', () => {
      const event = { hostname: 'api.example.com' }

      handler.handleCertPinFailed(event)

      expect(stateManager.setState).toHaveBeenCalledWith('error')
      expect(ctx.lastErrorInfo).toEqual({
        category: 'certificate_pin_failed',
        message: 'Certificate pin verification failed. Restart the app to retry.',
        retryable: false
      })
    })
  })

  describe('clearRateLimitState', () => {
    it('#given rateLimitConsecutive > 0 #when clearRateLimitState #then resets counter to 0', () => {
      ctx.rateLimitConsecutive = 5

      handler.clearRateLimitState()

      expect(ctx.rateLimitConsecutive).toBe(0)
    })
  })

  describe('handleAuthExpired (via handleCoordinatorError)', () => {
    it('#given refreshAccessToken succeeds #when auth_expired #then triggers fullSync', async () => {
      const err = { category: 'auth_expired', message: 'expired', retryable: false }
      vi.mocked(classifyError).mockReturnValueOnce(err)
      vi.mocked(ctx.deps.refreshAccessToken!).mockResolvedValueOnce(true)

      await handler.handleCoordinatorError(err)

      expect(onFullSync).toHaveBeenCalled()
    })

    it('#given refreshAccessToken fails #when auth_expired #then sets error state', async () => {
      const err = { category: 'auth_expired', message: 'expired', retryable: false }
      vi.mocked(classifyError).mockReturnValueOnce(err)
      vi.mocked(ctx.deps.refreshAccessToken!).mockResolvedValueOnce(false)

      await handler.handleCoordinatorError(err)

      expect(stateManager.setState).toHaveBeenCalledWith('error')
      expect(ctx.lastError).toBe('Session expired')
    })

    it('#given no refreshAccessToken dep #when auth_expired #then sets error state directly', async () => {
      ctx = createCtx({
        deps: { ...ctx.deps, refreshAccessToken: undefined } as SyncContext['deps']
      })
      handler = new ErrorRecoveryHandler(ctx, stateManager, onFullSync)

      const err = { category: 'auth_expired', message: 'expired', retryable: false }
      vi.mocked(classifyError).mockReturnValueOnce(err)

      await handler.handleCoordinatorError(err)

      expect(stateManager.setState).toHaveBeenCalledWith('error')
      expect(onFullSync).not.toHaveBeenCalled()
    })
  })
})
