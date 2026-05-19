import { z } from 'zod'

export const TelemetryEventNameSchema = z.enum([
  'app_started',
  'app_backgrounded',
  'app_active_heartbeat',
  'app_launch_phase_completed',
  'app_log_recorded',
  'onboarding_started',
  'onboarding_completed',
  'vault_created',
  'vault_opened',
  'page_viewed',
  'note_created',
  'note_opened',
  'note_updated',
  'note_deleted',
  'journal_opened',
  'journal_updated',
  'task_created',
  'task_completed',
  'task_reopened',
  'project_created',
  'inbox_captured',
  'inbox_filed',
  'inbox_archived',
  'inbox_snoozed',
  'search_opened',
  'search_performed',
  'search_result_opened',
  'calendar_event_created',
  'calendar_event_updated',
  'calendar_google_connected',
  'calendar_google_sync_completed',
  'graph_opened',
  'setting_changed',
  'sync_enabled',
  'sync_run_completed',
  'sync_error',
  'voice_recording_completed',
  'transcription_completed',
  'ai_action_completed',
  'app_error_seen'
])

export const TelemetrySurfaceSchema = z.enum([
  'app',
  'onboarding',
  'vault',
  'notes',
  'journal',
  'tasks',
  'inbox',
  'calendar',
  'search',
  'graph',
  'settings',
  'sync',
  'ai',
  'voice',
  'updater'
])

export const TelemetryResultSchema = z.enum(['success', 'failed', 'canceled', 'skipped'])
export const TelemetryBuildChannelSchema = z.enum(['development', 'staging', 'production'])
export const TelemetryAuthStateSchema = z.enum(['anonymous', 'signed_in', 'signed_out'])
export const TelemetrySyncStateSchema = z.enum(['disabled', 'enabled', 'unknown'])
export const TelemetryPlatformSchema = z.enum(['darwin', 'win32', 'linux'])

const SAFE_DIMENSION_VALUE = /^(?!.*@)(?!.*:\/\/)(?!.*[/\\]).{1,64}$/
const UUID_SHAPED_VALUE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

export const SafeDimensionValueSchema = z
  .string()
  .regex(SAFE_DIMENSION_VALUE)
  .refine((value) => !UUID_SHAPED_VALUE.test(value), {
    message: 'Telemetry dimension values must not contain raw identifiers'
  })

export const TelemetryDimensionsSchema = z
  .record(SafeDimensionValueSchema, SafeDimensionValueSchema)
  .refine((dimensions) => Object.keys(dimensions).length <= 1, {
    message: 'Telemetry events support at most one dimension'
  })

export const TelemetryMetricsSchema = z.object({
  durationMs: z.number().finite().nonnegative().optional(),
  itemCount: z.number().finite().nonnegative().optional(),
  byteCount: z.number().finite().nonnegative().optional(),
  queueCount: z.number().finite().nonnegative().optional(),
  resultCount: z.number().finite().nonnegative().optional(),
  retryCount: z.number().finite().nonnegative().optional(),
  activeSeconds: z.number().finite().nonnegative().optional(),
  value: z.number().finite().optional()
})

export const TelemetryEventSchema = z.object({
  id: z.string().uuid(),
  name: TelemetryEventNameSchema,
  occurredAt: z.string().datetime(),
  surface: TelemetrySurfaceSchema,
  action: SafeDimensionValueSchema,
  objectType: SafeDimensionValueSchema.optional(),
  source: SafeDimensionValueSchema.optional(),
  result: TelemetryResultSchema.optional(),
  errorCode: SafeDimensionValueSchema.optional(),
  dimensions: TelemetryDimensionsSchema.optional(),
  metrics: TelemetryMetricsSchema.optional()
})

export const TelemetryBatchSchema = z.object({
  schemaVersion: z.literal(1),
  installId: z.string().uuid(),
  sessionId: z.string().uuid(),
  appVersion: z.string().min(1).max(32),
  buildChannel: TelemetryBuildChannelSchema,
  platform: TelemetryPlatformSchema,
  arch: z.string().min(1).max(32),
  locale: z.string().min(2).max(16),
  timezoneOffsetMinutes: z.number().int().min(-840).max(840),
  authState: TelemetryAuthStateSchema,
  syncState: TelemetrySyncStateSchema,
  clientQueueDepth: z.number().int().min(0).max(1000).optional(),
  events: z.array(TelemetryEventSchema).min(1).max(100)
})

export type TelemetryEventName = z.infer<typeof TelemetryEventNameSchema>
export type TelemetrySurface = z.infer<typeof TelemetrySurfaceSchema>
export type TelemetryResult = z.infer<typeof TelemetryResultSchema>
export type TelemetryBuildChannel = z.infer<typeof TelemetryBuildChannelSchema>
export type TelemetryAuthState = z.infer<typeof TelemetryAuthStateSchema>
export type TelemetrySyncState = z.infer<typeof TelemetrySyncStateSchema>
export type TelemetryPlatform = z.infer<typeof TelemetryPlatformSchema>
export type TelemetryMetrics = z.infer<typeof TelemetryMetricsSchema>
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>
