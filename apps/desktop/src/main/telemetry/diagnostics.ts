import type { TelemetryErrorDetail, TelemetryResult } from '@memry/contracts/telemetry-api'
import {
  buildErrorDetail,
  normalizeRejectionReason,
  toErrorCode,
  toSafeToken
} from '@memry/contracts/telemetry-api'

import { isExpectedConditionError } from './expected-conditions'
import { getMainRedactOptions } from './redact-options'
import { shouldEmitThrottled } from './throttle'
import { trackMainEvent, type TrackMainEventOptions } from './track'

type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

const resultForLevel = (level: DiagnosticLevel): TelemetryResult =>
  level === 'error' || level === 'warn' ? 'failed' : 'success'

/**
 * What the module that owned the dead worker knows about it. Everything here is
 * a number, a bounded enum, or text the OWNER has already redacted — this module
 * only formats it.
 *
 * Additive by construction: every field is optional and rides inside the
 * existing `message` / `metrics` fields of `app_log_recorded`. No new event
 * name, no new dimension key, no contract change — so it needs no sync-server
 * deploy and cannot break an existing dashboard query.
 */
export interface ChildProcessGoneContext {
  /** OS pid of the dead worker, so reports can be tied to one fork. */
  pid?: number
  /** ms between the fork and this report. */
  uptimeMs?: number
  /** How the owning module last saw the worker (live, teardown, start_timeout, …). */
  release?: string
  /** Whether the worker's model was cached on disk when it was forked. */
  modelCache?: string
  modelCacheBytes?: number
  /** Whether the fork was a first load or a re-load after a prior failure. */
  load?: string
  /** Crash reports for this worker family this session, including this one. */
  crashCount?: number
  /**
   * Redacted tail of the dead worker's stderr. For a native abort this is the
   * closest thing to a stack trace this family can ever produce: the process
   * that died is not the one reporting, so `stack` is otherwise always empty.
   */
  stderrTail?: string
}

export interface ChildProcessGoneDetails {
  type: string
  reason: string
  // The MOJO interface name. Constant by construction — every utilityProcess
  // fork reports 'node.mojom.NodeService', so it cannot tell our workers apart.
  serviceName?: string
  // Where Electron actually routes the fork's `serviceName` OPTION, i.e. our
  // 'Embeddings' / 'ImageProcessing' / 'VoiceTranscription' labels. A fork that
  // passes no option (crdt-preflight) reports the default 'Node Utility Process'.
  name?: string
  // Platform exit status: on POSIX this carries the signal (11 SIGSEGV, 6 SIGABRT).
  exitCode?: number
  // Where the worker was in its own lifecycle when it died, when the owning
  // module can resolve it (see getEmbeddingWorkerPhase). Resolved by the caller
  // rather than looked up here: the worker modules already import this one, so
  // reaching back into them would close an import cycle.
  phase?: string
  // Resolved by the same caller, for the same reason.
  context?: ChildProcessGoneContext
}

// Utility workers (embeddings, image-processing, voice-model) idle-shutdown
// cleanly after ~30s; a clean exit — and, since Electron 40, a 'memory-eviction'
// (OS memory-pressure kill) — is lifecycle, not a fault, so it must not become an
// error event. Real faults get a composite code that stays inside the safe-token
// rules (no '@', '://', '/', '\', ≤64 chars).
export const isChildProcessFault = (reason: string): boolean =>
  reason !== 'clean-exit' && reason !== 'memory-eviction'

export const childProcessGoneErrorCode = (details: ChildProcessGoneDetails): string | null => {
  if (!isChildProcessFault(details.reason)) return null
  const worker = details.name ?? details.serviceName ?? ''
  return toSafeToken(`${details.type}:${details.reason}:${worker}`, 'ChildProcessGone')
}

// Telemetry events carry at most ONE dimension (TelemetryDimensionsSchema), and
// `log_action` already holds the phase — so the rest of the crash context rides
// in the message as `key=value` pairs. Bounded enums and numbers only; the
// owning module supplies them and no user content can reach here.
const contextSummary = (
  reason: string,
  context: ChildProcessGoneContext | undefined
): string | null => {
  // No context resolved (GPU, an unowned utility fork) → the message stays byte
  // identical to what it has always been. This is purely additive.
  if (!context) return null
  const parts = [
    // Baked into the error code as `type:reason:worker`, repeated here so it can
    // be read without string-splitting the fingerprint.
    `reason=${reason}`,
    context.pid !== undefined ? `pid=${context.pid}` : null,
    context.uptimeMs !== undefined ? `uptime=${Math.round(context.uptimeMs)}ms` : null,
    context.release ? `release=${context.release}` : null,
    context.modelCache ? `cache=${context.modelCache}` : null,
    context.modelCacheBytes !== undefined ? `cache_bytes=${context.modelCacheBytes}` : null,
    context.load ? `load=${context.load}` : null,
    context.crashCount !== undefined ? `crashes=${context.crashCount}` : null
  ].filter((part): part is string => part !== null)
  return `[${parts.join(' ')}]`
}

// Reports a `child-process-gone` fault as an error log event, or nothing at all
// for a clean idle-worker exit. Kept here (not inline in index.ts) so the
// skip decision is unit-tested rather than living in the untested bootstrap.
export const trackChildProcessGone = (details: ChildProcessGoneDetails): void => {
  const errorCode = childProcessGoneErrorCode(details)
  if (!errorCode) return
  // A dead child process leaves no JS stack in this one, so PostHog Error
  // Tracking has no frames to render for this family — and it is the largest one
  // in production. The message is the only "what happened" the issue page gets,
  // so it spells out the worker, the reason and the exit status. Every part is an
  // Electron constant or our own worker label: no user content can reach it.
  const worker = details.name ?? details.serviceName ?? details.type
  // Phase joins the exit status in the message, and the log_action dimension, but
  // deliberately NOT the errorCode: that is the Error Tracking fingerprint, and
  // splitting it per phase would orphan the history of every existing issue.
  const detail = [
    typeof details.exitCode === 'number' ? `exit ${details.exitCode}` : null,
    details.phase ?? null
  ].filter((part): part is string => part !== null)
  const exit = detail.length > 0 ? ` (${detail.join(', ')})` : ''
  const summary = contextSummary(details.reason, details.context)
  // Bounded by TelemetryErrorDetailSchema.message (512). Every part is an
  // Electron constant, our own worker label, or a number, so it cannot overflow
  // in practice — the cap is there so a future field can never 400 a whole batch.
  const message = `${worker} utility process ${details.reason}${exit}${
    summary ? ` ${summary}` : ''
  }`.slice(0, 512)
  // The crash context's numbers ride as metrics so they are queryable without
  // parsing the message. All four keys already exist in TelemetryMetricsSchema.
  const metrics: NonNullable<Parameters<typeof trackMainLog>[1]['metrics']> = {}
  if (typeof details.exitCode === 'number') metrics.value = details.exitCode
  if (typeof details.context?.uptimeMs === 'number') {
    metrics.durationMs = Math.max(0, Math.round(details.context.uptimeMs))
  }
  if (typeof details.context?.crashCount === 'number') {
    metrics.retryCount = Math.max(0, details.context.crashCount)
  }
  if (typeof details.context?.modelCacheBytes === 'number') {
    metrics.byteCount = Math.max(0, details.context.modelCacheBytes)
  }
  const error: TelemetryErrorDetail = { message }
  // The dead worker's own stderr. Capped again here (schema max 4000) because
  // this is native-runtime output and the owner's cap is the only other guard.
  if (details.context?.stderrTail) error.stack = details.context.stderrTail.slice(0, 4000)
  // errorCode stays stable (no exit code baked in) so the issue grouping counts
  // crashes per worker; the exit status rides along as a metric instead.
  trackMainLog('error', {
    scope: 'Electron',
    action: details.phase ? `child_process_gone_${details.phase}` : 'child_process_gone',
    errorCode,
    error,
    metrics: Object.keys(metrics).length > 0 ? metrics : undefined
  })
}

export const trackMainError = (source: string, action: string, error: unknown): void => {
  // Expected conditions (Ollama not running, an abandoned OAuth flow) still
  // reach the UI as an error envelope, but they are normal states — reporting
  // them here drowns the real signal.
  if (isExpectedConditionError(error)) return

  trackMainEvent('app_error_seen', {
    surface: 'app',
    action: toSafeToken(action, 'error'),
    objectType: 'exception',
    source: toSafeToken(source, 'main_process'),
    result: 'failed',
    errorCode: toErrorCode(error),
    error: buildErrorDetail(error, undefined, getMainRedactOptions())
  })
}

/**
 * Report a failure that is a normal condition rather than a defect: it stays
 * fully queryable as an `app_log_recorded` `warn`, but never lands in Error
 * Tracking. Same error-code derivation and same on-device redaction as
 * trackMainError — only the severity moves, so nothing is lost by the demotion
 * and the volume itself is still the diagnostic (issue #1587).
 */
export const trackMainWarning = (
  source: string,
  action: string,
  error: unknown,
  metrics?: { retryCount?: number }
): void => {
  if (isExpectedConditionError(error)) return

  trackMainLog('warn', {
    scope: source,
    action,
    errorCode: toErrorCode(error),
    error: buildErrorDetail(error, undefined, getMainRedactOptions()),
    metrics
  })
}

// A rejection reason can be any value — a string, a plain object, or a
// cross-realm Error that fails `instanceof Error` — and those carry no stack,
// landing in telemetry as an unactionable bare `Error` with an empty stack.
// Normalizing first guarantees a stack and a code naming the reason's type.
// Kept here (not inline in index.ts) so it is unit-tested rather than living in
// the untested bootstrap.
export const trackMainUnhandledRejection = (reason: unknown): void => {
  trackMainError('main_process', 'unhandled_rejection', normalizeRejectionReason(reason))
}

export const trackMainLog = (
  level: DiagnosticLevel,
  options: {
    scope: string
    action: string
    errorCode?: string
    error?: TelemetryErrorDetail
    metrics?: {
      durationMs?: number
      itemCount?: number
      byteCount?: number
      queueCount?: number
      retryCount?: number
      value?: number
    }
  }
): void => {
  const eventOptions: TrackMainEventOptions = {
    surface: 'app',
    action: level,
    objectType: 'log',
    source: toSafeToken(options.scope, 'main_process'),
    result: resultForLevel(level),
    dimensions: { log_action: toSafeToken(options.action, 'event') }
  }

  if (options.errorCode) {
    eventOptions.errorCode = toSafeToken(options.errorCode, 'LogError')
  }
  if (options.error) {
    eventOptions.error = options.error
  }
  if (options.metrics) {
    eventOptions.metrics = options.metrics
  }

  trackMainEvent('app_log_recorded', eventOptions)
}

/**
 * Count a local body edit as note_updated. Body edits flow through the CRDT
 * provider, not the notes UPDATE IPC, so typing never registered as usage.
 * The throttle key deliberately matches notes-handlers.ts UPDATE so metadata
 * and body edits share one 5-minute window per note. Only the throttle key
 * sees the note id; the event itself carries no identifier.
 */
export const trackNoteBodyEditThrottled = (noteId: string): void => {
  if (!shouldEmitThrottled(`note_updated:${noteId}`)) return
  trackMainEvent('note_updated', {
    surface: 'notes',
    action: 'updated',
    objectType: 'note',
    source: 'editor_body',
    result: 'success'
  })
}

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export const startActiveHeartbeat = (isFocused: () => boolean): void => {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    if (!isFocused()) return
    trackMainEvent('app_active_heartbeat', {
      surface: 'app',
      action: 'heartbeat',
      metrics: { activeSeconds: HEARTBEAT_INTERVAL_MS / 1000 }
    })
  }, HEARTBEAT_INTERVAL_MS)
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref()
  }
}

export const stopActiveHeartbeat = (): void => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

export const trackLaunchPhase = (phase: string, durationMs: number): void => {
  trackMainEvent('app_launch_phase_completed', {
    surface: 'app',
    action: toSafeToken(phase, 'phase'),
    source: 'main_process',
    result: 'success',
    metrics: { durationMs: Math.max(0, Math.round(durationMs)) }
  })
}
