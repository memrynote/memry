import { setSyncClientLoggerFactory } from '@memry/sync-client/logging'
import { setSyncClientTelemetrySink } from '@memry/sync-client/telemetry'
import { createLogger } from '../lib/logger'
import { trackMainEvent } from '../telemetry/track'
import { trackMainLog } from '../telemetry/diagnostics'

/**
 * Wires @memry/sync-client's logging and telemetry facades to desktop's
 * electron-log and telemetry runtime. Imported for its side effect at the very
 * top of the main entry so extracted sync modules log with the same scopes and
 * emit the same events they did before the extraction; anything they log
 * before this module runs would be dropped by the unwired facade.
 */
setSyncClientLoggerFactory((scope) => createLogger(scope))
setSyncClientTelemetrySink({
  trackEvent: (name, options) => trackMainEvent(name, options),
  trackLog: (level, options) => trackMainLog(level, options)
})
