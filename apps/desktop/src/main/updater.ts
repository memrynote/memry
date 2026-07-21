import { app, BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { UpdaterChannels } from '@memry/contracts/ipc-updater'
import { createLogger } from './lib/logger'
import { getMainI18n } from './lib/main-i18n'
import { formatAppVersionForDisplay } from './lib/app-version-display'
import { htmlToPlainText } from './lib/html-to-plain-text'
import { getUpdaterPrefs, setAutoCheckPref, setAutoDownloadPref, setSkippedVersion } from './store'

const logger = createLogger('Updater')

/**
 * How often to re-check for updates while the app is running when auto-check is on.
 * Short by design (10 min) so a release published while the app is open is picked up
 * within one interval — either silently downloaded (auto-download on) or surfaced via
 * the in-app prompt. The timer is unref'd and packaged-only, so it never blocks quit
 * and never polls in dev.
 */
const AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1000

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
  autoCheckEnabled: true
}

export function initializeUpdater(): void {
  if (initialized || !app.isPackaged) {
    return
  }

  initialized = true
  const prefs = getUpdaterPrefs()
  const autoDownloadEnabled = prefs.autoDownload ?? false
  const autoCheckEnabled = prefs.autoCheck ?? true
  autoUpdater.autoDownload = autoDownloadEnabled
  autoUpdater.autoInstallOnAppQuit = true
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
    logger.error('updater error', error)
    setState({
      status: 'error',
      error: message
    })
  })

  if (autoCheckEnabled) {
    startAutoCheckTimer()
    void checkForUpdates().catch((error) => {
      logger.warn('startup update check failed', error)
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
      logger.warn('scheduled update check failed', error)
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

  activeCheck = autoUpdater
    .checkForUpdates()
    .then(() => getUpdateState())
    .finally(() => {
      activeCheck = null
    })

  return activeCheck
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
  // electron-updater reads autoDownload only when the NEXT update-available fires.
  autoUpdater.autoDownload = enabled
  setState({ autoDownloadEnabled: enabled })
  // Close the gap where an update is already waiting: opting in should not leave that
  // update stuck behind the manual Download button, so start its download now.
  if (enabled && state.status === 'available') {
    void downloadUpdate().catch((error) => {
      logger.warn('auto-download on-enable download failed', error)
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
  if (enabled) {
    startAutoCheckTimer()
    void checkForUpdates().catch((error) => {
      logger.warn('auto-check enable update check failed', error)
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
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(UpdaterChannels.events.STATE_CHANGED, snapshot)
  })
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
