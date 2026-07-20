import { createHash, randomBytes } from 'node:crypto'
import { mergeTelemetryConfig, readTelemetryConfig } from './config'

export const getOrCreateDiagnosticsSalt = (): string => {
  const existing = readTelemetryConfig().diagnosticsSalt
  if (typeof existing === 'string' && /^[0-9a-f]{32}$/.test(existing)) return existing
  const fresh = randomBytes(16).toString('hex')
  mergeTelemetryConfig({ diagnosticsSalt: fresh })
  return fresh
}

export const makeSaltedHasher =
  (salt: string) =>
  (value: string): string =>
    createHash('sha256').update(salt).update('\0').update(value).digest('hex').slice(0, 10)
