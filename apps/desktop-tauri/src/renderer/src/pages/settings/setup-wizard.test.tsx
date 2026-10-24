import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SetupWizard } from './setup-wizard'

const authMock = vi.hoisted(() => ({
  useAuth: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
  })
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: authMock.useAuth
}))

vi.mock('@/components/sync/email-entry-form', () => ({
  EmailEntryForm: ({
    onSubmit,
    error
  }: {
    onSubmit: (email: string) => void
    error?: string | null
  }) => (
    <div>
      <button onClick={() => onSubmit('kaan@example.com')}>submit email</button>
      {error && <p>{error}</p>}
    </div>
  )
}))

vi.mock('@/components/sync/oauth-buttons', () => ({
  OAuthButtons: ({ onGoogleClick }: { onGoogleClick: () => void }) => (
    <button onClick={onGoogleClick}>google oauth</button>
  )
}))

vi.mock('@/components/sync/otp-verification', () => ({
  OtpVerification: ({
    email,
    expiresIn,
    onVerify,
    onResend,
    onBack
  }: {
    email: string
    expiresIn: number
    onVerify: (code: string) => void
    onResend: () => void
    onBack: () => void
  }) => (
    <div>
      <span>
        otp for {email}:{expiresIn}
      </span>
      <button onClick={() => onVerify('123456')}>verify otp</button>
      <button onClick={onResend}>resend otp</button>
      <button onClick={onBack}>back to sign in</button>
    </div>
  )
}))

vi.mock('@/components/sync/recovery-phrase-display', () => ({
  RecoveryPhraseDisplay: ({ phrase, onContinue }: { phrase: string; onContinue: () => void }) => (
    <div>
      <span>display:{phrase}</span>
      <button onClick={onContinue}>continue recovery</button>
    </div>
  )
}))

vi.mock('@/components/sync/recovery-phrase-confirm', () => ({
  RecoveryPhraseConfirm: ({
    phrase,
    onConfirmed,
    onBack
  }: {
    phrase: string
    onConfirmed: () => void
    onBack: () => void
  }) => (
    <div>
      <span>confirm:{phrase}</span>
      <button onClick={onConfirmed}>confirm recovery</button>
      <button onClick={onBack}>back to phrase</button>
    </div>
  )
}))

vi.mock('@/components/sync/recovery-phrase-input', () => ({
  RecoveryPhraseInput: ({
    onSubmit,
    onBack
  }: {
    onSubmit: (phrase: string) => void
    onBack: () => void
  }) => (
    <div>
      <button onClick={() => onSubmit('word one two')}>submit recovery phrase</button>
      <button onClick={onBack}>back to link choice</button>
    </div>
  )
}))

vi.mock('@/components/sync/linking-code-entry', () => ({
  LinkingCodeEntry: ({
    onLinked,
    onError,
    onBack
  }: {
    onLinked: (sessionId: string, verificationCode?: string) => void
    onError: (error: string) => void
    onBack: () => void
  }) => (
    <div>
      <button onClick={() => onLinked('session-1', '654321')}>linked code</button>
      <button onClick={() => onError('bad qr')}>link error</button>
      <button onClick={onBack}>back from scan</button>
    </div>
  )
}))

vi.mock('@/components/sync/linking-pending', () => ({
  LinkingPending: ({
    sessionId,
    verificationCode,
    onComplete,
    onError,
    onCancel
  }: {
    sessionId: string
    verificationCode?: string
    onComplete: () => void
    onError: (error: string) => void
    onCancel: () => void
  }) => (
    <div>
      <span>
        pending:{sessionId}:{verificationCode}
      </span>
      <button onClick={onComplete}>complete link</button>
      <button onClick={() => onError('link failed')}>pending error</button>
      <button onClick={onCancel}>cancel link</button>
    </div>
  )
}))

const baseAuthState = {
  status: 'unauthenticated',
  email: null,
  deviceId: null,
  error: null,
  needsRecoverySetup: false,
  wizardStep: 'sign-in',
  wizardLinkingSessionId: null,
  wizardVerificationCode: null,
  wizardExpiresAt: null,
  wizardOAuthState: null,
  wizardError: null
}

const clipboardWrite = vi.fn()

function stubClipboard() {
  clipboardWrite.mockReset()
  clipboardWrite.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: clipboardWrite
    }
  })
}

function mockAuth(
  state: Partial<typeof baseAuthState> = {},
  methods: Record<string, unknown> = {}
) {
  const auth = {
    state: { ...baseAuthState, ...state },
    requestOtp: vi.fn().mockResolvedValue({ expiresIn: 45 }),
    verifyOtp: vi.fn().mockResolvedValue({
      deviceId: 'device-1',
      needsRecoverySetup: false,
      needsRecoveryInput: false
    }),
    resendOtp: vi.fn().mockResolvedValue({ expiresIn: 30 }),
    initOAuth: vi.fn().mockResolvedValue({ state: 'oauth-state' }),
    confirmRecoveryPhrase: vi.fn().mockResolvedValue(undefined),
    linkViaRecovery: vi.fn().mockResolvedValue({ deviceId: 'device-1' }),
    linkingCompleted: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
    resetAuthState: vi.fn(),
    setWizardStep: vi.fn(),
    setWizardError: vi.fn(),
    clearWizardError: vi.fn(),
    resetWizard: vi.fn(),
    ...methods
  }
  authMock.useAuth.mockReturnValue(auth)
  return auth
}

describe('SetupWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    stubClipboard()
    ;(window as Window & { api: unknown }).api = {
      syncSetup: {
        getRecoveryPhrase: vi.fn().mockResolvedValue('alpha beta gamma')
      }
    }
  })

  it('requests email OTP and starts Google OAuth from sign-in', async () => {
    const user = userEvent.setup()
    const auth = mockAuth()

    render(<SetupWizard />)

    await user.click(screen.getByRole('button', { name: 'submit email' }))
    await waitFor(() =>
      expect(auth.setWizardStep).toHaveBeenCalledWith('otp-verification', {
        expiresAt: expect.any(Number)
      })
    )
    expect(auth.requestOtp).toHaveBeenCalledWith('kaan@example.com')
    expect(auth.clearWizardError).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'google oauth' }))
    await waitFor(() =>
      expect(auth.setWizardStep).toHaveBeenCalledWith('sign-in', { oauthState: 'oauth-state' })
    )
    expect(auth.initOAuth).toHaveBeenCalledWith()
  })

  it('handles OTP verify, resend, and back paths', async () => {
    const user = userEvent.setup()
    const auth = mockAuth(
      {
        wizardStep: 'otp-verification',
        email: 'kaan@example.com',
        wizardExpiresAt: Date.now() + 12_000
      },
      {
        verifyOtp: vi.fn().mockResolvedValue({ needsRecoveryInput: true })
      }
    )

    render(<SetupWizard />)

    expect(screen.getByText(/otp for kaan@example.com:/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'verify otp' }))
    await waitFor(() => expect(auth.setWizardStep).toHaveBeenCalledWith('linking-choice'))

    await user.click(screen.getByRole('button', { name: 'resend otp' }))
    await waitFor(() =>
      expect(auth.setWizardStep).toHaveBeenCalledWith('otp-verification', {
        expiresAt: expect.any(Number)
      })
    )

    await user.click(screen.getByRole('button', { name: 'back to sign in' }))
    expect(auth.setWizardStep).toHaveBeenCalledWith('sign-in')
  })

  it('fetches, advances, and confirms recovery phrases', async () => {
    const user = userEvent.setup()
    stubClipboard()
    const auth = mockAuth({ wizardStep: 'recovery-display' })

    const { rerender } = render(<SetupWizard />)

    expect(await screen.findByText('display:alpha beta gamma')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'continue recovery' }))
    expect(auth.setWizardStep).toHaveBeenCalledWith('recovery-confirm')

    authMock.useAuth.mockReturnValue({
      ...auth,
      state: { ...auth.state, wizardStep: 'recovery-confirm' }
    })
    rerender(<SetupWizard />)

    expect(await screen.findByText('confirm:alpha beta gamma')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'confirm recovery' }))
    await waitFor(() => expect(auth.confirmRecoveryPhrase).toHaveBeenCalled())
    expect(clipboardWrite).toHaveBeenCalledWith('')

    await user.click(screen.getByRole('button', { name: 'back to phrase' }))
    expect(auth.setWizardStep).toHaveBeenCalledWith('recovery-display')
  })

  it('refetches the pending recovery phrase after the wizard remounts', async () => {
    mockAuth({ wizardStep: 'recovery-display' })
    const getRecoveryPhrase = vi.fn().mockResolvedValue('alpha beta gamma')
    ;(window as Window & { api: unknown }).api = {
      syncSetup: { getRecoveryPhrase }
    }

    const { unmount } = render(<SetupWizard />)
    expect(await screen.findByText('display:alpha beta gamma')).toBeInTheDocument()

    unmount()
    render(<SetupWizard />)

    expect(await screen.findByText('display:alpha beta gamma')).toBeInTheDocument()
    expect(getRecoveryPhrase).toHaveBeenCalledTimes(2)
  })

  it('shows a recoverable error when the pending recovery phrase is gone', async () => {
    const user = userEvent.setup()
    const auth = mockAuth({ wizardStep: 'recovery-display' })
    ;(window as Window & { api: unknown }).api = {
      syncSetup: { getRecoveryPhrase: vi.fn().mockResolvedValue(null) }
    }

    render(<SetupWizard />)

    expect(await screen.findByText('setup.recovery.unavailable.title')).toBeInTheDocument()
    expect(screen.queryByText(/^display:/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'setup.recovery.unavailable.startOver' }))
    expect(auth.logout).toHaveBeenCalled()
  })

  it('shows a recoverable error when fetching the recovery phrase fails', async () => {
    mockAuth({ wizardStep: 'recovery-confirm' })
    ;(window as Window & { api: unknown }).api = {
      syncSetup: { getRecoveryPhrase: vi.fn().mockRejectedValue(new Error('ipc down')) }
    }

    render(<SetupWizard />)

    expect(await screen.findByText('setup.recovery.unavailable.title')).toBeInTheDocument()
    expect(screen.queryByText(/^confirm:/)).not.toBeInTheDocument()
  })

  it('routes linking choice, scan, pending, and recovery input callbacks', async () => {
    const user = userEvent.setup()
    const auth = mockAuth({ wizardStep: 'linking-choice' })
    const { rerender } = render(<SetupWizard />)

    await user.click(screen.getByRole('button', { name: /setup.linking.qrChoice/ }))
    await user.click(screen.getByRole('button', { name: /setup.linking.recoveryChoice/ }))
    expect(auth.setWizardStep).toHaveBeenCalledWith('linking-scan')
    expect(auth.setWizardStep).toHaveBeenCalledWith('recovery-input')

    authMock.useAuth.mockReturnValue({
      ...auth,
      state: { ...auth.state, wizardStep: 'linking-scan' }
    })
    rerender(<SetupWizard />)
    await user.click(screen.getByRole('button', { name: 'linked code' }))
    expect(auth.setWizardStep).toHaveBeenCalledWith('linking-pending', {
      linkingSessionId: 'session-1',
      verificationCode: '654321'
    })
    await user.click(screen.getByRole('button', { name: 'link error' }))
    await user.click(screen.getByRole('button', { name: 'back from scan' }))
    expect(auth.setWizardError).toHaveBeenCalledWith('bad qr')
    expect(auth.setWizardStep).toHaveBeenCalledWith('linking-choice')

    authMock.useAuth.mockReturnValue({
      ...auth,
      state: {
        ...auth.state,
        wizardStep: 'linking-pending',
        wizardLinkingSessionId: 'session-1',
        wizardVerificationCode: '654321'
      }
    })
    rerender(<SetupWizard />)
    expect(screen.getByText('pending:session-1:654321')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'complete link' }))
    await user.click(screen.getByRole('button', { name: 'pending error' }))
    await user.click(screen.getByRole('button', { name: 'cancel link' }))
    expect(auth.linkingCompleted).toHaveBeenCalled()
    expect(auth.setWizardError).toHaveBeenCalledWith('link failed')
    expect(auth.setWizardStep).toHaveBeenCalledWith('linking-choice')

    authMock.useAuth.mockReturnValue({
      ...auth,
      state: { ...auth.state, wizardStep: 'recovery-input' }
    })
    rerender(<SetupWizard />)
    await user.click(screen.getByRole('button', { name: 'submit recovery phrase' }))
    await waitFor(() => expect(auth.linkViaRecovery).toHaveBeenCalledWith('word one two'))
    await user.click(screen.getByRole('button', { name: 'back to link choice' }))
    expect(auth.setWizardStep).toHaveBeenCalledWith('linking-choice')
  })

  it('offers a start-fresh escape from the recovery step that only signs out after confirmation', async () => {
    // #given
    const user = userEvent.setup()
    const auth = mockAuth({ wizardStep: 'recovery-input' })
    render(<SetupWizard />)

    // #when — the escape is one subdued link away, never a default action
    await user.click(screen.getByRole('button', { name: 'setup.startFresh.trigger' }))

    // #then — consequences first, nothing destroyed yet
    expect(screen.getByText('setup.startFresh.consequenceKey')).toBeInTheDocument()
    expect(auth.logout).not.toHaveBeenCalled()

    // #when — backing out leaves the session alone
    await user.click(screen.getByRole('button', { name: 'setup.startFresh.cancel' }))
    expect(auth.logout).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'submit recovery phrase' })).toBeInTheDocument()

    // #when / #then — only the explicit confirm signs out
    await user.click(screen.getByRole('button', { name: 'setup.startFresh.trigger' }))
    await user.click(screen.getByRole('button', { name: 'setup.startFresh.confirm' }))
    expect(auth.logout).toHaveBeenCalledTimes(1)
  })
})
