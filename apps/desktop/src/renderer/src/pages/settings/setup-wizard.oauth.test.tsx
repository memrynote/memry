import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from '@/contexts/auth-context'
import type { InitOAuthResult } from '@memry/contracts/ipc-auth'
import { SetupWizard } from './setup-wizard'

const state = 'manual-browser-state'
const authorizationUrl = `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`
const initOAuth = vi.fn<typeof window.api.syncAuth.initOAuth>()
const retryOAuth = vi.fn<typeof window.api.syncAuth.retryOAuth>()
const setupFirstDevice = vi.fn<typeof window.api.syncSetup.setupFirstDevice>()
let oauthCallback: Parameters<typeof window.api.onOAuthCallback>[0] | undefined
let oauthError: Parameters<typeof window.api.onOAuthError>[0] | undefined

function AuthStatus() {
  const { state: auth, cancelOAuth } = useAuth()
  return (
    <>
      <output aria-label="Authentication status">{auth.status}</output>
      <button onClick={cancelOAuth}>Cancel Google sign-in</button>
    </>
  )
}

function renderSignIn() {
  return render(
    <AuthProvider>
      <SetupWizard />
      <AuthStatus />
    </AuthProvider>
  )
}

describe('Google sign-in browser recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    oauthCallback = undefined
    oauthError = undefined
    initOAuth.mockResolvedValue({ state, authorizationUrl, browserOpened: false })
    retryOAuth.mockResolvedValue({ browserOpened: true })
    setupFirstDevice.mockResolvedValue({
      success: true,
      deviceId: 'known-device',
      needsRecoverySetup: false,
      needsRecoveryInput: false
    })
    Object.assign(window.api.syncAuth, {
      initOAuth,
      retryOAuth,
      refreshToken: vi.fn().mockResolvedValue({ success: true })
    })
    Object.assign(window.api.syncSetup, { setupFirstDevice })
    Object.assign(window.api.syncDevices, {
      getDevices: vi.fn().mockResolvedValue({ devices: [] })
    })
    Object.assign(window.api, {
      onSessionExpired: vi.fn(() => vi.fn()),
      onTokenRefreshed: vi.fn(() => vi.fn()),
      onSyncStatusChanged: vi.fn(() => vi.fn()),
      onOAuthError: vi.fn((callback: Parameters<typeof window.api.onOAuthError>[0]) => {
        oauthError = callback
        return () => {
          oauthError = undefined
        }
      }),
      onLinkingFinalized: vi.fn(() => vi.fn()),
      onOAuthCallback: vi.fn((callback: Parameters<typeof window.api.onOAuthCallback>[0]) => {
        oauthCallback = callback
        return () => {
          oauthCallback = undefined
        }
      })
    })
  })

  it('copies the fallback link and completes only the matching manual callback', async () => {
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    renderSignIn()
    await waitFor(() =>
      expect(screen.getByLabelText('Authentication status')).toHaveTextContent('unauthenticated')
    )

    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))
    const copyButton = await screen.findByRole('button', { name: 'Copy sign-in link' })
    expect(copyButton).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Try opening browser again' })).toBeEnabled()
    await user.click(copyButton)
    expect(copy).toHaveBeenCalledWith(authorizationUrl)
    expect(screen.getByLabelText('Authentication status')).toHaveTextContent('authenticating')

    act(() => oauthCallback?.({ code: 'wrong-code', state: 'wrong-state' }))
    expect(setupFirstDevice).not.toHaveBeenCalled()

    act(() => oauthCallback?.({ code: 'manual-code', state }))
    await waitFor(() =>
      expect(screen.getByLabelText('Authentication status')).toHaveTextContent(/^authenticated$/)
    )
    expect(setupFirstDevice).toHaveBeenCalledExactlyOnceWith({
      provider: 'google',
      oauthToken: 'manual-code',
      state
    })
    expect(screen.queryByRole('button', { name: 'Copy sign-in link' })).not.toBeInTheDocument()

    act(() => oauthCallback?.({ code: 'manual-code', state }))
    expect(setupFirstDevice).toHaveBeenCalledTimes(1)
  })

  it('keeps the same sign-in session available after another browser failure and a successful retry', async () => {
    const user = userEvent.setup()
    retryOAuth.mockResolvedValueOnce({ browserOpened: false })
    renderSignIn()
    await waitFor(() =>
      expect(screen.getByLabelText('Authentication status')).toHaveTextContent('unauthenticated')
    )

    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))
    await user.click(await screen.findByRole('button', { name: 'Try opening browser again' }))
    await waitFor(() => expect(retryOAuth).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Copy sign-in link' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Try opening browser again' }))
    await waitFor(() => expect(retryOAuth).toHaveBeenCalledTimes(2))
    expect(retryOAuth.mock.calls).toEqual([[{ state }], [{ state }]])
    expect(initOAuth).toHaveBeenCalledTimes(1)

    act(() => oauthCallback?.({ code: 'retry-code', state }))
    await waitFor(() =>
      expect(screen.getByLabelText('Authentication status')).toHaveTextContent(/^authenticated$/)
    )
    expect(setupFirstDevice).toHaveBeenCalledWith({
      provider: 'google',
      oauthToken: 'retry-code',
      state
    })
  })

  it.each(['failure response', 'rejected IPC'])(
    'preserves the actionable initiation error after a %s',
    async (failure) => {
      const user = userEvent.setup()
      const message = 'Google sign-in is unavailable. Check your connection and try again.'
      const wrappedMessage = `Error invoking remote method 'sync:auth:init-oauth': Error: ${message}`
      if (failure === 'failure response') {
        initOAuth.mockResolvedValueOnce({ success: false, error: wrappedMessage })
      } else {
        initOAuth.mockRejectedValueOnce(new Error(wrappedMessage))
      }
      renderSignIn()
      await waitFor(() =>
        expect(screen.getByLabelText('Authentication status')).toHaveTextContent('unauthenticated')
      )

      await user.click(screen.getByRole('button', { name: 'Continue with Google' }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled()
        for (const alert of screen.getAllByRole('alert')) {
          expect(alert).toHaveTextContent(message)
          expect(alert).not.toHaveTextContent('Failed to start Google sign-in')
        }
      })
      expect(screen.getByRole('textbox', { name: 'Email address' })).toBeEnabled()
    }
  )

  it('does not show an error when a cancelled pending initiation settles', async () => {
    const user = userEvent.setup()
    let finishLaunch: ((result: InitOAuthResult) => void) | undefined
    initOAuth.mockImplementationOnce(
      () =>
        new Promise<InitOAuthResult>((resolve) => {
          finishLaunch = resolve
        })
    )
    renderSignIn()
    await waitFor(() =>
      expect(screen.getByLabelText('Authentication status')).toHaveTextContent('unauthenticated')
    )

    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Cancel Google sign-in' }))
    await act(async () => {
      finishLaunch?.({ state, authorizationUrl, browserOpened: false })
    })

    expect(screen.getByLabelText('Authentication status')).toHaveTextContent('unauthenticated')
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Email address' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Sign-in link' })).not.toBeInTheDocument()
  })

  it('accepts a matching callback that arrives before the browser launch IPC settles', async () => {
    const user = userEvent.setup()
    let finishLaunch: ((result: InitOAuthResult) => void) | undefined
    initOAuth.mockImplementationOnce(
      () =>
        new Promise<InitOAuthResult>((resolve) => {
          finishLaunch = resolve
        })
    )
    renderSignIn()
    await waitFor(() =>
      expect(screen.getByLabelText('Authentication status')).toHaveTextContent('unauthenticated')
    )

    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))
    act(() => oauthCallback?.({ code: 'early-code', state }))
    await act(async () => {
      finishLaunch?.({ state, authorizationUrl, browserOpened: true })
    })

    await waitFor(() =>
      expect(screen.getByLabelText('Authentication status')).toHaveTextContent(/^authenticated$/)
    )
    expect(setupFirstDevice).toHaveBeenCalledExactlyOnceWith({
      provider: 'google',
      oauthToken: 'early-code',
      state
    })
  })

  it('allows another sign-in method after cancellation and ignores the abandoned callback', async () => {
    const user = userEvent.setup()
    renderSignIn()
    await waitFor(() =>
      expect(screen.getByLabelText('Authentication status')).toHaveTextContent('unauthenticated')
    )
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))
    await user.click(await screen.findByRole('button', { name: 'Use another sign-in method' }))

    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled()
    expect(screen.getByLabelText('Authentication status')).toHaveTextContent('unauthenticated')
    act(() => oauthCallback?.({ code: 'abandoned-code', state }))
    expect(setupFirstDevice).not.toHaveBeenCalled()

    initOAuth.mockResolvedValueOnce({
      state: 'new-state',
      authorizationUrl: 'https://accounts.google.com/auth?state=new-state',
      browserOpened: false
    })
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))
    await screen.findByRole('button', { name: 'Copy sign-in link' })
    act(() => oauthCallback?.({ code: 'abandoned-code', state }))
    expect(setupFirstDevice).not.toHaveBeenCalled()
    act(() => oauthCallback?.({ code: 'new-code', state: 'new-state' }))
    await waitFor(() =>
      expect(screen.getByLabelText('Authentication status')).toHaveTextContent(/^authenticated$/)
    )
    expect(setupFirstDevice).toHaveBeenCalledExactlyOnceWith({
      provider: 'google',
      oauthToken: 'new-code',
      state: 'new-state'
    })
  })

  it('reenables sign-in when the main process expires the waiting session', async () => {
    const user = userEvent.setup()
    renderSignIn()
    await waitFor(() =>
      expect(screen.getByLabelText('Authentication status')).toHaveTextContent('unauthenticated')
    )
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))
    await screen.findByRole('button', { name: 'Copy sign-in link' })

    act(() => oauthError?.({ error: 'Sign-in expired. Please try again.' }))

    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Copy sign-in link' })).not.toBeInTheDocument()
    expect(
      screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Sign-in expired'))
    ).toBe(true)
    act(() => oauthCallback?.({ code: 'expired-code', state }))
    expect(setupFirstDevice).not.toHaveBeenCalled()
  })

  it('shows a copy failure without discarding the sign-in link or session', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('Clipboard denied'))
    renderSignIn()
    await waitFor(() =>
      expect(screen.getByLabelText('Authentication status')).toHaveTextContent('unauthenticated')
    )

    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))
    await user.click(await screen.findByRole('button', { name: 'Copy sign-in link' }))
    expect(await screen.findByText(/Could not copy the sign-in link/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Sign-in link' })).toHaveValue(authorizationUrl)
    expect(screen.getByRole('button', { name: 'Try opening browser again' })).toBeEnabled()
    expect(screen.getByLabelText('Authentication status')).toHaveTextContent('authenticating')
    expect(initOAuth).toHaveBeenCalledTimes(1)
  })
})
