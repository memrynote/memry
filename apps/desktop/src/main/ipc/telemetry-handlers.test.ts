import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockApp, mockElectron } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp,
  ipcMain: mockElectron.ipcMain
}))

const runtimeMock = {
  track: vi.fn(),
  flush: vi.fn().mockResolvedValue({ success: true, attempted: 0, accepted: 0 }),
  setEnabled: vi.fn(),
  getSettings: vi.fn().mockReturnValue({ enabled: true })
}

vi.mock('../telemetry/runtime', () => ({
  getTelemetryRuntime: vi.fn(() => runtimeMock)
}))

import { TelemetryChannels } from '@memry/contracts/ipc-channels'

import { registerTelemetryHandlers, unregisterTelemetryHandlers } from './telemetry-handlers'

const VALID_EVENT = {
  id: '550e8400-e29b-41d4-a716-446655440002',
  name: 'page_viewed' as const,
  occurredAt: '2026-05-01T12:00:00.000Z',
  surface: 'notes' as const,
  action: 'viewed',
  result: 'success' as const
}

describe('telemetry IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    unregisterTelemetryHandlers()
  })

  it('registers handlers for all four telemetry channels', () => {
    registerTelemetryHandlers()

    expect(mockElectron.ipcMain.handle).toHaveBeenCalledWith(
      TelemetryChannels.invoke.TRACK,
      expect.any(Function)
    )
    expect(mockElectron.ipcMain.handle).toHaveBeenCalledWith(
      TelemetryChannels.invoke.FLUSH,
      expect.any(Function)
    )
    expect(mockElectron.ipcMain.handle).toHaveBeenCalledWith(
      TelemetryChannels.invoke.GET_SETTINGS,
      expect.any(Function)
    )
    expect(mockElectron.ipcMain.handle).toHaveBeenCalledWith(
      TelemetryChannels.invoke.SET_ENABLED,
      expect.any(Function)
    )
  })

  it('track handler validates the event and forwards it to the runtime', async () => {
    registerTelemetryHandlers()
    const trackCall = mockElectron.ipcMain.handle.mock.calls.find(
      (call) => call[0] === TelemetryChannels.invoke.TRACK
    )
    expect(trackCall).toBeDefined()
    const trackHandler = trackCall![1] as (
      event: unknown,
      payload: unknown
    ) => Promise<{ success: boolean; error?: string }>

    const result = await trackHandler({}, VALID_EVENT)

    expect(result).toEqual({ success: true })
    expect(runtimeMock.track).toHaveBeenCalledTimes(1)
    expect(runtimeMock.track).toHaveBeenCalledWith(VALID_EVENT)
  })

  it('track handler rejects malformed events without forwarding', async () => {
    registerTelemetryHandlers()
    const trackCall = mockElectron.ipcMain.handle.mock.calls.find(
      (call) => call[0] === TelemetryChannels.invoke.TRACK
    )
    const trackHandler = trackCall![1] as (
      event: unknown,
      payload: unknown
    ) => Promise<{ success: boolean; error?: string }>

    const result = await trackHandler({}, { id: 'not-uuid', name: 'unknown' })

    expect(result.success).toBe(false)
    expect(runtimeMock.track).not.toHaveBeenCalled()
  })

  it('flush handler delegates to runtime.flush with manual reason', async () => {
    registerTelemetryHandlers()
    const flushCall = mockElectron.ipcMain.handle.mock.calls.find(
      (call) => call[0] === TelemetryChannels.invoke.FLUSH
    )
    const flushHandler = flushCall![1] as () => Promise<{
      success: boolean
      attempted: number
      accepted: number
    }>

    const result = await flushHandler()

    expect(runtimeMock.flush).toHaveBeenCalledWith('manual')
    expect(result).toEqual({ success: true, attempted: 0, accepted: 0, error: undefined })
  })

  it('setEnabled handler delegates a boolean to runtime.setEnabled', async () => {
    registerTelemetryHandlers()
    const setEnabledCall = mockElectron.ipcMain.handle.mock.calls.find(
      (call) => call[0] === TelemetryChannels.invoke.SET_ENABLED
    )
    const setEnabledHandler = setEnabledCall![1] as (
      event: unknown,
      enabled: unknown
    ) => Promise<{ success: boolean; error?: string }>

    const result = await setEnabledHandler({}, false)

    expect(result.success).toBe(true)
    expect(runtimeMock.setEnabled).toHaveBeenCalledWith(false)
  })

  it('getSettings handler returns the runtime settings object', async () => {
    registerTelemetryHandlers()
    const getSettingsCall = mockElectron.ipcMain.handle.mock.calls.find(
      (call) => call[0] === TelemetryChannels.invoke.GET_SETTINGS
    )
    const getSettingsHandler = getSettingsCall![1] as () => Promise<{ enabled: boolean }>

    const result = await getSettingsHandler()

    expect(result).toEqual({ enabled: true })
    expect(runtimeMock.getSettings).toHaveBeenCalled()
  })
})
