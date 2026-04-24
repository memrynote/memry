import type { MockRouteMap } from './types'

const OTP_CODE_PATTERN = /^\d{6}$/

export const authRoutes: MockRouteMap = {
  auth_status: async () => ({
    state: 'unlocked',
    deviceId: 'mock-device-1',
    email: 'kaan@mock.memry',
    hasBiometric: false
  }),
  auth_unlock: async () => ({ ok: true }),
  auth_lock: async () => ({ ok: true }),
  auth_request_otp: async (args) => {
    const { email } = (args as { email?: string }) ?? {}
    return { ok: true, expiresInSeconds: 300, email: email ?? 'kaan@mock.memry' }
  },
  auth_submit_otp: async (args) => {
    const { code } = args as { code: string }
    if (!OTP_CODE_PATTERN.test(code)) {
      throw new Error('Invalid OTP code — expected six digits')
    }
    return { ok: true }
  },
  auth_register_device: async () => ({
    deviceId: 'mock-device-1',
    publicKey: 'mock-pubkey-ed25519',
    createdAt: Date.now()
  }),
  auth_list_devices: async () => [
    { id: 'mock-device-1', name: 'This device', platform: 'macos', active: true },
    { id: 'mock-device-2', name: 'iPhone', platform: 'ios', active: false }
  ],
  auth_revoke_device: async (args) => {
    const { deviceId } = args as { deviceId: string }
    return { ok: true, deviceId }
  },
  auth_enable_biometric: async () => ({
    ok: false,
    reason: 'not-implemented-in-m1'
  }),
  auth_sign_out: async () => ({ ok: true })
}
