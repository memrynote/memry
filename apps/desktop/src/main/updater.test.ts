import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class MockEmitter {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    emit(event: string, ...args: unknown[]): boolean {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args)
      }
      return true
    }

    removeAllListeners(): this {
      this.listeners.clear()
      return this
    }
  }

  const emitter = new MockEmitter()
  const storeState: { prefs: { skippedVersion?: string; autoDownload?: boolean } } = { prefs: {} }
  return {
    storeState,
    store: {
      getUpdaterPrefs: vi.fn(() => storeState.prefs),
      setSkippedVersion: vi.fn((version: string | null) => {
        storeState.prefs = { ...storeState.prefs, skippedVersion: version ?? undefined }
      }),
      setAutoDownloadPref: vi.fn((enabled: boolean) => {
        storeState.prefs = { ...storeState.prefs, autoDownload: enabled }
      })
    },
    app: {
      isPackaged: true,
      getVersion: vi.fn(() => '1.2.3'),
      quit: vi.fn()
    },
    windows: [
      {
        webContents: {
          send: vi.fn()
        }
      }
    ],
    dialog: {
      showMessageBox: vi.fn()
    },
    autoUpdater: Object.assign(emitter, {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn()
    })
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: {
    getAllWindows: () => mocks.windows
  },
  dialog: mocks.dialog
}))

vi.mock('electron-updater', () => ({
  autoUpdater: mocks.autoUpdater
}))

vi.mock('./store', () => ({
  getUpdaterPrefs: mocks.store.getUpdaterPrefs,
  setSkippedVersion: mocks.store.setSkippedVersion,
  setAutoDownloadPref: mocks.store.setAutoDownloadPref
}))

vi.mock('./lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('./lib/main-i18n', () => ({
  getMainI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ''}`,
    getFixedT:
      () =>
      (key: string, values?: Record<string, unknown>): string =>
        `${key}${values ? JSON.stringify(values) : ''}`
  })
}))

vi.mock('./lib/app-version-display', () => ({
  formatAppVersionForDisplay: (version: string) => `v${version}`
}))

async function loadUpdater() {
  vi.resetModules()
  return import('./updater')
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('updater', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState.prefs = {}
    mocks.autoUpdater.removeAllListeners()
    mocks.autoUpdater.autoDownload = true
    mocks.autoUpdater.autoInstallOnAppQuit = false
    mocks.autoUpdater.checkForUpdates.mockResolvedValue(undefined)
    mocks.autoUpdater.downloadUpdate.mockResolvedValue(undefined)
    mocks.autoUpdater.quitAndInstall.mockImplementation(() => undefined)
    mocks.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    mocks.app.isPackaged = true
    mocks.app.getVersion.mockReturnValue('1.2.3')
    mocks.app.quit.mockClear()
    mocks.windows[0].webContents.send.mockClear()
  })

  it('keeps updater unavailable outside packaged builds', async () => {
    mocks.app.isPackaged = false
    const updater = await loadUpdater()

    updater.initializeUpdater()

    expect(updater.getUpdateState()).toMatchObject({
      currentVersion: 'v1.2.3',
      status: 'unavailable',
      updateSupported: false
    })
    await expect(updater.checkForUpdates()).resolves.toMatchObject({ status: 'unavailable' })
    await expect(updater.downloadUpdate()).resolves.toMatchObject({ status: 'unavailable' })
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('initializes packaged updater and broadcasts state changes from updater events', async () => {
    const updater = await loadUpdater()

    updater.initializeUpdater()
    mocks.autoUpdater.emit('checking-for-update')
    expect(updater.getUpdateState()).toMatchObject({
      status: 'checking',
      error: null,
      downloadProgressPercent: null
    })

    mocks.autoUpdater.emit('update-not-available')
    expect(updater.getUpdateState()).toMatchObject({
      status: 'up-to-date',
      availableVersion: null
    })

    mocks.autoUpdater.emit('download-progress', { percent: 120.4 })
    expect(updater.getUpdateState()).toMatchObject({
      status: 'downloading',
      downloadProgressPercent: 100
    })

    mocks.autoUpdater.emit('error', new Error('network failed'))
    expect(updater.getUpdateState()).toMatchObject({
      status: 'error',
      error: 'network failed'
    })
    expect(mocks.windows[0].webContents.send).toHaveBeenCalled()
    expect(mocks.autoUpdater.autoDownload).toBe(false)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('exposes available-update state without a native prompt or auto-download', async () => {
    const updater = await loadUpdater()

    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.4',
      releaseName: 'Memrynote 1.2.4',
      releaseDate: '2026-05-10',
      releaseNotes: [{ version: '1.2.4', note: 'Desktop sync fixes' }, { note: 'Calendar fixes' }]
    })
    await flushAsyncWork()

    // The in-app modal renders from this state — no native OS dialog, and the
    // download waits for the user (auto-download off by default).
    expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.getUpdateState()).toMatchObject({
      status: 'available',
      availableVersion: 'v1.2.4',
      releaseName: 'Memrynote 1.2.4',
      releaseDate: '2026-05-10',
      autoDownloadEnabled: false,
      error: null
    })
    expect(updater.getUpdateState().releaseNotes).toContain('Desktop sync fixes')
  })

  it('strips HTML from release notes exposed in the update state', async () => {
    const updater = await loadUpdater()

    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.6',
      releaseNotes: '<h2>Fixes</h2><ul><li>Sync fix</li><li>Calendar fix</li></ul>'
    })
    await flushAsyncWork()

    const { releaseNotes } = updater.getUpdateState()
    expect(releaseNotes).toContain('Sync fix')
    expect(releaseNotes).toContain('• Calendar fix')
    expect(releaseNotes).not.toMatch(/<[^>]+>/)
    expect(releaseNotes).toBe('Fixes\n• Sync fix\n• Calendar fix')
  })

  it('strips the developer changelog from string release notes', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.4',
      releaseNotes:
        '<h2>Fixes</h2><ul><li>Sync fix</li></ul><h2>Changelog</h2><p>Full Changelog: https://x</p><p>#123 title @a</p>'
    })
    expect(updater.getUpdateState().releaseNotes).toBe('Fixes\n• Sync fix')
  })

  it('strips the developer changelog from array release notes', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.4',
      releaseNotes: [
        { note: '<h2>Fixes</h2><ul><li>Sync fix</li></ul><h2>Changelog</h2><p>#1 x</p>' }
      ]
    })
    expect(updater.getUpdateState().releaseNotes).toBe('Fixes\n• Sync fix')
  })

  it('leaves curated-only notes untouched', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.4',
      releaseNotes: '<h2>New Features</h2><ul><li>Calendar sync</li></ul>'
    })
    expect(updater.getUpdateState().releaseNotes).toBe('New Features\n• Calendar sync')
  })

  it('skips a version: clears the current prompt and suppresses it on re-check', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    mocks.autoUpdater.emit('update-available', { version: '1.2.4', releaseNotes: 'notes' })
    expect(updater.getUpdateState().status).toBe('available')

    const next = updater.skipVersion('v1.2.4')
    expect(mocks.store.setSkippedVersion).toHaveBeenCalledWith('v1.2.4')
    expect(next.status).toBe('up-to-date')
    expect(next.availableVersion).toBeNull()

    // The same version re-emitted stays suppressed (no 'available').
    mocks.autoUpdater.emit('update-available', { version: '1.2.4', releaseNotes: 'notes' })
    expect(updater.getUpdateState().status).toBe('up-to-date')

    // A different version still surfaces.
    mocks.autoUpdater.emit('update-available', { version: '1.2.5', releaseNotes: 'notes' })
    expect(updater.getUpdateState()).toMatchObject({
      status: 'available',
      availableVersion: 'v1.2.5'
    })
  })

  it('clears a skipped version on a manual (clearSkip) check', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()
    updater.skipVersion('v1.2.4')

    await updater.checkForUpdates({ clearSkip: true })
    expect(mocks.store.setSkippedVersion).toHaveBeenCalledWith(null)
  })

  it('persists and applies the auto-download preference', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    const next = updater.setAutoDownloadEnabled(true)
    expect(mocks.store.setAutoDownloadPref).toHaveBeenCalledWith(true)
    expect(mocks.autoUpdater.autoDownload).toBe(true)
    expect(next.autoDownloadEnabled).toBe(true)
  })

  it('honors a persisted auto-download preference at startup', async () => {
    mocks.storeState.prefs = { autoDownload: true }
    const updater = await loadUpdater()
    updater.initializeUpdater()

    expect(mocks.autoUpdater.autoDownload).toBe(true)
    expect(updater.getUpdateState().autoDownloadEnabled).toBe(true)
  })

  it('coalesces manual checks and downloads, then installs downloaded updates', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    const firstCheck = updater.checkForUpdates()
    const secondCheck = updater.checkForUpdates()
    await Promise.all([firstCheck, secondCheck])
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    const firstDownload = updater.downloadUpdate()
    const secondDownload = updater.downloadUpdate()
    await Promise.all([firstDownload, secondDownload])
    expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)

    expect(() => updater.quitAndInstall()).toThrow('No downloaded update is ready to install')

    mocks.autoUpdater.emit('update-downloaded', {
      version: '1.2.5',
      releaseNotes: 'Ready to install'
    })
    await flushAsyncWork()
    updater.quitAndInstall()
    await flushAsyncWork()

    expect(updater.getUpdateState()).toMatchObject({
      // Clicking Restart flips the UI to the "installing" screen immediately.
      status: 'installing',
      availableVersion: 'v1.2.5',
      releaseNotes: 'Ready to install',
      downloadProgressPercent: 100
    })
    // quitAndInstall triggers a graceful app quit (so before-quit cleanup runs)
    // instead of installing immediately; the install runs after cleanup.
    expect(mocks.app.quit).toHaveBeenCalledTimes(1)
    expect(updater.isQuitAndInstallRequested()).toBe(true)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('installs the downloaded update only after graceful shutdown completes', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    mocks.autoUpdater.emit('update-downloaded', {
      version: '1.2.7',
      releaseNotes: 'Ready'
    })
    await flushAsyncWork()

    expect(updater.isQuitAndInstallRequested()).toBe(false)

    // User clicks "Restart now": request a graceful quit, do not install yet.
    updater.quitAndInstall()
    expect(mocks.app.quit).toHaveBeenCalledTimes(1)
    expect(updater.isQuitAndInstallRequested()).toBe(true)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()

    // The shutdown handler calls performQuitAndInstall() after cleanup; only
    // then does Squirrel install + relaunch.
    updater.performQuitAndInstall()
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    // Silent install (/S) + relaunch (--force-run) on Windows NSIS.
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})
