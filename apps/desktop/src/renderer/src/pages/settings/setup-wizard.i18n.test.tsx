import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { SetupWizard } from './setup-wizard'

const authMock = vi.hoisted(() => ({
  useAuth: vi.fn()
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: authMock.useAuth
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

function mockAuthState(overrides: Partial<typeof baseAuthState> = {}) {
  authMock.useAuth.mockReturnValue({
    state: { ...baseAuthState, ...overrides },
    requestOtp: vi.fn().mockResolvedValue({ expiresIn: 60 }),
    verifyOtp: vi.fn().mockResolvedValue({
      deviceId: 'device-1',
      needsRecoverySetup: false,
      needsRecoveryInput: false
    }),
    resendOtp: vi.fn().mockResolvedValue({ expiresIn: 60 }),
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
    resetWizard: vi.fn()
  })
}

function renderWizard(i18n: I18nInstance) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SetupWizard />
    </I18nextProvider>
  )
}

describe('SetupWizard i18n', () => {
  let i18n: I18nInstance

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockAuthState()
  })

  it('renders sign-in setup copy from the settings namespace', () => {
    renderWizard(i18n)

    expect(screen.getByRole('group', { name: 'Step 1 of 3: Sign In' })).toBeInTheDocument()
    expect(screen.getByText('Set up Sync')).toBeInTheDocument()
    expect(screen.getByText('Email address')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument()
  })

  it('renders linking choice copy from the settings namespace', () => {
    mockAuthState({ wizardStep: 'linking-choice' })

    renderWizard(i18n)

    expect(screen.getByRole('group', { name: 'Step 3 of 3: Link' })).toBeInTheDocument()
    expect(screen.getByText('Link this device')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Link via QR code/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Recovery phrase/ })).toBeInTheDocument()
  })
})
