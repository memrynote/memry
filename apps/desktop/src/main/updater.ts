import { app, BrowserWindow } from 'electron'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { UpdaterChannels } from '@memry/contracts/ipc-updater'
import { createLogger } from './lib/logger'
import { broadcastToAllWindows } from './lib/window-broadcast'
import { getMainI18n } from './lib/main-i18n'
import { formatAppVersionForDisplay } from './lib/app-version-display'
import { getUpdaterPrefs, setAutoCheckPref, setAutoDownloadPref, setSkippedVersion } from './store'
import { trackMainError, trackMainWarning } from './telemetry/diagnostics'
import { trackMainEvent } from './telemetry/track'
import { markUpdateInstallStarted } from './telemetry/update-install-marker'
import {
  classifyUpdaterError,
  isReadOnlyVolumeError,
  isUpdaterCheckPhase,
  recordUpdaterCheckFailure,
  recordUpdaterCheckSuccess,
  resetUpdaterCheckHealth
} from './updater-error-severity'
import { recordUpdateInstallFailure, reconcileUpdateInstallHealth } from './updater-install-health'
import type { UpdaterBackend, UpdaterHost } from './updater-backend'
import { createElectronUpdaterBackend } from './updater-backend-electron'
import { createVelopackBackend } from './updater-backend-velopack'

const logger = createLogger('Updater')

/**
 * How often to re-check for updates while the app is running when auto-check is on.
 * Short by design (10 min) so a release published while the app is open is picked up
 * within one interval — either silently downloaded (auto-download on) or surfaced via
 * the in-app prompt. The timer is unref'd and packaged-only, so it never blocks quit
 * and never polls in dev.
 */
const AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1000

/**
 * Where in the update lifecycle a failure happened. Shipped verbatim as the `phase`
 * field (see VERBATIM_FIELD_KEYS in contracts/redact) so a Loki line says whether the
 * startup check, the background check, the download, or the install is what broke.
 */
export type UpdaterErrorPhase =
  | 'startup-check'
  | 'scheduled-check'
  | 'auto-check-enable'
  | 'auto-download-enable'
  | 'check'
  | 'download'
  | 'downloaded'
  | 'install'
  | 'idle'

const ERROR_TEXT_CAP = 300
const ERROR_STACK_FRAMES = 4

const truncate = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value

/** electron-updater / node errno codes are strings; HTTP-ish libs sometimes use numbers. */
const codeOf = (error: object): string | undefined => {
  const { code } = error as { code?: unknown }
  if (typeof code === 'string' && code) return code
  if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  return undefined
}

const describeCause = (cause: unknown): string | undefined => {
  if (cause instanceof Error) {
    const code = codeOf(cause)
    return truncate(`${cause.name}: ${cause.message}${code ? ` (${code})` : ''}`, ERROR_TEXT_CAP)
  }
  return typeof cause === 'string' && cause ? truncate(cause, ERROR_TEXT_CAP) : undefined
}

/**
 * Stack frames only — the `Name: message` header is already carried by errorName /
 * errorMessage, and the shipped field value is capped at 500 chars upstream.
 */
const describeStack = (stack: unknown): string | undefined => {
  if (typeof stack !== 'string') return undefined
  const frames = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, ERROR_STACK_FRAMES)
  return frames.length > 0 ? truncate(frames.join(' | '), 400) : undefined
}

/**
 * Flatten an updater failure into log fields. Without this, `logger.error('updater
 * error', error)` shipped `{"errorName":"Error"}` and nothing else: the log-ship
 * transport keeps the first string argument as the message and never reads the
 * Error's own message/code (see telemetry/log-ship.ts parseRecord). Field names are
 * chosen against the redaction allowlist — `phase`/`errorCode` pass verbatim, `url`
 * is path-redacted (query string stripped), the rest are text-redacted and capped.
 */
export function describeUpdaterError(
  error: unknown,
  phase: UpdaterErrorPhase
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      phase,
      errorName: 'NonError',
      errorMessage: truncate(String(error), ERROR_TEXT_CAP)
    }
  }

  const source = error as Error & { statusCode?: unknown; url?: unknown; cause?: unknown }
  const status = typeof source.statusCode === 'number' ? source.statusCode : undefined
  const url = typeof source.url === 'string' && source.url ? source.url : undefined
  const code = codeOf(source)
  const cause = describeCause(source.cause)
  const stack = describeStack(source.stack)

  return {
    phase,
    errorName: error.name,
    errorMessage: truncate(error.message, ERROR_TEXT_CAP),
    ...(code ? { errorCode: code } : {}),
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(url ? { url } : {}),
    ...(cause ? { errorCause: cause } : {}),
    ...(stack ? { errorStack: stack } : {})
  }
}

/**
 * electron-updater's `error` event carries no phase of its own, so derive it from the
 * status the updater was in when it fired.
 */
/**
 * Route a failure to the telemetry severity it deserves. A background check that
 * could not reach the network is the user being offline, not a defect, so it
 * ships as a `warn` log line — queryable, but out of Error Tracking. So does an
 * app running from a read-only volume, in any phase. Everything else, plus an
 * install whose checks have been failing for a day straight, stays an exception:
 * those users cannot receive a fix. See updater-error-severity.ts.
 */
function reportUpdaterFailure(error: unknown, phase: UpdaterErrorPhase): void {
  if (!isUpdaterCheckPhase(phase)) {
    if (classifyUpdaterError(error, phase) === 'warn') {
      trackMainWarning('updater', phase, error)
      return
    }
    trackMainError('updater', phase, error)
    return
  }
  // Every failed check advances the streak, including the ones already reported
  // as errors — the streak measures "this install cannot update", not severity.
  const { consecutiveFailures, stuck } = recordUpdaterCheckFailure()
  if (stuck || classifyUpdaterError(error, phase) === 'error') {
    trackMainError('updater', phase, error)
    return
  }
  // retryCount carries the streak length so a cross-install signal can separate
  // one laptop failing 40 times from 40 laptops failing 3 times in a row.
  trackMainWarning('updater', phase, error, { retryCount: consecutiveFailures })
}

function currentErrorPhase(): UpdaterErrorPhase {
  switch (state.status) {
    case 'checking':
      return 'check'
    case 'downloading':
      return 'download'
    case 'downloaded':
      return 'downloaded'
    case 'installing':
      return 'install'
    default:
      return 'idle'
  }
}

/**
 * Count a failure that belongs to the install half of the pipeline, and surface
 * the manual-installer path once the same update has failed to install enough
 * times in a row (#1999).
 *
 * The phase is the whole gate, deliberately. `downloaded` is set only by the
 * update-downloaded handler, and electron-updater's MacUpdater hands the file to
 * Squirrel.Mac for staging in the same tick it dispatches that event — so an
 * error arriving in this state is a failed install attempt for
 * `state.availableVersion`, which is what the macOS ShipIt `ditto` failures are.
 * `install` is the explicit Restart-to-install path.
 *
 * `idle` is NOT counted even though the same failure can land there once the
 * status has moved on: it is also the phase for every error that arrives while
 * no operation is running, and padding the streak with unrelated failures would
 * hand a user the "download it manually" dialog for an update that is fine.
 * Under-counting only delays the escalation by a launch.
 */
function noteInstallAttemptFailure(phase: UpdaterErrorPhase): void {
  if (phase !== 'downloaded' && phase !== 'install') {
    return
  }
  const targetVersion = state.availableVersion
  if (!targetVersion) {
    return
  }
  const { consecutiveFailures, stuck } = recordUpdateInstallFailure(
    getCurrentDisplayVersion(),
    targetVersion
  )
  logger.warn('update install attempt failed', { targetVersion, consecutiveFailures })
  if (stuck) {
    noteFailedUpdateInstall(targetVersion)
  }
}

let initialized = false
let activeCheck: Promise<AppUpdateState> | null = null
let activeDownload: Promise<AppUpdateState> | null = null
let quitAndInstallRequested = false
let autoCheckTimer: ReturnType<typeof setInterval> | null = null
let backend: UpdaterBackend | null = null
let installOnQuitDisabledForSessionEnd = false

let state: AppUpdateState = {
  currentVersion: getCurrentDisplayVersion(),
  status: isUpdateSupported() ? 'idle' : 'unavailable',
  updateSupported: isUpdateSupported(),
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  releaseNotesHtml: null,
  downloadProgressPercent: null,
  lastCheckedAt: null,
  error: null,
  autoDownloadEnabled: false,
  autoCheckEnabled: true,
  installFailed: null
}

/**
 * The state machine seen from a backend. Every transition an update source can cause
 * goes through here, so electron-updater and Velopack drive one identical
 * `AppUpdateState` and the renderer never learns which one is installed.
 */
const host: UpdaterHost = {
  onChecking() {
    logger.info('checking for updates')
    setState({
      status: 'checking',
      error: null,
      lastCheckedAt: Date.now(),
      downloadProgressPercent: null
    })
  },

  onUpdateAvailable(update) {
    recordUpdaterCheckSuccess()
    const displayVersion = formatAppVersionForDisplay(update.version)

    // Honor "Skip This Version": suppress the prompt for a version the user
    // dismissed. A manual check from Settings clears the skip (see checkForUpdates).
    if (getUpdaterPrefs().skippedVersion === displayVersion) {
      logger.info('update available but skipped by user', { version: update.version })
      setState({
        status: 'up-to-date',
        availableVersion: null,
        releaseName: null,
        releaseDate: null,
        releaseNotes: null,
        releaseNotesHtml: null,
        downloadProgressPercent: null,
        error: null
      })
      return false
    }

    logger.info('update available', { version: update.version })
    setState({
      status: 'available',
      availableVersion: displayVersion,
      releaseName: update.releaseName,
      releaseDate: update.releaseDate,
      releaseNotes: update.releaseNotes,
      releaseNotesHtml: update.releaseNotesHtml,
      downloadProgressPercent: null,
      error: null
    })
    // No native dialog here: the renderer surfaces an in-app modal from this state.
    return true
  },

  onUpToDate() {
    recordUpdaterCheckSuccess()
    logger.info('no update available')
    setState({
      status: 'up-to-date',
      availableVersion: null,
      releaseName: null,
      releaseDate: null,
      releaseNotes: null,
      releaseNotesHtml: null,
      downloadProgressPercent: null,
      error: null
    })
  },

  onDownloadProgress(percent) {
    setState({
      status: 'downloading',
      downloadProgressPercent: Math.max(0, Math.min(100, Math.round(percent)))
    })
  },

  onDownloaded(update) {
    logger.info('update downloaded', { version: update.version })
    setState({
      status: 'downloaded',
      availableVersion: formatAppVersionForDisplay(update.version),
      releaseName: update.releaseName,
      releaseDate: update.releaseDate,
      releaseNotes: update.releaseNotes,
      releaseNotesHtml: update.releaseNotesHtml,
      downloadProgressPercent: 100,
      error: null
    })
    // No native dialog: the renderer surfaces the in-app "restart to install" modal
    // from the 'downloaded' state (Restart Now / Later).
  },

  onError(error) {
    const message =
      error instanceof Error ? error.message : getMainI18n().t('system:error.updateFailed')
    const phase = currentErrorPhase()
    // The local main.log line and the user-facing state stay at error severity:
    // only the telemetry severity is classified.
    logger.error('updater error', error, describeUpdaterError(error, phase))
    // Update-pipeline breakage (feed 404s, signature failures, disk-full
    // downloads) must reach error tracking: affected users cannot update to a fix.
    reportUpdaterFailure(error, phase)
    // The app is on the mounted DMG or a translocated ~/Downloads copy, so
    // Squirrel cannot stage anything and never will from here. Its own message
    // explains that without naming the fix, so say what to do instead. The
    // `isInApplicationsFolder()` guard is what keeps this from telling a
    // correctly installed user to move an app that is already in place; it is
    // macOS-only, so `?.()` leaves every other platform on the raw message.
    const readOnlyVolume = isReadOnlyVolumeError(error) && app.isInApplicationsFolder?.() === false
    setState({
      status: 'error',
      error: readOnlyVolume ? getMainI18n().t('system:error.updateReadOnlyVolume') : message
    })
    noteInstallAttemptFailure(phase)
  },

  currentPhase: currentErrorPhase,

  isAutoDownloadEnabled: () => state.autoDownloadEnabled
}

/**
 * One decision, once. Windows packaged builds prefer Velopack; every other platform,
 * and a Windows install that is not a Velopack install (NSIS), stays on
 * electron-updater unchanged.
 */
function selectUpdaterBackend(host: UpdaterHost): UpdaterBackend {
  if (process.platform === 'win32') {
    const velopack = createVelopackBackend(host)
    if (velopack) {
      return velopack
    }
  }
  return createElectronUpdaterBackend(host)
}

/**
 * Surface a previous session's failed install to the renderer. Called at startup
 * from the update-install marker, which runs long before initializeUpdater() —
 * setState merges, so the flag survives updater init either way.
 *
 * Without this the failure is telemetry-only: the user sees the update prompt
 * again on every launch, presses Restart again, and never learns why nothing
 * changes. With it, the renderer can offer the manual installer instead.
 */
export function noteFailedUpdateInstall(version: string | null): void {
  logger.warn('previous update install did not apply', { version })
  setState({ installFailed: { version } })
}

/**
 * Windows kills the detached installer that install-on-quit spawns when the quit
 * is part of an OS shutdown/restart/log-off — after the old install has already
 * been removed. That is how a user ends up with an install directory holding only
 * the uninstaller and a dead Start menu shortcut (#1851). When the OS session is
 * ending, skip the install-on-quit entirely: the downloaded update applies on the
 * next user-initiated quit or via the in-app Restart prompt instead.
 * `query-session-end` can fire for a shutdown that another app then cancels — the
 * cost of that false positive is one skipped silent install, which the next quit
 * picks up.
 */
function disableInstallOnSessionEnd(): void {
  if (installOnQuitDisabledForSessionEnd || !backend) {
    return
  }
  installOnQuitDisabledForSessionEnd = true
  logger.warn(
    'OS session ending — skipping install-on-quit so a killed installer cannot remove the existing install'
  )
  backend.setInstallOnQuit(false)
}

function watchWindowForSessionEnd(window: BrowserWindow): void {
  window.on('query-session-end', disableInstallOnSessionEnd)
  window.on('session-end', disableInstallOnSessionEnd)
}

function registerSessionEndInstallGuard(): void {
  if (process.platform !== 'win32') {
    return
  }
  for (const window of BrowserWindow.getAllWindows()) {
    watchWindowForSessionEnd(window)
  }
  app.on('browser-window-created', (_event, window) => {
    watchWindowForSessionEnd(window)
  })
}

export function initializeUpdater(): void {
  if (initialized || !app.isPackaged) {
    return
  }

  initialized = true
  resetUpdaterCheckHealth()
  // A streak that already escalated is re-surfaced on every launch it is still
  // live: the user stays stuck on the old build until they install manually, and
  // the escalation latch only stops repeat failures from re-firing the dialog.
  const strandedInstallVersion = reconcileUpdateInstallHealth(getCurrentDisplayVersion())
  if (strandedInstallVersion) {
    noteFailedUpdateInstall(strandedInstallVersion)
  }
  const prefs = getUpdaterPrefs()
  const autoDownloadEnabled = prefs.autoDownload ?? false
  const autoCheckEnabled = prefs.autoCheck ?? true
  backend = selectUpdaterBackend(host)
  logger.info('updater backend selected', { backend: backend.kind })
  backend.setAutoDownload(autoDownloadEnabled)
  backend.setInstallOnQuit(true)
  registerSessionEndInstallGuard()
  // A normal quit with an update already downloaded: the backend applies it in
  // place, without relaunching. The Restart-to-install path goes through
  // performQuitAndInstall() instead, which must not install twice.
  app.on('will-quit', () => {
    if (state.status === 'downloaded' && !quitAndInstallRequested) {
      backend?.applyOnQuit()
    }
  })
  setState({ autoDownloadEnabled, autoCheckEnabled })

  if (autoCheckEnabled) {
    startAutoCheckTimer()
    void checkForUpdates().catch((error) => {
      logger.warn(
        'startup update check failed',
        error,
        describeUpdaterError(error, 'startup-check')
      )
    })
  }
}

/**
 * Schedule the recurring background check. No-op if already running so toggling or
 * re-init never stacks intervals. The timer is unref'd so a pending tick never blocks
 * app quit.
 */
function startAutoCheckTimer(): void {
  if (autoCheckTimer) {
    return
  }
  autoCheckTimer = setInterval(() => {
    void checkForUpdates().catch((error) => {
      logger.warn(
        'scheduled update check failed',
        error,
        describeUpdaterError(error, 'scheduled-check')
      )
    })
  }, AUTO_CHECK_INTERVAL_MS)
  autoCheckTimer.unref?.()
}

function stopAutoCheckTimer(): void {
  if (autoCheckTimer) {
    clearInterval(autoCheckTimer)
    autoCheckTimer = null
  }
}

export function getUpdateState(): AppUpdateState {
  return { ...state }
}

export async function checkForUpdates(options?: {
  /** Clear a previously skipped version so it can surface again (manual checks). */
  clearSkip?: boolean
}): Promise<AppUpdateState> {
  const activeBackend = backend
  if (!state.updateSupported || !activeBackend) {
    return getUpdateState()
  }

  if (options?.clearSkip) {
    setSkippedVersion(null)
  }

  if (activeCheck) {
    return activeCheck
  }

  activeCheck = activeBackend
    .check()
    .then(() => getUpdateState())
    .finally(() => {
      activeCheck = null
    })

  return activeCheck
}

export async function downloadUpdate(): Promise<AppUpdateState> {
  const activeBackend = backend
  if (!state.updateSupported || !activeBackend) {
    return getUpdateState()
  }

  if (state.status === 'downloaded') {
    return getUpdateState()
  }

  if (activeDownload) {
    return activeDownload
  }

  logger.info('starting update download')
  setState({
    status: 'downloading',
    error: null,
    downloadProgressPercent: state.downloadProgressPercent ?? 0
  })

  activeDownload = activeBackend
    .download()
    .then(() => getUpdateState())
    .finally(() => {
      activeDownload = null
    })

  return activeDownload
}

/**
 * Persist the current available version as skipped and clear the available state
 * so neither the modal nor the sidebar button re-surface it. Automatic checks stay
 * suppressed for this version; a manual "Check for updates" clears the skip.
 */
export function skipVersion(version: string): AppUpdateState {
  logger.info('skipping update version', { version })
  setSkippedVersion(version)
  trackMainEvent('setting_changed', {
    surface: 'updater',
    action: 'changed',
    dimensions: { setting: 'skip_version' }
  })
  setState({
    status: 'up-to-date',
    availableVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    releaseNotesHtml: null,
    downloadProgressPercent: null,
    error: null
  })
  return getUpdateState()
}

/**
 * Toggle automatic download + install. Persists the choice, applies it to the
 * running updater, and — if enabling while an update already waits — starts the
 * download immediately.
 */
export function setAutoDownloadEnabled(enabled: boolean): AppUpdateState {
  logger.info('setting auto-download preference', { enabled })
  setAutoDownloadPref(enabled)
  trackMainEvent('setting_changed', {
    surface: 'updater',
    action: 'changed',
    dimensions: { setting: 'auto_download' }
  })
  backend?.setAutoDownload(enabled)
  setState({ autoDownloadEnabled: enabled })
  // Close the gap where an update is already waiting: opting in should not leave that
  // update stuck behind the manual Download button, so start its download now.
  if (enabled && state.status === 'available') {
    void downloadUpdate().catch((error) => {
      logger.warn(
        'auto-download on-enable download failed',
        error,
        describeUpdaterError(error, 'auto-download-enable')
      )
    })
  }
  return getUpdateState()
}

/**
 * Toggle automatic update checks. Persists the choice, then starts/stops the
 * recurring background check. Enabling also fires an immediate check so the user
 * gets instant feedback instead of waiting for the next interval.
 */
export function setAutoCheckEnabled(enabled: boolean): AppUpdateState {
  logger.info('setting auto-check preference', { enabled })
  setAutoCheckPref(enabled)
  trackMainEvent('setting_changed', {
    surface: 'updater',
    action: 'changed',
    dimensions: { setting: 'auto_check' }
  })
  if (enabled) {
    startAutoCheckTimer()
    void checkForUpdates().catch((error) => {
      logger.warn(
        'auto-check enable update check failed',
        error,
        describeUpdaterError(error, 'auto-check-enable')
      )
    })
  } else {
    stopAutoCheckTimer()
  }
  setState({ autoCheckEnabled: enabled })
  return getUpdateState()
}

export function quitAndInstall(): void {
  if (state.status !== 'downloaded') {
    throw new Error('No downloaded update is ready to install')
  }

  logger.info('quitting to install update', { version: state.availableVersion })
  quitAndInstallRequested = true
  // Flip the UI to a dedicated "Installing update…" screen immediately, before the
  // window starts tearing down. Without this the frozen window (and any vault
  // teardown underneath) reads as a hang / broken vault picker.
  setState({ status: 'installing' })
  // Trigger the app's graceful shutdown first. Handing off to the installer
  // directly here is cancelled by the before-quit handler (event.preventDefault +
  // app.exit), so the update never installs and the app re-prompts on every launch.
  // The shutdown handler calls performQuitAndInstall() once cleanup completes.
  app.quit()
}

export function isQuitAndInstallRequested(): boolean {
  return quitAndInstallRequested
}

// Performs the real install + relaunch. Must run only after the app's graceful
// shutdown (vault close, write-back flush) has completed.
export function performQuitAndInstall(): void {
  // Last chance to leave evidence: the installer runs after this process exits,
  // and the shutdown chain has already disposed the telemetry runtime and the
  // log-ship transport, so an install failure from here on reaches nobody. The
  // next launch reads this marker and reports the install that never applied.
  markUpdateInstallStarted(getCurrentVersion(), state.availableVersion ?? undefined)
  backend?.applyAndRestart()
}

function setState(patch: Partial<AppUpdateState>): void {
  state = {
    ...state,
    ...patch,
    currentVersion: getCurrentDisplayVersion(),
    updateSupported: isUpdateSupported()
  }
  broadcastState()
}

function getCurrentVersion(): string {
  return typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0'
}

function getCurrentDisplayVersion(): string {
  return formatAppVersionForDisplay(getCurrentVersion())
}

function isUpdateSupported(): boolean {
  return app.isPackaged === true
}

function broadcastState(): void {
  const snapshot = getUpdateState()
  broadcastToAllWindows(UpdaterChannels.events.STATE_CHANGED, snapshot)
}
