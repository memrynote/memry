// Unclean-shutdown detection. A hard crash (main-process abort, OOM kill,
// force-quit) discards the in-memory telemetry queue, so the crash itself never
// ships — the classic "it crashed and there are no logs" report. The marker
// file inverts that: written at startup, refreshed while alive, removed on
// clean quit. A marker still present at the NEXT launch means the previous
// session died uncleanly, and that launch emits `app_crashed` on its behalf.
import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { createLogger } from '../lib/logger'
import { trackMainEvent } from './track'

const logger = createLogger('CrashMarker')

export const CRASH_MARKER_FILENAME = 'session-marker.json'
const ALIVE_INTERVAL_MS = 60_000

export type ShutdownFailureReason = 'timeout' | 'cleanup_error'

interface SessionMarker {
  sessionId: string
  startedAt: string
  lastAliveAt: string
  appVersion?: string
  // Set when a shutdown was ATTEMPTED but failed (budget exhausted / cleanup
  // chain rejected) before the forced exit — distinguishes "shutdown hung" from
  // a hard crash on the next launch's report.
  shutdownFailure?: ShutdownFailureReason
  // The shutdown step that was still running when the budget ran out. Without
  // it every timeout landed as one undifferentiated SHUTDOWN_TIMEOUT and there
  // was no way to tell "the chain as a whole was too slow" from "this one step
  // hangs on this user's machine" (#1586). Optional: markers written by older
  // builds simply do not carry it.
  shutdownStep?: string
}

// Guards what may become part of an errorCode. Step names are ours and bounded,
// but the marker is a file on disk: anything that survived a hand edit or a torn
// write must degrade to the plain code rather than ship as a dimension value.
const SHUTDOWN_STEP_TOKEN = /^[a-z][a-z0-9-]{0,39}$/

// The marker's string fields, as they may appear in a shipped message. This
// REJECTS rather than substitutes: `toSafeToken` would turn a stray
// /Users/kaan/secret.md into _Users_kaan_secret_md, which still leaks its
// structure — the same reasoning TYPED_ERROR_CODE is built on.
const MARKER_FIELD_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

const markerField = (value: string | undefined, fallback: string): string =>
  value && MARKER_FIELD_TOKEN.test(value) ? value : fallback

const shutdownTimeoutCode = (step: string | undefined): string =>
  step && SHUTDOWN_STEP_TOKEN.test(step)
    ? `SHUTDOWN_TIMEOUT_${step.replace(/-/g, '_').toUpperCase()}`
    : 'SHUTDOWN_TIMEOUT'

let aliveTimer: ReturnType<typeof setInterval> | null = null
// Only the process that WROTE a marker may remove one: a short-lived second
// instance (single-instance lock loser) shares userData and must not erase the
// primary's marker on its way out.
let installedThisSession = false

const markerPath = (): string => path.join(app.getPath('userData'), CRASH_MARKER_FILENAME)

const parseMarker = (raw: string): SessionMarker | null => {
  try {
    const parsed = JSON.parse(raw) as SessionMarker
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const priorSessionDurationMs = (marker: SessionMarker): number | undefined => {
  const startedAt = Date.parse(marker.startedAt)
  const lastAliveAt = Date.parse(marker.lastAliveAt)
  if (!Number.isFinite(startedAt) || !Number.isFinite(lastAliveAt)) return undefined
  return Math.max(0, lastAliveAt - startedAt)
}

/**
 * Emit `app_crashed` if the previous session left its marker behind. Call once
 * per launch, after the telemetry runtime initializes and BEFORE
 * installCrashMarker writes this session's own marker.
 */
export const detectUncleanShutdown = (): void => {
  let raw: string | null = null
  try {
    raw = fs.readFileSync(markerPath(), 'utf-8')
  } catch {
    return // no marker: the previous session quit cleanly (or first launch)
  }

  // The marker's PRESENCE is the crash signal; its contents only enrich the
  // event. An unparseable marker still reports the crash, just without the
  // observed-uptime metric.
  const marker = parseMarker(raw)
  const durationMs = marker ? priorSessionDurationMs(marker) : undefined
  // The overrunning step rides in the errorCode, not in a dimension: telemetry
  // ships at most ONE dimension per event, and that slot already carries
  // prior_app_version. The SHUTDOWN_TIMEOUT prefix is preserved so existing
  // dashboards keep matching.
  const errorCode =
    marker?.shutdownFailure === 'timeout'
      ? shutdownTimeoutCode(marker.shutdownStep)
      : marker?.shutdownFailure === 'cleanup_error'
        ? 'SHUTDOWN_CLEANUP_FAILED'
        : 'UNCLEAN_SHUTDOWN'
  // The errorCode alone is the whole Error Tracking issue title, so an
  // UNCLEAN_SHUTDOWN row said nothing about which session died or where (#1989).
  //
  // Every interpolated field is bounded before it lands here, and the join is
  // capped, for the same reason SHUTDOWN_STEP_TOKEN exists: the marker is a file
  // on disk, and a hand edit or a torn write can put anything in these fields.
  // An over-512 message fails TelemetryErrorDetailSchema at the sync-server,
  // which 400s the WHOLE batch — and the client classifies 4xx as permanently
  // rejected, so up to 100 unrelated events would be dropped every launch until
  // the marker cleared.
  const message = [
    `Unclean shutdown [failure=${markerField(marker?.shutdownFailure, 'none')}]`,
    `[step=${markerField(marker?.shutdownStep, 'unknown')}]`,
    `[prior_version=${markerField(marker?.appVersion, 'unknown')}]`,
    `[uptime_ms=${durationMs ?? 'unknown'}]`,
    `[marker=${marker ? 'parsed' : 'unreadable'}]`
  ]
    .join(' ')
    .slice(0, 512)

  trackMainEvent('app_crashed', {
    surface: 'app',
    action: 'unclean_shutdown',
    source: 'main_process',
    result: 'failed',
    errorCode,
    error: { message },
    metrics: durationMs === undefined ? undefined : { durationMs },
    dimensions: marker?.appVersion ? { prior_app_version: marker.appVersion } : undefined
  })
}

/**
 * Write this session's marker and keep its lastAliveAt fresh, so a later crash
 * report carries how long the session survived. Never throws — a read-only
 * disk must not break startup.
 */
export const installCrashMarker = (sessionId: string, appVersion?: string): void => {
  const startedAt = new Date().toISOString()
  const write = (): void => {
    const marker: SessionMarker = {
      sessionId,
      startedAt,
      lastAliveAt: new Date().toISOString(),
      ...(appVersion ? { appVersion } : {})
    }
    fs.writeFileSync(markerPath(), JSON.stringify(marker), 'utf-8')
  }

  try {
    write()
  } catch (error) {
    logger.warn('Failed to write crash marker; unclean shutdowns will go undetected', { error })
    return
  }
  installedThisSession = true

  aliveTimer = setInterval(() => {
    try {
      write()
    } catch {
      // Transient write failure: the previous lastAliveAt stays on disk, which
      // only under-reports the session duration — never worth logging per tick.
    }
  }, ALIVE_INTERVAL_MS)
  if (typeof aliveTimer.unref === 'function') aliveTimer.unref()
}

/**
 * Stamp the marker with the shutdown-failure reason right before a forced
 * exit, so the next launch's app_crashed says "shutdown hung/failed" instead
 * of a generic unclean exit. The process is about to app.exit(); the shipped
 * log line for this failure never flushes, but the marker survives.
 *
 * `step` names the shutdown step that was still running, which is what turns
 * "shutdown was slow somewhere" into an answer.
 */
export const markShutdownFailure = (reason: ShutdownFailureReason, step?: string): void => {
  if (!installedThisSession) return
  try {
    const raw = fs.readFileSync(markerPath(), 'utf-8')
    const marker = parseMarker(raw)
    if (!marker) return
    marker.shutdownFailure = reason
    if (step) marker.shutdownStep = step
    marker.lastAliveAt = new Date().toISOString()
    fs.writeFileSync(markerPath(), JSON.stringify(marker), 'utf-8')
  } catch {
    // The plain marker still reports UNCLEAN_SHUTDOWN — losing only the reason.
  }
}

/** Remove the marker on clean shutdown so the next launch reports nothing. */
export const clearCrashMarker = (): void => {
  if (aliveTimer) {
    clearInterval(aliveTimer)
    aliveTimer = null
  }
  if (!installedThisSession) return
  installedThisSession = false
  try {
    fs.rmSync(markerPath(), { force: true })
  } catch (error) {
    logger.warn('Failed to clear crash marker; next launch may report a false crash', { error })
  }
}
