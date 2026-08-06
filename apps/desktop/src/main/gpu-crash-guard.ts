import { app } from 'electron'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './lib/logger'
// Runs at module load, before the telemetry runtime exists; events land in the
// early buffer (telemetry/track.ts) and ship once the runtime installs.
import { trackMainLog } from './telemetry/diagnostics'

const logger = createLogger('GpuCrashGuard')

// Persisted next to the app's other guard markers. When a prior launch saw the
// GPU process die (common on old/blacklisted Windows GPUs, where the window is
// created but never composites — process alive, no visible window), we record
// it here and disable hardware acceleration on the NEXT launch so the app can
// paint via software rendering instead of stranding the user on an invisible
// window. Scoped by version so a fresh build re-attempts hardware acceleration
// (the auto-update itself becomes the retry), never permanently kneecapping it.
export interface GpuGuardMarker {
  disabledForGpu: boolean
  version: string
}

/**
 * Pure decision: should this launch disable hardware acceleration? Only when a
 * marker says a GPU crash was recorded for the version we are currently running.
 * A marker from a different version means a new build is in play — retry HW accel.
 */
export function shouldDisableHwAccel(
  marker: GpuGuardMarker | null,
  currentVersion: string
): boolean {
  if (!marker || !marker.disabledForGpu) return false
  return marker.version === currentVersion
}

function markerPath(): string {
  return join(app.getPath('userData'), 'gpu-crash-guard.json')
}

function safeVersion(): string {
  return typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0'
}

function readGpuGuard(): GpuGuardMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(), 'utf8')) as Partial<GpuGuardMarker>
    if (typeof parsed.disabledForGpu === 'boolean' && typeof parsed.version === 'string') {
      return { disabledForGpu: parsed.disabledForGpu, version: parsed.version }
    }
  } catch {
    // Missing or corrupt marker → treat as no prior GPU crash.
  }
  return null
}

function clearGpuGuard(): void {
  try {
    rmSync(markerPath(), { force: true })
  } catch (err) {
    logger.warn('failed to clear gpu-crash marker', err)
  }
}

/**
 * Called once at module load, before app 'ready'. Disables hardware acceleration
 * if a GPU crash was recorded for the current version; clears a stale marker from
 * an older version so the new build gets a fresh chance with HW accel.
 * disableHardwareAcceleration() MUST run before the app is ready, so this is a
 * synchronous, best-effort call on the startup path.
 */
export function applyGpuCrashGuard(): void {
  if (!app.isPackaged) return
  const marker = readGpuGuard()
  if (!marker) return

  if (shouldDisableHwAccel(marker, safeVersion())) {
    try {
      app.disableHardwareAcceleration()
      logger.warn('hardware acceleration disabled after a prior GPU crash on this version')
      trackMainLog('warn', { scope: 'GpuCrashGuard', action: 'hw_accel_disabled' })
    } catch (err) {
      logger.warn('failed to disable hardware acceleration', err)
    }
    return
  }

  // Marker is from an older version — a new build may render fine. Drop it so
  // this launch retries hardware acceleration.
  clearGpuGuard()
}

/**
 * Pure decision: should a `child-process-gone` event be recorded as a GPU crash?
 * Only the GPU process dying for a real fault qualifies — exclude 'clean-exit'
 * (normal shutdown) and, since Electron 40, 'memory-eviction' (OS memory-pressure
 * kill), since mis-recording either needlessly disables hardware acceleration on
 * the next launch.
 */
export function shouldRecordGpuCrash(details: { type: string; reason: string }): boolean {
  return (
    details.type === 'GPU' &&
    details.reason !== 'clean-exit' &&
    details.reason !== 'memory-eviction'
  )
}

/** Record that the GPU process died so the next launch falls back to software rendering. */
export function recordGpuCrash(): void {
  if (!app.isPackaged) return
  try {
    const marker: GpuGuardMarker = { disabledForGpu: true, version: safeVersion() }
    writeFileSync(markerPath(), JSON.stringify(marker))
    logger.warn('recorded GPU crash; hardware acceleration will be disabled on next launch')
  } catch (err) {
    logger.warn('failed to write gpu-crash marker', err)
  }
}
