import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { createLogger } from '../lib/logger'

const logger = createLogger('TelemetryConfig')

export const TELEMETRY_CONFIG_FILENAME = 'telemetry.json'

export interface TelemetryConfigOnDisk {
  installId?: string
  enabled?: boolean
  lastRunVersion?: string
}

const getConfigPath = (): string => path.join(app.getPath('userData'), TELEMETRY_CONFIG_FILENAME)

export const readTelemetryConfig = (): TelemetryConfigOnDisk => {
  try {
    const configPath = getConfigPath()
    if (!fs.existsSync(configPath)) return {}
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as TelemetryConfigOnDisk
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    logger.warn('Telemetry config unreadable; returning empty', { error })
    return {}
  }
}

export const mergeTelemetryConfig = (updates: TelemetryConfigOnDisk): void => {
  const configPath = getConfigPath()
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const current = readTelemetryConfig()
    const next = { ...current, ...updates }
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf-8')
  } catch (error) {
    logger.error('Failed to persist telemetry config', { error })
  }
}
