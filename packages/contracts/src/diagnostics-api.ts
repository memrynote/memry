import { z } from 'zod'
import {
  TelemetryAuthStateSchema,
  TelemetryBuildChannelSchema,
  TelemetryPlatformSchema,
  TelemetrySyncStateSchema
} from './telemetry-api'

const SAFE_TOKEN = /^(?!.*@)(?!.*:\/\/)(?!.*[/\\]).{1,64}$/
const SafeToken = z.string().regex(SAFE_TOKEN)
// bounded record of already-redacted primitive field values.
const SafeFields = z.record(
  z.string().max(64),
  z.union([z.string().max(500), z.number().finite(), z.boolean()])
)

export const DiagnosticTriggerSchema = z.object({
  source: SafeToken,
  errorCode: SafeToken.optional(),
  stack: z.string().max(8000).optional()
})

export const DiagnosticLogLineSchema = z.object({
  ts: z.string().datetime(),
  level: z.enum(['warn', 'error']),
  scope: SafeToken,
  action: SafeToken.optional(),
  message: z.string().max(2000),
  errorCode: SafeToken.optional(),
  fields: SafeFields.optional(),
  origin: z.enum(['main', 'worker']),
  workerName: SafeToken.optional()
})

const clientMeta = {
  schemaVersion: z.literal(1),
  installId: z.string().uuid(),
  sessionId: z.string().uuid(),
  appVersion: z.string().min(1).max(32),
  buildChannel: TelemetryBuildChannelSchema,
  platform: TelemetryPlatformSchema,
  arch: z.string().min(1).max(32)
}

export const DiagnosticLogBatchSchema = z.object({
  ...clientMeta,
  lines: z.array(DiagnosticLogLineSchema).min(1).max(50)
})

export const DiagnosticSnapshotSchema = z.object({
  appVersion: z.string().max(32),
  buildChannel: TelemetryBuildChannelSchema,
  platform: TelemetryPlatformSchema,
  arch: z.string().max(32),
  locale: z.string().max(16),
  uptimeSeconds: z.number().finite().nonnegative(),
  syncEnabled: z.boolean(),
  syncState: TelemetrySyncStateSchema,
  queueDepth: z.number().int().nonnegative(),
  vaultOpen: z.boolean(),
  authState: TelemetryAuthStateSchema
})

export const DiagnosticReportSchema = z.object({
  ...clientMeta,
  incidentId: z.string().regex(/^MEMRY-[A-Z0-9]{6,12}$/),
  trigger: z.object({
    source: SafeToken,
    errorCode: SafeToken.optional(),
    stack: z.string().max(4000).optional()
  }),
  snapshot: DiagnosticSnapshotSchema,
  lines: z.array(DiagnosticLogLineSchema).max(200),
  /**
   * Accepted for backward compatibility with older desktop builds, but
   * DELIBERATELY IGNORED by the server. Report identity is resolved from the
   * verified `Authorization` bearer instead (see routes/diagnostics.ts): a body
   * field is client-asserted, and it feeds a PostHog `distinct_id`, where an
   * `$identify` merge is permanent. Do not start trusting this.
   */
  accountId: z.string().uuid().optional()
})

export type DiagnosticTrigger = z.infer<typeof DiagnosticTriggerSchema>
export type DiagnosticLogLine = z.infer<typeof DiagnosticLogLineSchema>
export type DiagnosticLogBatch = z.infer<typeof DiagnosticLogBatchSchema>
export type DiagnosticSnapshot = z.infer<typeof DiagnosticSnapshotSchema>
export type DiagnosticReport = z.infer<typeof DiagnosticReportSchema>
