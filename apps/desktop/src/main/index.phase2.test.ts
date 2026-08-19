import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import type { VaultStatus } from '@memry/contracts/vault-api'

const appOnMock = vi.fn()
const whenReadyMock = vi.fn(() => new Promise<void>(() => {}))
const requestSingleInstanceLockMock = vi.fn(() => true)
const getPathMock = vi.fn((name: string) => `/mock/${name}`)
const setPathMock = vi.fn()
const dotenvConfigMock = vi.fn(() => ({ error: undefined }))
const registerAllHandlersMock = vi.fn()
let globalCaptureRegistered = true
let globalCaptureAppliedHandler: ((configuredRegistered: boolean) => void) | null = null
// Mirrors the real module: applying the configured accelerator always reports the
// outcome to the fallback owner in index.ts.
const applyGlobalCaptureShortcutMock = vi.fn(() => {
  globalCaptureAppliedHandler?.(globalCaptureRegistered)
  return { registered: globalCaptureRegistered }
})
const setGlobalCaptureAppliedHandlerMock = vi.fn(
  (handler: ((configuredRegistered: boolean) => void) | null) => {
    globalCaptureAppliedHandler = handler
  }
)
const autoOpenLastVaultMock = vi.fn(async () => undefined)
const closeVaultMock = vi.fn(async () => undefined)
const vaultStatusChangedListeners: Array<(status: VaultStatus) => void> = []
const onVaultStatusChangedMock = vi.fn((listener: (status: VaultStatus) => void) => {
  vaultStatusChangedListeners.push(listener)
  return () => {
    const index = vaultStatusChangedListeners.indexOf(listener)
    if (index !== -1) vaultStatusChangedListeners.splice(index, 1)
  }
})
const createMainI18nMock = vi.fn(async () => ({ t: (key: string) => key }))
const setMainI18nMock = vi.fn()
const buildAppMenuMock = vi.fn(() => ({ id: 'menu' }))
const editableContextMenuPopupMock = vi.fn()
const buildEditableTextContextMenuMock = vi.fn(() => ({ popup: editableContextMenuPopupMock }))
const getCurrentVaultPathMock = vi.fn(() => null as string | null)
const getStoredLocaleMock = vi.fn(() => null as string | null)
const getVaultsMock = vi.fn(() => [] as Array<{ path: string }>)
const setStoredLocaleMock = vi.fn()
type StoredWindowBoundsShape = {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized?: boolean
}
const getWindowBoundsMock = vi.fn((): StoredWindowBoundsShape | null => null)
const setWindowBoundsMock = vi.fn()
const getVaultStatusMock = vi.fn(() => ({ path: null as string | null }))
const readPreferencesMock = vi.fn(() => ({ language: 'en' }))
const initializeTelemetryRuntimeMock = vi.fn(() => ({
  context: { sessionId: 'test-session' }
}))
const disposeTelemetryRuntimeMock = vi.fn(async () => undefined)
const initPersistenceMock = vi.fn(async () => undefined)
const getOpenNoteIdsMock = vi.fn(() => [] as string[])
const getProviderDocMock = vi.fn()
const getCrdtProviderMock = vi.fn(() => ({
  initPersistence: initPersistenceMock,
  getOpenNoteIds: getOpenNoteIdsMock,
  getDoc: getProviderDocMock
}))
const stopSyncRuntimeMock = vi.fn(async () => undefined)
const flushPendingWritebacksMock = vi.fn(async () => undefined)
const closeAllDatabasesMock = vi.fn()
const markShutdownFailureMock = vi.fn()
const stopEmbeddingModelMock = vi.fn(async () => undefined)
const startGoogleCalendarSyncRunnerMock = vi.fn(async () => undefined)
const stopGoogleCalendarSyncRunnerMock = vi.fn()
const triggerGoogleCalendarSyncNowMock = vi.fn()
const computeSpkiHashFromPemMock = vi.fn(() => 'hash')
const isPinningDisabledMock = vi.fn(() => true)
const getPinnedCertificateHashesMock = vi.fn(() => [] as string[])
const getPinnedCertificateHashesForHostnameMock = vi.fn(() => [] as string[])
const initializeUpdaterMock = vi.fn()
const sendAppNavigationCommandMock = vi.fn()
const sendAppNavigationKeyboardCommandMock = vi.fn(() => false)
const sendAppNavigationSwipeCommandMock = vi.fn()
const isDevMock = { dev: false }
const existsSyncMock = vi.fn(() => false)
const readdirSyncMock = vi.fn(() => [])
const statSyncMock = vi.fn(() => ({ size: 10 }))
const createReadStreamMock = vi.fn()
const webRequestOnHeadersReceivedMock = vi.fn()
const protocolHandleMock = vi.fn()
const protocolRegisterSchemesMock = vi.fn()
const ipcMainOnMock = vi.fn()
const ipcMainHandleMock = vi.fn()
const setCertificateVerifyProcMock = vi.fn()
const setPermissionRequestHandlerMock = vi.fn()
const setPermissionCheckHandlerMock = vi.fn()
const crashReporterStartMock = vi.fn()
const globalShortcutRegisterMock = vi.fn(() => true)
const globalShortcutUnregisterMock = vi.fn()
const globalShortcutUnregisterAllMock = vi.fn()
const menuSetApplicationMenuMock = vi.fn()
const netFetchMock = vi.fn(async () => new Response('file'))
const getNoteCacheByIdMock = vi.fn(() => null as { path: string; title: string } | null)
const toAbsolutePathMock = vi.fn((path: string) => path)
const createSnapshotMock = vi.fn(() => null as unknown)
const safeReadMock = vi.fn(async () => null as string | null)
const disableConsoleTransportMock = vi.fn()
const applyPackagedLogLevelsMock = vi.fn()
const getHeadlessCliArgsMock = vi.fn((argv: string[]) => {
  const cliIndex = argv.indexOf('--cli')
  return cliIndex === -1 ? null : argv.slice(cliIndex + 1)
})
const runHeadlessCliMock = vi.fn(async () => undefined)
const startBillingCheckoutMock = vi.fn(async () => ({ success: true }))
const reconcileBillingAndSyncMock = vi.fn(async () => undefined)
const browserWindows: Array<ReturnType<typeof createBrowserWindowMock>> = []

function createBrowserWindowMock() {
  const eventHandlers = new Map<string, (...args: unknown[]) => void>()
  const window = {
    id: browserWindows.length + 1,
    webContents: {
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn()
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers.set(event, handler)
      return window
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers.set(event, handler)
      return window
    }),
    show: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    loadFile: vi.fn(async () => undefined),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    close: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: vi.fn(() => false),
    getSize: vi.fn(() => [480, 82] as [number, number]),
    setSize: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 480, height: 82 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 480, height: 82 })),
    emitTestEvent: (event: string, ...args: unknown[]) => eventHandlers.get(event)?.(...args)
  }
  browserWindows.push(window)
  return window
}

const BrowserWindowMock = Object.assign(
  vi.fn(function BrowserWindowConstructor() {
    return createBrowserWindowMock()
  }),
  {
    getAllWindows: vi.fn(() => browserWindows),
    getFocusedWindow: vi.fn(() => browserWindows[0] ?? null)
  }
)

vi.mock('dotenv', () => ({
  config: dotenvConfigMock
}))

vi.mock('./ipc', () => ({
  registerAllHandlers: registerAllHandlersMock
}))

vi.mock('./ipc/settings-handlers', () => ({
  applyGlobalCaptureShortcut: applyGlobalCaptureShortcutMock,
  setGlobalCaptureAppliedHandler: setGlobalCaptureAppliedHandlerMock
}))

vi.mock('./vault', () => ({
  autoOpenLastVault: autoOpenLastVaultMock,
  beginVaultShutdown: vi.fn(),
  closeVault: closeVaultMock,
  getStatus: getVaultStatusMock,
  onVaultStatusChanged: onVaultStatusChangedMock
}))

vi.mock('./store', () => ({
  getCurrentVaultPath: getCurrentVaultPathMock,
  getStoredLocale: getStoredLocaleMock,
  // getVaults/setStoredLocale back first-run locale detection. Leaving them off
  // this mock does not fail loudly: detectFirstRunLocale()'s try/catch swallows
  // the "not a function" TypeError and silently returns null, so the whole
  // detection path would sit untested while every assertion still passed.
  getVaults: getVaultsMock,
  setStoredLocale: setStoredLocaleMock,
  getWindowBounds: getWindowBoundsMock,
  setWindowBounds: setWindowBoundsMock
}))

vi.mock('./vault/vault-preferences', () => ({
  readPreferences: readPreferencesMock
}))

vi.mock('@memry/i18n/main', () => ({
  createMainI18n: createMainI18nMock
}))

vi.mock('./lib/main-i18n', () => ({
  setMainI18n: setMainI18nMock
}))

vi.mock('./menu', () => ({
  buildAppMenu: buildAppMenuMock,
  buildEditableTextContextMenu: buildEditableTextContextMenuMock
}))

vi.mock('./inbox/snooze', () => ({
  startSnoozeScheduler: vi.fn(),
  stopSnoozeScheduler: vi.fn(),
  checkDueItemsOnStartup: vi.fn()
}))

vi.mock('./lib/reminders', () => ({
  startReminderScheduler: vi.fn(),
  stopReminderScheduler: vi.fn()
}))

vi.mock('./inbox/review-scheduler', () => ({
  startInboxReviewScheduler: vi.fn(),
  stopInboxReviewScheduler: vi.fn()
}))

vi.mock('./inbox/voice-model', () => ({
  stopVoiceModel: vi.fn(async () => undefined)
}))

// Keep the real module (other importers use initEmbeddingModel/getModelInfo/etc.);
// spy only stopEmbeddingModel to assert the embeddings utilityProcess is stopped on quit (#805).
vi.mock('./lib/embeddings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/embeddings')>()),
  stopEmbeddingModel: stopEmbeddingModelMock
}))

vi.mock('./telemetry/runtime', () => ({
  initializeTelemetryRuntime: initializeTelemetryRuntimeMock,
  disposeTelemetryRuntime: disposeTelemetryRuntimeMock,
  getTelemetryRuntime: vi.fn(() => null)
}))

vi.mock('./telemetry/state', () => ({
  getTelemetryAuthState: vi.fn(() => null),
  getTelemetrySyncState: vi.fn(() => null)
}))

vi.mock('./telemetry/log-ship', () => ({
  installLogShip: vi.fn(),
  getLogShip: vi.fn(() => ({ dispose: vi.fn(async () => undefined) }))
}))

vi.mock('./calendar/google/sync-service', () => ({
  startGoogleCalendarSyncRunner: startGoogleCalendarSyncRunnerMock,
  stopGoogleCalendarSyncRunner: stopGoogleCalendarSyncRunnerMock,
  triggerGoogleCalendarSyncNow: triggerGoogleCalendarSyncNowMock
}))

vi.mock('./sync/certificate-pinning', () => ({
  computeSpkiHashFromPem: computeSpkiHashFromPemMock,
  isPinningDisabled: isPinningDisabledMock,
  getPinnedCertificateHashes: getPinnedCertificateHashesMock,
  getPinnedCertificateHashesForHostname: getPinnedCertificateHashesForHostnameMock
}))

vi.mock('./sync/crdt-provider', () => ({
  getCrdtProvider: getCrdtProviderMock
}))

vi.mock('./sync/runtime', () => ({
  stopSyncRuntime: stopSyncRuntimeMock
}))

vi.mock('./database/client', () => ({
  getIndexDatabase: vi.fn(() => ({})),
  closeAllDatabases: closeAllDatabasesMock
}))

vi.mock('./sync/crdt-writeback', () => ({
  flushPendingWritebacks: flushPendingWritebacksMock
}))

vi.mock('./telemetry/crash-marker', () => ({
  clearCrashMarker: vi.fn(),
  detectUncleanShutdown: vi.fn(),
  installCrashMarker: vi.fn(),
  markShutdownFailure: markShutdownFailureMock
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: getNoteCacheByIdMock
}))

vi.mock('./vault/notes', () => ({
  toAbsolutePath: toAbsolutePathMock,
  createSnapshot: createSnapshotMock
}))

vi.mock('./vault/file-ops', () => ({
  safeRead: safeReadMock
}))

vi.mock('./updater', () => ({
  initializeUpdater: initializeUpdaterMock,
  isQuitAndInstallRequested: vi.fn(() => false),
  performQuitAndInstall: vi.fn()
}))

vi.mock('./app-navigation-command', () => ({
  sendAppNavigationCommand: sendAppNavigationCommandMock,
  sendAppNavigationKeyboardCommand: sendAppNavigationKeyboardCommandMock,
  sendAppNavigationSwipeCommand: sendAppNavigationSwipeCommandMock
}))

vi.mock('./cli/headless', () => ({
  getHeadlessCliArgs: getHeadlessCliArgsMock,
  runHeadlessCli: runHeadlessCliMock
}))

vi.mock('./billing/paddle-billing', () => ({
  startBillingCheckout: startBillingCheckoutMock,
  reconcileBillingAndSync: reconcileBillingAndSyncMock
}))

vi.mock('./capture/pairing', () => ({
  openPairingWindow: vi.fn()
}))

vi.mock('./capture/server', () => ({
  startCaptureServer: vi.fn(async () => 7849),
  stopCaptureServer: vi.fn(async () => undefined)
}))

vi.mock('./lib/logger', () => {
  const scopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
  return {
    log: { initialize: vi.fn(), warn: vi.fn() },
    createLogger: vi.fn(() => scopedLogger),
    disableConsoleTransport: disableConsoleTransportMock,
    applyPackagedLogLevels: applyPackagedLogLevelsMock,
    migrateLegacyLogDir: vi.fn()
  }
})

vi.mock('./app-identity', () => ({
  applyMemrynoteIdentity: vi.fn(() => Promise.resolve())
}))

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readdirSync: readdirSyncMock,
  statSync: statSyncMock,
  createReadStream: createReadStreamMock
}))

vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: isDevMock
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/mock/app'),
    getPath: getPathMock,
    setPath: setPathMock,
    requestSingleInstanceLock: requestSingleInstanceLockMock,
    on: appOnMock,
    whenReady: whenReadyMock,
    isDefaultProtocolClient: vi.fn(() => true),
    setAsDefaultProtocolClient: vi.fn(),
    getVersion: vi.fn(() => '1.0.0'),
    getLocale: vi.fn(() => 'en-US'),
    quit: vi.fn(),
    exit: vi.fn(),
    dock: { setIcon: vi.fn() }
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: BrowserWindowMock,
  ipcMain: {
    on: ipcMainOnMock,
    handle: ipcMainHandleMock,
    removeListener: vi.fn()
  },
  protocol: {
    registerSchemesAsPrivileged: protocolRegisterSchemesMock,
    handle: protocolHandleMock
  },
  net: {
    fetch: netFetchMock
  },
  crashReporter: {
    start: crashReporterStartMock
  },
  globalShortcut: {
    register: globalShortcutRegisterMock,
    unregister: globalShortcutUnregisterMock,
    unregisterAll: globalShortcutUnregisterAllMock
  },
  clipboard: {
    readText: vi.fn(() => '')
  },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1440, height: 900 } })),
    getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }])
  },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: webRequestOnHeadersReceivedMock
      },
      setCertificateVerifyProc: setCertificateVerifyProcMock,
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
      setPermissionCheckHandler: setPermissionCheckHandlerMock,
      extensions: {
        loadExtension: vi.fn(async () => ({ name: 'React DevTools' }))
      }
    }
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({ id: 'icon' }))
  },
  Menu: Object.assign(
    vi.fn(function MenuConstructor() {
      return {
        append: vi.fn(),
        once: vi.fn(),
        popup: vi.fn()
      }
    }),
    { setApplicationMenu: menuSetApplicationMenuMock }
  ),
  MenuItem: vi.fn(function MenuItemConstructor(config) {
    return config
  })
}))

const ORIGINAL_ENV = { ...process.env }
const ORIGINAL_ARGV = [...process.argv]

async function importMainModule() {
  return import('./index')
}

async function flushReadyWork() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

// Run `body` with the electron mock reporting `osLocale` from app.getLocale().
// The mock keeps its implementation across `vi.clearAllMocks()`, so the default
// is restored afterwards the same way the packaged-build test restores
// `isPackaged` — otherwise one test's OS locale leaks into every later one.
async function withOsLocale(osLocale: string, body: () => Promise<void>): Promise<void> {
  const { app } = await import('electron')
  vi.mocked(app.getLocale).mockReturnValue(osLocale)
  try {
    await body()
  } finally {
    vi.mocked(app.getLocale).mockReturnValue('en-US')
  }
}

// Drain microtasks until `predicate` holds (bounded by a safety cap), instead of
// looping a hard-coded number of ticks that's coupled to the shutdown chain
// length and breaks whenever an async step is added/removed.
async function flushUntil(predicate: () => boolean, maxTicks = 100): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i++) {
    await Promise.resolve()
  }
}

type FlushDoneListener = (event: { sender: unknown }, requestId?: string) => void

function getFlushDoneListeners(): FlushDoneListener[] {
  return ipcMainOnMock.mock.calls
    .filter(([event]) => event === 'app:flush-done')
    .map(([, handler]) => handler as FlushDoneListener)
}

function getFlushRequestId(window: ReturnType<typeof createBrowserWindowMock>): string | undefined {
  return window.webContents.send.mock.calls
    .filter(([channel]) => channel === 'app:request-flush')
    .at(-1)?.[1] as string | undefined
}

// `app:flush-done` is a shared channel, so a reply only counts when it carries
// the sender and the request id the main process actually asked for. Fanning the
// reply out to every listener mirrors the real ipcMain dispatch.
function completeFlush(window: ReturnType<typeof createBrowserWindowMock>): void {
  const requestId = getFlushRequestId(window)
  for (const listener of getFlushDoneListeners()) {
    listener({ sender: window.webContents }, requestId)
  }
}

describe('main index phase2 exports', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    browserWindows.length = 0
    vaultStatusChangedListeners.length = 0
    getPathMock.mockImplementation((name: string) => `/mock/${name}`)
    whenReadyMock.mockImplementation(() => new Promise<void>(() => {}))
    requestSingleInstanceLockMock.mockReturnValue(true)
    globalCaptureRegistered = true
    globalCaptureAppliedHandler = null
    getCurrentVaultPathMock.mockReturnValue(null)
    getStoredLocaleMock.mockReturnValue(null)
    getVaultsMock.mockReturnValue([])
    getWindowBoundsMock.mockReturnValue(null)
    getVaultStatusMock.mockReturnValue({ path: null })
    readPreferencesMock.mockReturnValue({ language: 'en' })
    isPinningDisabledMock.mockReturnValue(true)
    getPinnedCertificateHashesMock.mockReturnValue([])
    getPinnedCertificateHashesForHostnameMock.mockReturnValue([])
    computeSpkiHashFromPemMock.mockReturnValue('hash')
    getOpenNoteIdsMock.mockReturnValue([])
    getProviderDocMock.mockReturnValue(undefined)
    getNoteCacheByIdMock.mockReturnValue(null)
    toAbsolutePathMock.mockImplementation((filePath: string) => filePath)
    createSnapshotMock.mockReturnValue(null)
    safeReadMock.mockResolvedValue(null)
    existsSyncMock.mockReturnValue(false)
    readdirSyncMock.mockReturnValue([])
    statSyncMock.mockReturnValue({ size: 10 })
    BrowserWindowMock.getAllWindows.mockImplementation(() => browserWindows)
    BrowserWindowMock.getFocusedWindow.mockImplementation(() => browserWindows[0] ?? null)
    process.env = { ...ORIGINAL_ENV }
    process.argv = [...ORIGINAL_ARGV]
    isDevMock.dev = false
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    process.argv = [...ORIGINAL_ARGV]
    vi.useRealTimers()
  })

  it('loads environment config defaults when optional vars are absent', async () => {
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_WHISPER_MODEL
    delete process.env.OPENAI_EMBEDDING_MODEL

    const module = await importMainModule()

    expect(module.envConfig.openaiApiKey).toBeUndefined()
    expect(module.envConfig.whisperModel).toBe('whisper-1')
    expect(module.envConfig.embeddingModel).toBe('text-embedding-3-small')
    expect(dotenvConfigMock).toHaveBeenCalled()
    expect(requestSingleInstanceLockMock).toHaveBeenCalledTimes(1)
    expect(appOnMock).toHaveBeenCalled()
  })

  it('loads environment overrides from process env', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_WHISPER_MODEL = 'whisper-test'
    process.env.OPENAI_EMBEDDING_MODEL = 'embed-test'

    const module = await importMainModule()

    expect(module.envConfig.openaiApiKey).toBe('test-key')
    expect(module.envConfig.whisperModel).toBe('whisper-test')
    expect(module.envConfig.embeddingModel).toBe('embed-test')
  })

  it('suppresses console logging before running headless CLI mode', async () => {
    process.argv = [ORIGINAL_ARGV[0] ?? 'electron', '/mock/app', '--cli', 'vault', 'list']

    await importMainModule()

    expect(disableConsoleTransportMock).toHaveBeenCalled()
    expect(runHeadlessCliMock).toHaveBeenCalledWith(['vault', 'list'])
    expect(requestSingleInstanceLockMock).not.toHaveBeenCalled()
  })

  it('applies device-scoped userData and falls back to cwd dotenv when app env fails', async () => {
    process.env.MEMRY_DEVICE = 'B'
    dotenvConfigMock.mockReturnValueOnce({ error: new Error('missing env') })

    await importMainModule()

    expect(setPathMock).toHaveBeenCalledWith('userData', '/mock/userData-B')
    expect(dotenvConfigMock).toHaveBeenCalledWith({
      path: '/mock/app/.env.development',
      quiet: true
    })
    expect(dotenvConfigMock).toHaveBeenCalledWith({ quiet: true })
  })

  it('loads the unpackaged runtime env selected by MEMRY_ENV', async () => {
    process.env.MEMRY_ENV = 'staging'

    await importMainModule()

    expect(dotenvConfigMock).toHaveBeenCalledWith({ path: '/mock/app/.env.staging', quiet: true })
    expect(dotenvConfigMock).not.toHaveBeenCalledWith({ path: '/mock/app/.env', quiet: true })
  })

  it('scopes the default dev profile by worktree path', async () => {
    process.env.MEMRY_DEVICE = 'dev'

    await importMainModule()

    expect(process.env.MEMRY_DEVICE).toMatch(/^dev-[a-f0-9]{8}$/)
    expect(process.env.MEMRY_DEVICE).not.toBe('dev')
    expect(setPathMock).toHaveBeenCalledWith(
      'userData',
      `/mock/userData-${process.env.MEMRY_DEVICE}`
    )
  })

  it('skips the single-instance lock for multi-device test launches', async () => {
    process.env.NODE_ENV = 'test'
    process.env.MEMRY_DEVICE = 'A'

    await importMainModule()

    expect(requestSingleInstanceLockMock).not.toHaveBeenCalled()
  })

  it('boots i18n from vault preferences and rebuilds the app menu', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    getCurrentVaultPathMock.mockReturnValue('/vault')
    readPreferencesMock.mockReturnValue({ language: 'tr' })

    await importMainModule()
    await flushReadyWork()

    expect(readPreferencesMock).toHaveBeenCalledWith('/vault')
    expect(createMainI18nMock).toHaveBeenCalledWith({ locale: 'tr' })

    const registration = registerAllHandlersMock.mock.calls.at(-1)?.[0] as {
      rebuildMenu: (locale: string) => void
    }
    registration.rebuildMenu('tr')
    expect(menuSetApplicationMenuMock).toHaveBeenCalledWith({ id: 'menu' })
  })

  it('boots i18n from stored app locale when no vault is open', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    getCurrentVaultPathMock.mockReturnValue(null)
    getStoredLocaleMock.mockReturnValue('tr')

    await importMainModule()
    await flushReadyWork()

    expect(readPreferencesMock).not.toHaveBeenCalled()
    expect(createMainI18nMock).toHaveBeenCalledWith({ locale: 'tr' })
  })

  it('adopts the OS locale on a genuinely fresh install and persists it once', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    // Fresh install: nothing stored, no current vault, empty vault registry.
    getStoredLocaleMock.mockReturnValue(null)
    getCurrentVaultPathMock.mockReturnValue(null)
    getVaultsMock.mockReturnValue([])

    await withOsLocale('de-DE', async () => {
      await importMainModule()
      await flushReadyWork()
    })

    expect(createMainI18nMock).toHaveBeenCalledWith({ locale: 'de' })
    // Persisted so the choice is made exactly once — later launches read it back
    // through getStoredLocale() and never re-detect.
    expect(setStoredLocaleMock).toHaveBeenCalledWith('de')
  })

  it('keeps an existing install on English even when the OS locale is not English', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    // Every install predating the locale setting also has a null stored locale,
    // so the vault registry is the real first-run signal. A registered vault
    // means this user already runs the English UI — shipping OS detection must
    // never flip their language out from under them.
    getStoredLocaleMock.mockReturnValue(null)
    getCurrentVaultPathMock.mockReturnValue(null)
    getVaultsMock.mockReturnValue([{ path: '/existing-vault' }])

    await withOsLocale('de-DE', async () => {
      await importMainModule()
      await flushReadyWork()
    })

    expect(createMainI18nMock).toHaveBeenCalledWith({ locale: 'en' })
    expect(setStoredLocaleMock).not.toHaveBeenCalled()
  })

  it('treats a current vault with an empty registry as an existing install', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    // A config written before `vaults` existed merges in as an empty array, so
    // currentVault alone still identifies an existing user.
    getStoredLocaleMock.mockReturnValue(null)
    getCurrentVaultPathMock.mockReturnValue('/legacy-vault')
    getVaultsMock.mockReturnValue([])
    // Unparseable vault preference: the boot locale stays whatever detection
    // left in place, so this asserts detection and not the preference read.
    readPreferencesMock.mockReturnValue({ language: 'not-a-locale' })

    await withOsLocale('de-DE', async () => {
      await importMainModule()
      await flushReadyWork()
    })

    expect(createMainI18nMock).toHaveBeenCalledWith({ locale: 'en' })
    expect(setStoredLocaleMock).not.toHaveBeenCalled()
  })

  it('falls back to English when a fresh install reports an unsupported OS locale', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    getStoredLocaleMock.mockReturnValue(null)
    getCurrentVaultPathMock.mockReturnValue(null)
    getVaultsMock.mockReturnValue([])

    await withOsLocale('xh-ZA', async () => {
      await importMainModule()
      await flushReadyWork()
    })

    expect(createMainI18nMock).toHaveBeenCalledWith({ locale: 'en' })
    // English is still a decision, so it is persisted like any other — the
    // detection runs once and never revisits an unsupported OS locale.
    expect(setStoredLocaleMock).toHaveBeenCalledWith('en')
  })

  it('boots in English without crashing when first-run detection throws', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    getStoredLocaleMock.mockReturnValue(null)
    getCurrentVaultPathMock.mockReturnValue(null)
    getVaultsMock.mockReturnValue([])
    // Unwritable config. `mockImplementationOnce` rather than a plain
    // implementation because `vi.clearAllMocks()` does not reset
    // implementations, so a persistent thrower would leak into later tests; the
    // `toHaveBeenCalledWith` below proves the one-shot was actually consumed.
    setStoredLocaleMock.mockImplementationOnce(() => {
      throw new Error('config is read-only')
    })

    await withOsLocale('de-DE', async () => {
      await importMainModule()
      await flushReadyWork()
    })

    expect(setStoredLocaleMock).toHaveBeenCalledWith('de')
    // The detected locale is discarded rather than returned unpersisted, so the
    // next launch re-detects instead of running a language it never stored.
    expect(createMainI18nMock).toHaveBeenCalledWith({ locale: 'en' })
    // Locale detection is never the reason a launch fails: boot continues.
    expect(registerAllHandlersMock).toHaveBeenCalled()
  })

  it('applies packaged log levels when running packaged', async () => {
    const electron = await import('electron')
    const app = electron.app as unknown as { isPackaged: boolean }
    app.isPackaged = true
    // Packaged env loading resolves Resources/app-config from resourcesPath.
    Object.defineProperty(process, 'resourcesPath', {
      value: '/mock/resources',
      configurable: true
    })

    try {
      await importMainModule()
      expect(applyPackagedLogLevelsMock).toHaveBeenCalled()
    } finally {
      app.isPackaged = false
      delete (process as unknown as { resourcesPath?: string }).resourcesPath
    }
  })

  it('registerOAuthState schedules expiry cleanup at 10 minutes', async () => {
    vi.useFakeTimers()

    const module = await importMainModule()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    module.registerOAuthState('state-1')

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10 * 60 * 1000)
  })

  it('wires ready-time desktop startup without touching real Electron state', async () => {
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    expect(registerAllHandlersMock).toHaveBeenCalledWith({
      i18n: expect.any(Object),
      rebuildMenu: expect.any(Function)
    })
    expect(initializeTelemetryRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appVersion: '1.0.0',
        locale: 'en-US',
        buildChannel: 'development'
      })
    )
    expect(applyPackagedLogLevelsMock).not.toHaveBeenCalled()
    expect(protocolHandleMock).toHaveBeenCalledWith('memry-file', expect.any(Function))
    expect(webRequestOnHeadersReceivedMock).toHaveBeenCalledWith(expect.any(Function))
    expect(setPermissionRequestHandlerMock).toHaveBeenCalledWith(expect.any(Function))
    expect(setPermissionCheckHandlerMock).toHaveBeenCalledWith(expect.any(Function))
    // The CRDT store is scoped to the open vault's uuid, and at ready time no
    // vault is open — autoOpenLastVault runs later in this same function, and
    // openVault makes the call. Opening it here could only ever be a no-op, and
    // a bootstrap that "settled" the init before a vault existed would leave
    // the provider in-memory for the rest of the session.
    expect(initPersistenceMock).not.toHaveBeenCalled()
    expect(applyGlobalCaptureShortcutMock).toHaveBeenCalled()
    expect(BrowserWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 760,
        height: 560,
        show: false
      })
    )
    expect(initializeUpdaterMock).toHaveBeenCalled()
    expect(autoOpenLastVaultMock).toHaveBeenCalled()

    const createdWindow = browserWindows[0]
    createdWindow.emitTestEvent('focus')
    expect(triggerGoogleCalendarSyncNowMock).toHaveBeenCalledWith('window-focus')
  })

  it('starts default-sized when a stored vault path exists', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    getCurrentVaultPathMock.mockReturnValue('/vault')

    await importMainModule()
    await flushReadyWork()

    expect(BrowserWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1550,
        height: 900,
        show: false
      })
    )
  })

  it('restores the saved window size and position when a vault is open', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    getCurrentVaultPathMock.mockReturnValue('/vault')
    getWindowBoundsMock.mockReturnValue({
      width: 1280,
      height: 820,
      x: 120,
      y: 90,
      isMaximized: false
    })

    await importMainModule()
    await flushReadyWork()

    expect(BrowserWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1280, height: 820, x: 120, y: 90, show: false })
    )
    expect(browserWindows[0].maximize).not.toHaveBeenCalled()
  })

  it('re-maximizes on launch when the window was left maximized', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    getCurrentVaultPathMock.mockReturnValue('/vault')
    getWindowBoundsMock.mockReturnValue({
      width: 1280,
      height: 820,
      x: 120,
      y: 90,
      isMaximized: true
    })

    await importMainModule()
    await flushReadyWork()

    expect(browserWindows[0].maximize).toHaveBeenCalledTimes(1)
  })

  it('restores saved bounds on dock reopen even when dev forces the vault picker', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    // MEMRY_FORCE_VAULT_PICKER shrinks the *initial* size in dev, but on a dock
    // reopen the vault is genuinely open — the saved geometry must still win.
    process.env.MEMRY_FORCE_VAULT_PICKER = '1'
    getCurrentVaultPathMock.mockReturnValue('/vault')
    getVaultStatusMock.mockReturnValue({ isOpen: true, path: '/vault' } as never)
    getWindowBoundsMock.mockReturnValue({
      width: 1327,
      height: 750,
      x: 120,
      y: 90,
      isMaximized: false
    })

    await importMainModule()
    await flushReadyWork()

    expect(BrowserWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1327, height: 750, x: 120, y: 90, show: false })
    )
  })

  it('resizes the compact picker window to the default app size after a vault opens', async () => {
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const createdWindow = browserWindows[0]
    createdWindow.getSize.mockReturnValue([760, 560])

    vaultStatusChangedListeners[0]?.({
      isOpen: true,
      path: '/vault',
      isIndexing: false,
      indexProgress: 0,
      error: null
    })

    expect(createdWindow.setSize).toHaveBeenCalledWith(1550, 900)

    createdWindow.setSize.mockClear()
    createdWindow.getSize.mockReturnValue([1550, 900])
    vaultStatusChangedListeners[0]?.({
      isOpen: true,
      path: '/vault',
      isIndexing: false,
      indexProgress: 0,
      error: null
    })

    expect(createdWindow.setSize).not.toHaveBeenCalled()
  })

  it('resizes the main window back to compact when the vault closes', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    getCurrentVaultPathMock.mockReturnValue('/vault')

    await importMainModule()
    await flushReadyWork()

    const createdWindow = browserWindows[0]
    createdWindow.getSize.mockReturnValue([1550, 900])

    vaultStatusChangedListeners[0]?.({
      isOpen: false,
      path: null,
      isIndexing: false,
      indexProgress: 0,
      error: null
    })

    expect(createdWindow.setSize).toHaveBeenCalledWith(760, 560)
  })

  it('drops the launch-timeline vault-status listener when the vault fails to open', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    getCurrentVaultPathMock.mockReturnValue('/vault')
    autoOpenLastVaultMock.mockRejectedValueOnce(new Error('vault open failed'))

    await importMainModule()
    await flushReadyWork()
    await flushUntil(() => vaultStatusChangedListeners.length === 1)

    // isOpen:true never arrives on a failed open, so the timeline listener has to
    // be dropped by the settled promise or it leaks for the whole session. Only
    // the window-resize listener may survive.
    expect(vaultStatusChangedListeners).toHaveLength(1)

    // ...and the survivor is the window-resize listener, not the timeline one.
    const createdWindow = browserWindows[0]
    createdWindow.getSize.mockReturnValue([1550, 900])
    vaultStatusChangedListeners[0]?.({
      isOpen: false,
      path: null,
      isIndexing: false,
      indexProgress: 0,
      error: null
    })
    expect(createdWindow.setSize).toHaveBeenCalledWith(760, 560)
  })

  // The stale-vault-path case: a stored path whose folder is gone resolves
  // autoOpenLastVault without ever opening a vault, so isOpen:true never fires.
  it('drops the launch-timeline vault-status listener when auto-open resolves without opening', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    getCurrentVaultPathMock.mockReturnValue('/vault')

    await importMainModule()
    await flushReadyWork()
    await flushUntil(() => vaultStatusChangedListeners.length === 1)

    expect(vaultStatusChangedListeners).toHaveLength(1)
  })

  it('covers dev-only startup paths for CSP, renderer URL loading, and React DevTools', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    isDevMock.dev = true
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
    existsSyncMock.mockReturnValue(true)
    readdirSyncMock.mockReturnValue(['1.0.0', '.DS_Store', '2.0.0'])

    await importMainModule()
    await flushReadyWork()

    expect(browserWindows[0].loadURL).toHaveBeenCalledWith('http://localhost:5173/')

    const cspCallback = webRequestOnHeadersReceivedMock.mock.calls.at(-1)?.[0] as (
      details: { url: string; responseHeaders?: Record<string, string[]> },
      callback: (response: { responseHeaders?: Record<string, string[]> }) => void
    ) => void
    const callback = vi.fn()
    cspCallback({ url: 'http://localhost:5173/index.html', responseHeaders: {} }, callback)
    expect(callback).toHaveBeenCalledWith({
      responseHeaders: expect.objectContaining({
        'Content-Security-Policy': [expect.stringContaining("'unsafe-eval'")]
      })
    })
  })

  it('serves memry-file protocol only from allowed paths', async () => {
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const protocolHandler = protocolHandleMock.mock.calls
      .find(([scheme]) => scheme === 'memry-file')
      ?.at(1) as (request: Request) => Promise<Response>
    expect(protocolHandler).toBeTypeOf('function')

    const blocked = await protocolHandler(new Request('memry-file://local/tmp/secret.txt'))
    expect(blocked.status).toBe(403)

    const missingImage = await protocolHandler(
      new Request('memry-file://local/mock/userData/thumb.png')
    )
    expect(missingImage.status).toBe(200)
    expect(missingImage.headers.get('Content-Type')).toBe('image/png')

    const missingText = await protocolHandler(
      new Request('memry-file://local/mock/userData/missing.txt')
    )
    expect(missingText.status).toBe(404)
  })

  it('serves existing memry-file requests with full and ranged responses', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ size: 10 })
    createReadStreamMock.mockReturnValue([Buffer.from('range')])

    await importMainModule()
    await flushReadyWork()

    const protocolHandler = protocolHandleMock.mock.calls
      .find(([scheme]) => scheme === 'memry-file')
      ?.at(1) as (request: Request) => Promise<Response>

    const full = await protocolHandler(new Request('memry-file://local/mock/userData/file.txt'))
    expect(full.status).toBe(200)
    expect(netFetchMock).toHaveBeenCalledWith('file:///mock/userData/file.txt')

    const ranged = await protocolHandler(
      new Request('memry-file://local/mock/userData/audio.mp3', {
        headers: { Range: 'bytes=2-6' }
      })
    )
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('Content-Range')).toBe('bytes 2-6/10')
    expect(await ranged.text()).toBe('range')
    expect(createReadStreamMock).toHaveBeenCalledWith('/mock/userData/audio.mp3', {
      start: 2,
      end: 6
    })

    statSyncMock.mockImplementationOnce(() => {
      throw new Error('stat failed')
    })
    const statFailed = await protocolHandler(
      new Request('memry-file://local/mock/userData/broken.txt')
    )
    expect(statFailed.status).toBe(404)
  })

  it('serves memry-file paths with the vault allow-list and open-ended ranges', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    getCurrentVaultPathMock.mockReturnValue('/vault')
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ size: 10 })
    createReadStreamMock.mockReturnValue([Buffer.from('tail')])

    await importMainModule()
    await flushReadyWork()

    const protocolHandler = protocolHandleMock.mock.calls
      .find(([scheme]) => scheme === 'memry-file')
      ?.at(1) as (request: Request) => Promise<Response>

    const allowed = await protocolHandler(
      new Request('memry-file://local/vault/media/audio.mp3', {
        headers: { Range: 'bytes=4-' }
      })
    )

    expect(allowed.status).toBe(206)
    expect(createReadStreamMock).toHaveBeenCalledWith('/vault/media/audio.mp3', {
      start: 4,
      end: 9
    })
  })

  it('applies CSP only to app-owned pages', async () => {
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const cspCallback = webRequestOnHeadersReceivedMock.mock.calls.at(-1)?.[0] as (
      details: { url: string; responseHeaders?: Record<string, string[]> },
      callback: (response: { responseHeaders?: Record<string, string[]> }) => void
    ) => void

    const ownCallback = vi.fn()
    cspCallback(
      { url: 'memry-file://local/mock/userData/file.png', responseHeaders: {} },
      ownCallback
    )
    expect(ownCallback).toHaveBeenCalledWith({
      responseHeaders: expect.objectContaining({
        'Content-Security-Policy': [expect.stringContaining("default-src 'self' memry-file:")]
      })
    })

    const externalCallback = vi.fn()
    cspCallback({ url: 'https://example.com/script.js', responseHeaders: {} }, externalCallback)
    expect(externalCallback).toHaveBeenCalledWith({})
  })

  it('configures certificate pinning callbacks when pins are available', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    isPinningDisabledMock.mockReturnValue(false)
    getPinnedCertificateHashesMock.mockReturnValue(['hash'])
    getPinnedCertificateHashesForHostnameMock.mockReturnValue(['hash'])

    await importMainModule()
    await flushReadyWork()

    const verify = setCertificateVerifyProcMock.mock.calls[0][0] as (
      request: { certificate: { data?: string }; hostname: string },
      callback: (result: number) => void
    ) => void

    const callback = vi.fn()
    verify({ certificate: {}, hostname: 'api.memrynote.com' }, callback)
    expect(callback).toHaveBeenLastCalledWith(-2)

    computeSpkiHashFromPemMock.mockReturnValueOnce('wrong-hash')
    verify({ certificate: { data: 'pem' }, hostname: 'api.memrynote.com' }, callback)
    expect(callback).toHaveBeenLastCalledWith(-2)

    computeSpkiHashFromPemMock.mockImplementationOnce(() => {
      throw new Error('bad pem')
    })
    verify({ certificate: { data: 'bad' }, hostname: 'api.memrynote.com' }, callback)
    expect(callback).toHaveBeenLastCalledWith(-2)

    verify({ certificate: { data: 'pem' }, hostname: 'api.memrynote.com' }, callback)
    expect(callback).toHaveBeenLastCalledWith(0)
  })

  it('lets unpinned external hosts use normal TLS in packaged builds', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    isPinningDisabledMock.mockReturnValue(false)
    getPinnedCertificateHashesMock.mockReturnValue(['hash'])
    getPinnedCertificateHashesForHostnameMock.mockImplementation((hostname: string) =>
      hostname === 'sync.memrynote.com' ? ['hash'] : []
    )

    await importMainModule()
    await flushReadyWork()

    const verify = setCertificateVerifyProcMock.mock.calls[0][0] as (
      request: { certificate: { data?: string }; hostname: string },
      callback: (result: number) => void
    ) => void

    const callback = vi.fn()
    verify({ certificate: {}, hostname: 'react-tweet.vercel.app' }, callback)

    expect(callback).toHaveBeenCalledWith(0)
    expect(computeSpkiHashFromPemMock).not.toHaveBeenCalled()
  })

  it('leaves certificate verification unset when pinning has no pins', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    isPinningDisabledMock.mockReturnValue(false)
    getPinnedCertificateHashesMock.mockReturnValue([])

    await importMainModule()
    await flushReadyWork()

    expect(setCertificateVerifyProcMock).not.toHaveBeenCalled()
  })

  it('wires BrowserWindow navigation, ready, and external-link handlers', async () => {
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const createdWindow = browserWindows[0]
    createdWindow.emitTestEvent('ready-to-show')
    expect(createdWindow.show).toHaveBeenCalled()

    const openHandler = createdWindow.webContents.setWindowOpenHandler.mock
      .calls[0][0] as (details: { url: string }) => { action: string }
    expect(openHandler({ url: 'https://memrynote.com' })).toEqual({ action: 'deny' })

    createdWindow.emitTestEvent('app-command', {}, 'browser-backward')
    expect(sendAppNavigationCommandMock).toHaveBeenCalledWith(
      createdWindow.webContents,
      'browser-backward'
    )

    createdWindow.emitTestEvent('swipe', {}, 'left')
    expect(sendAppNavigationSwipeCommandMock).toHaveBeenCalledWith(
      createdWindow.webContents,
      'left'
    )

    sendAppNavigationKeyboardCommandMock.mockReturnValueOnce(true)
    const beforeInput = createdWindow.webContents.on.mock.calls.find(
      ([event]) => event === 'before-input-event'
    )?.[1] as (event: { preventDefault: () => void }, input: unknown) => void
    const preventDefault = vi.fn()
    beforeInput({ preventDefault }, { key: 'BrowserBack' })
    expect(preventDefault).toHaveBeenCalled()
  })

  it('routes memry-file window opens to shell.openPath instead of openExternal', async () => {
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const { shell } = await import('electron')
    const createdWindow = browserWindows[0]
    const openHandler = createdWindow.webContents.setWindowOpenHandler.mock
      .calls[0][0] as (details: { url: string }) => { action: string }

    getCurrentVaultPathMock.mockReturnValue('/mock/vault')

    expect(openHandler({ url: 'memry-file://local/mock/vault/files/photo%201.png' })).toEqual({
      action: 'deny'
    })
    expect(shell.openPath).toHaveBeenCalledWith('/mock/vault/files/photo 1.png')
    expect(shell.openExternal).not.toHaveBeenCalled()

    vi.mocked(shell.openPath).mockClear()
    expect(openHandler({ url: 'memry-file://local/mock/elsewhere/secret.txt' })).toEqual({
      action: 'deny'
    })
    expect(shell.openPath).not.toHaveBeenCalled()

    expect(openHandler({ url: 'smb://host/share' })).toEqual({ action: 'deny' })
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(shell.openExternal).not.toHaveBeenCalled()

    expect(openHandler({ url: 'https://memrynote.com' })).toEqual({ action: 'deny' })
    expect(shell.openExternal).toHaveBeenCalledWith('https://memrynote.com')
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('guards will-frame-navigate on every created webContents', async () => {
    await importMainModule()

    const webContentsCreated = appOnMock.mock.calls.find(
      ([event]) => event === 'web-contents-created'
    )?.[1] as (event: unknown, contents: unknown) => void
    expect(webContentsCreated).toBeTypeOf('function')

    const contentsListeners = new Map<string, (...args: unknown[]) => void>()
    const contents = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        contentsListeners.set(event, listener)
      }),
      getURL: vi.fn(() => 'file:///mock/app/renderer/index.html#/home')
    }
    webContentsCreated({}, contents)

    const navListener = contentsListeners.get('will-frame-navigate') as (details: {
      url: string
      isMainFrame: boolean
      preventDefault: () => void
    }) => void
    expect(navListener).toBeTypeOf('function')

    const { shell } = await import('electron')

    // In-app hash routing stays untouched.
    const hashNav = {
      url: 'file:///mock/app/renderer/index.html#/notes/abc',
      isMainFrame: true,
      preventDefault: vi.fn()
    }
    navListener(hashNav)
    expect(hashNav.preventDefault).not.toHaveBeenCalled()

    // External links cancel in-window navigation and open in the OS browser.
    const externalNav = {
      url: 'https://memrynote.com/page',
      isMainFrame: true,
      preventDefault: vi.fn()
    }
    navListener(externalNav)
    expect(externalNav.preventDefault).toHaveBeenCalledTimes(1)
    expect(shell.openExternal).toHaveBeenCalledWith('https://memrynote.com/page')

    // Script schemes are blocked and never reach the OS.
    vi.mocked(shell.openExternal).mockClear()
    const scriptNav = { url: 'javascript:alert(1)', isMainFrame: true, preventDefault: vi.fn() }
    navListener(scriptNav)
    expect(scriptNav.preventDefault).toHaveBeenCalledTimes(1)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('logs the app version and channel at startup', async () => {
    await importMainModule()

    const { createLogger } = await import('./lib/logger')
    const scoped = vi.mocked(createLogger).mock.results[0]?.value as {
      info: ReturnType<typeof vi.fn>
    }
    expect(scoped.info).toHaveBeenCalledWith('MemryNote 1.0.0 starting (dev)')
  })

  it('reveals the main window via fallback timeout when ready-to-show never fires', async () => {
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const createdWindow = browserWindows[0]
    expect(createdWindow.show).not.toHaveBeenCalled()

    vi.advanceTimersByTime(10_000)
    expect(createdWindow.show).toHaveBeenCalledTimes(1)

    // The reveal reports one structured timeline so the slow phase is
    // attributable from the logs alone (#843).
    const { createLogger } = await import('./lib/logger')
    const scoped = vi.mocked(createLogger).mock.results[0]?.value as {
      warn: ReturnType<typeof vi.fn>
    }
    const timeline = scoped.warn.mock.calls.find(([message]) => message === 'launch timeline')
    expect(timeline?.[1]).toMatchObject({ reason: 'fallback-timeout', fallback: true })
    expect(timeline?.[1]).toHaveProperty('windowCreatedMs')
    expect(timeline?.[1]).toHaveProperty('shownMs')
  })

  it('reveals the main window on fatal load failure but ignores ERR_ABORTED', async () => {
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const createdWindow = browserWindows[0]
    const didFailLoad = createdWindow.webContents.on.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as (event: unknown, code: number, description: string, url: string) => void

    didFailLoad({}, -3, 'ERR_ABORTED', 'file:///renderer/index.html')
    expect(createdWindow.show).not.toHaveBeenCalled()

    didFailLoad({}, -6, 'ERR_FILE_NOT_FOUND', 'file:///renderer/index.html')
    expect(createdWindow.show).toHaveBeenCalledTimes(1)
  })

  it('surfaces a hidden existing window when a second instance launches', async () => {
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const existing = browserWindows[0]
    existing.isVisible.mockReturnValue(false)
    existing.isMinimized.mockReturnValue(true)

    const secondInstanceHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'second-instance'
    )?.[1] as (event: unknown, commandLine: string[]) => void

    secondInstanceHandler({}, ['--no-deep-link'])

    expect(existing.show).toHaveBeenCalled()
    expect(existing.restore).toHaveBeenCalled()
    expect(existing.focus).toHaveBeenCalled()
  })

  it('handles OAuth deep links for registered states', async () => {
    whenReadyMock.mockResolvedValue(undefined)

    const module = await importMainModule()
    await flushReadyWork()
    module.registerOAuthState('oauth-state')

    const openUrlHandler = appOnMock.mock.calls.find(([event]) => event === 'open-url')?.[1] as (
      event: { preventDefault: () => void },
      url: string
    ) => void
    const preventDefault = vi.fn()
    openUrlHandler({ preventDefault }, 'memry://oauth/callback?code=auth-code&state=oauth-state')

    expect(preventDefault).toHaveBeenCalled()
    expect(browserWindows[0].webContents.send).toHaveBeenCalledWith('auth:oauth-callback', {
      code: 'auth-code',
      state: 'oauth-state'
    })
    expect(browserWindows[0].focus).toHaveBeenCalled()

    const secondInstanceHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'second-instance'
    )?.[1] as (_event: unknown, commandLine: string[]) => void
    module.registerOAuthState('second-state')
    secondInstanceHandler({}, ['--flag', 'memry://oauth/callback?code=second&state=second-state'])
    expect(browserWindows[0].webContents.send).toHaveBeenCalledWith('auth:oauth-callback', {
      code: 'second',
      state: 'second-state'
    })

    expect(() => openUrlHandler({ preventDefault }, 'not a valid url')).not.toThrow()
  })

  it('routes billing deep links through checkout and reconciliation handlers', async () => {
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const openUrlHandler = appOnMock.mock.calls.find(([event]) => event === 'open-url')?.[1] as (
      event: { preventDefault: () => void },
      url: string
    ) => void
    const preventDefault = vi.fn()

    openUrlHandler({ preventDefault }, 'memry://billing/start?plan=plus&cadence=monthly')
    expect(preventDefault).toHaveBeenCalled()
    expect(browserWindows[0].webContents.send).toHaveBeenCalledWith(
      SettingsChannels.events.OPEN_SECTION,
      'account'
    )
    expect(startBillingCheckoutMock).toHaveBeenCalledWith()

    openUrlHandler({ preventDefault }, 'memry://billing/complete?transactionId=txn_123')
    expect(reconcileBillingAndSyncMock).toHaveBeenCalledWith({ transactionId: 'txn_123' })
  })

  it('handles window control IPC and native context menu resolution', async () => {
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const mainWindow = browserWindows[0]
    const pingHandler = ipcMainOnMock.mock.calls.find(
      ([event]) => event === 'ping'
    )?.[1] as () => void
    pingHandler()

    const minimizeHandler = ipcMainOnMock.mock.calls.find(
      ([event]) => event === 'window-minimize'
    )?.[1] as () => void
    minimizeHandler()
    expect(mainWindow.minimize).toHaveBeenCalled()

    const maximizeHandler = ipcMainOnMock.mock.calls.find(
      ([event]) => event === 'window-maximize'
    )?.[1] as () => void
    maximizeHandler()
    expect(mainWindow.maximize).toHaveBeenCalled()
    mainWindow.isMaximized.mockReturnValueOnce(true)
    maximizeHandler()
    expect(mainWindow.unmaximize).toHaveBeenCalled()

    const closeHandler = ipcMainOnMock.mock.calls.find(
      ([event]) => event === 'window-close'
    )?.[1] as () => void
    BrowserWindowMock.getFocusedWindow.mockReturnValueOnce(null)
    closeHandler()
    BrowserWindowMock.getFocusedWindow.mockReturnValueOnce(mainWindow)
    closeHandler()
    completeFlush(browserWindows[0])
    await flushReadyWork()
    expect(mainWindow.close).toHaveBeenCalled()

    const contextHandler = ipcMainHandleMock.mock.calls.find(
      ([event]) => event === 'context-menu:show'
    )?.[1] as (_event: unknown, items: Array<Record<string, unknown>>) => Promise<string | null>
    const { Menu, MenuItem } = await import('electron')
    const selected = contextHandler({}, [
      { id: 'copy', label: 'Copy', accelerator: 'CmdOrCtrl+C' },
      { id: 'sep', label: '', type: 'separator' },
      { id: 'disabled', label: 'Disabled', disabled: true }
    ])
    const copyItem = vi
      .mocked(MenuItem)
      .mock.calls.find(([config]) => (config as { label?: string }).label === 'Copy')?.[0] as {
      click: () => void
    }
    copyItem.click()
    await expect(selected).resolves.toBe('copy')

    const closed = contextHandler({}, [])
    const menuInstance = vi.mocked(Menu).mock.results.at(-1)?.value as {
      once: ReturnType<typeof vi.fn>
    }
    const menuWillClose = menuInstance.once.mock.calls.find(
      ([event]) => event === 'menu-will-close'
    )?.[1] as () => void
    menuWillClose()
    vi.advanceTimersByTime(100)
    await expect(closed).resolves.toBeNull()
  })

  it('shows the native editable context menu for text fields only', async () => {
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const mainWindow = browserWindows[0]
    const contextMenuHandler = mainWindow.webContents.on.mock.calls.find(
      ([event]) => event === 'context-menu'
    )?.[1] as (_event: unknown, params: Record<string, unknown>) => void
    const editableParams = {
      isEditable: true,
      frame: { id: 'frame-1' },
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true
      }
    }

    contextMenuHandler({}, editableParams)

    expect(buildEditableTextContextMenuMock).toHaveBeenCalledWith(expect.anything(), editableParams)
    expect(editableContextMenuPopupMock).toHaveBeenCalledWith({
      window: mainWindow,
      frame: editableParams.frame
    })

    editableContextMenuPopupMock.mockClear()
    buildEditableTextContextMenuMock.mockReturnValueOnce(null)
    contextMenuHandler({}, { isEditable: false, editFlags: {} })

    expect(editableContextMenuPopupMock).not.toHaveBeenCalled()
  })

  it('falls back to the global quick-capture shortcut and manages the quick window', async () => {
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)
    globalCaptureRegistered = false

    await importMainModule()
    await flushReadyWork()

    expect(globalShortcutRegisterMock).toHaveBeenCalledWith(
      'CommandOrControl+Shift+Space',
      expect.any(Function)
    )
    const shortcutHandler = globalShortcutRegisterMock.mock.calls[0][1] as () => void
    shortcutHandler()

    const quickWindow = browserWindows.at(-1)!
    expect(BrowserWindowMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        width: 480,
        height: 82,
        alwaysOnTop: true,
        skipTaskbar: true
      })
    )
    quickWindow.emitTestEvent('ready-to-show')
    expect(quickWindow.show).toHaveBeenCalled()
    expect(quickWindow.focus).toHaveBeenCalled()

    shortcutHandler()
    expect(quickWindow.focus).toHaveBeenCalledTimes(2)

    const resizeHandler = ipcMainOnMock.mock.calls.find(
      ([event]) => event === 'quick-capture:resize'
    )?.[1] as (_event: unknown, height: number) => void
    resizeHandler({}, 999)
    expect(quickWindow.setSize).toHaveBeenCalledWith(480, 400)

    const closeHandler = ipcMainOnMock.mock.calls.find(
      ([event]) => event === 'quick-capture:close'
    )?.[1] as () => void
    closeHandler()
    expect(quickWindow.close).toHaveBeenCalled()

    quickWindow.emitTestEvent('blur')
    vi.advanceTimersByTime(100)
    expect(quickWindow.close).toHaveBeenCalled()

    quickWindow.emitTestEvent('closed')
    shortcutHandler()
    expect(BrowserWindowMock).toHaveBeenCalledTimes(3)
  })

  it('keeps the quick-capture fallback shortcut alive across keyboard settings saves', async () => {
    // Saving keyboard settings re-applies the configured accelerator. That path used
    // to call globalShortcut.unregisterAll(), which silently dropped the fallback and
    // left quick capture with no working shortcut at all (#1087).
    whenReadyMock.mockResolvedValue(undefined)
    globalCaptureRegistered = false

    await importMainModule()
    await flushReadyWork()

    const fallbackRegistrations = (): Array<[string, () => void]> =>
      (globalShortcutRegisterMock.mock.calls as unknown as Array<[string, () => void]>).filter(
        ([accelerator]) => accelerator === 'CommandOrControl+Shift+Space'
      )

    expect(fallbackRegistrations()).toHaveLength(1)
    // Without this wiring a later re-apply can never restore the fallback.
    expect(setGlobalCaptureAppliedHandlerMock).toHaveBeenCalledWith(expect.any(Function))

    // Two further saves while the configured accelerator is still taken.
    applyGlobalCaptureShortcutMock()
    applyGlobalCaptureShortcutMock()

    expect(fallbackRegistrations()).toHaveLength(1)
    expect(globalShortcutUnregisterMock).not.toHaveBeenCalledWith('CommandOrControl+Shift+Space')

    // Still bound: firing it opens the quick capture window.
    const shortcutHandler = fallbackRegistrations()[0][1]
    shortcutHandler()
    expect(browserWindows.length).toBeGreaterThan(1)
  })

  it('releases the quick-capture fallback once the configured accelerator registers', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    globalCaptureRegistered = false

    await importMainModule()
    await flushReadyWork()

    globalCaptureRegistered = true
    applyGlobalCaptureShortcutMock()

    expect(globalShortcutUnregisterMock).toHaveBeenCalledWith('CommandOrControl+Shift+Space')

    // Idempotent: a repeat save must not release an accelerator we no longer hold.
    globalShortcutUnregisterMock.mockClear()
    applyGlobalCaptureShortcutMock()
    expect(globalShortcutUnregisterMock).not.toHaveBeenCalled()
  })

  it('loads quick capture from the dev renderer URL and wires load-failure logging', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    isDevMock.dev = true
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
    globalCaptureRegistered = false

    await importMainModule()
    await flushReadyWork()

    const shortcutHandler = globalShortcutRegisterMock.mock.calls[0][1] as () => void
    shortcutHandler()

    const quickWindow = browserWindows.at(-1)!
    expect(quickWindow.loadURL).toHaveBeenCalledWith('http://localhost:5173/#/quick-capture')

    const failLoadHandler = quickWindow.webContents.on.mock.calls.find(
      ([event]) => event === 'did-fail-load'
    )?.[1] as (_event: unknown, code: number, description: string) => void
    expect(() => failLoadHandler({}, -3, 'aborted')).not.toThrow()
  })

  it('routes quick capture settings to the main window before closing the capture window', async () => {
    whenReadyMock.mockResolvedValue(undefined)
    globalCaptureRegistered = false

    await importMainModule()
    await flushReadyWork()

    const shortcutHandler = globalShortcutRegisterMock.mock.calls[0][1] as () => void
    shortcutHandler()
    const quickWindow = browserWindows.at(-1)!
    const mainWindow = browserWindows[0]
    mainWindow.isMinimized.mockReturnValueOnce(true)
    mainWindow.isVisible.mockReturnValueOnce(false)

    const openSettingsHandler = ipcMainOnMock.mock.calls.find(
      ([event]) => event === 'quick-capture:open-settings'
    )?.[1] as (_event: unknown, section?: string) => void
    openSettingsHandler({}, 'sync')

    expect(mainWindow.restore).toHaveBeenCalled()
    expect(mainWindow.show).toHaveBeenCalled()
    expect(mainWindow.focus).toHaveBeenCalled()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      SettingsChannels.events.OPEN_SECTION,
      'sync'
    )
    expect(quickWindow.close).toHaveBeenCalled()
  })

  it('runs graceful shutdown cleanup from before-quit', async () => {
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const beforeQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as (event: { preventDefault: () => void }) => void
    const preventDefault = vi.fn()
    beforeQuitHandler({ preventDefault })
    const duplicatePreventDefault = vi.fn()
    beforeQuitHandler({ preventDefault: duplicatePreventDefault })
    expect(duplicatePreventDefault).not.toHaveBeenCalled()

    completeFlush(browserWindows[0])
    for (let i = 0; i < 40; i++) {
      await Promise.resolve()
    }

    expect(preventDefault).toHaveBeenCalled()
    expect(disposeTelemetryRuntimeMock).toHaveBeenCalled()
    // Embeddings utilityProcess must be stopped on quit or it lingers as a
    // Memrynote.exe and blocks the Windows NSIS update install (#805).
    expect(stopEmbeddingModelMock).toHaveBeenCalled()
    expect(stopSyncRuntimeMock).toHaveBeenCalled()
    expect(closeVaultMock).toHaveBeenCalled()
  })

  it('removes the flush-done listener when a window flush times out', async () => {
    // A busy renderer that never answers must not leave a listener behind on the
    // shared ipcMain: window-close runs on every close, so the leak is unbounded.
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()
    const { ipcMain } = await import('electron')

    const mainWindow = browserWindows[0]
    const closeHandler = ipcMainOnMock.mock.calls.find(
      ([event]) => event === 'window-close'
    )?.[1] as () => void
    closeHandler()

    const flushListener = getFlushDoneListeners().at(-1)
    expect(flushListener).toBeDefined()

    vi.advanceTimersByTime(2000)
    await flushUntil(() => mainWindow.close.mock.calls.length > 0)

    expect(mainWindow.close).toHaveBeenCalled()
    expect(ipcMain.removeListener).toHaveBeenCalledWith('app:flush-done', flushListener)
  })

  it('waits for every window to answer its own flush before shutdown continues', async () => {
    // One window replying must not satisfy the other window's flush, or the
    // slower renderer is torn down with unsaved edits still pending.
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)
    globalCaptureRegistered = false

    await importMainModule()
    await flushReadyWork()

    const shortcutHandler = globalShortcutRegisterMock.mock.calls[0][1] as () => void
    shortcutHandler()
    expect(browserWindows.length).toBeGreaterThan(1)

    const beforeQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as (event: { preventDefault: () => void }) => void
    beforeQuitHandler({ preventDefault: vi.fn() })

    // One shared listener covers every in-flight flush; the request id is what
    // separates them.
    expect(getFlushDoneListeners()).toHaveLength(1)

    completeFlush(browserWindows[0])
    await flushUntil(() => closeVaultMock.mock.calls.length > 0, 40)
    expect(closeVaultMock).not.toHaveBeenCalled()

    completeFlush(browserWindows[1])
    await flushUntil(() => closeVaultMock.mock.calls.length > 0)
    expect(closeVaultMock).toHaveBeenCalled()
  })

  it('keeps one flush-done listener when more than ten windows flush at once', async () => {
    // `app:flush-done` lives on the shared ipcMain, and Node warns
    // (MaxListenersExceededWarning) past ten listeners on one channel. A
    // listener per window tripped that on any quit with enough windows open.
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()
    const { ipcMain } = await import('electron')

    for (let i = 0; i < 12; i++) createBrowserWindowMock()
    expect(browserWindows.length).toBeGreaterThan(10)

    const beforeQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as (event: { preventDefault: () => void }) => void
    beforeQuitHandler({ preventDefault: vi.fn() })

    const flushListeners = getFlushDoneListeners()
    expect(flushListeners).toHaveLength(1)
    // Every window still got its own request, so no flush is silently skipped.
    const requestIds = browserWindows.map((window) => getFlushRequestId(window))
    expect(requestIds.every((requestId) => typeof requestId === 'string')).toBe(true)
    expect(new Set(requestIds).size).toBe(browserWindows.length)

    for (const window of browserWindows) completeFlush(window)
    await flushUntil(() => closeVaultMock.mock.calls.length > 0)

    expect(closeVaultMock).toHaveBeenCalled()
    // Nothing is pending any more, so the shared listener is detached too.
    expect(ipcMain.removeListener).toHaveBeenCalledWith('app:flush-done', flushListeners[0])
  })

  it('ignores a flush-done from another window even when it carries the pending request id', async () => {
    // Defence in depth on top of the request id: no renderer may answer on
    // another window's behalf, because that window's saves are still in flight.
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)
    globalCaptureRegistered = false

    await importMainModule()
    await flushReadyWork()

    const shortcutHandler = globalShortcutRegisterMock.mock.calls[0][1] as () => void
    shortcutHandler()

    const beforeQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as (event: { preventDefault: () => void }) => void
    beforeQuitHandler({ preventDefault: vi.fn() })

    const impersonatedRequestId = getFlushRequestId(browserWindows[0])
    for (const listener of getFlushDoneListeners()) {
      listener({ sender: browserWindows[1].webContents }, impersonatedRequestId)
    }

    completeFlush(browserWindows[1])
    await flushUntil(() => closeVaultMock.mock.calls.length > 0, 40)
    expect(closeVaultMock).not.toHaveBeenCalled()

    completeFlush(browserWindows[0])
    await flushUntil(() => closeVaultMock.mock.calls.length > 0)
    expect(closeVaultMock).toHaveBeenCalled()
  })

  it('ignores a stale flush-done from an earlier request on the same window', async () => {
    // The close flush timed out and the renderer answered late. That reply is
    // about older content, so it must not satisfy the quit flush.
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()

    const mainWindow = browserWindows[0]
    const closeHandler = ipcMainOnMock.mock.calls.find(
      ([event]) => event === 'window-close'
    )?.[1] as () => void
    closeHandler()
    const staleRequestId = getFlushRequestId(mainWindow)
    vi.advanceTimersByTime(2000)
    await flushUntil(() => mainWindow.close.mock.calls.length > 0)

    const beforeQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as (event: { preventDefault: () => void }) => void
    beforeQuitHandler({ preventDefault: vi.fn() })

    const quitRequestId = getFlushRequestId(mainWindow)
    expect(quitRequestId).not.toBe(staleRequestId)

    for (const listener of getFlushDoneListeners()) {
      listener({ sender: mainWindow.webContents }, staleRequestId)
    }
    await flushUntil(() => closeVaultMock.mock.calls.length > 0, 40)
    expect(closeVaultMock).not.toHaveBeenCalled()

    completeFlush(mainWindow)
    await flushUntil(() => closeVaultMock.mock.calls.length > 0)
    expect(closeVaultMock).toHaveBeenCalled()
  })

  it('terminates via app.quit (not app.exit) after graceful shutdown so update-on-quit can run', async () => {
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()
    const { app } = await import('electron')

    const beforeQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as (event: { preventDefault: () => void }) => void
    beforeQuitHandler({ preventDefault: vi.fn() })

    completeFlush(browserWindows[0])
    for (let i = 0; i < 40; i++) {
      await Promise.resolve()
    }

    expect(app.quit).toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('hands off to performQuitAndInstall when an update install was requested', async () => {
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)

    await importMainModule()
    await flushReadyWork()
    const { app } = await import('electron')
    const updater = await import('./updater')
    // Install-requested is read twice in the success path: once to pick the
    // skip-final-sync path, once at completion. Use two once's (not a persistent
    // mockReturnValue) so the flag doesn't leak into later tests.
    vi.mocked(updater.isQuitAndInstallRequested).mockReturnValueOnce(true).mockReturnValueOnce(true)

    const beforeQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as (event: { preventDefault: () => void }) => void
    beforeQuitHandler({ preventDefault: vi.fn() })

    completeFlush(browserWindows[0])
    for (let i = 0; i < 40; i++) {
      await Promise.resolve()
    }

    expect(updater.performQuitAndInstall).toHaveBeenCalled()
    // Update path skips the unbounded final network push.
    expect(stopSyncRuntimeMock).toHaveBeenCalledWith({ skipFinalSync: true })
    expect(app.quit).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('creates close snapshots for open CRDT notes during graceful shutdown', async () => {
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)
    getOpenNoteIdsMock.mockReturnValue(['note-a', 'note-b', 'missing-note', 'empty-note'])
    getNoteCacheByIdMock.mockImplementation((_db, noteId: string) => {
      const rows: Record<string, { path: string; title: string }> = {
        'note-a': { path: 'notes/a.md', title: 'Alpha' },
        'note-b': { path: 'notes/b.md', title: 'Beta' },
        'empty-note': { path: 'notes/empty.md', title: 'Empty' }
      }
      return rows[noteId] ?? null
    })
    safeReadMock.mockImplementation(async (filePath: string) =>
      filePath.includes('empty') ? null : `content for ${filePath}`
    )
    createSnapshotMock.mockReturnValueOnce({ id: 'snap-a' }).mockReturnValueOnce(null)

    await importMainModule()
    await flushReadyWork()

    const beforeQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as (event: { preventDefault: () => void }) => void
    beforeQuitHandler({ preventDefault: vi.fn() })

    completeFlush(browserWindows[0])
    for (let i = 0; i < 30; i++) {
      await Promise.resolve()
    }

    expect(toAbsolutePathMock).toHaveBeenCalledWith('notes/a.md')
    expect(safeReadMock).toHaveBeenCalledWith('notes/a.md')
    expect(createSnapshotMock).toHaveBeenCalledWith(
      'note-a',
      'content for notes/a.md',
      'Alpha',
      expect.any(String)
    )
    expect(createSnapshotMock).toHaveBeenCalledWith(
      'note-b',
      'content for notes/b.md',
      'Beta',
      expect.any(String)
    )
    expect(createSnapshotMock).toHaveBeenCalledTimes(2)
  })

  it('flushes pending write-backs and closes the databases before the forced exit', async () => {
    // #given a vault close that never settles, so the budget runs out on the
    // last teardown step (#1586)
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)
    closeVaultMock.mockImplementationOnce(() => new Promise(() => {}))

    await importMainModule()
    await flushReadyWork()
    const { app } = await import('electron')
    const { SHUTDOWN_BUDGET_MS } = await import('./shutdown-sequence')

    const beforeQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as (event: { preventDefault: () => void }) => void
    beforeQuitHandler({ preventDefault: vi.fn() })

    completeFlush(browserWindows[0])
    await flushUntil(() => closeVaultMock.mock.calls.length > 0)

    // #when the shutdown budget expires
    await vi.advanceTimersByTimeAsync(SHUTDOWN_BUDGET_MS)

    // #then the marker names the step that overran, and the last chance to make
    // the user's data durable runs BEFORE the process is killed
    expect(markShutdownFailureMock).toHaveBeenCalledWith('timeout', 'close-vault')
    await flushUntil(() => vi.mocked(app.exit).mock.calls.length > 0)
    expect(flushPendingWritebacksMock).toHaveBeenCalled()
    expect(closeAllDatabasesMock).toHaveBeenCalled()
    expect(app.exit).toHaveBeenCalledWith(1)
  })

  it('does not force-exit before the graceful budget is spent', async () => {
    // #given the same wedged vault close
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)
    closeVaultMock.mockImplementationOnce(() => new Promise(() => {}))

    await importMainModule()
    await flushReadyWork()
    const { app } = await import('electron')

    const beforeQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as (event: { preventDefault: () => void }) => void
    beforeQuitHandler({ preventDefault: vi.fn() })

    completeFlush(browserWindows[0])
    await flushUntil(() => closeVaultMock.mock.calls.length > 0)

    // #when the old 5s deadline passes — the point at which the app used to be
    // killed with write-back timers still armed
    await vi.advanceTimersByTimeAsync(5000)

    // #then the chain is still allowed to finish
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('exits with failure when graceful cleanup rejects', async () => {
    vi.useFakeTimers()
    whenReadyMock.mockResolvedValue(undefined)
    closeVaultMock.mockRejectedValueOnce(new Error('close failed'))

    await importMainModule()
    await flushReadyWork()
    const { app } = await import('electron')

    const beforeQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'before-quit'
    )?.[1] as (event: { preventDefault: () => void }) => void
    beforeQuitHandler({ preventDefault: vi.fn() })

    completeFlush(browserWindows[0])
    await flushUntil(() => vi.mocked(app.exit).mock.calls.length > 0)

    expect(app.exit).toHaveBeenCalledWith(1)
  })

  it('starts the crash reporter without ever uploading minidumps', async () => {
    // #when the main module loads
    await importMainModule()

    // #then dumps are kept for the local diagnostic bundle only. uploadToServer
    // must stay false: a minidump is raw process memory, and PostHog neither
    // ingests it nor could redact it.
    expect(crashReporterStartMock).toHaveBeenCalledWith({ uploadToServer: false })
  })

  it('handles app close lifecycle events', async () => {
    await importMainModule()
    const { app } = await import('electron')

    const windowAllClosedHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'window-all-closed'
    )?.[1] as () => void
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      windowAllClosedHandler()
      expect(app.quit).toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }

    const willQuitHandler = appOnMock.mock.calls.find(
      ([event]) => event === 'will-quit'
    )?.[1] as () => void
    willQuitHandler()
    expect(globalShortcutUnregisterAllMock).toHaveBeenCalled()
  })
})
