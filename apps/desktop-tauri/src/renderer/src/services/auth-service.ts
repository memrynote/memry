import { LINK_FAILURE_SETUP_SESSION_EXPIRED } from '@memry/contracts/ipc-devices'

import type { SetupFirstDeviceResult } from '@memry/contracts/ipc-auth'

import { commands, type AuthOtpSent } from '../../../generated/bindings'
import { commandErrorCode, extractErrorMessage } from '@/lib/ipc-error'

/**
 * The Rust account commands, answered in Electron's `{ success, error, errorCode }` envelopes
 * (`apps/desktop/src/main/ipc/auth-device-handlers.ts`), which the auth context branches on.
 */
type Failure = {
  success: false
  error: string
  errorCode?: typeof LINK_FAILURE_SETUP_SESSION_EXPIRED | typeof SETUP_CONFLICT
}

/** `setupNewAccount`: another device set the account up first, so its phrase links this one. */
export const SETUP_CONFLICT = 'account-setup-conflict'

/** The command error codes a call answers with an `errorCode`, and nothing else. */
type ErrorCodes = Partial<Record<string, NonNullable<Failure['errorCode']>>>

function failure(error: unknown, errorCodes: ErrorCodes): Failure {
  const result: Failure = { success: false, error: extractErrorMessage(error, '') }
  const errorCode = errorCodes[commandErrorCode(error) ?? '']
  if (errorCode) result.errorCode = errorCode
  return result
}

async function envelope<T extends object>(
  run: () => Promise<T>,
  errorCodes: ErrorCodes = {}
): Promise<({ success: true } & T) | Failure> {
  try {
    return { success: true, ...(await run()) }
  } catch (error) {
    return failure(error, errorCodes)
  }
}

const sent = ({ expiresIn }: AuthOtpSent) => ({ expiresIn: expiresIn ?? undefined })

export const authService = {
  requestOtp: (input: { email: string }) =>
    envelope(async () => sent(await commands.authRequestOtp(input.email))),

  // The address is the pending request's, which the session holds, as for a resend.
  verifyOtp: (input: { email: string; code: string }) =>
    envelope(async () => {
      const verified = await commands.authVerifyOtp(input.code)
      return { ...verified, deviceId: verified.deviceId ?? undefined }
    }),

  // The code goes to the address of the pending request, as in Electron.
  resendOtp: (_input: { email: string }) =>
    envelope(async () => sent(await commands.authResendOtp())),

  // Google is the one provider; the command knows it.
  initOAuth: (_input: { provider: 'google' }) => envelope(() => commands.authInitOauth()),

  retryOAuth: (input: { state: string }) => envelope(() => commands.authRetryOauth(input.state)),

  refreshToken: () => commands.authRefreshToken(),

  setupFirstDevice: (input: {
    provider: 'google'
    oauthToken: string
    state: string
  }): Promise<SetupFirstDeviceResult> =>
    envelope(async () => {
      const first = await commands.syncSetupFirstDevice(
        input.provider,
        input.oauthToken,
        input.state
      )
      return { ...first, deviceId: first.deviceId ?? undefined }
    }),

  setupNewAccount: () =>
    envelope(() => commands.syncSetupNewAccount(), { account_setup_conflict: SETUP_CONFLICT }),

  confirmRecoveryPhrase: (input: { confirmed: boolean }) =>
    envelope(async () => {
      await commands.syncConfirmRecoveryPhrase(input.confirmed)
      return {}
    }),

  /** The phrase of the setup that just ran, until it is confirmed; `null` after a restart. */
  getRecoveryPhrase: () => commands.syncGetRecoveryPhrase(),

  linkViaRecovery: (input: { recoveryPhrase: string }) =>
    envelope(() => commands.syncLinkViaRecovery(input.recoveryPhrase), {
      setup_session_expired: LINK_FAILURE_SETUP_SESSION_EXPIRED
    }),

  /** The account at launch, from this device alone: offline or waiting still reads as signed in. */
  getAccountInfo: () => commands.accountGetInfo(),

  logout: () => {
    return window.api.syncAuth.logout()
  }
}
