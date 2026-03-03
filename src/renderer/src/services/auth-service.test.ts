import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { authService } from './auth-service'

describe('auth-service', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards requestOtp to window.api.syncAuth', async () => {
    // #given
    const response = { success: true, expiresIn: 300 }
    api.syncAuth.requestOtp = vi.fn().mockResolvedValue(response)

    // #when
    const result = await authService.requestOtp({ email: 'test@example.com' })

    // #then
    expect(api.syncAuth.requestOtp).toHaveBeenCalledWith({ email: 'test@example.com' })
    expect(result).toEqual(response)
  })

  it('forwards verifyOtp to window.api.syncAuth', async () => {
    // #given
    const response = { success: true, isNewUser: true, needsRecoverySetup: true }
    api.syncAuth.verifyOtp = vi.fn().mockResolvedValue(response)

    // #when
    const result = await authService.verifyOtp({ email: 'test@example.com', code: '123456' })

    // #then
    expect(api.syncAuth.verifyOtp).toHaveBeenCalledWith({
      email: 'test@example.com',
      code: '123456'
    })
    expect(result).toEqual(response)
  })

  it('forwards resendOtp to window.api.syncAuth', async () => {
    // #given
    const response = { success: true, expiresIn: 300 }
    api.syncAuth.resendOtp = vi.fn().mockResolvedValue(response)

    // #when
    const result = await authService.resendOtp({ email: 'test@example.com' })

    // #then
    expect(api.syncAuth.resendOtp).toHaveBeenCalledWith({ email: 'test@example.com' })
    expect(result).toEqual(response)
  })
})
