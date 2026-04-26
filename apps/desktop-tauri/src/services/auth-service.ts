import { invoke } from '@/lib/ipc/invoke'
import type {
  InitOAuthView,
  LogoutView,
  OtpRequestView,
  OtpVerifyView,
  RefreshTokenView,
  SetupResultView,
  SimpleSuccess
} from '@/generated/bindings'

export type RequestOtpResult = OtpRequestView & { error?: string }

export type VerifyOtpResult = OtpVerifyView & { error?: string }

export type RefreshTokenResult = RefreshTokenView

export type InitOAuthResult = InitOAuthView

export type SetupFirstDeviceResult = SetupResultView & {
  needsRecoveryInput?: boolean
}

export type ConfirmRecoveryPhraseResult = SimpleSuccess

export type LogoutResult = LogoutView

export const authService = {
  requestOtp: (input: { email: string }): Promise<RequestOtpResult> => {
    return invoke<RequestOtpResult>('sync_auth_request_otp', input)
  },

  verifyOtp: (input: { email: string; code: string }): Promise<VerifyOtpResult> => {
    return invoke<VerifyOtpResult>('sync_auth_verify_otp', input)
  },

  resendOtp: (input: { email: string }): Promise<RequestOtpResult> => {
    return invoke<RequestOtpResult>('sync_auth_resend_otp', input)
  },

  initOAuth: (input: { provider: 'google'; redirectUri?: string }): Promise<InitOAuthResult> => {
    return invoke<InitOAuthResult>('sync_auth_init_o_auth', input)
  },

  refreshToken: (): Promise<RefreshTokenResult> => {
    return invoke<RefreshTokenResult>('sync_auth_refresh_token')
  },

  setupFirstDevice: (input: {
    provider: 'google'
    oauthToken: string
    state: string
  }): Promise<SetupFirstDeviceResult> => {
    return invoke<SetupFirstDeviceResult>('sync_setup_setup_first_device', input)
  },

  setupNewAccount: (): Promise<SetupFirstDeviceResult> => {
    return invoke<SetupFirstDeviceResult>('sync_setup_setup_new_account')
  },

  confirmRecoveryPhrase: (input: { confirmed: boolean }): Promise<ConfirmRecoveryPhraseResult> => {
    return invoke<ConfirmRecoveryPhraseResult>('sync_setup_confirm_recovery_phrase', input)
  },

  logout: (): Promise<LogoutResult> => {
    return invoke<LogoutResult>('sync_auth_logout')
  }
}
