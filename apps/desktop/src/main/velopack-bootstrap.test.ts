import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const makeLogger = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
  const run = vi.fn<() => void>()
  const setLogger = vi.fn<
    (callback: (level: string, message: string) => void) => { run: typeof run }
  >(() => ({ run }))
  const build = vi.fn<() => { setLogger: typeof setLogger }>(() => ({ setLogger }))

  return {
    build,
    setLogger,
    run,
    loadVelopack: vi.fn(() => ({ VelopackApp: { build } })),
    library: makeLogger(),
    bootstrap: makeLogger(),
    createLogger: vi.fn<(scope: string) => ReturnType<typeof makeLogger>>(),
    app: { isPackaged: true }
  }
})

vi.mock('electron', () => ({
  app: mocks.app
}))

vi.mock('./lib/logger', () => ({
  createLogger: mocks.createLogger
}))

vi.mock('./velopack-native', () => ({
  loadVelopack: mocks.loadVelopack
}))

async function importBootstrap(): Promise<void> {
  vi.resetModules()
  await import('./velopack-bootstrap')
}

const realPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

describe('velopack bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform('win32')
    mocks.app.isPackaged = true
    mocks.run.mockReset()
    mocks.createLogger.mockImplementation((scope) =>
      scope === 'Velopack' ? mocks.library : mocks.bootstrap
    )
  })

  afterEach(() => {
    setPlatform(realPlatform)
  })

  it('runs the Velopack startup hooks on a packaged Windows build', async () => {
    await importBootstrap()

    expect(mocks.build).toHaveBeenCalledTimes(1)
    expect(mocks.setLogger).toHaveBeenCalledTimes(1)
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })

  it("routes Velopack's own log messages into the app log", async () => {
    await importBootstrap()

    const [route] = mocks.setLogger.mock.calls[0]
    route('info', 'checking for pending hooks')
    route('warn', 'no update pending')
    // Velopack has a trace level; electron-log stops at debug.
    route('trace', 'locator resolved')

    expect(mocks.createLogger).toHaveBeenCalledWith('Velopack')
    expect(mocks.library.info).toHaveBeenCalledWith('checking for pending hooks')
    expect(mocks.library.warn).toHaveBeenCalledWith('no update pending')
    expect(mocks.library.debug).toHaveBeenCalledWith('locator resolved')
  })

  it('keeps the app starting when the bootstrap throws', async () => {
    const failure = new Error('Update.exe is missing')
    mocks.run.mockImplementation(() => {
      throw failure
    })

    await expect(importBootstrap()).resolves.toBeUndefined()

    expect(mocks.bootstrap.warn).toHaveBeenCalledWith(
      'velopack bootstrap failed; continuing without it',
      failure
    )
  })

  it('does nothing off Windows', async () => {
    setPlatform('darwin')

    await importBootstrap()

    expect(mocks.loadVelopack).not.toHaveBeenCalled()
  })

  it('does nothing in an unpackaged build', async () => {
    mocks.app.isPackaged = false

    await importBootstrap()

    expect(mocks.loadVelopack).not.toHaveBeenCalled()
  })
})
