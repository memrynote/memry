import type { MockRouteMap } from './types'

const OTP_CODE_PATTERN = /^\d{6}$/

const mockAuthStatus = {
  state: 'unlocked' as const,
  deviceId: 'mock-device-1',
  email: 'kaan@mock.memry',
  hasBiometric: false,
  rememberDevice: true
}

export const authRoutes: MockRouteMap = {
  auth_status: async () => mockAuthStatus,
  auth_unlock: async () => mockAuthStatus,
  auth_lock: async () => null,
  auth_request_otp: async () => ({ success: true, expiresIn: 300 }),
  auth_submit_otp: async (args) => {
    const { code } = args as { code: string }
    if (!OTP_CODE_PATTERN.test(code)) {
      throw new Error('Invalid OTP code — expected six digits')
    }
    return { success: true, needsSetup: false }
  },
  auth_register_device: async () => ({
    deviceId: 'mock-device-1',
    signingPublicKey: 'mock-pubkey-ed25519'
  }),
  auth_enable_biometric: async () => ({
    ok: false,
    reason: 'not-implemented-post-v1'
  })
}
