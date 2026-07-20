import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockApp, mockElectron } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp,
  ipcMain: mockElectron.ipcMain,
  net: { fetch: vi.fn() }
}))

const FIXED_REPORT = {
  schemaVersion: 1 as const,
  installId: '550e8400-e29b-41d4-a716-446655440000',
  sessionId: '550e8400-e29b-41d4-a716-446655440001',
  appVersion: '0.1.0',
  buildChannel: 'production' as const,
  platform: 'darwin' as const,
  arch: 'arm64',
  incidentId: 'MEMRY-ABCD2345',
  trigger: { source: 'settings' },
  snapshot: {
    appVersion: '0.1.0',
    buildChannel: 'production' as const,
    platform: 'darwin' as const,
    arch: 'arm64',
    locale: 'en',
    uptimeSeconds: 42,
    syncEnabled: true,
    syncState: 'enabled' as const,
    queueDepth: 0,
    vaultOpen: true,
    authState: 'signed_in' as const
  },
  lines: []
}

const buildIncidentReportMock = vi.fn(() => FIXED_REPORT)
const collectIncidentDepsMock = vi.fn(() => ({}))
const sendIncidentReportMock = vi.fn().mockResolvedValue({ incidentId: 'MEMRY-ABCD2345' })

vi.mock('../diagnostics/incident-report', () => ({
  buildIncidentReport: (...args: unknown[]) => buildIncidentReportMock(...args),
  collectIncidentDeps: (...args: unknown[]) => collectIncidentDepsMock(...args),
  sendIncidentReport: (...args: unknown[]) => sendIncidentReportMock(...args)
}))

import { DiagnosticsChannels } from '@memry/contracts/ipc-channels'

import { registerDiagnosticsHandlers, unregisterDiagnosticsHandlers } from './diagnostics-handlers'

type PreviewHandler = (
  event: unknown,
  payload: unknown
) => Promise<{ success: true; report: unknown } | { success: false; error: string }>
type SendHandler = (
  event: unknown,
  payload: unknown
) => Promise<{ success: true; incidentId: string } | { success: false; error: string }>

const getHandler = <T>(channel: string): T => {
  const call = mockElectron.ipcMain.handle.mock.calls.find((c) => c[0] === channel)
  expect(call).toBeDefined()
  return call![1] as T
}

describe('diagnostics IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    unregisterDiagnosticsHandlers()
  })

  it('registers handlers for both diagnostics channels', () => {
    registerDiagnosticsHandlers()

    expect(mockElectron.ipcMain.handle).toHaveBeenCalledWith(
      DiagnosticsChannels.invoke.PREVIEW_REPORT,
      expect.any(Function)
    )
    expect(mockElectron.ipcMain.handle).toHaveBeenCalledWith(
      DiagnosticsChannels.invoke.SEND_REPORT,
      expect.any(Function)
    )
  })

  it('previewReport returns a built report for a valid trigger', async () => {
    registerDiagnosticsHandlers()
    const handler = getHandler<PreviewHandler>(DiagnosticsChannels.invoke.PREVIEW_REPORT)

    const result = await handler({}, { source: 'settings' })

    expect(result).toEqual({ success: true, report: FIXED_REPORT })
    expect(collectIncidentDepsMock).toHaveBeenCalledWith({ source: 'settings' })
    expect(buildIncidentReportMock).toHaveBeenCalledWith({ source: 'settings' }, {})
  })

  it('previewReport rejects an invalid trigger (source containing a slash) without building', async () => {
    registerDiagnosticsHandlers()
    const handler = getHandler<PreviewHandler>(DiagnosticsChannels.invoke.PREVIEW_REPORT)

    const result = await handler({}, { source: 'a/b' })

    expect(result.success).toBe(false)
    expect(buildIncidentReportMock).not.toHaveBeenCalled()
  })

  it('sendReport forwards a valid report and returns the incidentId', async () => {
    registerDiagnosticsHandlers()
    const handler = getHandler<SendHandler>(DiagnosticsChannels.invoke.SEND_REPORT)

    const result = await handler({}, FIXED_REPORT)

    expect(result).toEqual({ success: true, incidentId: 'MEMRY-ABCD2345' })
    expect(sendIncidentReportMock).toHaveBeenCalledTimes(1)
    expect(sendIncidentReportMock.mock.calls[0][0]).toEqual(FIXED_REPORT)
  })

  it('sendReport rejects garbage input without forwarding', async () => {
    registerDiagnosticsHandlers()
    const handler = getHandler<SendHandler>(DiagnosticsChannels.invoke.SEND_REPORT)

    const result = await handler({}, { not: 'a report' })

    expect(result.success).toBe(false)
    expect(sendIncidentReportMock).not.toHaveBeenCalled()
  })
})
