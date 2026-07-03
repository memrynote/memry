import { app, BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { UpdaterChannels } from '@memry/contracts/ipc-updater'
import { createLogger } from './lib/logger'
import { getMainI18n } from './lib/main-i18n'
import { formatAppVersionForDisplay } from './lib/app-version-display'
import { htmlToPlainText } from './lib/html-to-plain-text'
import { getUpdaterPrefs, setAutoDownloadPref, setSkippedVersion } from './store'

const logger = createLogger('Updater')

let initialized = false
let activeCheck: Promise<AppUpdateState> | null = null
let activeDownload: Promise<AppUpdateState> | null = null
let quitAndInstallRequested = false

let state: AppUpdateState = {
  currentVersion: getCurrentDisplayVersion(),
  status: isUpdateSupported() ? 'idle' : 'unavailable',
  updateSupported: isUpdateSupported(),
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  downloadProgressPercent: null,
  lastCheckedAt: null,
  error: null,
  autoDownloadEnabled: false
}

export function initializeUpdater(): void {
  if (initialized || !app.isPackaged) {
    return
  }

  initialized = true
  const prefs = getUpdaterPrefs()
  const autoDownloadEnabled = prefs.autoDownload ?? false
  autoUpdater.autoDownload = autoDownloadEnabled
  autoUpdater.autoInstallOnAppQuit = true
  setState({ autoDownloadEnabled })

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

  void checkForUpdates().catch((error) => {
    logger.warn('startup update check failed', error)
  })
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
  // Applies to future checks ("in the future"): electron-updater reads autoDownload
  // when the next update-available fires. The currently-available update is left for
  // the user to start with the Download button.
  autoUpdater.autoDownload = enabled
  setState({ autoDownloadEnabled: enabled })
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
