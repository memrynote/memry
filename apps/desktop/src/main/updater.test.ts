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
      getVersion: vi.fn(() => '1.2.3')
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
      releaseName: 'Memry 1.2.4',
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
      releaseName: 'Memry 1.2.4',
      releaseDate: '2026-05-10',
      error: null
    })
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
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
