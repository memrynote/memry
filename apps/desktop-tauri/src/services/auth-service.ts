import { invoke } from '@/lib/ipc/invoke'

export interface RequestOtpResult {
  success: boolean
  error?: string
  expiresIn?: number
}

export interface VerifyOtpResult {
  success: boolean
  error?: string
  isNewUser?: boolean
  needsRecoverySetup?: boolean
  needsSetup?: boolean
  deviceId?: string
  email?: string
}

export interface RefreshTokenResult {
  success: boolean
  error?: string
}

export interface InitOAuthResult {
  state: string
}

export interface SetupFirstDeviceResult {
  success: boolean
  error?: string
  deviceId?: string
  email?: string
  recoveryPhrase?: string[]
  needsRecoverySetup?: boolean
  needsRecoveryInput?: boolean
}

export interface ConfirmRecoveryPhraseResult {
  success: boolean
  error?: string
}

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

  initOAuth: (input: { provider: 'google' }): Promise<InitOAuthResult> => {
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

  logout: (): Promise<{ success: boolean; error?: string }> => {
    return invoke<{ success: boolean; error?: string }>('sync_auth_logout')
  }
}
