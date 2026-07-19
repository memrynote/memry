import { ipcMain, net } from 'electron'

import { DiagnosticsChannels } from '@memry/contracts/ipc-channels'
import { DiagnosticReportSchema, DiagnosticTriggerSchema } from '@memry/contracts/diagnostics-api'

import { createLogger } from '../lib/logger'
import {
  buildIncidentReport,
  collectIncidentDeps,
  sendIncidentReport
} from '../diagnostics/incident-report'

const logger = createLogger('IPC:Diagnostics')

let registered = false

const DIAGNOSTICS_CHANNELS = [
  DiagnosticsChannels.invoke.PREVIEW_REPORT,
  DiagnosticsChannels.invoke.SEND_REPORT
] as const

export const registerDiagnosticsHandlers = (): void => {
  if (registered) return

  ipcMain.handle(DiagnosticsChannels.invoke.PREVIEW_REPORT, async (_event, payload: unknown) => {
    const parsed = DiagnosticTriggerSchema.safeParse(payload)
    if (!parsed.success) {
      return { success: false, error: 'INVALID_TRIGGER' }
    }

    try {
      const deps = collectIncidentDeps(parsed.data)
      const report = buildIncidentReport(parsed.data, deps)
      return { success: true, report }
    } catch (error) {
      logger.error('Failed to build incident report preview', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'PREVIEW_FAILED'
      }
    }
  })

  ipcMain.handle(DiagnosticsChannels.invoke.SEND_REPORT, async (_event, payload: unknown) => {
    const parsed = DiagnosticReportSchema.safeParse(payload)
    if (!parsed.success) {
      return { success: false, error: 'INVALID_REPORT' }
    }

    try {
      const { incidentId } = await sendIncidentReport(parsed.data, {
        fetch: (input, init) => net.fetch(input.toString(), init)
      })
      return { success: true, incidentId }
    } catch (error) {
      logger.error('Failed to send incident report', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'SEND_FAILED'
      }
    }
  })

  registered = true
}

export const unregisterDiagnosticsHandlers = (): void => {
  if (!registered) return
  for (const channel of DIAGNOSTICS_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registered = false
}
