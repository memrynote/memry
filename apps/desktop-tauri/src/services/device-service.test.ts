import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { deviceService, setupService } from './device-service'

describe('device-service', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards getDevices to window.api.syncDevices and adapts null email to ""', async () => {
    // #given
    const response = {
      devices: [
        {
          id: 'dev-1',
          name: 'MacBook',
          platform: 'macos',
          isCurrentDevice: true,
          linkedAt: Date.now()
        }
      ],
      email: null
    }
    api.syncDevices.getDevices = vi.fn().mockResolvedValue(response)

    // #when
    const result = await deviceService.getDevices()

    // #then
    expect(api.syncDevices.getDevices).toHaveBeenCalled()
    expect(result).toEqual({ devices: response.devices, email: '' })
  })

  it('forwards removeDevice to window.api.syncDevices wrapped in { input }', async () => {
    // #given
    api.syncDevices.removeDevice = vi.fn().mockResolvedValue({ success: true })

    // #when
    const result = await deviceService.removeDevice({ deviceId: 'dev-1' })

    // #then
    expect(api.syncDevices.removeDevice).toHaveBeenCalledWith({
      input: { deviceId: 'dev-1' }
    })
    expect(result).toEqual({ success: true })
  })

  it('forwards renameDevice to window.api.syncDevices wrapped in { input }', async () => {
    // #given
    api.syncDevices.renameDevice = vi.fn().mockResolvedValue({ success: true })

    // #when
    const result = await deviceService.renameDevice({ deviceId: 'dev-1', newName: 'My Laptop' })

    // #then
    expect(api.syncDevices.renameDevice).toHaveBeenCalledWith({
      input: { deviceId: 'dev-1', newName: 'My Laptop' }
    })
    expect(result).toEqual({ success: true })
  })
})

describe('setup-service', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards setupFirstDevice to window.api.syncSetup wrapped in { input }', async () => {
    // #given
    const response = {
      success: true,
      recoveryPhrase: ['word1', 'word2', 'word3'],
      deviceId: 'dev-1'
    }
    api.syncSetup.setupFirstDevice = vi.fn().mockResolvedValue(response)

    // #when
    const result = await setupService.setupFirstDevice({
      provider: 'google',
      oauthToken: 'oauth-token-123',
      state: 'oauth-state-123'
    })

    // #then
    expect(api.syncSetup.setupFirstDevice).toHaveBeenCalledWith({
      input: {
        provider: 'google',
        oauthToken: 'oauth-token-123',
        state: 'oauth-state-123'
      }
    })
    expect(result).toEqual(response)
  })

  it('forwards setupNewAccount to window.api.syncSetup wrapped in { input }', async () => {
    // #given
    const response = {
      success: true,
      recoveryPhrase: ['word1', 'word2', 'word3'],
      deviceId: 'dev-1'
    }
    api.syncSetup.setupNewAccount = vi.fn().mockResolvedValue(response)

    // #when
    const result = await setupService.setupNewAccount({
      email: 'test@example.com',
      password: 'correct horse battery staple',
      rememberDevice: true,
      deviceName: 'Kaan MacBook',
      platform: 'macos',
      osVersion: '14.6',
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
        osVersion: '14.6',
        appVersion: '0.1.0'
      }
    })
    expect(result).toEqual(response)
  })

  it('forwards confirmRecoveryPhrase to window.api.syncSetup wrapped in { input }', async () => {
    // #given
    api.syncSetup.confirmRecoveryPhrase = vi.fn().mockResolvedValue({ success: true })

    // #when
    const result = await setupService.confirmRecoveryPhrase({ confirmed: true })

    // #then
    expect(api.syncSetup.confirmRecoveryPhrase).toHaveBeenCalledWith({
      input: { confirmed: true }
    })
    expect(result).toEqual({ success: true })
  })
})
