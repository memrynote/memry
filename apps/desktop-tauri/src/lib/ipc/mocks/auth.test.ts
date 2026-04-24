import { describe, it, expect } from 'vitest'

import { authRoutes } from './auth'

describe('authRoutes', () => {
  it('auth_status reports an unlocked device', async () => {
    const status = (await authRoutes.auth_status!(undefined)) as {
      state: string
      deviceId: string
      email: string | null
    }
    expect(status.state).toBe('unlocked')
    expect(status.deviceId).toBeDefined()
  })

  it('auth_unlock returns ok', async () => {
    const res = (await authRoutes.auth_unlock!({ passphrase: 'secret' })) as { ok: boolean }
    expect(res.ok).toBe(true)
  })

  it('auth_lock returns ok', async () => {
    const res = (await authRoutes.auth_lock!(undefined)) as { ok: boolean }
    expect(res.ok).toBe(true)
  })

  it('auth_request_otp returns ok + expiry seconds', async () => {
    const res = (await authRoutes.auth_request_otp!({ email: 'a@b.com' })) as {
      ok: boolean
      expiresInSeconds: number
    }
    expect(res.ok).toBe(true)
    expect(res.expiresInSeconds).toBeGreaterThan(0)
  })

  it('auth_submit_otp returns ok for a six-digit code', async () => {
    const res = (await authRoutes.auth_submit_otp!({ code: '123456' })) as { ok: boolean }
    expect(res.ok).toBe(true)
  })

  it('auth_submit_otp rejects malformed codes', async () => {
    await expect(authRoutes.auth_submit_otp!({ code: 'abc' })).rejects.toThrow(/invalid/i)
  })

  it('auth_register_device returns a device id and public key', async () => {
    const res = (await authRoutes.auth_register_device!(undefined)) as {
      deviceId: string
      publicKey: string
    }
    expect(res.deviceId).toBeDefined()
    expect(res.publicKey).toBeDefined()
  })

  it('auth_enable_biometric returns not-implemented reason at M1', async () => {
    const res = (await authRoutes.auth_enable_biometric!(undefined)) as {
      ok: boolean
      reason: string
    }
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/m1/i)
  })
})
