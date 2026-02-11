export const authService = {
  requestOtp: (input: { email: string }) => {
    return window.api.syncAuth.requestOtp(input)
  },

  verifyOtp: (input: { email: string; code: string }) => {
    return window.api.syncAuth.verifyOtp(input)
  },

  resendOtp: (input: { email: string }) => {
    return window.api.syncAuth.resendOtp(input)
  },

  initOAuth: (input: { provider: 'google' }) => {
    return window.api.syncAuth.initOAuth(input)
  },

  refreshToken: () => {
    return window.api.syncAuth.refreshToken()
  },

  setupFirstDevice: (input: { provider: 'google'; oauthToken: string; state: string }) => {
    return window.api.syncSetup.setupFirstDevice(input)
  },

  setupNewAccount: () => {
    return window.api.syncSetup.setupNewAccount()
  },

  confirmRecoveryPhrase: (input: { confirmed: boolean }) => {
    return window.api.syncSetup.confirmRecoveryPhrase(input)
  },

  logout: () => {
    return window.api.syncAuth.logout()
  }
}
