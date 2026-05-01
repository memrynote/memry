import { randomUUID } from 'node:crypto'

import { mergeTelemetryConfig, readTelemetryConfig, TELEMETRY_CONFIG_FILENAME } from './config'

export { TELEMETRY_CONFIG_FILENAME }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const getOrCreateInstallId = (): string => {
  const existing = readTelemetryConfig().installId
  if (typeof existing === 'string' && UUID_PATTERN.test(existing)) {
    return existing
  }

  const fresh = randomUUID()
  mergeTelemetryConfig({ installId: fresh })
  return fresh
}
