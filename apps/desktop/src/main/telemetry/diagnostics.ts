import type { TelemetryResult } from '@memry/contracts/telemetry-api'
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
}

// Utility workers (embeddings, image-processing, voice-model) idle-shutdown
// cleanly after ~30s; a clean exit — and, since Electron 40, a 'memory-eviction'
// (OS memory-pressure kill) — is lifecycle, not a fault, so it must not become an
// error event. Real faults get a composite code that stays inside the safe-token
// rules (no '@', '://', '/', '\', ≤64 chars).
export const childProcessGoneErrorCode = (details: ChildProcessGoneDetails): string | null => {
  if (details.reason === 'clean-exit' || details.reason === 'memory-eviction') return null
  const worker = details.name ?? details.serviceName ?? ''
  return toSafeToken(`${details.type}:${details.reason}:${worker}`, 'ChildProcessGone')
}

// Reports a `child-process-gone` fault as an error log event, or nothing at all
// for a clean idle-worker exit. Kept here (not inline in index.ts) so the
// skip decision is unit-tested rather than living in the untested bootstrap.
export const trackChildProcessGone = (details: ChildProcessGoneDetails): void => {
  const errorCode = childProcessGoneErrorCode(details)
  if (!errorCode) return
  // errorCode stays stable (no exit code baked in) so Grafana can count crashes
  // per worker; the exit status rides along as a metric instead.
  trackMainLog('error', {
    scope: 'Electron',
    action: 'child_process_gone',
    errorCode,
    metrics: typeof details.exitCode === 'number' ? { value: details.exitCode } : undefined
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
    metrics?: {
      durationMs?: number
      itemCount?: number
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
