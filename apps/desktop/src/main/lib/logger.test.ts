import { describe, it, expect, vi, beforeEach } from 'vitest'

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

  it('starts error handler', async () => {
    await import('./logger')
    expect(mockStartCatching).toHaveBeenCalled()
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
