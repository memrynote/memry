import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'

const mocks = vi.hoisted(() => ({
  commands: {
    syncGetDevices: vi.fn(),
    syncRemoveDevice: vi.fn(),
    syncRenameDevice: vi.fn()
  }
}))

vi.mock('../../../generated/bindings', () => ({ commands: mocks.commands }))

import { deviceService, setupService } from './device-service'

describe('device-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers the device list in the shape the device list reads', async () => {
    mocks.commands.syncGetDevices.mockResolvedValue({
      devices: [
        {
          id: 'dev-1',
          name: 'MacBook',
          platform: 'macos',
          formFactor: null,
          isCurrentDevice: true,
          lastSyncAt: null,
          linkedAt: 1_700_000_000_000
        },
        {
          id: 'dev-2',
          name: 'iPad',
          platform: 'ios',
          formFactor: 'tablet',
          isCurrentDevice: false,
          lastSyncAt: 1_700_000_100_000,
          linkedAt: 1_700_000_000_000
        }
      ],
      email: null,
      needsRecoveryConfirmation: false
    })

    const result = await deviceService.getDevices()

    expect(result.email).toBeUndefined()
    expect(result.devices[0].lastSyncAt).toBeUndefined()
    expect(result.devices[1]).toMatchObject({ formFactor: 'tablet', lastSyncAt: 1_700_000_100_000 })
  })

  it('answers a rename and a removal in envelopes, with the failure message', async () => {
    mocks.commands.syncRenameDevice.mockResolvedValue(null)
    mocks.commands.syncRemoveDevice.mockRejectedValue({
      kind: 'invalid',
      code: 'cannot_remove_current_device',
      message: 'You cannot remove the current device.'
    })

    await expect(
      deviceService.renameDevice({ deviceId: 'dev-1', newName: 'My Laptop' })
    ).resolves.toEqual({ success: true })
    await expect(deviceService.removeDevice({ deviceId: 'dev-1' })).resolves.toEqual({
      success: false,
      error: 'You cannot remove the current device.'
    })
    expect(mocks.commands.syncRenameDevice).toHaveBeenCalledWith('dev-1', 'My Laptop')
    expect(mocks.commands.syncRemoveDevice).toHaveBeenCalledWith('dev-1')
  })
})

describe('setup-service', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards setupFirstDevice to window.api.syncSetup', async () => {
    // #given
    const response = {
      success: true,
      recoveryPhrase: 'word1 word2 word3',
      deviceId: 'dev-1'
    }
    api.syncSetup.setupFirstDevice = vi.fn().mockResolvedValue(response)

    // #when
    const result = await setupService.setupFirstDevice({
      provider: 'google',
      oauthToken: 'oauth-token-123'
    })

    // #then
    expect(api.syncSetup.setupFirstDevice).toHaveBeenCalledWith({
      provider: 'google',
      oauthToken: 'oauth-token-123'
    })
    expect(result).toEqual(response)
  })
})
