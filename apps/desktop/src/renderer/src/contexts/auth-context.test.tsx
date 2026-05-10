import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const serviceMocks = vi.hoisted(() => ({
  authService: {
    requestOtp: vi.fn(),
    verifyOtp: vi.fn(),
    resendOtp: vi.fn(),
    initOAuth: vi.fn(),
    refreshToken: vi.fn(),
    setupFirstDevice: vi.fn(),
    setupNewAccount: vi.fn(),
    logout: vi.fn()
  },
  deviceService: {
    getDevices: vi.fn()
  },
  setupService: {
    confirmRecoveryPhrase: vi.fn()
  }
}))

vi.mock('@/services/auth-service', () => ({
  authService: serviceMocks.authService
}))

vi.mock('@/services/device-service', () => ({
  deviceService: serviceMocks.deviceService,
  setupService: serviceMocks.setupService
}))

import { AuthProvider, useAuth } from './auth-context'

type EventCallback<T = any> = (event: T) => void

let sessionExpiredCallback: (() => void) | null = null
let oauthErrorCallback: EventCallback<{ error?: string }> | null = null
let linkingFinalizedCallback: EventCallback<{ deviceId?: string; error?: string }> | null = null
let oauthCallback: EventCallback<{ code: string; state: string }> | null = null

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}

function installApiHandlers(): void {
  const api = window.api as any
  api.onSessionExpired = vi.fn((cb: () => void) => {
    sessionExpiredCallback = cb
    return vi.fn()
  })
  api.onOAuthError = vi.fn((cb: EventCallback<{ error?: string }>) => {
    oauthErrorCallback = cb
    return vi.fn()
  })
  api.onLinkingFinalized = vi.fn((cb: EventCallback<{ deviceId?: string; error?: string }>) => {
    linkingFinalizedCallback = cb
    return vi.fn()
  })
  api.onOAuthCallback = vi.fn((cb: EventCallback<{ code: string; state: string }>) => {
    oauthCallback = cb
    return vi.fn()
  })
  api.syncLinking = {
    linkViaRecovery: vi.fn().mockResolvedValue({ success: true, deviceId: 'linked-device' })
  }
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionExpiredCallback = null
    oauthErrorCallback = null
    linkingFinalizedCallback = null
    oauthCallback = null
    installApiHandlers()
    serviceMocks.deviceService.getDevices.mockResolvedValue({ devices: [] })
    serviceMocks.authService.refreshToken.mockResolvedValue({ success: true })
    serviceMocks.authService.requestOtp.mockResolvedValue({ success: true, expiresIn: 90 })
    serviceMocks.authService.resendOtp.mockResolvedValue({ success: true, expiresIn: 60 })
    serviceMocks.authService.verifyOtp.mockResolvedValue({ success: true, needsSetup: true })
    serviceMocks.authService.setupNewAccount.mockResolvedValue({
      success: true,
      deviceId: 'new-device'
    })
    serviceMocks.authService.initOAuth.mockResolvedValue({ state: 'oauth-state' })
    serviceMocks.authService.setupFirstDevice.mockResolvedValue({
      deviceId: 'oauth-device',
      needsRecoverySetup: true
    })
    serviceMocks.setupService.confirmRecoveryPhrase.mockResolvedValue({ success: true })
    serviceMocks.authService.logout.mockResolvedValue({ success: true })
  })

  it('runs OTP setup, resend, recovery confirmation, recovery linking, and logout flows', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'))
    expect(result.current.state.wizardStep).toBe('sign-in')

    let requestResult: { expiresIn?: number } | undefined
    await act(async () => {
      requestResult = await result.current.requestOtp('kaan@example.com')
    })
    expect(requestResult).toEqual({ expiresIn: 90 })
    expect(result.current.state.email).toBe('kaan@example.com')

    let resendResult: { expiresIn?: number } | undefined
    await act(async () => {
      resendResult = await result.current.resendOtp()
    })
    expect(resendResult).toEqual({ expiresIn: 60 })

    let otpResult: unknown
    await act(async () => {
      otpResult = await result.current.verifyOtp('123456')
    })
    expect(otpResult).toEqual({
      deviceId: 'new-device',
      needsRecoverySetup: true,
      needsRecoveryInput: false
    })
    expect(result.current.state.status).toBe('authenticating')
    expect(result.current.state.needsRecoverySetup).toBe(true)

    await act(async () => {
      await result.current.confirmRecoveryPhrase()
    })
    expect(result.current.state.status).toBe('authenticated')

    let linked: unknown
    await act(async () => {
      linked = await result.current.linkViaRecovery('recovery phrase')
    })
    expect(linked).toEqual({ deviceId: 'linked-device' })
    expect(result.current.state.deviceId).toBe('linked-device')

    await act(async () => {
      await result.current.logout()
    })
    expect(result.current.state.status).toBe('unauthenticated')
  })

  it('checks existing auth and responds to session, OAuth, and linking events', async () => {
    serviceMocks.deviceService.getDevices.mockResolvedValue({
      email: 'kaan@example.com',
      devices: [
        { id: 'old-device', isCurrentDevice: false },
        { id: 'current-device', isCurrentDevice: true }
      ]
    })

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.state.status).toBe('authenticated'))
    expect(result.current.state.deviceId).toBe('current-device')
    expect(result.current.state.email).toBe('kaan@example.com')

    act(() => {
      sessionExpiredCallback?.()
    })
    expect(result.current.state.status).toBe('unauthenticated')

    act(() => {
      oauthErrorCallback?.({ error: 'OAuth failed' })
    })
    expect(result.current.state.status).toBe('error')
    expect(result.current.state.error).toBe('OAuth failed')
    expect(result.current.state.wizardError).toBe('OAuth failed')

    act(() => {
      result.current.clearError()
      result.current.clearWizardError()
    })
    expect(result.current.state.error).toBeNull()
    expect(result.current.state.wizardError).toBeNull()

    act(() => {
      linkingFinalizedCallback?.({ deviceId: 'linked-final' })
    })
    expect(result.current.state.status).toBe('authenticated')
    expect(result.current.state.deviceId).toBe('linked-final')
  })

  it('supports OAuth callback state checks and wizard state helpers', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'))

    await act(async () => {
      expect(await result.current.initOAuth()).toEqual({ state: 'oauth-state' })
    })

    act(() => {
      result.current.setWizardStep('linking-scan', {
        linkingSessionId: 'session-1',
        verificationCode: '246810',
        expiresAt: 123,
        oauthState: 'expected-state'
      })
    })
    await waitFor(() => expect(result.current.state.wizardOAuthState).toBe('expected-state'))

    await act(async () => {
      oauthCallback?.({ code: 'ignored-code', state: 'wrong-state' })
      await Promise.resolve()
    })
    expect(serviceMocks.authService.setupFirstDevice).not.toHaveBeenCalled()

    await act(async () => {
      oauthCallback?.({ code: 'oauth-code', state: 'expected-state' })
      await Promise.resolve()
    })

    await waitFor(() => expect(result.current.state.deviceId).toBe('oauth-device'))
    expect(result.current.state.wizardStep).toBe('recovery-display')

    act(() => {
      result.current.setWizardError('Wizard failed')
      result.current.resetWizard()
      result.current.resetAuthState()
    })

    expect(result.current.state.wizardStep).toBe('sign-in')
    expect(result.current.state.status).toBe('unauthenticated')
  })

  it('surfaces service errors through state and thrown messages', async () => {
    serviceMocks.authService.requestOtp.mockResolvedValueOnce({
      success: false,
      error: 'mail down'
    })

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'))

    let requestError: unknown
    await act(async () => {
      try {
        await result.current.requestOtp('kaan@example.com')
      } catch (err) {
        requestError = err
      }
    })
    expect(requestError).toEqual(new Error('mail down'))
    await waitFor(() => expect(result.current.state.error).toBe('mail down'))

    serviceMocks.authService.setupFirstDevice.mockResolvedValueOnce({ error: 'setup failed' })
    await act(async () => {
      expect(
        await result.current.setupFirstDevice({
          provider: 'google',
          oauthToken: 'token',
          state: 'state'
        })
      ).toEqual({ error: 'setup failed' })
    })
    expect(result.current.state.error).toBe('setup failed')
  })

  it('covers unauthenticated error branches and rejected device flows', async () => {
    serviceMocks.deviceService.getDevices.mockRejectedValueOnce(new Error('device lookup failed'))
    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'))

    await expect(async () => result.current.verifyOtp('000000')).rejects.toThrow('No email set')
    await expect(async () => result.current.resendOtp()).rejects.toThrow('No email set')

    serviceMocks.authService.initOAuth.mockRejectedValueOnce(new Error('oauth start failed'))
    await act(async () => {
      expect(await result.current.initOAuth()).toBeNull()
    })
    expect(result.current.state.status).toBe('error')

    await act(async () => {
      await result.current.requestOtp('kaan@example.com')
    })

    serviceMocks.authService.verifyOtp.mockResolvedValueOnce({
      success: false,
      error: 'bad code'
    })
    await expect(async () => result.current.verifyOtp('bad')).rejects.toThrow('bad code')

    serviceMocks.authService.verifyOtp.mockResolvedValueOnce({ success: true, needsSetup: true })
    serviceMocks.authService.setupNewAccount.mockResolvedValueOnce({
      success: false,
      error: 'setup account failed'
    })
    await expect(async () => result.current.verifyOtp('123456')).rejects.toThrow(
      'setup account failed'
    )

    serviceMocks.authService.verifyOtp.mockResolvedValueOnce({ success: true, needsSetup: false })
    await act(async () => {
      expect(await result.current.verifyOtp('123456')).toEqual({
        deviceId: '',
        needsRecoverySetup: true,
        needsRecoveryInput: true
      })
    })

    serviceMocks.authService.resendOtp.mockResolvedValueOnce({
      success: false,
      error: 'resend failed'
    })
    await expect(async () => result.current.resendOtp()).rejects.toThrow('resend failed')

    serviceMocks.authService.setupFirstDevice.mockRejectedValueOnce(
      new Error('device setup failed')
    )
    await act(async () => {
      expect(
        await result.current.setupFirstDevice({
          provider: 'google',
          oauthToken: 'token',
          state: 'state'
        })
      ).toBeNull()
    })

    serviceMocks.setupService.confirmRecoveryPhrase.mockResolvedValueOnce({ success: false })
    await expect(async () => result.current.confirmRecoveryPhrase()).rejects.toThrow(
      'Failed to confirm recovery phrase'
    )
    ;(window.api.syncLinking.linkViaRecovery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'link failed'
    })
    await expect(async () => result.current.linkViaRecovery('bad phrase')).rejects.toThrow(
      'link failed'
    )

    act(() => {
      linkingFinalizedCallback?.({ error: 'linking finalized failed' })
    })
    expect(result.current.state.error).toBe('linking finalized failed')
  })

  it('surfaces OAuth callback setup errors and guards provider usage', async () => {
    expect(() => renderHook(() => useAuth())).toThrow('useAuth must be used within an AuthProvider')

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.state.status).toBe('unauthenticated'))

    act(() => {
      result.current.setWizardStep('linking-scan', { oauthState: 'oauth-error-state' })
    })
    await waitFor(() => expect(result.current.state.wizardOAuthState).toBe('oauth-error-state'))

    serviceMocks.authService.setupFirstDevice.mockResolvedValueOnce({
      error: 'google setup failed'
    })
    await act(async () => {
      oauthCallback?.({ code: 'oauth-code', state: 'oauth-error-state' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.wizardError).toBe('google setup failed'))

    act(() => {
      result.current.setWizardStep('linking-scan', { oauthState: 'oauth-throw-state' })
    })
    await waitFor(() => expect(result.current.state.wizardOAuthState).toBe('oauth-throw-state'))

    serviceMocks.authService.setupFirstDevice.mockRejectedValueOnce(new Error('google threw'))
    await act(async () => {
      oauthCallback?.({ code: 'oauth-code', state: 'oauth-throw-state' })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.state.wizardError).toBe('google threw'))
  })
})
