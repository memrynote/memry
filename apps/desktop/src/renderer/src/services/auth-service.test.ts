import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { authService } from './auth-service'

describe('auth-service', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards requestOtp to window.api.syncAuth', async () => {
    // #given
    const response = { success: true, expiresIn: 300 }
    api.syncAuth.requestOtp = vi.fn().mockResolvedValue(response)

    // #when
    const result = await authService.requestOtp({ email: 'test@example.com' })

    // #then
    expect(api.syncAuth.requestOtp).toHaveBeenCalledWith({ email: 'test@example.com' })
    expect(result).toEqual(response)
  })

  it('forwards verifyOtp to window.api.syncAuth', async () => {
    // #given
    const response = { success: true, isNewUser: true, needsRecoverySetup: true }
    api.syncAuth.verifyOtp = vi.fn().mockResolvedValue(response)

    // #when
    const result = await authService.verifyOtp({ email: 'test@example.com', code: '123456' })

    // #then
    expect(api.syncAuth.verifyOtp).toHaveBeenCalledWith({
      email: 'test@example.com',
      code: '123456'
    })
    expect(result).toEqual(response)
  })

  it('forwards resendOtp to window.api.syncAuth', async () => {
    // #given
    const response = { success: true, expiresIn: 300 }
    api.syncAuth.resendOtp = vi.fn().mockResolvedValue(response)

    // #when
    const result = await authService.resendOtp({ email: 'test@example.com' })

    // #then
    expect(api.syncAuth.resendOtp).toHaveBeenCalledWith({ email: 'test@example.com' })
    expect(result).toEqual(response)
  })

  it('forwards OAuth, setup, recovery, refresh, and logout calls', async () => {
    const syncAuth = api.syncAuth as typeof api.syncAuth & {
      initOAuth: ReturnType<typeof vi.fn>
      refreshToken: ReturnType<typeof vi.fn>
      logout: ReturnType<typeof vi.fn>
    }
    const syncSetup = api.syncSetup as typeof api.syncSetup & {
      setupNewAccount: ReturnType<typeof vi.fn>
    }

    syncAuth.initOAuth = vi.fn().mockResolvedValue({ state: 'oauth-state' })
    syncAuth.refreshToken = vi.fn().mockResolvedValue({ success: true })
    syncAuth.logout = vi.fn().mockResolvedValue({ success: true })
    syncSetup.setupFirstDevice = vi.fn().mockResolvedValue({ success: true })
    syncSetup.setupNewAccount = vi.fn().mockResolvedValue({ success: true })
    syncSetup.confirmRecoveryPhrase = vi.fn().mockResolvedValue({ success: true })

    await expect(authService.initOAuth({ provider: 'google' })).resolves.toEqual({
      state: 'oauth-state'
    })
    await expect(authService.refreshToken()).resolves.toEqual({ success: true })
    await expect(
      authService.setupFirstDevice({
        provider: 'google',
        oauthToken: 'token',
        state: 'oauth-state'
      })
    ).resolves.toEqual({ success: true })
    await expect(authService.setupNewAccount()).resolves.toEqual({ success: true })
    await expect(authService.confirmRecoveryPhrase({ confirmed: true })).resolves.toEqual({
      success: true
    })
    await expect(authService.logout()).resolves.toEqual({ success: true })

    expect(syncAuth.initOAuth).toHaveBeenCalledWith({ provider: 'google' })
    expect(syncAuth.refreshToken).toHaveBeenCalled()
    expect(syncSetup.setupFirstDevice).toHaveBeenCalledWith({
      provider: 'google',
      oauthToken: 'token',
      state: 'oauth-state'
    })
    expect(syncSetup.setupNewAccount).toHaveBeenCalled()
    expect(syncSetup.confirmRecoveryPhrase).toHaveBeenCalledWith({ confirmed: true })
    expect(syncAuth.logout).toHaveBeenCalled()
  })
})
