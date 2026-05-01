import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { createLogger } from '../lib/logger'

const logger = createLogger('TelemetryInstall')

export const TELEMETRY_CONFIG_FILENAME = 'telemetry.json'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface TelemetryConfigOnDisk {
  installId?: string
}

const getConfigPath = (): string =>
  path.join(app.getPath('userData'), TELEMETRY_CONFIG_FILENAME)

const writeConfig = (configPath: string, installId: string): void => {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ installId }, null, 2), 'utf-8')
  } catch (error) {
    logger.error('Failed to persist telemetry install id', { error })
  }
}

const readStoredInstallId = (configPath: string): string | null => {
  try {
    if (!fs.existsSync(configPath)) return null
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as TelemetryConfigOnDisk
    if (typeof parsed.installId === 'string' && UUID_PATTERN.test(parsed.installId)) {
      return parsed.installId
    }
    return null
  } catch (error) {
    logger.warn('Telemetry config unreadable; regenerating', { error })
    return null
  }
}

export const getOrCreateInstallId = (): string => {
  const configPath = getConfigPath()
  const existing = readStoredInstallId(configPath)
  if (existing) return existing

  const fresh = randomUUID()
  writeConfig(configPath, fresh)
  return fresh
}
