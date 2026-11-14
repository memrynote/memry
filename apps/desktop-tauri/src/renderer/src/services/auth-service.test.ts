import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LINK_FAILURE_SETUP_SESSION_EXPIRED } from '@memry/contracts/ipc-devices'

const mocks = vi.hoisted(() => ({
  commands: {
    authRequestOtp: vi.fn(),
    authResendOtp: vi.fn(),
    authVerifyOtp: vi.fn(),
    syncSetupNewAccount: vi.fn(),
    syncConfirmRecoveryPhrase: vi.fn(),
    syncLinkViaRecovery: vi.fn()
  }
}))

vi.mock('../../../generated/bindings', () => ({ commands: mocks.commands }))

import { SETUP_CONFLICT, authService } from './auth-service'

/** A rejected Tauri command: the serialized `CommandError`. */
const rejected = (code: string, message: string) => ({ kind: 'auth', code, message })

describe('auth-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers the email code calls in the envelopes the auth context reads', async () => {
    mocks.commands.authRequestOtp.mockResolvedValue({ expiresIn: 600 })
    mocks.commands.authResendOtp.mockResolvedValue({ expiresIn: null })
    mocks.commands.authVerifyOtp.mockResolvedValue({
      isNewUser: false,
      needsSetup: false,
      needsRecoveryInput: true,
      deviceId: null
    })

    await expect(authService.requestOtp({ email: 'me@example.com' })).resolves.toEqual({
      success: true,
      expiresIn: 600
    })
    await expect(authService.resendOtp({ email: 'me@example.com' })).resolves.toEqual({
      success: true,
      expiresIn: undefined
    })
    await expect(
      authService.verifyOtp({ email: 'me@example.com', code: '123456' })
    ).resolves.toEqual({
      success: true,
      isNewUser: false,
      needsSetup: false,
      needsRecoveryInput: true,
      deviceId: undefined
    })
    expect(mocks.commands.authRequestOtp).toHaveBeenCalledWith('me@example.com')
    expect(mocks.commands.authVerifyOtp).toHaveBeenCalledWith('123456')
  })

  it('turns a rejected command into a failure, with the code a dead setup token carries', async () => {
    mocks.commands.syncLinkViaRecovery.mockRejectedValueOnce(
      rejected('setup_session_expired', 'Sign in again.')
    )
    await expect(authService.linkViaRecovery({ recoveryPhrase: 'words' })).resolves.toEqual({
      success: false,
      error: 'Sign in again.',
      errorCode: LINK_FAILURE_SETUP_SESSION_EXPIRED
    })

    mocks.commands.syncLinkViaRecovery.mockRejectedValueOnce(
      rejected('recovery_phrase_mismatch', 'Not this account.')
    )
    await expect(authService.linkViaRecovery({ recoveryPhrase: 'words' })).resolves.toEqual({
      success: false,
      error: 'Not this account.'
    })

    // Only the phrase link reads a dead setup token as `setup-session-expired`.
    mocks.commands.syncSetupNewAccount.mockRejectedValueOnce(
      rejected('setup_session_expired', 'Sign in again.')
    )
    await expect(authService.setupNewAccount()).resolves.toEqual({
      success: false,
      error: 'Sign in again.'
    })
    mocks.commands.syncSetupNewAccount.mockRejectedValueOnce(
      rejected('account_setup_conflict', 'Another device set up this account first.')
    )
    await expect(authService.setupNewAccount()).resolves.toEqual({
      success: false,
      error: 'Another device set up this account first.',
      errorCode: SETUP_CONFLICT
    })

    mocks.commands.syncSetupNewAccount.mockResolvedValueOnce({ deviceId: 'device-1' })
    await expect(authService.setupNewAccount()).resolves.toEqual({
      success: true,
      deviceId: 'device-1'
    })
    mocks.commands.syncConfirmRecoveryPhrase.mockResolvedValueOnce(null)
    await expect(authService.confirmRecoveryPhrase({ confirmed: true })).resolves.toEqual({
      success: true
    })
    expect(mocks.commands.syncConfirmRecoveryPhrase).toHaveBeenCalledWith(true)
  })
})
