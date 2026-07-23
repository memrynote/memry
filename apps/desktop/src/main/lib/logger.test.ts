import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const mockScope = vi.fn()
const mockStartCatching = vi.fn()

vi.mock('electron-log', () => {
  const scopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    silly: vi.fn()
  }

  mockScope.mockReturnValue(scopedLogger)

  return {
    default: {
      transports: {
        file: { level: null, maxSize: 0, format: '' },
        console: { level: null, format: '' }
      },
      errorHandler: { startCatching: mockStartCatching },
      scope: mockScope,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    }
  }
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('logger', () => {
  it('exports log and createLogger', async () => {
    const { log, createLogger } = await import('./logger')
    expect(log).toBeDefined()
    expect(createLogger).toBeTypeOf('function')
  })

  it('configures file transport', async () => {
    const { log } = await import('./logger')
    expect(log.transports.file.maxSize).toBe(5 * 1024 * 1024)
    expect(log.transports.file.format).toContain('[{level}]')
    expect(log.transports.file.format).toContain('[{scope}]')
  })

  it('configures console transport', async () => {
    const { log } = await import('./logger')
    expect(log.transports.console.format).toContain('[{level}]')
    expect(log.transports.console.format).toContain('[{scope}]')
  })

  it('starts error handler with showDialog disabled and onError callback', async () => {
    await import('./logger')
    expect(mockStartCatching).toHaveBeenCalledWith({
      showDialog: false,
      onError: expect.any(Function)
    })
  })

  it('exports disableConsoleTransport that sets console level to false', async () => {
    const { log, disableConsoleTransport } = await import('./logger')
    // #given
    log.transports.console.level = 'debug'

    // #when
    disableConsoleTransport()

    // #then
    expect(log.transports.console.level).toBe(false)
  })

  it('applyPackagedLogLevels drops verbosity to info file / warn console', async () => {
    const { log, applyPackagedLogLevels } = await import('./logger')

    applyPackagedLogLevels()

    expect(log.transports.file.level).toBe('info')
    expect(log.transports.console.level).toBe('warn')
  })

  it('createLogger returns scoped logger with expected methods', async () => {
    const { createLogger } = await import('./logger')
    const scoped = createLogger('test-scope')

    expect(mockScope).toHaveBeenCalledWith('test-scope')
    expect(scoped.info).toBeTypeOf('function')
    expect(scoped.error).toBeTypeOf('function')
    expect(scoped.warn).toBeTypeOf('function')
    expect(scoped.debug).toBeTypeOf('function')
  })
})

type ResolvePathFn = (variables: { fileName?: string }) => string

const getResolvePathFn = async (): Promise<ResolvePathFn> => {
  const { log } = await import('./logger')
  return (log.transports.file as unknown as { resolvePathFn: ResolvePathFn }).resolvePathFn
}

const withPlatform = async (platform: string, run: () => Promise<void>): Promise<void> => {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    await run()
  } finally {
    Object.defineProperty(process, 'platform', { value: original })
  }
}

describe('file transport location', () => {
  beforeEach(() => {
    delete process.env.MEMRY_TEST_LOG_DIR
    delete process.env.MEMRY_DEVICE
    delete process.env.XDG_CONFIG_HOME
    delete process.env.APPDATA
  })

  it('resolves ~/Library/Logs/memrynote on macOS', async () => {
    await withPlatform('darwin', async () => {
      const resolvePathFn = await getResolvePathFn()
      expect(resolvePathFn({ fileName: 'main.log' })).toBe(
        join(homedir(), 'Library', 'Logs', 'memrynote', 'main.log')
      )
    })
  })

  it('falls back to main.log when fileName is missing', async () => {
    await withPlatform('darwin', async () => {
      const resolvePathFn = await getResolvePathFn()
      expect(resolvePathFn({})).toBe(join(homedir(), 'Library', 'Logs', 'memrynote', 'main.log'))
    })
  })

  it('suffixes the dir with MEMRY_DEVICE so dev profiles stay isolated', async () => {
    process.env.MEMRY_DEVICE = 'A'
    await withPlatform('darwin', async () => {
      const resolvePathFn = await getResolvePathFn()
      expect(resolvePathFn({ fileName: 'main.log' })).toBe(
        join(homedir(), 'Library', 'Logs', 'memrynote-A', 'main.log')
      )
    })
  })

  it('prefers MEMRY_TEST_LOG_DIR over everything else', async () => {
    process.env.MEMRY_TEST_LOG_DIR = join(tmpdir(), 'e2e-run-logs')
    process.env.MEMRY_DEVICE = 'A'
    await withPlatform('darwin', async () => {
      const resolvePathFn = await getResolvePathFn()
      expect(resolvePathFn({ fileName: 'renderer.log' })).toBe(
        join(tmpdir(), 'e2e-run-logs', 'renderer.log')
      )
    })
  })

  it('resolves %APPDATA%/memrynote/logs on Windows', async () => {
    process.env.APPDATA = join(tmpdir(), 'Roaming')
    await withPlatform('win32', async () => {
      const resolvePathFn = await getResolvePathFn()
      expect(resolvePathFn({ fileName: 'main.log' })).toBe(
        join(tmpdir(), 'Roaming', 'memrynote', 'logs', 'main.log')
      )
    })
  })

  it('falls back to homedir AppData/Roaming when APPDATA is unset', async () => {
    await withPlatform('win32', async () => {
      const resolvePathFn = await getResolvePathFn()
      expect(resolvePathFn({ fileName: 'main.log' })).toBe(
        join(homedir(), 'AppData', 'Roaming', 'memrynote', 'logs', 'main.log')
      )
    })
  })

  it('resolves XDG config dir/memrynote/logs on Linux', async () => {
    process.env.XDG_CONFIG_HOME = join(tmpdir(), 'xdg')
    await withPlatform('linux', async () => {
      const resolvePathFn = await getResolvePathFn()
      expect(resolvePathFn({ fileName: 'main.log' })).toBe(
        join(tmpdir(), 'xdg', 'memrynote', 'logs', 'main.log')
      )
    })
  })

  it('falls back to ~/.config/memrynote/logs on Linux without XDG_CONFIG_HOME', async () => {
    await withPlatform('linux', async () => {
      const resolvePathFn = await getResolvePathFn()
      expect(resolvePathFn({ fileName: 'main.log' })).toBe(
        join(homedir(), '.config', 'memrynote', 'logs', 'main.log')
      )
    })
  })
})

describe('migrateLegacyLogDir', () => {
  let base: string

  beforeEach(() => {
    delete process.env.MEMRY_TEST_LOG_DIR
    delete process.env.MEMRY_DEVICE
    base = mkdtempSync(join(tmpdir(), 'memry-logger-'))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  const migrate = async (overrides: { legacyDir: string; targetDir: string }): Promise<void> => {
    const { migrateLegacyLogDir } = await import('./logger')
    migrateLegacyLogDir(overrides)
  }

  it('moves legacy log files into the target dir and removes the legacy dir', async () => {
    const legacyDir = join(base, 'legacy')
    const targetDir = join(base, 'target')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'main.log'), 'old-main')
    writeFileSync(join(legacyDir, 'main.old.log'), 'old-rotated')

    await migrate({ legacyDir, targetDir })

    expect(readFileSync(join(targetDir, 'main.log'), 'utf8')).toBe('old-main')
    expect(readFileSync(join(targetDir, 'main.old.log'), 'utf8')).toBe('old-rotated')
    expect(existsSync(legacyDir)).toBe(false)
  })

  it('keeps an already-started target file and moves the legacy one aside', async () => {
    const legacyDir = join(base, 'legacy')
    const targetDir = join(base, 'target')
    mkdirSync(legacyDir, { recursive: true })
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(legacyDir, 'main.log'), 'old-main')
    writeFileSync(join(targetDir, 'main.log'), 'new-main')

    await migrate({ legacyDir, targetDir })

    expect(readFileSync(join(targetDir, 'main.log'), 'utf8')).toBe('new-main')
    expect(readFileSync(join(targetDir, 'legacy-main.log'), 'utf8')).toBe('old-main')
    expect(existsSync(legacyDir)).toBe(false)
  })

  it('leaves the file in place when both target names are taken', async () => {
    const legacyDir = join(base, 'legacy')
    const targetDir = join(base, 'target')
    mkdirSync(legacyDir, { recursive: true })
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(legacyDir, 'main.log'), 'old-main')
    writeFileSync(join(targetDir, 'main.log'), 'new-main')
    writeFileSync(join(targetDir, 'legacy-main.log'), 'other')

    await migrate({ legacyDir, targetDir })

    expect(readFileSync(join(legacyDir, 'main.log'), 'utf8')).toBe('old-main')
    expect(existsSync(legacyDir)).toBe(true)
  })

  it('skips subdirectories and keeps the legacy dir when one remains', async () => {
    const legacyDir = join(base, 'legacy')
    const targetDir = join(base, 'target')
    mkdirSync(join(legacyDir, 'nested'), { recursive: true })
    writeFileSync(join(legacyDir, 'main.log'), 'old-main')

    await migrate({ legacyDir, targetDir })

    expect(readFileSync(join(targetDir, 'main.log'), 'utf8')).toBe('old-main')
    expect(existsSync(join(legacyDir, 'nested'))).toBe(true)
  })

  it('does nothing when the legacy dir does not exist', async () => {
    const legacyDir = join(base, 'legacy')
    const targetDir = join(base, 'target')

    await migrate({ legacyDir, targetDir })

    expect(existsSync(targetDir)).toBe(false)
  })

  it('removes an emptied @memry parent dir', async () => {
    const legacyDir = join(base, '@memry', 'desktop')
    const targetDir = join(base, 'target')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'main.log'), 'old-main')

    await migrate({ legacyDir, targetDir })

    expect(existsSync(join(base, '@memry'))).toBe(false)
  })

  it('is a no-op under MEMRY_TEST_LOG_DIR (E2E runs must not touch user logs)', async () => {
    process.env.MEMRY_TEST_LOG_DIR = join(base, 'e2e')
    const legacyDir = join(base, 'legacy')
    const targetDir = join(base, 'target')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'main.log'), 'old-main')

    await migrate({ legacyDir, targetDir })

    expect(readFileSync(join(legacyDir, 'main.log'), 'utf8')).toBe('old-main')
    expect(existsSync(targetDir)).toBe(false)
  })

  it('is a no-op for MEMRY_DEVICE dev profiles', async () => {
    process.env.MEMRY_DEVICE = 'A'
    const legacyDir = join(base, 'legacy')
    const targetDir = join(base, 'target')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'main.log'), 'old-main')

    await migrate({ legacyDir, targetDir })

    expect(readFileSync(join(legacyDir, 'main.log'), 'utf8')).toBe('old-main')
    expect(existsSync(targetDir)).toBe(false)
  })
})
