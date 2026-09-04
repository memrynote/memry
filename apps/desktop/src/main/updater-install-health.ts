// Cross-launch install-failure streak. macOS Squirrel.Mac stages a downloaded
// update into its own ShipIt copy, and when that copy fails (`ditto: Could not
// lstat …`, `No space left on device`) electron-updater's `error` event fires in
// a session that then quits normally. Nothing about the failure survives the
// quit, so the next launch re-serves the same cached zip to Squirrel and fails
// the same way — two production installs sat on 2026.817.1 through four releases
// with no user-facing signal at all (#1999). The shipped artifact was fine; only
// the local staging copy failed.
//
// The check-phase streak in updater-error-severity.ts can live in memory because
// its escalation window is one session. This one cannot: staging is re-attempted
// on every auto-check while an update sits downloaded (electron-updater serves
// the cached, already-validated zip via `done(false)` in AppUpdater, which
// re-dispatches `update-downloaded`), but a user who quits after one or two
// failures starts from zero on the next launch and never reaches the threshold.
// Only a file on disk carries the streak across that quit. Same conventions as
// telemetry/update-install-marker.ts and telemetry/crash-marker.ts:
// synchronous, never throws, and a corrupt or half-written file degrades to "no
// streak" rather than breaking the updater.
import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { createLogger } from './lib/logger'

const logger = createLogger('UpdateInstallHealth')

export const UPDATE_INSTALL_HEALTH_FILENAME = 'update-install-health.json'

/**
 * Failed install attempts before the user is offered the manual installer.
 * Attempts, not launches: staging is retried on every auto-check, so a
 * persistently stuck install reaches this within ~30 minutes rather than over
 * three days. Three because a single failure is the disk that was momentarily
 * full, while a higher bar only extends the silent loop this exists to break.
 */
const STUCK_INSTALL_FAILURES = 3

/**
 * Guards the version strings read back off disk before they are handed to the
 * updater state and rendered. Deliberately not `toSafeToken`: that substitutes
 * illegal characters, which would turn a hand-edited or torn-write path into a
 * plausible-looking version (`_Users_kaan_x`) instead of rejecting it.
 */
const VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

/** A streak this long is already far past the threshold; the cap only stops a
 * garbage value from being written back and growing without bound. */
const MAX_RECORDED_FAILURES = 999

interface UpdateInstallHealth {
  /**
   * Display version of the build that keeps failing to update. The one value
   * that says the streak is still live: booting as anything else means the app
   * moved on, whether via this update, a later one, or a manual install.
   */
  fromVersion: string
  /** Display version being installed. The streak is per target: a different
   * update failing once is not a stranded install. */
  targetVersion: string
  consecutiveFailures: number
  /** Latched once the streak escalated, so the user-facing dialog fires once per
   * streak instead of on every subsequent failure. */
  escalated: boolean
}

const healthPath = (): string => path.join(app.getPath('userData'), UPDATE_INSTALL_HEALTH_FILENAME)

const parseHealth = (raw: string): UpdateInstallHealth | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateInstallHealth>
    if (!parsed || typeof parsed !== 'object') return null
    const { fromVersion, targetVersion, consecutiveFailures, escalated } = parsed
    if (typeof fromVersion !== 'string' || !VERSION_TOKEN.test(fromVersion)) return null
    if (typeof targetVersion !== 'string' || !VERSION_TOKEN.test(targetVersion)) return null
    if (
      typeof consecutiveFailures !== 'number' ||
      !Number.isInteger(consecutiveFailures) ||
      consecutiveFailures < 1 ||
      consecutiveFailures > MAX_RECORDED_FAILURES
    ) {
      return null
    }
    if (typeof escalated !== 'boolean') return null
    return { fromVersion, targetVersion, consecutiveFailures, escalated }
  } catch {
    return null
  }
}

const readHealth = (): UpdateInstallHealth | null => {
  try {
    return parseHealth(fs.readFileSync(healthPath(), 'utf-8'))
  } catch {
    return null // no file: no streak, which is every install that has never failed
  }
}

const writeHealth = (health: UpdateInstallHealth): void => {
  try {
    fs.writeFileSync(healthPath(), JSON.stringify(health), 'utf-8')
  } catch (error) {
    logger.warn('Failed to persist the update-install streak; it restarts next launch', { error })
  }
}

const clearHealth = (): void => {
  try {
    fs.rmSync(healthPath(), { force: true })
  } catch (error) {
    logger.warn('Failed to clear the update-install streak', { error })
  }
}

/**
 * Count one failed install attempt for `targetVersion` and report whether this
 * is the attempt that crosses the threshold. `stuck` is true exactly once per
 * streak, matching recordUpdaterCheckFailure's latch.
 *
 * The streak resets whenever either version changes: a new target means a
 * different update, and a new `fromVersion` means an install did apply.
 */
export const recordUpdateInstallFailure = (
  fromVersion: string,
  targetVersion: string
): { consecutiveFailures: number; stuck: boolean } => {
  const existing = readHealth()
  const previous =
    existing && existing.fromVersion === fromVersion && existing.targetVersion === targetVersion
      ? existing
      : null
  const consecutiveFailures = Math.min(
    previous ? previous.consecutiveFailures + 1 : 1,
    MAX_RECORDED_FAILURES
  )
  const stuck = !previous?.escalated && consecutiveFailures >= STUCK_INSTALL_FAILURES
  writeHealth({
    fromVersion,
    targetVersion,
    consecutiveFailures,
    escalated: (previous?.escalated ?? false) || stuck
  })
  return { consecutiveFailures, stuck }
}

/**
 * Reconcile the persisted streak against the build that is actually running.
 * Call once per launch, before any install attempt.
 *
 * Returns the target version the user is still stranded on when the streak has
 * already escalated, so the manual-installer dialog comes back on every launch
 * the loop is still live — the escalation latch stops repeat *failures* from
 * re-firing it, not repeat launches. Returns null in every other case, and
 * clears the file once the app boots as a different build, which is the only
 * honest evidence that an install applied.
 */
export const reconcileUpdateInstallHealth = (currentVersion: string): string | null => {
  const health = readHealth()
  if (!health) return null
  if (health.fromVersion !== currentVersion) {
    clearHealth()
    return null
  }
  return health.escalated ? health.targetVersion : null
}
