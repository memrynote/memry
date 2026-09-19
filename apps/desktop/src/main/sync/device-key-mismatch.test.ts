import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'

const mocks = vi.hoisted(() => ({
  broadcastToAllWindows: vi.fn(),
  trackMainEvent: vi.fn(),
  isKeyMaterialActivityRecent: vi.fn(() => false),
  teardownSession: vi.fn(async () => {})
}))

vi.mock('../lib/window-broadcast', () => ({
  broadcastToAllWindows: mocks.broadcastToAllWindows
}))
vi.mock('../telemetry/track', () => ({ trackMainEvent: mocks.trackMainEvent }))
vi.mock('./key-verification', () => ({
  isKeyMaterialActivityRecent: mocks.isKeyMaterialActivityRecent
}))
vi.mock('./session-teardown', () => ({ teardownSession: mocks.teardownSession }))

const loadHandler = async (): Promise<() => void> => {
  vi.resetModules()
  const mod = await import('./device-key-mismatch')
  return mod.handleDeviceKeyMismatch
}

describe('handleDeviceKeyMismatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isKeyMaterialActivityRecent.mockReturnValue(false)
  })

  it('#given a steady-state mismatch #then it reports the error and signs out once', async () => {
    const handle = await loadHandler()

    handle()
    await vi.waitFor(() => expect(mocks.teardownSession).toHaveBeenCalledWith('integrity'))

    expect(mocks.broadcastToAllWindows).toHaveBeenCalledWith(EVENT_CHANNELS.STATUS_CHANGED, {
      status: 'error',
      pendingCount: 0,
      error: 'errors:sync.deviceKeyMismatch',
      errorCategory: 'device_key_mismatch'
    })
    expect(mocks.trackMainEvent).toHaveBeenCalledTimes(1)

    // A push rejects every queued item the same way, so the burst must not
    // produce a sign-out per item.
    handle()
    handle()
    expect(mocks.teardownSession).toHaveBeenCalledTimes(1)
    expect(mocks.trackMainEvent).toHaveBeenCalledTimes(1)
  })

  it('#given key material is in flux #then it stands down and stays armed', async () => {
    const handle = await loadHandler()
    mocks.isKeyMaterialActivityRecent.mockReturnValue(true)

    handle()

    // Sign-in / recovery / linking is already re-registering the device; tearing
    // the session down here would abort that repair.
    expect(mocks.teardownSession).not.toHaveBeenCalled()
    expect(mocks.trackMainEvent).not.toHaveBeenCalled()

    mocks.isKeyMaterialActivityRecent.mockReturnValue(false)
    handle()
    await vi.waitFor(() => expect(mocks.teardownSession).toHaveBeenCalledWith('integrity'))
  })
})
