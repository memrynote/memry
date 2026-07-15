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
  'agent_chat_started',
  'agent_chat_message_sent',
  'command_palette_opened',
  'app_update_installed',
  'app_error_seen'
])

export const TelemetrySurfaceSchema = z.enum([
  'app',
  'home',
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

export const TelemetryErrorDetailSchema = z.object({
  // NOTE: there is intentionally NO free-form message field. On the desktop an
  // error message can embed a note title, filename, or content, so we only ever
  // ship the stack frames (code locations) and the React component stack.
  stack: z.string().max(4000).optional(),
  componentStack: z.string().max(2000).optional()
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
  metrics: TelemetryMetricsSchema.optional(),
  error: TelemetryErrorDetailSchema.optional()
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

// --- Landing web telemetry ---------------------------------------------------
// Anonymous events from the marketing site (apps/landing). Privacy mirror of the
// desktop schema above: slug-like event names/targets, path-only pages, bounded
// UTM values — no emails, URLs, raw identifiers, or free-form strings.
const LANDING_EVENT_NAME = /^[a-z0-9_]{1,64}$/
const LANDING_PAGE_PATH = /^\/[a-zA-Z0-9\-._~/]{0,199}$/
const LANDING_TARGET = /^[a-zA-Z0-9:._-]{1,120}$/
const LANDING_UTM_VALUE = /^(?!.*@)(?!.*:\/\/)(?!.*[/\\]).{1,120}$/

const withoutRawIdentifiers = <T extends z.ZodString>(schema: T) =>
  schema.refine((value) => !UUID_SHAPED_VALUE.test(value), {
    message: 'Landing telemetry values must not contain raw identifiers'
  })

export const LandingTelemetryEventSchema = z.object({
  name: z.string().regex(LANDING_EVENT_NAME),
  page: withoutRawIdentifiers(z.string().regex(LANDING_PAGE_PATH)),
  target: withoutRawIdentifiers(z.string().regex(LANDING_TARGET)).optional(),
  utm_source: withoutRawIdentifiers(z.string().regex(LANDING_UTM_VALUE)).optional(),
  utm_medium: withoutRawIdentifiers(z.string().regex(LANDING_UTM_VALUE)).optional(),
  utm_campaign: withoutRawIdentifiers(z.string().regex(LANDING_UTM_VALUE)).optional(),
  utm_content: withoutRawIdentifiers(z.string().regex(LANDING_UTM_VALUE)).optional(),
  utm_term: withoutRawIdentifiers(z.string().regex(LANDING_UTM_VALUE)).optional()
})

export const LandingTelemetryBatchSchema = z.object({
  visitorId: z.string().uuid(),
  events: z.array(LandingTelemetryEventSchema).min(1).max(20)
})

export type LandingTelemetryEvent = z.infer<typeof LandingTelemetryEventSchema>
export type LandingTelemetryBatch = z.infer<typeof LandingTelemetryBatchSchema>

export type TelemetryEventName = z.infer<typeof TelemetryEventNameSchema>
export type TelemetrySurface = z.infer<typeof TelemetrySurfaceSchema>
export type TelemetryResult = z.infer<typeof TelemetryResultSchema>
export type TelemetryBuildChannel = z.infer<typeof TelemetryBuildChannelSchema>
export type TelemetryAuthState = z.infer<typeof TelemetryAuthStateSchema>
export type TelemetrySyncState = z.infer<typeof TelemetrySyncStateSchema>
export type TelemetryPlatform = z.infer<typeof TelemetryPlatformSchema>
export type TelemetryMetrics = z.infer<typeof TelemetryMetricsSchema>
export type TelemetryErrorDetail = z.infer<typeof TelemetryErrorDetailSchema>
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>

/**
 * Scrub obvious PII from an error message or stack trace before it leaves the
 * device / reaches PostHog. Keeps the diagnostic shape (frames, class names,
 * project-relative paths) while removing usernames, emails, ids, and tokens.
 * Shared by desktop renderer, desktop main, and the sync-server mirror.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
// /Users/<name>, /home/<name>, /root, C:\Users\<name> → ~ (drops the username, keeps the rest)
const HOME_PATH_UNIX_PATTERN = /(?:\/Users\/|\/home\/|\/root\/)[^/\s:)'"]+/g
const HOME_PATH_WIN_PATTERN = /[A-Za-z]:\\Users\\[^\\\s:)'"]+/gi

export const redactSensitive = (input: string): string =>
  input
    .replace(JWT_PATTERN, '<jwt>')
    .replace(BEARER_PATTERN, 'Bearer <token>')
    .replace(EMAIL_PATTERN, '<email>')
    .replace(UUID_PATTERN, '<uuid>')
    .replace(HOME_PATH_UNIX_PATTERN, '~')
    .replace(HOME_PATH_WIN_PATTERN, '~')

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value

// Keep only "    at <fn> (<file>:<line>:<col>)" frame lines. This deliberately
// drops the leading "<ErrorName>: <message>" header (and any other prose) so a
// free-form message — which on the desktop can embed a note title, filename, or
// content — never rides along inside the stack. Frames are code locations only.
const keepStackFrameLines = (stack: string): string =>
  stack
    .split('\n')
    .filter((line) => /^\s*at\s/.test(line))
    .join('\n')

const SAFE_TOKEN = /^(?!.*@)(?!.*:\/\/)(?!.*[/\\]).{1,64}$/

/**
 * Coerce a value into a token safe to ship as telemetry metadata: known charset,
 * ≤64 chars, no '@', '://', '/' or '\'. Falls back when the value cannot be made
 * to fit.
 */
export const toSafeToken = (value: unknown, fallback: string): string => {
  const raw =
    value instanceof Error
      ? value.name
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : ''
  const token = raw.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64)
  return SAFE_TOKEN.test(token) ? token : fallback
}

// A typed error code is an enum-ish token that the app or a native library
// assigns: NOTE_WRITE_FAILED, SQLITE_BUSY, ECONNREFUSED. Anything else — a path,
// an email, a URL, free-form prose — is REJECTED outright rather than run through
// toSafeToken, because a character-substituted path ('_Users_kaan_secret.md')
// still leaks its structure. Rejected codes fall back to the class name.
const TYPED_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/

const typedErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return undefined
  return TYPED_ERROR_CODE.test(code) ? code : undefined
}

/**
 * Derive the `errorCode` dimension for an error. Prefers a typed code the error
 * carries (NoteError.code, better-sqlite3's error.code, Node's ECONNREFUSED)
 * over the class name, so a failure says NOTE_WRITE_FAILED / SQLITE_BUSY rather
 * than collapsing every note failure to "NoteError" and every DB failure to
 * "SqliteError". Falls back to the class name, then the constructor name.
 */
export const toErrorCode = (error: unknown): string => {
  const typed = typedErrorCode(error)
  if (typed) return typed
  if (error instanceof Error && error.name) {
    return toSafeToken(error.name, 'Error')
  }
  if (error && typeof error === 'object' && error.constructor?.name) {
    return toSafeToken(error.constructor.name, 'UnknownError')
  }
  if (typeof error === 'string') return 'StringError'
  return 'UnknownError'
}

const hasStackFrames = (value: unknown): value is { stack: string } => {
  const stack = (value as { stack?: unknown } | null | undefined)?.stack
  return typeof stack === 'string' && /^\s*at\s/m.test(stack)
}

const rejectionTypeName = (reason: unknown): string => {
  if (reason === null) return 'Rejection_null'
  if (reason === undefined) return 'Rejection_undefined'
  if (typeof reason !== 'object') return `Rejection_${typeof reason}`
  const ctor = (reason as { constructor?: { name?: unknown } }).constructor?.name
  return typeof ctor === 'string' && ctor ? `Rejection_${ctor}` : 'Rejection_object'
}

/**
 * Normalize an unhandled rejection reason into an Error that always carries a
 * stack. A rejection can carry ANY value: a string, a plain object, undefined,
 * or a cross-realm Error that fails `instanceof Error`. Those produce no stack
 * and land in telemetry as an unactionable bare `Error` with an empty stack.
 *
 * Real Errors pass through; a cross-realm error's own frames are adopted;
 * anything else gets a stack synthesized at the handler plus a name describing
 * the reason's type/constructor. Privacy: the reason's message/value is NEVER
 * copied — only its shape. buildErrorDetail still strips the stack header.
 */
export const normalizeRejectionReason = (reason: unknown): Error => {
  if (reason instanceof Error && hasStackFrames(reason)) return reason

  const normalized = new Error()
  normalized.name = toSafeToken(rejectionTypeName(reason), 'Rejection_unknown')
  if (hasStackFrames(reason)) {
    normalized.stack = reason.stack
    const name = (reason as { name?: unknown }).name
    if (typeof name === 'string' && name) {
      normalized.name = toSafeToken(name, normalized.name)
    }
  }
  return normalized
}

/**
 * Build the redacted, length-capped error detail attached to `app_error_seen`
 * desktop telemetry. Privacy: we NEVER send the error message (it can contain a
 * note title/filename/content) — only the stack frames (code locations) and the
 * React component stack, with home paths and stray identifiers scrubbed.
 * Returns undefined when there is nothing useful to send.
 */
export const buildErrorDetail = (
  error: unknown,
  componentStack?: string
): TelemetryErrorDetail | undefined => {
  const detail: TelemetryErrorDetail = {}
  const rawStack =
    error instanceof Error && typeof error.stack === 'string' ? error.stack : undefined
  if (rawStack) {
    const frames = keepStackFrameLines(rawStack)
    if (frames) detail.stack = truncate(redactSensitive(frames), 4000)
  }
  if (componentStack) {
    detail.componentStack = truncate(redactSensitive(componentStack), 2000)
  }
  return detail.stack || detail.componentStack ? detail : undefined
}
