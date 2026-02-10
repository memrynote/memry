export const authService = {
  requestOtp: (input: { email: string }) => {
    return window.api.syncAuth.requestOtp(input)
  },

  verifyOtp: (input: { email: string; code: string }) => {
    return window.api.syncAuth.verifyOtp(input)
  },

  resendOtp: (input: { email: string }) => {
    return window.api.syncAuth.resendOtp(input)
  }
}
