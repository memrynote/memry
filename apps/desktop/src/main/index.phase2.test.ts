import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appOnMock = vi.fn()
const whenReadyMock = vi.fn(() => new Promise<void>(() => {}))
const requestSingleInstanceLockMock = vi.fn(() => true)
const getPathMock = vi.fn((name: string) => `/mock/${name}`)
const setPathMock = vi.fn()
const dotenvConfigMock = vi.fn(() => ({ error: undefined }))

vi.mock('dotenv', () => ({
  config: dotenvConfigMock
}))

vi.mock('./ipc', () => ({
  registerAllHandlers: vi.fn()
}))

vi.mock('./vault', () => ({
  autoOpenLastVault: vi.fn(async () => undefined),
  closeVault: vi.fn(async () => undefined)
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

vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: false }
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
    quit: vi.fn(),
    exit: vi.fn()
  },
  shell: { openExternal: vi.fn() },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null)
  },
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn()
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn()
  },
  net: {
    fetch: vi.fn()
  },
  globalShortcut: {
    register: vi.fn(() => true),
    unregisterAll: vi.fn()
  },
  clipboard: {
    readText: vi.fn(() => '')
  },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1440, height: 900 } }))
  },
  session: {
    defaultSession: {}
  },
  Menu: vi.fn(),
  MenuItem: vi.fn()
}))

const ORIGINAL_ENV = { ...process.env }

async function importMainModule() {
  return import('./index')
}

describe('main index phase2 exports', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    getPathMock.mockImplementation((name: string) => `/mock/${name}`)
    process.env = { ...ORIGINAL_ENV }
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
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

  it('skips the single-instance lock for multi-device test launches', async () => {
    process.env.NODE_ENV = 'test'
    process.env.MEMRY_DEVICE = 'A'

    await importMainModule()

    expect(requestSingleInstanceLockMock).not.toHaveBeenCalled()
  })

  it('registerOAuthState schedules expiry cleanup at 10 minutes', async () => {
    vi.useFakeTimers()

    const module = await importMainModule()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    module.registerOAuthState('state-1')

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10 * 60 * 1000)
  })
})
