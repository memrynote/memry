import { app, BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { UpdaterChannels } from '@memry/contracts/ipc-updater'
import { createLogger } from './lib/logger'
import { broadcastToAllWindows } from './lib/window-broadcast'
import { getMainI18n } from './lib/main-i18n'
import { formatAppVersionForDisplay } from './lib/app-version-display'
import { htmlToPlainText } from './lib/html-to-plain-text'
import { getUpdaterPrefs, setAutoCheckPref, setAutoDownloadPref, setSkippedVersion } from './store'
import { trackMainError, trackMainWarning } from './telemetry/diagnostics'
import { trackMainEvent } from './telemetry/track'
import { markUpdateInstallStarted } from './telemetry/update-install-marker'
import {
  classifyUpdaterError,
  isExpiredSignedAssetError,
  isUpdaterCheckPhase,
  recordUpdaterCheckFailure,
  recordUpdaterCheckSuccess,
  resetUpdaterCheckHealth
} from './updater-error-severity'

const logger = createLogger('Updater')

/**
 * electron-updater defaults its own logger to `console` (AppUpdater sets it at
 * construction), and a packaged build has no console attached — so its
 * diagnostics went nowhere. That is the half of the update pipeline we never
 * see: "Cannot run installer: error code: EACCES/UNKNOWN/ENOENT", the
 * elevate.exe retry, differential-download fallbacks. Routing them into the app
 * log makes a user's main.log answer why an update did not install.
 */
const libraryLogger = createLogger('ElectronUpdater')
const updaterLibraryLogger = {
  info: (message?: unknown) => logMessage('info', message),
  warn: (message?: unknown) => logMessage('warn', message),
  error: (message?: unknown) => logMessage('error', message),
  debug: (message?: unknown) => logMessage('debug', message)
}

function logMessage(level: 'info' | 'warn' | 'error' | 'debug', message?: unknown): void {
  // electron-updater passes arbitrary values here; best-effort stringify for the log line.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  libraryLogger[level](typeof message === 'string' ? message : String(message ?? ''))
}

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
 * ships as a `warn` log line — queryable, but out of Error Tracking. Everything
 * else, plus an install whose checks have been failing for a day straight, stays
 * an exception: those users cannot receive a fix. See updater-error-severity.ts.
 */
function reportUpdaterFailure(error: unknown, phase: UpdaterErrorPhase): void {
  if (!isUpdaterCheckPhase(phase)) {
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
 * Extra attempts for a check that died on an expired GitHub signed-asset URL,
 * and the pause before each. A check is three small GETs, so asking again is
 * cheap; the delay is there because the expiry is a timing race, not a state we
 * can observe. Bounded at two so a genuinely refused asset still fails within
 * seconds instead of retrying forever.
 */
const SIGNED_ASSET_RETRY_ATTEMPTS = 2
const SIGNED_ASSET_RETRY_DELAY_MS = 2_000

/**
 * Retries still available for the in-flight check. electron-updater emits its
 * `error` event *before* checkForUpdates() rejects, so without this the first
 * attempt would already have flipped the UI to `error` and shipped an exception
 * for a failure we are about to recover from. Zero whenever no check is running,
 * so a download- or install-phase failure is never suppressed.
 */
let signedAssetRetriesLeft = 0

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let initialized = false
let activeCheck: Promise<AppUpdateState> | null = null
let activeDownload: Promise<AppUpdateState> | null = null
let quitAndInstallRequested = false
let autoCheckTimer: ReturnType<typeof setInterval> | null = null

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
 * Windows kills the detached NSIS installer that autoInstallOnAppQuit spawns
 * when the quit is part of an OS shutdown/restart/log-off — after the old
 * install has already been removed. That is how a user ends up with an install
 * directory holding only the uninstaller and a dead Start menu shortcut
 * (#1851). When the OS session is ending, skip the install-on-quit entirely:
 * the downloaded update applies on the next user-initiated quit or via the
 * in-app Restart prompt instead. `query-session-end` can fire for a shutdown
 * that another app then cancels — the cost of that false positive is one
 * skipped silent install, which the next quit picks up.
 */
function disableInstallOnSessionEnd(): void {
  if (!autoUpdater.autoInstallOnAppQuit) {
    return
  }
  logger.warn(
    'OS session ending — skipping install-on-quit so a killed installer cannot remove the existing install'
  )
  autoUpdater.autoInstallOnAppQuit = false
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
  autoUpdater.logger = updaterLibraryLogger
  const prefs = getUpdaterPrefs()
  const autoDownloadEnabled = prefs.autoDownload ?? false
  const autoCheckEnabled = prefs.autoCheck ?? true
  autoUpdater.autoDownload = autoDownloadEnabled
  autoUpdater.autoInstallOnAppQuit = true
  registerSessionEndInstallGuard()
  setState({ autoDownloadEnabled, autoCheckEnabled })

  autoUpdater.on('checking-for-update', () => {
    logger.info('checking for updates')
    setState({
      status: 'checking',
      error: null,
      lastCheckedAt: Date.now(),
      downloadProgressPercent: null
    })
  })

  autoUpdater.on('update-available', (info) => {
    recordUpdaterCheckSuccess()
    const displayVersion = formatUpdateVersion(info)

    // Honor "Skip This Version": suppress the prompt for a version the user
    // dismissed. A manual check from Settings clears the skip (see checkForUpdates).
    if (getUpdaterPrefs().skippedVersion === displayVersion) {
      logger.info('update available but skipped by user', { version: info.version })
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
      return
    }

    logger.info('update available', { version: info.version })
    setState({
      status: 'available',
      availableVersion: displayVersion,
      releaseName: info.releaseName ?? null,
      releaseDate: info.releaseDate ?? null,
      releaseNotes: normalizeReleaseNotes(info),
      releaseNotesHtml: rawReleaseNotesHtml(info),
      downloadProgressPercent: null,
      error: null
    })
    // No native dialog here: the renderer surfaces an in-app modal from this state.
    // When auto-download is on, electron-updater downloads automatically (autoDownload=true),
    // so the state flows straight to 'downloading' without prompting.
  })

  autoUpdater.on('update-not-available', () => {
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
  })

  autoUpdater.on('download-progress', (progress) => {
    setState({
      status: 'downloading',
      downloadProgressPercent: Math.max(0, Math.min(100, Math.round(progress.percent)))
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    logger.info('update downloaded', { version: info.version })
    const displayVersion = formatUpdateVersion(info)
    setState({
      status: 'downloaded',
      availableVersion: displayVersion,
      releaseName: info.releaseName ?? null,
      releaseDate: info.releaseDate ?? null,
      releaseNotes: normalizeReleaseNotes(info),
      releaseNotesHtml: rawReleaseNotesHtml(info),
      downloadProgressPercent: 100,
      error: null
    })
    // No native dialog: the renderer surfaces the in-app "restart to install" modal
    // from the 'downloaded' state (Restart Now / Later).
  })

  autoUpdater.on('error', (error) => {
    const message =
      error instanceof Error ? error.message : getMainI18n().t('system:error.updateFailed')
    const phase = currentErrorPhase()
    // An expired signed release-asset URL is a token that aged out mid-redirect,
    // not a broken update. runUpdateCheck() is about to ask GitHub again for a
    // fresh one, so leave the user-facing state and the telemetry alone —
    // surfacing a failure we then recover from is the noise, not the signal.
    if (
      signedAssetRetriesLeft > 0 &&
      isUpdaterCheckPhase(phase) &&
      isExpiredSignedAssetError(error)
    ) {
      logger.warn(
        'update check hit an expired release-asset url, retrying',
        error,
        describeUpdaterError(error, phase)
      )
      return
    }
    // The local main.log line and the user-facing state stay at error severity:
    // only the telemetry severity is classified.
    logger.error('updater error', error, describeUpdaterError(error, phase))
    // Update-pipeline breakage (feed 404s, signature failures, disk-full
    // downloads) must reach error tracking: affected users cannot update to a fix.
    reportUpdaterFailure(error, phase)
    setState({
      status: 'error',
      error: message
    })
  })

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
  if (!state.updateSupported) {
    return getUpdateState()
  }

  if (options?.clearSkip) {
    setSkippedVersion(null)
  }

  if (activeCheck) {
    return activeCheck
  }

  activeCheck = runUpdateCheck()
    .then(() => getUpdateState())
    .finally(() => {
      activeCheck = null
    })

  return activeCheck
}

/**
 * Run the check, asking again when GitHub's signed release-asset URL expired
 * between the redirect and the follow-up GET (status 618, `jwt:expired`).
 * electron-updater does not retry that itself, so a single aged-out token used
 * to lose the whole check — 36 production exceptions across four releases, all
 * in the check phase. Only the final attempt reaches the `error` handler.
 */
async function runUpdateCheck(): Promise<void> {
  try {
    for (let attempt = 0; ; attempt += 1) {
      signedAssetRetriesLeft = SIGNED_ASSET_RETRY_ATTEMPTS - attempt
      try {
        await autoUpdater.checkForUpdates()
        return
      } catch (error) {
        if (signedAssetRetriesLeft <= 0 || !isExpiredSignedAssetError(error)) {
          throw error
        }
        await delay(SIGNED_ASSET_RETRY_DELAY_MS * (attempt + 1))
      }
    }
  } finally {
    signedAssetRetriesLeft = 0
  }
}

export async function downloadUpdate(): Promise<AppUpdateState> {
  if (!state.updateSupported) {
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

  activeDownload = autoUpdater
    .downloadUpdate()
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
  // electron-updater reads autoDownload only when the NEXT update-available fires.
  autoUpdater.autoDownload = enabled
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
  // Trigger the app's graceful shutdown first. Calling autoUpdater.quitAndInstall()
  // directly here is cancelled by the before-quit handler (event.preventDefault +
  // app.exit), so the update never installs and the app re-prompts on every launch.
  // The shutdown handler calls performQuitAndInstall() once cleanup completes.
  app.quit()
}

export function isQuitAndInstallRequested(): boolean {
  return quitAndInstallRequested
}

// Performs the real Squirrel/NSIS install + relaunch. Must run only after the
// app's graceful shutdown (vault close, write-back flush) has completed.
// (isSilent=true, isForceRunAfter=true): install with no visible NSIS window
// (adds /S) and relaunch afterwards (adds --force-run). macOS Squirrel relaunches
// regardless; the flags only affect the Windows NSIS installer.
export function performQuitAndInstall(): void {
  // Last chance to leave evidence: the installer runs after this process exits,
  // and the shutdown chain has already disposed the telemetry runtime and the
  // log-ship transport, so an install failure from here on reaches nobody. The
  // next launch reads this marker and reports the install that never applied.
  markUpdateInstallStarted(getCurrentVersion(), state.availableVersion ?? undefined)
  autoUpdater.quitAndInstall(true, true)
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

function formatUpdateVersion(info: UpdateInfo): string {
  return formatAppVersionForDisplay(info.version)
}

function isUpdateSupported(): boolean {
  return app.isPackaged === true
}

function broadcastState(): void {
  const snapshot = getUpdateState()
  broadcastToAllWindows(UpdaterChannels.events.STATE_CHANGED, snapshot)
}

function stripDeveloperChangelog(text: string): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.trim().toLowerCase() === 'changelog')
  if (index === -1) {
    return text
  }
  return lines.slice(0, index).join('\n').trimEnd()
}

/**
 * The full release-notes body kept verbatim (HTML from the update feed) for the
 * read-only "release notes" tab. Unlike normalizeReleaseNotes, this does NOT convert
 * to plain text or strip the developer changelog, so the tab keeps the clickable PR
 * references / Full Changelog link. For array feeds each entry is prefixed with its
 * version heading.
 */
function rawReleaseNotesHtml(info: UpdateInfo): string | null {
  const { releaseNotes } = info

  if (!releaseNotes) {
    return null
  }

  if (typeof releaseNotes === 'string') {
    return releaseNotes.trim() || null
  }

  const combined = releaseNotes
    .map((entry) => {
      const heading = entry.version ? `<h3>${formatAppVersionForDisplay(entry.version)}</h3>\n` : ''
      return `${heading}${entry.note ?? ''}`.trim()
    })
    .filter(Boolean)
    .join('\n')

  return combined || null
}

function normalizeReleaseNotes(info: UpdateInfo): string | null {
  const { releaseNotes } = info

  if (!releaseNotes) {
    return null
  }

  if (typeof releaseNotes === 'string') {
    return stripDeveloperChangelog(htmlToPlainText(releaseNotes)) || null
  }

  const combined = releaseNotes
    .map((entry) => {
      const heading = entry.version ? `${formatAppVersionForDisplay(entry.version)}\n` : ''
      return `${heading}${stripDeveloperChangelog(htmlToPlainText(entry.note ?? ''))}`.trim()
    })
    .filter(Boolean)
    .join('\n\n')

  return combined || null
}
