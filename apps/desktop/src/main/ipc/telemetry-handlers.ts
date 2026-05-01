import { ipcMain } from 'electron'

import { TelemetryChannels } from '@memry/contracts/ipc-channels'
import { TelemetryEventSchema } from '@memry/contracts/telemetry-api'

import { createLogger } from '../lib/logger'
import { getTelemetryRuntime } from '../telemetry/runtime'

const logger = createLogger('IPC:Telemetry')

let registered = false

const TELEMETRY_CHANNELS = [
  TelemetryChannels.invoke.TRACK,
  TelemetryChannels.invoke.FLUSH,
  TelemetryChannels.invoke.GET_SETTINGS,
  TelemetryChannels.invoke.SET_ENABLED
] as const

export const registerTelemetryHandlers = (): void => {
  if (registered) return

  ipcMain.handle(TelemetryChannels.invoke.TRACK, async (_event, payload: unknown) => {
    const parsed = TelemetryEventSchema.safeParse(payload)
    if (!parsed.success) {
      return { success: false, error: 'INVALID_TELEMETRY_EVENT' }
    }

    const runtime = getTelemetryRuntime()
    if (!runtime) {
      return { success: false, error: 'TELEMETRY_NOT_INITIALIZED' }
    }

    runtime.track(parsed.data)
    return { success: true }
  })

  ipcMain.handle(TelemetryChannels.invoke.FLUSH, async () => {
    const runtime = getTelemetryRuntime()
    if (!runtime) return { success: true }
    const result = await runtime.flush('manual')
    return { success: result.success, error: result.error }
  })

  ipcMain.handle(TelemetryChannels.invoke.GET_SETTINGS, async () => {
    const runtime = getTelemetryRuntime()
    if (!runtime) return { enabled: false }
    return runtime.getSettings()
  })

  ipcMain.handle(TelemetryChannels.invoke.SET_ENABLED, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'INVALID_ENABLED_VALUE' }
    }

    const runtime = getTelemetryRuntime()
    if (!runtime) return { success: false, error: 'TELEMETRY_NOT_INITIALIZED' }

    try {
      runtime.setEnabled(enabled)
      return { success: true }
    } catch (error) {
      logger.error('Failed to set telemetry enabled flag', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'UNKNOWN_TELEMETRY_ERROR'
      }
    }
  })

  registered = true
}

export const unregisterTelemetryHandlers = (): void => {
  if (!registered) return
  for (const channel of TELEMETRY_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registered = false
}
