import { z } from 'zod'

import { redactText, type RedactOptions } from './redact'

// DEPLOY ORDER: the sync-server validates /telemetry/batch with THIS schema
// (apps/sync-server/src/routes/telemetry.ts). A server running older contracts
// rejects the ENTIRE batch with a 400, not just the unknown event — so any
// addition here must reach the deployed sync-server before a desktop release
// ships it.
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
  'app_error_seen',
  'app_crashed',
  'canvas_sync_conflict_copy',
  'canvas_too_large',
  'sync_skipped_unknown_type',
  'canvas_asset_uploaded',
  'canvas_asset_dedup_hit',
  'canvas_asset_gc_reaped',
  'canvas_created',
  'canvas_opened',
  'canvas_deleted',
  'canvas_card_added',
  'project_opened',
  'project_updated',
  'project_archived',
  'project_deleted',
  'project_item_linked',
  'tag_created',
  'tag_renamed',
  'tag_deleted',
  'tag_merged',
  'tag_category_created',
  'task_updated',
  'task_deleted',
  'calendar_event_deleted',
  'calendar_google_disconnected',
  'note_imported',
  'note_exported',
  'import_completed',
  'deep_link_opened',
  'home_board_customized',
  'reminder_created',
  'reminder_deleted'
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
  'updater',
  'canvas',
  'projects',
  'tags'
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

// PostHog treats these as reserved/special-purpose property names regardless of
// which object they land on (event properties, person properties, etc). A `$`
// prefix is PostHog's own reserved-property convention; distinct_id in
// particular lives in a different namespace on PostHogEvent (top-level, not
// under `properties`) than anything productEvent itself writes, so ordering
// tricks there cannot protect it — the key must never be accepted here.
const RESERVED_DIMENSION_KEYS = new Set([
  'distinct_id',
  'set',
  'set_once',
  'groups',
  'session_id',
  'ip'
])

export const SafeDimensionKeySchema = SafeDimensionValueSchema.refine(
  (key) => !key.startsWith('$') && !RESERVED_DIMENSION_KEYS.has(key),
  { message: 'Telemetry dimension keys must not use a PostHog-reserved name' }
)

export const TelemetryDimensionsSchema = z
  .record(SafeDimensionKeySchema, SafeDimensionValueSchema)
  .refine((dimensions) => Object.keys(dimensions).length <= 1, {
    message: 'Telemetry events support at most one dimension'
  })

/**
 * The ONLY dimension keys allowed to leave the device.
 *
 * `SafeDimensionValueSchema` is a blocklist: it rejects emails, urls, paths and
 * over-long strings, but a short free-text string sails through it. A scraped
 * `<title>` ("Divorce settlement calculator") is a legal safe-dimension value.
 * That is how page-derived text reached telemetry (issue #1142): nothing
 * downstream could tell a bounded enum from arbitrary content.
 *
 * So the key namespace is closed instead. Each entry below is a bounded enum,
 * a version string, or a bucket label — never free text derived from user
 * content, page content, or a filename. Adding a key here is the review gate:
 * if the value cannot be enumerated ahead of time, it does not belong in a
 * dimension. Send a metric (a count, a duration, a length bucket) instead.
 */
export const TELEMETRY_DIMENSION_KEYS = [
  'capture_type',
  'changed_fields',
  'decision',
  'filed_action',
  'format',
  'from_version',
  'itemType',
  'log_action',
  'prior_app_version',
  'result_bucket',
  'setting',
  'target',
  'target_app_version',
  'tool',
  'transport',
  'value'
] as const

export type TelemetryDimensionKey = (typeof TELEMETRY_DIMENSION_KEYS)[number]

const ALLOWED_DIMENSION_KEYS: ReadonlySet<string> = new Set(TELEMETRY_DIMENSION_KEYS)

/**
 * Reduce a caller-supplied dimensions bag to what is allowed to ship: at most
 * one entry, whose key is in the allowlist above and whose value still passes
 * the safe-value shape.
 *
 * Drops rather than rejects. Telemetry must never break a feature, and losing
 * one dimension is always preferable to either shipping user content or
 * discarding the whole event (a batch containing one bad event is rejected
 * wholesale by the sync-server, which would cost every other event in it).
 *
 * Deliberately NOT folded into `TelemetryDimensionsSchema`: the sync-server
 * validates `/telemetry/batch` with that schema, so narrowing it would make a
 * newly deployed server 400 entire batches coming from already-shipped desktop
 * builds. The allowlist is enforced on the client, where the data still is.
 */
export const sanitizeTelemetryDimensions = (
  dimensions: Record<string, string> | undefined
): Record<string, string> | undefined => {
  if (!dimensions) return undefined
  for (const [key, value] of Object.entries(dimensions)) {
    if (!ALLOWED_DIMENSION_KEYS.has(key)) continue
    if (!SafeDimensionValueSchema.safeParse(value).success) continue
    return { [key]: value }
  }
  return undefined
}

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
  // Historically there was NO message field: on the desktop an error message can
  // embed a note title, filename, or content. That rule predates redact.ts. The
  // message is now allowed, but ONLY after the client has run it through
  // redactText — the server re-runs redaction in mask mode as a backstop.
  message: z.string().max(512).optional(),
  stack: z.string().max(4000).optional(),
  componentStack: z.string().max(2000).optional()
})

// The sync-server's structured error codes are SCREAMING_SNAKE tokens
// (VALIDATION_ERROR, AUTH_INVALID_TOKEN, STORAGE_QUOTA_EXCEEDED). Anchored and
// length-capped so this can never become a free-text channel.
const SERVER_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/

/**
 * The queryable facts about a failed request, split out of the single opaque
 * `errorCode` label.
 *
 * `sync_error` + `server_error` used to cover 400, 403, 404, 409 AND every 5xx
 * with no status and no server code anywhere in the event (#1584), so a
 * permanent client-side contract bug and a transient edge 5xx were the same row
 * in every chart and no alert threshold could tell them apart.
 *
 * Every field is bounded by construction — a status code is a 3-digit range, a
 * server code is an anchored enum-ish token, `retryable` is a boolean — so this
 * carries no free text and needs none of the gating TELEMETRY_DIMENSION_KEYS
 * exists for. It is a field of its own rather than a dimension because
 * `TelemetryDimensionsSchema` admits at most ONE dimension per event and
 * `sync_error` already spends it on `transport`.
 *
 * ADDITIVE ON PURPOSE: a sync-server running older contracts strips this key
 * (z.object strips unknown keys, it does not reject), so a desktop build that
 * sends it never costs the other events in its batch. An older desktop that
 * omits it stays valid for the same reason — the field is optional.
 */
export const TelemetryFailureDetailSchema = z.object({
  httpStatus: z.number().int().min(100).max(599).optional(),
  serverCode: z.string().regex(SERVER_ERROR_CODE).optional(),
  retryable: z.boolean().optional()
})

/**
 * Reduce a caller-supplied failure detail to what is allowed to ship: each field
 * survives only if it still satisfies `TelemetryFailureDetailSchema`.
 *
 * Drops rather than rejects, for exactly the reason `sanitizeTelemetryDimensions`
 * does: the sync-server rejects the ENTIRE batch when one event fails
 * validation, so a malformed status or code must cost that one field, never the
 * other 99 events queued behind it. Returns the input untouched when there is
 * nothing to drop.
 */
export const sanitizeTelemetryFailure = (
  failure: z.infer<typeof TelemetryFailureDetailSchema> | undefined
): z.infer<typeof TelemetryFailureDetailSchema> | undefined => {
  if (!failure) return failure
  if (TelemetryFailureDetailSchema.safeParse(failure).success) return failure
  const safe: z.infer<typeof TelemetryFailureDetailSchema> = {}
  const { httpStatus, serverCode, retryable } = failure
  if (
    typeof httpStatus === 'number' &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
  ) {
    safe.httpStatus = httpStatus
  }
  if (typeof serverCode === 'string' && SERVER_ERROR_CODE.test(serverCode)) {
    safe.serverCode = serverCode
  }
  if (typeof retryable === 'boolean') safe.retryable = retryable
  return Object.keys(safe).length > 0 ? safe : undefined
}

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
  error: TelemetryErrorDetailSchema.optional(),
  failure: TelemetryFailureDetailSchema.optional()
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
export type TelemetryErrorDetail = z.infer<typeof TelemetryErrorDetailSchema>
export type TelemetryFailureDetail = z.infer<typeof TelemetryFailureDetailSchema>
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

// A rejection reason or `event.error` can be ANY value: a Proxy whose traps
// throw, an object with throwing getters, a revoked Proxy. Every read below
// happens inside a diagnostics handler, so a throw there destroys the very
// report we are building — the original error is then lost for good.
const safeRead = <T>(read: () => T, fallback: T): T => {
  try {
    return read()
  } catch {
    return fallback
  }
}

// Read one property at a time: a single hostile getter must not cost us the
// other properties, so each read gets its own guard.
const readProp = (value: unknown, key: string): unknown =>
  safeRead(() => (value as Record<string, unknown> | null | undefined)?.[key], undefined)

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

const MAX_CAUSE_DEPTH = 4

const typedErrorCode = (error: unknown, depth = 0): string | undefined => {
  if (!error || typeof error !== 'object' || depth > MAX_CAUSE_DEPTH) return undefined
  const candidate = {
    telemetryCode: readProp(error, 'telemetryCode'),
    code: readProp(error, 'code'),
    cause: readProp(error, 'cause'),
    errors: readProp(error, 'errors')
  }
  // A richer app-assigned code wins over the bare `.code`, so a note failure
  // keeps its originating errno (NoteError.telemetryCode = NOTE_WRITE_FAILED:EBUSY)
  // instead of collapsing to NOTE_WRITE_FAILED.
  if (
    typeof candidate.telemetryCode === 'string' &&
    TYPED_ERROR_CODE.test(candidate.telemetryCode)
  ) {
    return candidate.telemetryCode
  }
  if (typeof candidate.code === 'string' && TYPED_ERROR_CODE.test(candidate.code)) {
    return candidate.code
  }
  // undici raises `TypeError: fetch failed` and hangs the real code on `.cause`
  // (sometimes inside an AggregateError's `.errors` for dual-stack localhost), so
  // the chain is walked to a bounded depth. TYPED_ERROR_CODE still gates every hop,
  // so a nested path/email/url can never be adopted.
  if (Array.isArray(candidate.errors)) {
    for (const nested of candidate.errors) {
      const nestedCode = typedErrorCode(nested, depth + 1)
      if (nestedCode) return nestedCode
    }
  }
  return typedErrorCode(candidate.cause, depth + 1)
}

/**
 * Derive the `errorCode` dimension for an error. Prefers a typed code the error
 * carries (NoteError.telemetryCode, NoteError.code, better-sqlite3's error.code,
 * or Node's ECONNREFUSED nested on `.cause`) over the class name, so a failure
 * says NOTE_WRITE_FAILED:EBUSY / SQLITE_BUSY rather than collapsing every note
 * failure to "NoteError" and every DB failure to "SqliteError". Falls back to the
 * class name, then the constructor name.
 */
export const toErrorCode = (error: unknown): string => {
  const typed = typedErrorCode(error)
  if (typed) return typed
  const name = readProp(error, 'name')
  if (isError(error) && typeof name === 'string' && name) {
    return toSafeToken(name, 'Error')
  }
  const ctor = constructorName(error)
  if (error && typeof error === 'object' && ctor) {
    return toSafeToken(ctor, 'UnknownError')
  }
  if (typeof error === 'string') return 'StringError'
  return 'UnknownError'
}

// `instanceof` itself can throw: a Proxy may trap `getPrototypeOf`, and an
// object may define a throwing `Symbol.hasInstance`.
const isError = (value: unknown): value is Error => safeRead(() => value instanceof Error, false)

const constructorName = (value: unknown): string | undefined => {
  const name = readProp(readProp(value, 'constructor'), 'name')
  return typeof name === 'string' && name ? name : undefined
}

// The value's own `.stack`, but only when it holds real "    at …" frames.
const ownStackFrames = (value: unknown): string | undefined => {
  const stack = readProp(value, 'stack')
  return typeof stack === 'string' && /^\s*at\s/m.test(stack) ? stack : undefined
}

// A value's own `.name`, adopted only when it is already an enum-ish token. A
// path/email/prose name is rejected outright (not character-substituted, which
// would still leak its structure).
const enumishName = (value: unknown): string | undefined => {
  const name = readProp(value, 'name')
  return typeof name === 'string' && TYPED_ERROR_CODE.test(name) ? name : undefined
}

const rejectionTypeName = (reason: unknown): string => {
  if (reason === null) return 'Rejection_null'
  if (reason === undefined) return 'Rejection_undefined'
  if (typeof reason !== 'object') return `Rejection_${typeof reason}`
  // An error that crossed a structured-clone / IPC boundary keeps its `.name`
  // ('TypeError') but loses both its stack and its constructor, so it would
  // otherwise collapse to the unactionable Rejection_Object / Rejection_Error.
  const own = enumishName(reason)
  if (own) return `Rejection_${own}`
  const ctor = constructorName(reason)
  return ctor ? `Rejection_${ctor}` : 'Rejection_object'
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
  const frames = ownStackFrames(reason)
  if (isError(reason) && frames) return reason

  const normalized = new Error()
  normalized.name = toSafeToken(rejectionTypeName(reason), 'Rejection_unknown')
  if (frames) {
    normalized.stack = frames
    // Adopt the reason's own name only when it is already an enum-ish token.
    const own = enumishName(reason)
    if (own) normalized.name = own
  }
  // Otherwise the stack stays the one captured here, i.e. this handler's own
  // frames. That is deliberate — there is nothing better to report — and the
  // Rejection_* name is what marks the stack as synthetic during triage.
  return normalized
}

export interface WindowErrorReport {
  error?: unknown
  message?: unknown
  filename?: unknown
  lineno?: unknown
  colno?: unknown
}

// "Uncaught TypeError: x is not a function" → TypeError. Only the leading
// <Something>Error token is read; everything after it is prose that can embed a
// note title or path, and is never touched.
const MESSAGE_ERROR_CLASS =
  /^(?:Uncaught\s+(?:\(in promise\)\s+)?)?([A-Za-z][A-Za-z0-9_$]{0,55}Error)\b/

const MAX_SOURCE_FILENAME = 300

// "    at window_error (file:///…/index-VP6Jd1Vs.js:121718:22)" — the browser's
// filename/lineno/colno rebuilt as a stack frame, so it survives the same frame
// filter and redaction as a real stack. A code location, never message text.
const sourceFrame = (report: WindowErrorReport): string | undefined => {
  const filename = typeof report.filename === 'string' ? report.filename.trim() : ''
  if (!filename) return undefined
  const line = Number.isFinite(report.lineno) ? (report.lineno as number) : 0
  const column = Number.isFinite(report.colno) ? (report.colno as number) : 0
  return `    at window_error (${filename.slice(0, MAX_SOURCE_FILENAME)}:${line}:${column})`
}

/**
 * Normalize a window `error` event into an Error that carries a code and a
 * location. `event.error` is absent for cross-origin scripts and for some
 * Chromium failure paths, and passing the bare `event.message` string on landed
 * in telemetry as `StringError` with no stack — nothing to triage at all.
 *
 * Privacy: the message is only pattern-matched for its leading error class; its
 * text is never copied. The filename rides along as a stack frame, so it goes
 * through the same redaction as any other frame.
 */
export const normalizeWindowError = (report: WindowErrorReport): Error => {
  const frames = ownStackFrames(report.error)
  if (isError(report.error) && frames) return report.error

  const normalized = new Error()
  const messageClass =
    typeof report.message === 'string' ? MESSAGE_ERROR_CLASS.exec(report.message)?.[1] : undefined
  normalized.name = toSafeToken(enumishName(report.error) ?? messageClass, 'WindowError')
  const stack = frames ?? sourceFrame(report)
  if (stack) normalized.stack = stack
  return normalized
}

/**
 * Build the redacted, length-capped error detail attached to `app_error_seen`
 * desktop telemetry: the stack frames (code locations), the React component
 * stack, and the error message — each with home paths and stray identifiers
 * scrubbed. Returns undefined when there is nothing useful to send.
 *
 * The message is the one field that can carry free-form text (a note title, a
 * filename, note content), so it never ships raw: it goes through `redactText`
 * — the same module Path A log shipping uses — HERE, on the device, before it
 * ever leaves the process. `redactOptions` carries the caller's vault root and
 * salted hasher; main-process callers pass both, so placeholders correlate
 * across lines. A caller with neither (the renderer, which knows no salt) still
 * gets full redaction, just with fixed `<email>`/`<id>`/`[name].ext`
 * placeholders instead of correlatable hashes. The sync-server re-runs the same
 * redaction in mask mode as a backstop; see TelemetryErrorDetailSchema.message.
 *
 * That redaction is shape-based: a note TITLE quoted in a message with no file
 * extension is not a shape it can recognize, so this is narrower than the
 * earlier all-or-nothing "no message field at all" guarantee.
 */
export const buildErrorDetail = (
  error: unknown,
  componentStack?: string,
  redactOptions?: RedactOptions
): TelemetryErrorDetail | undefined => {
  const detail: TelemetryErrorDetail = {}
  const message = readProp(error, 'message')
  if (typeof message === 'string' && message) {
    const redacted = truncate(redactText(message, redactOptions), 512)
    if (redacted) detail.message = redacted
  }
  const stack = readProp(error, 'stack')
  const rawStack = isError(error) && typeof stack === 'string' ? stack : undefined
  if (rawStack) {
    const frames = keepStackFrameLines(rawStack)
    if (frames) detail.stack = truncate(redactSensitive(frames), 4000)
  }
  if (componentStack) {
    detail.componentStack = truncate(redactSensitive(componentStack), 2000)
  }
  return detail.message || detail.stack || detail.componentStack ? detail : undefined
}
