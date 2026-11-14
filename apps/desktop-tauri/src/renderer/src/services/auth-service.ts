import { LINK_FAILURE_SETUP_SESSION_EXPIRED } from '@memry/contracts/ipc-devices'

import { commands, type AuthOtpSent } from '../../../generated/bindings'
import { commandErrorCode, extractErrorMessage } from '@/lib/ipc-error'

/**
 * The Rust account commands, answered in Electron's `{ success, error, errorCode }` envelopes
 * (`apps/desktop/src/main/ipc/auth-device-handlers.ts`), which the auth context branches on.
 */
type Failure = {
  success: false
  error: string
  errorCode?: typeof LINK_FAILURE_SETUP_SESSION_EXPIRED
}

function failure(error: unknown): Failure {
  const result: Failure = { success: false, error: extractErrorMessage(error, '') }
  if (commandErrorCode(error) === 'setup_session_expired') {
    result.errorCode = LINK_FAILURE_SETUP_SESSION_EXPIRED
  }
  return result
}

async function envelope<T extends object>(
  run: () => Promise<T>
): Promise<({ success: true } & T) | Failure> {
  try {
    return { success: true, ...(await run()) }
  } catch (error) {
    return failure(error)
  }
}

const sent = ({ expiresIn }: AuthOtpSent) => ({ expiresIn: expiresIn ?? undefined })

export const authService = {
  requestOtp: (input: { email: string }) =>
    envelope(async () => sent(await commands.authRequestOtp(input.email))),

  verifyOtp: (input: { email: string; code: string }) =>
    envelope(async () => {
      const verified = await commands.authVerifyOtp(input.email, input.code)
      return { ...verified, deviceId: verified.deviceId ?? undefined }
    }),

  // The code goes to the address of the pending request, as in Electron.
  resendOtp: (_input: { email: string }) =>
    envelope(async () => sent(await commands.authResendOtp())),

  initOAuth: (input: { provider: 'google' }) => {
    return window.api.syncAuth.initOAuth(input)
  },

  refreshToken: () => commands.authRefreshToken(),

  setupFirstDevice: (input: { provider: 'google'; oauthToken: string; state: string }) => {
    return window.api.syncSetup.setupFirstDevice(input)
  },

  setupNewAccount: () => envelope(() => commands.syncSetupNewAccount()),

  confirmRecoveryPhrase: (input: { confirmed: boolean }) =>
    envelope(async () => {
      await commands.syncConfirmRecoveryPhrase(input.confirmed)
      return {}
    }),

  /** The phrase of the setup that just ran, until it is confirmed; `null` after a restart. */
  getRecoveryPhrase: () => commands.syncGetRecoveryPhrase(),

  linkViaRecovery: (input: { recoveryPhrase: string }) =>
    envelope(() => commands.syncLinkViaRecovery(input.recoveryPhrase)),

  /** The account at launch, from this device alone: offline or waiting still reads as signed in. */
  getAccountInfo: () => commands.accountGetInfo(),

  logout: () => {
    return window.api.syncAuth.logout()
  }
}
