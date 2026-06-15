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
  return {
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

  it('shows available-update prompts with release notes and starts downloads on demand', async () => {
    const updater = await loadUpdater()
    mocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })

    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.4',
      releaseName: 'Memrynote 1.2.4',
      releaseDate: '2026-05-10',
      releaseNotes: [{ version: '1.2.4', note: 'Desktop sync fixes' }, { note: 'Calendar fixes' }]
    })
    await flushAsyncWork()

    expect(mocks.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ['dialog.update.buttonDownload', 'dialog.update.buttonLater'],
        detail: expect.stringContaining('Desktop sync fixes')
      })
    )
    expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(updater.getUpdateState()).toMatchObject({
      availableVersion: 'v1.2.4',
      releaseName: 'Memrynote 1.2.4',
      releaseDate: '2026-05-10',
      error: null
    })
  })

  it('strips HTML from release notes before showing them in the dialog', async () => {
    const updater = await loadUpdater()

    updater.initializeUpdater()
    mocks.autoUpdater.emit('update-available', {
      version: '1.2.6',
      releaseNotes: '<h2>Fixes</h2><ul><li>Sync fix</li><li>Calendar fix</li></ul>'
    })
    await flushAsyncWork()

    const { detail } = mocks.dialog.showMessageBox.mock.calls[0][0]
    expect(detail).toContain('Sync fix')
    expect(detail).toContain('• Calendar fix')
    expect(detail).not.toMatch(/<[^>]+>/)
    expect(updater.getUpdateState().releaseNotes).toBe('Fixes\n• Sync fix\n• Calendar fix')
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
      status: 'downloaded',
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
  })
})
