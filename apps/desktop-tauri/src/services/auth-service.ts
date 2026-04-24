import { invoke } from '@/lib/ipc/invoke'

export const authService = {
  requestOtp: (input: { email: string }) => {
    return invoke('sync_auth_request_otp', input)
  },

  verifyOtp: (input: { email: string; code: string }) => {
    return invoke('sync_auth_verify_otp', input)
  },

  resendOtp: (input: { email: string }) => {
    return invoke('sync_auth_resend_otp', input)
  },

  initOAuth: (input: { provider: 'google' }) => {
    return invoke('sync_auth_init_o_auth', input)
  },

  refreshToken: () => {
    return invoke('sync_auth_refresh_token')
  },

  setupFirstDevice: (input: { provider: 'google'; oauthToken: string; state: string }) => {
    return invoke('sync_setup_setup_first_device', input)
  },

  setupNewAccount: () => {
    return invoke('sync_setup_setup_new_account')
  },

  confirmRecoveryPhrase: (input: { confirmed: boolean }) => {
    return invoke('sync_setup_confirm_recovery_phrase', input)
  },

  logout: () => {
    return invoke('sync_auth_logout')
  }
}
