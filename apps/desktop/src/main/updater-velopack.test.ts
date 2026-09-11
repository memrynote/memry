import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateInfo, VelopackAsset } from 'velopack'

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

  const velopack = {
    construct: vi.fn<(source: unknown) => void>(),
    checkForUpdatesAsync: vi.fn<() => Promise<UpdateInfo | null>>(),
    downloadUpdateAsync:
      vi.fn<(update: UpdateInfo, onProgress?: (percent: number) => void) => Promise<void>>(),
    waitExitThenApplyUpdate:
      vi.fn<(update: UpdateInfo, silent?: boolean, restart?: boolean) => void>()
  }

  class MockUpdateManager {
    checkForUpdatesAsync = velopack.checkForUpdatesAsync
    downloadUpdateAsync = velopack.downloadUpdateAsync
    waitExitThenApplyUpdate = velopack.waitExitThenApplyUpdate

    constructor(source: unknown) {
      velopack.construct(source)
    }
  }

  const storeState: {
    prefs: { skippedVersion?: string; autoDownload?: boolean; autoCheck?: boolean }
  } = { prefs: {} }

  return {
    velopack,
    UpdateManager: MockUpdateManager,
    storeState,
    store: {
      getUpdaterPrefs: vi.fn(() => storeState.prefs),
      setSkippedVersion: vi.fn((version: string | null) => {
        storeState.prefs = { ...storeState.prefs, skippedVersion: version ?? undefined }
      }),
      setAutoDownloadPref: vi.fn((enabled: boolean) => {
        storeState.prefs = { ...storeState.prefs, autoDownload: enabled }
      }),
      setAutoCheckPref: vi.fn((enabled: boolean) => {
        storeState.prefs = { ...storeState.prefs, autoCheck: enabled }
      })
    },
    app: Object.assign(new MockEmitter(), {
      isPackaged: true,
      getVersion: vi.fn(() => '1.2.3'),
      quit: vi.fn(),
      isInApplicationsFolder: vi.fn(() => true)
    }),
    windows: [
      Object.assign(new MockEmitter(), {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: vi.fn()
        }
      })
    ],
    installHealth: {
      recordUpdateInstallFailure: vi.fn(),
      reconcileUpdateInstallHealth: vi.fn()
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    },
    autoUpdater: Object.assign(new MockEmitter(), {
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
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: mocks.autoUpdater
}))

vi.mock('./velopack-native', () => ({
  loadVelopack: () => ({ UpdateManager: mocks.UpdateManager })
}))

// The NSIS fallback path constructs the hand-off, which reads userData and the
// filesystem; its own behaviour is covered in updater-nsis-handoff.test.ts.
vi.mock('./installer-handoff', () => ({
  createInstallerHandoff: () => ({
    prepare: async () => {},
    armed: () => false,
    launch: () => false
  })
}))

vi.mock('./store', () => ({
  getUpdaterPrefs: mocks.store.getUpdaterPrefs,
  setSkippedVersion: mocks.store.setSkippedVersion,
  setAutoDownloadPref: mocks.store.setAutoDownloadPref,
  setAutoCheckPref: mocks.store.setAutoCheckPref
}))

vi.mock('./lib/logger', () => ({
  createLogger: () => mocks.logger
}))

vi.mock('./lib/main-i18n', () => ({
  getMainI18n: () => ({
    t: (key: string) => key,
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('./lib/app-version-display', () => ({
  formatAppVersionForDisplay: (version: string) => `v${version}`
}))

vi.mock('./telemetry/diagnostics', () => ({
  trackMainError: vi.fn(),
  trackMainWarning: vi.fn()
}))
vi.mock('./telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))
vi.mock('./telemetry/update-install-marker', () => ({
  markUpdateInstallStarted: vi.fn()
}))
vi.mock('./updater-install-health', () => ({
  recordUpdateInstallFailure: mocks.installHealth.recordUpdateInstallFailure,
  reconcileUpdateInstallHealth: mocks.installHealth.reconcileUpdateInstallHealth
}))

import { markUpdateInstallStarted } from './telemetry/update-install-marker'
import { trackMainError } from './telemetry/diagnostics'
import { VELOPACK_FEED_URL } from './updater-backend-velopack'

async function loadUpdater() {
  vi.resetModules()
  return import('./updater')
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeUpdate(version: string, notes: Partial<VelopackAsset> = {}): UpdateInfo {
  return {
    TargetFullRelease: {
      PackageId: 'MemryNote',
      Version: version,
      Type: 'Full',
      FileName: `MemryNote-${version}-full.nupkg`,
      SHA1: 'sha1',
      SHA256: 'sha256',
      Size: 1024,
      NotesMarkdown: '',
      NotesHtml: '',
      ...notes
    },
    DeltasToTarget: [],
    IsDowngrade: false
  }
}

const realPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

describe('velopack updater backend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('win32')
    // Most cases drive the check by hand; the startup check would otherwise
    // occupy the coalescing slot in checkForUpdates().
    mocks.storeState.prefs = { autoCheck: false }
    mocks.app.removeAllListeners()
    mocks.windows[0].removeAllListeners()
    mocks.autoUpdater.removeAllListeners()
    mocks.app.isPackaged = true
    mocks.app.getVersion.mockReturnValue('1.2.3')
    mocks.app.isInApplicationsFolder.mockReturnValue(true)
    mocks.autoUpdater.checkForUpdates.mockResolvedValue(undefined)
    mocks.autoUpdater.downloadUpdate.mockResolvedValue(undefined)
    mocks.velopack.construct.mockReset()
    mocks.velopack.checkForUpdatesAsync.mockReset()
    mocks.velopack.checkForUpdatesAsync.mockResolvedValue(null)
    mocks.velopack.downloadUpdateAsync.mockReset()
    mocks.velopack.downloadUpdateAsync.mockResolvedValue(undefined)
    mocks.velopack.waitExitThenApplyUpdate.mockReset()
    mocks.installHealth.recordUpdateInstallFailure.mockReturnValue({
      consecutiveFailures: 1,
      stuck: false
    })
    mocks.installHealth.reconcileUpdateInstallHealth.mockReturnValue(null)
  })

  afterEach(() => {
    setPlatform(realPlatform)
  })

  describe('backend selection', () => {
    it('drives updates through Velopack on a packaged Windows Velopack install', async () => {
      mocks.storeState.prefs = {}
      const updater = await loadUpdater()

      updater.initializeUpdater()
      await flushAsyncWork()

      expect(mocks.velopack.construct).toHaveBeenCalledWith(VELOPACK_FEED_URL)
      expect(mocks.logger.info).toHaveBeenCalledWith('updater backend selected', {
        backend: 'velopack'
      })
      expect(mocks.velopack.checkForUpdatesAsync).toHaveBeenCalledTimes(1)
      expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    })

    it('falls back to electron-updater when the Windows install is not a Velopack install', async () => {
      mocks.storeState.prefs = {}
      mocks.velopack.construct.mockImplementation(() => {
        throw new Error('This application is not properly installed')
      })
      const updater = await loadUpdater()

      updater.initializeUpdater()
      await flushAsyncWork()

      expect(mocks.logger.info).toHaveBeenCalledWith(
        'not a Velopack install; falling back to electron-updater',
        { reason: 'This application is not properly installed' }
      )
      expect(mocks.logger.info).toHaveBeenCalledWith('updater backend selected', {
        backend: 'electron-updater'
      })
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(mocks.velopack.checkForUpdatesAsync).not.toHaveBeenCalled()
    })

    it('never touches Velopack off Windows', async () => {
      setPlatform('darwin')
      mocks.storeState.prefs = {}
      const updater = await loadUpdater()

      updater.initializeUpdater()
      await flushAsyncWork()

      expect(mocks.velopack.construct).not.toHaveBeenCalled()
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    })
  })

  describe('checking for updates', () => {
    it('reports an available release with the version and notes Velopack returned', async () => {
      const updater = await loadUpdater()
      updater.initializeUpdater()
      mocks.velopack.checkForUpdatesAsync.mockResolvedValue(
        makeUpdate('1.2.4', {
          NotesHtml: '<h2>Fixes</h2><ul><li>Sync fix</li><li>Calendar fix</li></ul>'
        })
      )

      const startedAt = Date.now()
      const pending = updater.checkForUpdates()
      expect(updater.getUpdateState()).toMatchObject({
        status: 'checking',
        error: null,
        downloadProgressPercent: null
      })
      expect(updater.getUpdateState().lastCheckedAt).toBeGreaterThanOrEqual(startedAt)

      await pending

      expect(updater.getUpdateState()).toMatchObject({
        status: 'available',
        availableVersion: 'v1.2.4',
        releaseNotes: 'Fixes\n• Sync fix\n• Calendar fix',
        releaseNotesHtml: '<h2>Fixes</h2><ul><li>Sync fix</li><li>Calendar fix</li></ul>',
        error: null
      })
    })

    it('reports up-to-date when Velopack finds no release', async () => {
      const updater = await loadUpdater()
      updater.initializeUpdater()

      await expect(updater.checkForUpdates()).resolves.toMatchObject({
        status: 'up-to-date',
        availableVersion: null,
        releaseNotes: null,
        releaseNotesHtml: null
      })
    })

    it('falls back to the markdown notes when a release was packed without the html transform', async () => {
      const updater = await loadUpdater()
      updater.initializeUpdater()
      mocks.velopack.checkForUpdatesAsync.mockResolvedValue(
        makeUpdate('1.2.4', { NotesHtml: '', NotesMarkdown: '## Fixes\n- Sync fix' })
      )

      await updater.checkForUpdates()

      expect(updater.getUpdateState()).toMatchObject({
        status: 'available',
        releaseNotes: '## Fixes\n- Sync fix',
        releaseNotesHtml: null
      })
    })
  })

  describe('skipped versions', () => {
    it('does not download a version the user skipped, even with auto-download on', async () => {
      mocks.storeState.prefs = { autoCheck: false, autoDownload: true }
      const updater = await loadUpdater()
      updater.initializeUpdater()
      mocks.velopack.checkForUpdatesAsync.mockResolvedValue(makeUpdate('1.2.4'))

      updater.skipVersion('v1.2.4')
      await updater.checkForUpdates()
      await flushAsyncWork()

      expect(updater.getUpdateState()).toMatchObject({
        status: 'up-to-date',
        availableVersion: null
      })
      expect(mocks.velopack.downloadUpdateAsync).not.toHaveBeenCalled()
    })

    it('surfaces a skipped version again on a manual check that clears the skip', async () => {
      const updater = await loadUpdater()
      updater.initializeUpdater()
      mocks.velopack.checkForUpdatesAsync.mockResolvedValue(makeUpdate('1.2.4'))
      await updater.checkForUpdates()
      updater.skipVersion('v1.2.4')

      await updater.checkForUpdates({ clearSkip: true })

      expect(mocks.store.setSkippedVersion).toHaveBeenCalledWith(null)
      expect(updater.getUpdateState()).toMatchObject({
        status: 'available',
        availableVersion: 'v1.2.4'
      })
    })
  })

  describe('downloading', () => {
    it('downloads automatically after a check when auto-download is on', async () => {
      mocks.storeState.prefs = { autoCheck: false, autoDownload: true }
      const download = deferred()
      mocks.velopack.downloadUpdateAsync.mockImplementation(() => download.promise)
      const updater = await loadUpdater()
      updater.initializeUpdater()
      mocks.velopack.checkForUpdatesAsync.mockResolvedValue(makeUpdate('1.2.4'))

      await updater.checkForUpdates()
      await flushAsyncWork()
      expect(mocks.velopack.downloadUpdateAsync).toHaveBeenCalledTimes(1)

      const [, reportProgress] = mocks.velopack.downloadUpdateAsync.mock.calls[0]
      reportProgress?.(42.6)
      expect(updater.getUpdateState()).toMatchObject({
        status: 'downloading',
        downloadProgressPercent: 43
      })
      reportProgress?.(120.4)
      expect(updater.getUpdateState().downloadProgressPercent).toBe(100)

      download.resolve()
      await flushAsyncWork()

      expect(updater.getUpdateState()).toMatchObject({
        status: 'downloaded',
        availableVersion: 'v1.2.4',
        downloadProgressPercent: 100
      })
    })

    it('downloads once on demand while an update waits', async () => {
      const updater = await loadUpdater()
      updater.initializeUpdater()
      mocks.velopack.checkForUpdatesAsync.mockResolvedValue(makeUpdate('1.2.4'))
      await updater.checkForUpdates()
      expect(updater.getUpdateState().status).toBe('available')

      await expect(updater.downloadUpdate()).resolves.toMatchObject({
        status: 'downloaded',
        availableVersion: 'v1.2.4',
        downloadProgressPercent: 100
      })
      expect(mocks.velopack.downloadUpdateAsync).toHaveBeenCalledTimes(1)
    })
  })

  describe('failures', () => {
    it('reports a failed check in the check phase', async () => {
      const updater = await loadUpdater()
      updater.initializeUpdater()
      mocks.velopack.checkForUpdatesAsync.mockRejectedValue(new Error('feed unreachable'))

      await expect(updater.checkForUpdates()).rejects.toThrow('feed unreachable')

      expect(updater.getUpdateState()).toMatchObject({
        status: 'error',
        error: 'feed unreachable'
      })
      expect(trackMainError).toHaveBeenCalledWith('updater', 'check', expect.any(Error))
    })

    it('reports a failed download in the download phase', async () => {
      const updater = await loadUpdater()
      updater.initializeUpdater()
      mocks.velopack.checkForUpdatesAsync.mockResolvedValue(makeUpdate('1.2.4'))
      await updater.checkForUpdates()
      mocks.velopack.downloadUpdateAsync.mockRejectedValue(new Error('disk full'))

      await expect(updater.downloadUpdate()).rejects.toThrow('disk full')

      expect(updater.getUpdateState()).toMatchObject({ status: 'error', error: 'disk full' })
      expect(trackMainError).toHaveBeenCalledWith('updater', 'download', expect.any(Error))
    })

    it('counts a failed hand-off in the install phase and still quits', async () => {
      const updater = await loadUpdater()
      updater.initializeUpdater()
      mocks.velopack.checkForUpdatesAsync.mockResolvedValue(makeUpdate('1.2.4'))
      await updater.checkForUpdates()
      await updater.downloadUpdate()
      mocks.velopack.waitExitThenApplyUpdate.mockImplementation(() => {
        throw new Error('Update.exe is missing')
      })

      updater.quitAndInstall()
      updater.performQuitAndInstall()

      expect(updater.getUpdateState()).toMatchObject({
        status: 'error',
        error: 'Update.exe is missing'
      })
      expect(trackMainError).toHaveBeenCalledWith('updater', 'install', expect.any(Error))
      expect(mocks.installHealth.recordUpdateInstallFailure).toHaveBeenCalledWith(
        'v1.2.3',
        'v1.2.4'
      )
      expect(mocks.app.quit).toHaveBeenCalledTimes(2)
    })
  })

  describe('restart to install', () => {
    it('marks the install attempt before handing the update to Velopack', async () => {
      const update = makeUpdate('1.2.4')
      const updater = await loadUpdater()
      updater.initializeUpdater()
      mocks.velopack.checkForUpdatesAsync.mockResolvedValue(update)
      await updater.checkForUpdates()
      await updater.downloadUpdate()

      updater.quitAndInstall()
      expect(updater.getUpdateState().status).toBe('installing')
      expect(mocks.app.quit).toHaveBeenCalledTimes(1)
      expect(mocks.velopack.waitExitThenApplyUpdate).not.toHaveBeenCalled()

      updater.performQuitAndInstall()

      expect(markUpdateInstallStarted).toHaveBeenCalledWith('1.2.3', 'v1.2.4', 'velopack')
      expect(vi.mocked(markUpdateInstallStarted).mock.invocationCallOrder[0]).toBeLessThan(
        mocks.velopack.waitExitThenApplyUpdate.mock.invocationCallOrder[0]
      )
      expect(mocks.velopack.waitExitThenApplyUpdate).toHaveBeenCalledWith(update, true, true)
      expect(mocks.app.quit).toHaveBeenCalledTimes(2)
    })
  })

  describe('install on quit', () => {
    async function loadWithDownloadedUpdate(update: UpdateInfo) {
      const updater = await loadUpdater()
      updater.initializeUpdater()
      mocks.velopack.checkForUpdatesAsync.mockResolvedValue(update)
      await updater.checkForUpdates()
      await updater.downloadUpdate()
      return updater
    }

    it('applies a downloaded update on a normal quit without relaunching', async () => {
      const update = makeUpdate('1.2.4')
      await loadWithDownloadedUpdate(update)

      mocks.app.emit('will-quit')

      expect(mocks.velopack.waitExitThenApplyUpdate).toHaveBeenCalledWith(update, true, false)
    })

    it('skips the quit hand-off once the OS session-end guard has fired', async () => {
      await loadWithDownloadedUpdate(makeUpdate('1.2.4'))

      mocks.windows[0].emit('query-session-end')
      mocks.app.emit('will-quit')

      expect(mocks.velopack.waitExitThenApplyUpdate).not.toHaveBeenCalled()
    })

    it('applies the update once when a restart-to-install is already under way', async () => {
      const update = makeUpdate('1.2.4')
      const updater = await loadWithDownloadedUpdate(update)

      updater.quitAndInstall()
      mocks.app.emit('will-quit')
      expect(mocks.velopack.waitExitThenApplyUpdate).not.toHaveBeenCalled()

      updater.performQuitAndInstall()
      mocks.app.emit('will-quit')

      expect(mocks.velopack.waitExitThenApplyUpdate).toHaveBeenCalledTimes(1)
      expect(mocks.velopack.waitExitThenApplyUpdate).toHaveBeenCalledWith(update, true, true)
    })
  })

  describe('scheduled checks', () => {
    it('re-checks Velopack on the background interval', async () => {
      mocks.storeState.prefs = {}
      vi.useFakeTimers()
      try {
        const updater = await loadUpdater()
        updater.initializeUpdater()
        expect(mocks.velopack.checkForUpdatesAsync).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        expect(mocks.velopack.checkForUpdatesAsync).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        expect(mocks.velopack.checkForUpdatesAsync).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('starts the Velopack check loop when auto-check is turned on', async () => {
      vi.useFakeTimers()
      try {
        const updater = await loadUpdater()
        updater.initializeUpdater()
        expect(mocks.velopack.checkForUpdatesAsync).not.toHaveBeenCalled()

        updater.setAutoCheckEnabled(true)
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.velopack.checkForUpdatesAsync).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        expect(mocks.velopack.checkForUpdatesAsync).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
