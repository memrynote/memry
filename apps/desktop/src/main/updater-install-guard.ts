import { app } from 'electron'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from './lib/logger'

const logger = createLogger('UpdaterGuard')

// Must match electron-builder `appId` (config/electron-builder.yml). Squirrel.Mac
// keeps its ShipIt install state under ~/Library/Caches/<bundleId>.ShipIt/.
const MAC_BUNDLE_ID = 'com.memrynote.memry'

// A pending install is only "in flight" for a bounded window. Past this, a
// leftover marker or ShipItState.plist is stale (aborted install, crash, or an
// abandoned Restart) and must NOT trigger the guard — otherwise the app could
// refuse to open. The real install window is ~11s; 5 min is a generous ceiling.
const PENDING_INSTALL_FRESH_MS = 5 * 60 * 1000

interface InstallMarker {
  // Version that initiated the install. If the running app still reports this
  // version, ShipIt has not swapped us to the new build yet (we are the old
  // version the user relaunched mid-install). A differing version means the
  // install already succeeded and we are the freshly-launched new build.
  fromVersion: string
  createdAt: number
}

function markerPath(): string {
  return join(app.getPath('userData'), 'pending-update-install.json')
}

/**
 * Record that an update install was just handed off to Squirrel from this
 * version. Read on the next launch to detect a manual relaunch of the old
 * build while ShipIt is still installing. macOS + packaged only; the write is
 * best-effort and must never break the install path.
 */
export function writePendingInstallMarker(fromVersion: string, now = Date.now()): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  try {
    const marker: InstallMarker = { fromVersion, createdAt: now }
    writeFileSync(markerPath(), JSON.stringify(marker))
  } catch (err) {
    logger.warn('failed to write pending-install marker', err)
  }
}

/** Remove the pending-install marker once a normal boot commits. */
export function clearPendingInstallMarker(): void {
  try {
    rmSync(markerPath(), { force: true })
  } catch (err) {
    logger.warn('failed to clear pending-install marker', err)
  }
}

function readPendingInstallMarker(): InstallMarker | null {
  try {
    const raw = readFileSync(markerPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<InstallMarker>
    if (typeof parsed.fromVersion === 'string' && typeof parsed.createdAt === 'number') {
      return { fromVersion: parsed.fromVersion, createdAt: parsed.createdAt }
    }
  } catch {
    // Missing or corrupt marker → treat as no pending install.
  }
  return null
}

function shipItStatePlistPath(): string {
  return join(homedir(), 'Library/Caches', `${MAC_BUNDLE_ID}.ShipIt`, 'ShipItState.plist')
}

function statShipItPlist(): { exists: boolean; mtimeMs: number | null } {
  try {
    const st = statSync(shipItStatePlistPath())
    return { exists: true, mtimeMs: st.mtimeMs }
  } catch {
    return { exists: false, mtimeMs: null }
  }
}

function isShipItProcessAlive(): boolean {
  try {
    // pgrep -f matches the full command line; Squirrel launches ShipIt with the
    // launchd label "<bundleId>.ShipIt" as an argv entry, so it is unambiguous.
    // Exit status 1 (no match) makes execFileSync throw → caught below.
    const out = execFileSync('pgrep', ['-f', `${MAC_BUNDLE_ID}.ShipIt`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // This runs synchronously on the startup path — never let a hung pgrep
      // block boot. A timeout throws, which we treat as "not alive" (safe: the
      // guard just doesn't fire and the app boots normally).
      timeout: 2000
    })
    return out.trim().length > 0
  } catch {
    return false
  }
}

export interface PendingInstallInput {
  marker: InstallMarker | null
  currentVersion: string
  now: number
  plistExists: boolean
  plistMtimeMs: number | null
  shipItProcessAlive: boolean
  freshMs?: number
}

/**
 * Pure decision: should the app show the "Installing update…" guard instead of
 * booting normally? Fires only when every signal agrees a ShipIt install is
 * genuinely in flight for the build the user just relaunched. Kept side-effect
 * free so the full truth table is unit-tested without Electron or the disk.
 */
export function shouldGuardForPendingInstall(input: PendingInstallInput): boolean {
  const freshMs = input.freshMs ?? PENDING_INSTALL_FRESH_MS
  const { marker } = input
  if (!marker) return false
  // We must still be the version that started the install. A different version
  // means ShipIt already swapped in the new build — nothing to wait for.
  if (marker.fromVersion !== input.currentVersion) return false
  // Bounded freshness: an old marker is a leftover from an aborted/abandoned
  // install and must not lock the app on the installing screen.
  if (input.now - marker.createdAt > freshMs) return false
  // Confirm a ShipIt install is actually running right now. Without this a
  // failed install would strand the user on "Installing…" with no way out.
  if (!input.shipItProcessAlive) return false
  // Corroborate with a fresh ShipItState.plist so a stray pgrep match on its
  // own cannot fire the guard.
  if (!input.plistExists || input.plistMtimeMs === null) return false
  if (input.now - input.plistMtimeMs > freshMs) return false
  return true
}

/**
 * True when a Squirrel/ShipIt update install started from this same version is
 * still running — i.e. the user relaunched the old build mid-install. Cheap
 * marker/stat checks short-circuit before the pgrep call, so a normal boot
 * never shells out.
 */
export function isPendingInstallInFlight(now = Date.now()): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) return false

  const marker = readPendingInstallMarker()
  if (!marker) return false
  const currentVersion = app.getVersion()
  if (marker.fromVersion !== currentVersion) return false
  if (now - marker.createdAt > PENDING_INSTALL_FRESH_MS) return false

  const { exists: plistExists, mtimeMs: plistMtimeMs } = statShipItPlist()
  if (!plistExists || plistMtimeMs === null) return false
  if (now - plistMtimeMs > PENDING_INSTALL_FRESH_MS) return false

  return shouldGuardForPendingInstall({
    marker,
    currentVersion,
    now,
    plistExists,
    plistMtimeMs,
    shipItProcessAlive: isShipItProcessAlive()
  })
}
