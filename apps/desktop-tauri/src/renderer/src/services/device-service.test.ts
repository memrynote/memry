import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { deviceService } from './device-service'

describe('device-service', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards getDevices to window.api.syncDevices', async () => {
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
      ]
    }
    api.syncDevices.getDevices = vi.fn().mockResolvedValue(response)

    // #when
    const result = await deviceService.getDevices()

    // #then
    expect(api.syncDevices.getDevices).toHaveBeenCalled()
    expect(result).toEqual(response)
  })

  it('forwards removeDevice to window.api.syncDevices', async () => {
    // #given
    api.syncDevices.removeDevice = vi.fn().mockResolvedValue({ success: true })

    // #when
    const result = await deviceService.removeDevice({ deviceId: 'dev-1' })

    // #then
    expect(api.syncDevices.removeDevice).toHaveBeenCalledWith({ deviceId: 'dev-1' })
    expect(result).toEqual({ success: true })
  })

  it('forwards renameDevice to window.api.syncDevices', async () => {
    // #given
    api.syncDevices.renameDevice = vi.fn().mockResolvedValue({ success: true })

    // #when
    const result = await deviceService.renameDevice({ deviceId: 'dev-1', newName: 'My Laptop' })

    // #then
    expect(api.syncDevices.renameDevice).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      newName: 'My Laptop'
    })
    expect(result).toEqual({ success: true })
  })
})
