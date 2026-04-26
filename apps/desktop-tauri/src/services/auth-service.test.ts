import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { authService } from './auth-service'

// The setup-dom mock for `@/lib/ipc/invoke` resolves the snake-case
// command name to `window.api.<domain>.<method>(args)` and passes the
// args object through untouched. Tauri commands declared with a single
// `input: T` parameter are addressed as `invoke(NAME, { input: T })`,
// so the wrapper survives the mock-router round trip and the test
// asserts on it directly.

describe('auth-service', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards requestOtp to window.api.syncAuth wrapped in { input }', async () => {
    // #given
    const response = { success: true, expiresIn: 300 }
    api.syncAuth.requestOtp = vi.fn().mockResolvedValue(response)

    // #when
    const result = await authService.requestOtp({ email: 'test@example.com' })

    // #then
    expect(api.syncAuth.requestOtp).toHaveBeenCalledWith({
      input: { email: 'test@example.com' }
    })
    expect(result).toEqual(response)
  })

  it('forwards verifyOtp to window.api.syncAuth wrapped in { input }', async () => {
    // #given
    const response = { success: true, needsSetup: false }
    api.syncAuth.verifyOtp = vi.fn().mockResolvedValue(response)

    // #when
    const result = await authService.verifyOtp({ email: 'test@example.com', code: '123456' })

    // #then
    expect(api.syncAuth.verifyOtp).toHaveBeenCalledWith({
      input: { email: 'test@example.com', code: '123456' }
    })
    expect(result).toEqual(response)
  })

  it('forwards resendOtp to window.api.syncAuth wrapped in { input }', async () => {
    // #given
    const response = { success: true, expiresIn: 300 }
    api.syncAuth.resendOtp = vi.fn().mockResolvedValue(response)

    // #when
    const result = await authService.resendOtp({ email: 'test@example.com' })

    // #then
    expect(api.syncAuth.resendOtp).toHaveBeenCalledWith({
      input: { email: 'test@example.com' }
    })
    expect(result).toEqual(response)
  })

  it('forwards setupNewAccount to window.api.syncSetup wrapped in { input }', async () => {
    // #given
    const response = { success: true, deviceId: 'dev-1' }
    api.syncSetup.setupNewAccount = vi.fn().mockResolvedValue(response)

    // #when
    const result = await authService.setupNewAccount({
      email: 'test@example.com',
      password: 'correct horse battery staple',
      rememberDevice: true,
      deviceName: 'Kaan MacBook',
      platform: 'macos',
      osVersion: null,
      appVersion: '0.1.0'
    })

    // #then
    expect(api.syncSetup.setupNewAccount).toHaveBeenCalledWith({
      input: {
        email: 'test@example.com',
        password: 'correct horse battery staple',
        rememberDevice: true,
        deviceName: 'Kaan MacBook',
        platform: 'macos',
        osVersion: null,
        appVersion: '0.1.0'
      }
    })
    expect(result).toEqual(response)
  })
})
