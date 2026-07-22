// One-per-launch startup phase timeline. Prod installs hit the 10s
// 'ready-to-show' fallback (#843) and the logs only said the deadline was
// missed, never which phase ate the time. Each phase stamps its offset from
// process start here; the reveal emits them as a single structured line so a
// slow launch is attributable from one log record.
import { createLogger } from './lib/logger'
import { trackLaunchPhase } from './telemetry/diagnostics'

const launchStartedAt = Date.now()
const startupLog = createLogger('Startup')

// Only warn/error records reach the diagnostic log sink, so a healthy launch
// stays local-only and pathological ones ship for triage.
const SLOW_LAUNCH_MS = 5_000

export type LaunchPhase =
  | 'app_ready'
  | 'window_created'
  | 'vault_open_start'
  | 'vault_open_ready'
  | 'window_did_finish_load'
  | 'window_ready_to_show'
  | 'window_shown'

// Field names are the summary line's schema; the numeric ones are allowlisted
// in the shared redaction module so they ship as numbers, not scrubbed text.
const PHASE_FIELDS: Array<[LaunchPhase, string]> = [
  ['app_ready', 'appReadyMs'],
  ['window_created', 'windowCreatedMs'],
  ['vault_open_start', 'vaultOpenStartMs'],
  ['vault_open_ready', 'vaultOpenReadyMs'],
  ['window_did_finish_load', 'rendererLoadedMs'],
  ['window_ready_to_show', 'readyToShowMs'],
  ['window_shown', 'shownMs']
]

const marks = new Map<LaunchPhase, number>()
let reported = false

/**
 * Stamp a launch phase and forward it as the per-phase telemetry event.
 * A phase can repeat (a macOS dock reopen re-creates the window, a reload
 * re-fires did-finish-load); the timeline only ever describes the first one.
 */
export const recordLaunchPhase = (phase: LaunchPhase): void => {
  const elapsedMs = Math.max(0, Date.now() - launchStartedAt)
  if (!marks.has(phase)) marks.set(phase, elapsedMs)
  trackLaunchPhase(phase, elapsedMs)
}

/**
 * Emit the timeline once, at the moment the window is revealed — the point the
 * user stops staring at nothing. `reason` names what revealed it, so a
 * fallback reveal and a normal one are one field apart in the log sink.
 */
export const reportLaunchTimeline = (reason: string): void => {
  if (reported) return
  reported = true

  const fields: Record<string, number | string | boolean> = { reason }
  for (const [phase, field] of PHASE_FIELDS) {
    const at = marks.get(phase)
    if (at !== undefined) fields[field] = at
  }

  fields.fallback = reason === 'fallback-timeout'
  // Vault open runs concurrently with renderer load. Still running at reveal
  // makes it the prime suspect for a blocked main process, so say so instead
  // of leaving the reader to infer it from a missing field.
  fields.vaultOpenPending = marks.has('vault_open_start') && !marks.has('vault_open_ready')

  const shownMs = marks.get('window_shown') ?? 0
  const slow = fields.fallback === true || shownMs >= SLOW_LAUNCH_MS
  if (slow) startupLog.warn('launch timeline', fields)
  else startupLog.info('launch timeline', fields)
}
