import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  const storeState: {
    prefs: { skippedVersion?: string; autoDownload?: boolean; autoCheck?: boolean }
  } = { prefs: {} }
  const child = { unref: vi.fn(), on: vi.fn() }

  return {
    storeState,
    store: {
      getUpdaterPrefs: vi.fn(() => storeState.prefs),
      setSkippedVersion: vi.fn(),
      setAutoDownloadPref: vi.fn(),
      setAutoCheckPref: vi.fn()
    },
    app: Object.assign(new MockEmitter(), {
      isPackaged: true,
      getVersion: vi.fn(() => '1.2.3'),
      getPath: vi.fn(() => 'C:\\Users\\kaan\\AppData\\Roaming\\memrynote'),
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
    }),
    child,
    childProcess: {
      execFile: vi.fn(),
      spawn: vi.fn(() => child)
    },
    fs: {
      existsSync: vi.fn((p: unknown) => String(p).endsWith('Uninstall MemryNote.exe')),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
      writeFileSync: vi.fn(),
      copyFileSync: vi.fn(),
      createWriteStream: vi.fn()
    },
    fetch: vi.fn()
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
  loadVelopack: () => ({
    UpdateManager: class {
      constructor() {
        throw new Error('This application is not properly installed')
      }
    }
  })
}))

vi.mock('node:child_process', () => mocks.childProcess)
vi.mock('node:fs', () => ({ default: mocks.fs, ...mocks.fs }))
vi.mock('node:os', () => ({ tmpdir: () => 'C:\\Users\\kaan\\AppData\\Local\\Temp' }))

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

const SETUP_URL =
  'https://github.com/memrynote/memry/releases/download/v2026-09-11.1/MemryNote-win-Setup.exe'
const VALID_SIGNATURE = JSON.stringify({
  Status: 0,
  SignerCertificate: { Subject: 'CN=Open Source Developer Kaan Karaca, C=TR' }
})

const realPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

async function loadUpdater() {
  vi.resetModules()
  return import('./updater')
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function response(status: number, body?: Readable): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(body ? { 'content-length': '4' } : {}),
    body
  } as unknown as Response
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const downloadedInfo = {
  version: '1.2.4',
  tag: 'v2026-09-11.1',
  files: [{ url: 'MemryNote-1.2.4-setup.exe', sha512: 'sha' }],
  path: 'MemryNote-1.2.4-setup.exe',
  sha512: 'sha',
  releaseDate: '2026-09-11',
  downloadedFile:
    'C:\\Users\\kaan\\AppData\\Local\\memrynote-updater\\pending\\MemryNote-1.2.4-setup.exe'
}

function serveVelopackAsset(head: Response = response(200)): void {
  mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === 'HEAD' ? head : response(200, Readable.from([Buffer.from('abcd')]))
  )
}

async function loadWithDownloadedUpdate() {
  const updater = await loadUpdater()
  updater.initializeUpdater()
  mocks.autoUpdater.emit('update-downloaded', downloadedInfo)
  await vi.waitFor(() => {
    expect(updater.getUpdateState().status).toBe('downloaded')
  })
  return updater
}

describe('NSIS to Velopack hand-off through the updater', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('win32')
    vi.stubGlobal('fetch', mocks.fetch)
    mocks.storeState.prefs = {}
    mocks.autoUpdater.removeAllListeners()
    mocks.app.removeAllListeners()
    mocks.windows[0].removeAllListeners()
    mocks.autoUpdater.autoDownload = true
    mocks.autoUpdater.autoInstallOnAppQuit = false
    mocks.autoUpdater.checkForUpdates.mockResolvedValue(undefined)
    mocks.app.isPackaged = true
    mocks.app.getVersion.mockReturnValue('1.2.3')
    mocks.installHealth.recordUpdateInstallFailure.mockReturnValue({
      consecutiveFailures: 1,
      stuck: false
    })
    mocks.installHealth.reconcileUpdateInstallHealth.mockReturnValue(null)
    mocks.fs.existsSync.mockImplementation((p: unknown) =>
      String(p).endsWith('Uninstall MemryNote.exe')
    )
    mocks.fs.createWriteStream.mockImplementation(
      () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          }
        })
    )
    mocks.childProcess.spawn.mockReturnValue(mocks.child)
    mocks.childProcess.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(null, VALID_SIGNATURE, '')
      }
    )
    serveVelopackAsset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setPlatform(realPlatform)
  })

  it('wires the hand-off into the electron-updater backend on an NSIS install', async () => {
    const updater = await loadUpdater()
    updater.initializeUpdater()

    expect(mocks.logger.info).toHaveBeenCalledWith('updater backend selected', {
      backend: 'electron-updater'
    })
    mocks.autoUpdater.emit('update-downloaded', downloadedInfo)
    await flushAsyncWork()

    expect(mocks.fetch).toHaveBeenCalledWith(SETUP_URL, { method: 'HEAD' })
  })

  it('holds the state at downloading until the hand-off is prepared', async () => {
    const head = deferred<Response>()
    mocks.fetch.mockImplementation(async () => head.promise)
    const updater = await loadUpdater()
    updater.initializeUpdater()
    mocks.autoUpdater.emit('download-progress', { percent: 100 })

    mocks.autoUpdater.emit('update-downloaded', downloadedInfo)
    await flushAsyncWork()
    expect(updater.getUpdateState().status).toBe('downloading')

    head.resolve(response(404))
    await vi.waitFor(() => {
      expect(updater.getUpdateState().status).toBe('downloaded')
    })
    expect(updater.getUpdateState().availableVersion).toBe('v1.2.4')
  })

  it('hands the Restart-to-install path to the Velopack script instead of the NSIS installer', async () => {
    const updater = await loadWithDownloadedUpdate()

    updater.quitAndInstall()
    expect(mocks.app.quit).toHaveBeenCalledTimes(1)
    updater.performQuitAndInstall()

    expect(markUpdateInstallStarted).toHaveBeenCalledWith('1.2.3', 'v1.2.4', 'velopack-handoff')
    const scriptPath = path.win32.join(
      'C:\\Users\\kaan\\AppData\\Local\\Temp',
      `memry-installer-handoff-${process.pid}.cmd`
    )
    expect(mocks.childProcess.spawn).toHaveBeenCalledWith('cmd.exe', ['/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    expect(vi.mocked(markUpdateInstallStarted).mock.invocationCallOrder[0]).toBeLessThan(
      mocks.childProcess.spawn.mock.invocationCallOrder[0]
    )
    expect(mocks.child.unref).toHaveBeenCalled()
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false)
    expect(mocks.app.quit).toHaveBeenCalledTimes(2)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('keeps the NSIS install when the release carries no Velopack installer', async () => {
    serveVelopackAsset(response(404))
    const updater = await loadWithDownloadedUpdate()

    updater.quitAndInstall()
    updater.performQuitAndInstall()

    expect(markUpdateInstallStarted).toHaveBeenCalledWith('1.2.3', 'v1.2.4', 'electron-updater')
    expect(mocks.childProcess.spawn).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('writes the marker and launches the script on a normal quit with install-on-quit', async () => {
    await loadWithDownloadedUpdate()
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true)

    mocks.app.emit('will-quit')

    expect(markUpdateInstallStarted).toHaveBeenCalledWith('1.2.3', 'v1.2.4', 'velopack-handoff')
    expect(mocks.childProcess.spawn).toHaveBeenCalledWith(
      'cmd.exe',
      expect.any(Array),
      expect.objectContaining({ detached: true })
    )
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('does not launch the script when the OS session is ending', async () => {
    await loadWithDownloadedUpdate()

    mocks.windows[0].emit('query-session-end')
    mocks.app.emit('will-quit')

    expect(markUpdateInstallStarted).not.toHaveBeenCalled()
    expect(mocks.childProcess.spawn).not.toHaveBeenCalled()
  })
})
