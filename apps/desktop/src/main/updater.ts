import { app, BrowserWindow, dialog } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { UpdaterChannels } from '@memry/contracts/ipc-updater'
import { createLogger } from './lib/logger'

const logger = createLogger('Updater')

let initialized = false
let activeCheck: Promise<AppUpdateState> | null = null
let activeDownload: Promise<AppUpdateState> | null = null
let downloadPromptVisible = false
let restartPromptVisible = false

let state: AppUpdateState = {
  currentVersion: getCurrentVersion(),
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
    setState({
      status: 'available',
      availableVersion: info.version,
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
    setState({
      status: 'downloaded',
      availableVersion: info.version,
      releaseName: info.releaseName ?? null,
      releaseDate: info.releaseDate ?? null,
      releaseNotes: normalizeReleaseNotes(info),
      downloadProgressPercent: 100,
      error: null
    })
    void promptToRestart(info)
  })

  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : 'Update failed'
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
  setImmediate(() => autoUpdater.quitAndInstall())
}

function setState(patch: Partial<AppUpdateState>): void {
  state = {
    ...state,
    ...patch,
    currentVersion: getCurrentVersion(),
    updateSupported: isUpdateSupported()
  }
  broadcastState()
}

function getCurrentVersion(): string {
  return typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0'
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
    const detail = buildPromptDetail(info, 'Download the update now?')
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `Memry ${info.version} is available.`,
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
    const detail = buildPromptDetail(info, 'Restart Memry to finish installing the update.')
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Memry ${info.version} has been downloaded.`,
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

  const trimmedNotes = notes.length > 1200 ? `${notes.slice(0, 1197)}...` : notes
  return `${fallback}\n\nRelease notes:\n${trimmedNotes}`
}

function normalizeReleaseNotes(info: UpdateInfo): string | null {
  const { releaseNotes } = info

  if (!releaseNotes) {
    return null
  }

  if (typeof releaseNotes === 'string') {
    return releaseNotes.trim() || null
  }

  const combined = releaseNotes
    .map((entry) => {
      const heading = entry.version ? `${entry.version}\n` : ''
      return `${heading}${entry.note}`.trim()
    })
    .filter(Boolean)
    .join('\n\n')

  return combined || null
}
