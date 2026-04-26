import { describe, it, expect } from 'vitest'

import { authRoutes } from './auth'

describe('authRoutes', () => {
  it('auth_status reports an unlocked device', async () => {
    // #given
    // #when
    const status = (await authRoutes.auth_status!(undefined)) as {
      state: string
      deviceId: string | null
      email: string | null
      hasBiometric: boolean
    }
    // #then
    expect(status.state).toBe('unlocked')
    expect(status.deviceId).toBeDefined()
  })

  it('auth_unlock returns the unlocked status snapshot', async () => {
    // #when
    const res = (await authRoutes.auth_unlock!({
      password: 'secret',
      rememberDevice: true
    })) as { state: string; deviceId: string | null }
    // #then
    expect(res.state).toBe('unlocked')
    expect(res.deviceId).toBeDefined()
  })

  it('auth_lock returns null (void) on success', async () => {
    // #when
    const res = await authRoutes.auth_lock!(undefined)
    // #then
    expect(res).toBeNull()
  })

  it('auth_request_otp returns success + expiry seconds', async () => {
    // #when
    const res = (await authRoutes.auth_request_otp!({ email: 'a@b.com' })) as {
      success: boolean
      expiresIn: number
    }
    // #then
    expect(res.success).toBe(true)
    expect(res.expiresIn).toBeGreaterThan(0)
  })

  it('auth_submit_otp returns success + needsSetup for a six-digit code', async () => {
    // #when
    const res = (await authRoutes.auth_submit_otp!({
      email: 'a@b.com',
      code: '123456'
    })) as { success: boolean; needsSetup: boolean }
    // #then
    expect(res.success).toBe(true)
    expect(res.needsSetup).toBe(false)
  })

  it('auth_submit_otp rejects malformed codes', async () => {
    await expect(
      authRoutes.auth_submit_otp!({ email: 'a@b.com', code: 'abc' })
    ).rejects.toThrow(/invalid/i)
  })

  it('auth_register_device returns a device id and signing public key', async () => {
    // #when
    const res = (await authRoutes.auth_register_device!(undefined)) as {
      deviceId: string
      signingPublicKey: string
    }
    // #then
    expect(res.deviceId).toBeDefined()
    expect(res.signingPublicKey).toBeDefined()
  })

  it('auth_enable_biometric returns the post-v1 deferred reason', async () => {
    // #when
    const res = (await authRoutes.auth_enable_biometric!(undefined)) as {
      ok: boolean
      reason: string
    }
    // #then
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/post-v1/i)
  })
})
