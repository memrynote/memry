import { app, BrowserWindow, dialog } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { UpdaterChannels } from '@memry/contracts/ipc-updater'
import { createLogger } from './lib/logger'
import { getMainI18n } from './lib/main-i18n'
import { formatAppVersionForDisplay } from './lib/app-version-display'
import { htmlToPlainText } from './lib/html-to-plain-text'

const logger = createLogger('Updater')

let initialized = false
let activeCheck: Promise<AppUpdateState> | null = null
let activeDownload: Promise<AppUpdateState> | null = null
let downloadPromptVisible = false
let restartPromptVisible = false
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
  error: null
}

export function initializeUpdater(): void {
  if (initialized || !app.isPackaged) {
    return
  }

  initialized = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

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
    logger.info('update available', { version: info.version })
    const displayVersion = formatUpdateVersion(info)
    setState({
      status: 'available',
      availableVersion: displayVersion,
      releaseName: info.releaseName ?? null,
      releaseDate: info.releaseDate ?? null,
      releaseNotes: normalizeReleaseNotes(info),
      downloadProgressPercent: null,
      error: null
    })
    void promptToDownload(info)
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
    void promptToRestart(info)
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

export async function checkForUpdates(): Promise<AppUpdateState> {
  if (!state.updateSupported) {
    return getUpdateState()
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

async function promptToDownload(info: UpdateInfo): Promise<void> {
  if (downloadPromptVisible) {
    return
  }

  downloadPromptVisible = true
  try {
    const t = getMainI18n().getFixedT(null, 'system')
    const detail = buildPromptDetail(info, t('dialog.update.availableDetailFallback'))
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: [t('dialog.update.buttonDownload'), t('dialog.update.buttonLater')],
      defaultId: 0,
      cancelId: 1,
      title: t('dialog.update.availableTitle'),
      message: t('dialog.update.availableMessage', { version: formatUpdateVersion(info) }),
      detail
    })

    if (result.response === 0) {
      await downloadUpdate()
    }
  } finally {
    downloadPromptVisible = false
  }
}

async function promptToRestart(info: UpdateInfo): Promise<void> {
  if (restartPromptVisible) {
    return
  }

  restartPromptVisible = true
  try {
    const t = getMainI18n().getFixedT(null, 'system')
    const detail = buildPromptDetail(info, t('dialog.update.readyDetailFallback'))
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: [t('dialog.update.buttonRestartNow'), t('dialog.update.buttonLater')],
      defaultId: 0,
      cancelId: 1,
      title: t('dialog.update.readyTitle'),
      message: t('dialog.update.readyMessage', { version: formatUpdateVersion(info) }),
      detail
    })

    if (result.response === 0) {
      quitAndInstall()
    }
  } finally {
    restartPromptVisible = false
  }
}

function buildPromptDetail(info: UpdateInfo, fallback: string): string {
  const notes = normalizeReleaseNotes(info)
  if (!notes) {
    return fallback
  }

  const t = getMainI18n().getFixedT(null, 'system')
  const trimmedNotes = notes.length > 1200 ? `${notes.slice(0, 1197)}...` : notes
  return `${fallback}\n\n${t('dialog.update.releaseNotesLabel')}\n${trimmedNotes}`
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
