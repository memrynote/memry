// Failed-update-install detection. The NSIS/Squirrel installer runs AFTER this
// process exits, and the shutdown chain disposes the telemetry runtime and the
// log-ship transport before handing off — so when an install fails (elevation
// refused, installer aborted because a process still held the install dir, AV
// quarantine) electron-updater's error lands in a disposed runtime and reaches
// nobody. The result is silence: zero updater errors in error tracking while
// the reporting user's version never moves.
//
// This marker inverts that, like crash-marker does for hard crashes: written
// synchronously at the install handoff, read on the next launch. Still running
// the version that started the install means the install did not apply.
import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { createLogger } from '../lib/logger'
import { trackMainEvent } from './track'

const logger = createLogger('UpdateInstallMarker')

export const UPDATE_INSTALL_MARKER_FILENAME = 'update-install-attempt.json'

interface UpdateInstallAttempt {
  /**
   * Raw `app.getVersion()` of the build that handed off to the installer — the
   * one value the next launch can compare itself against. Never the display
   * version, which does not match `app.getVersion()`.
   */
  fromVersion: string
  /** Display version being installed. Reported as-is; never compared. */
  toVersion?: string
  startedAt: string
}

const markerPath = (): string => path.join(app.getPath('userData'), UPDATE_INSTALL_MARKER_FILENAME)

const parseAttempt = (raw: string): UpdateInstallAttempt | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateInstallAttempt>
    if (!parsed || typeof parsed.fromVersion !== 'string' || !parsed.fromVersion) return null
    return {
      fromVersion: parsed.fromVersion,
      toVersion: typeof parsed.toVersion === 'string' ? parsed.toVersion : undefined,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : ''
    }
  } catch {
    return null
  }
}

/**
 * Record that this build just handed off to the update installer. Called on the
 * quit path, so the write must be synchronous — the process is about to exit —
 * and must never throw: losing the marker only costs a diagnostic, while
 * throwing here would break the install itself.
 */
export const markUpdateInstallStarted = (fromVersion: string, toVersion?: string): void => {
  try {
    const attempt: UpdateInstallAttempt = {
      fromVersion,
      ...(toVersion ? { toVersion } : {}),
      startedAt: new Date().toISOString()
    }
    fs.writeFileSync(markerPath(), JSON.stringify(attempt), 'utf-8')
  } catch (error) {
    logger.warn('Failed to record update-install attempt; a failed install will go undetected', {
      error
    })
  }
}

/**
 * Emit `app_error_seen` when the previous launch handed off an install that
 * never applied. Call once per launch, after the telemetry runtime initializes.
 * The marker is consumed on every launch whatever the verdict, so a stale one
 * can neither accumulate nor report the same failure twice.
 */
export const detectFailedUpdateInstall = (currentVersion: string): void => {
  let raw: string
  try {
    raw = fs.readFileSync(markerPath(), 'utf-8')
  } catch {
    return // no attempt recorded: normal launch
  }

  try {
    fs.rmSync(markerPath(), { force: true })
  } catch (error) {
    logger.warn('Failed to clear update-install marker; the next launch may re-report', { error })
  }

  const attempt = parseAttempt(raw)
  // A corrupt marker proves an install was attempted but not from WHICH
  // version, and without that the applied/failed split is a coin flip.
  if (!attempt) return
  // Booted as a different build: the installer did its job.
  if (attempt.fromVersion !== currentVersion) return

  const startedAt = Date.parse(attempt.startedAt)
  const durationMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : undefined

  logger.error('update install did not apply; still running the version that started it', {
    fromVersion: attempt.fromVersion,
    toVersion: attempt.toVersion
  })
  trackMainEvent('app_error_seen', {
    surface: 'app',
    action: 'install',
    objectType: 'exception',
    source: 'updater',
    result: 'failed',
    errorCode: 'UPDATE_INSTALL_DID_NOT_APPLY',
    metrics: durationMs === undefined ? undefined : { durationMs },
    dimensions: {
      prior_app_version: attempt.fromVersion,
      ...(attempt.toVersion ? { target_app_version: attempt.toVersion } : {})
    }
  })
}
