import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))

vi.mock('../telemetry/diagnostics', () => ({
  trackMainError: vi.fn()
}))

import { getDatabase } from '../database'
import { trackMainError } from '../telemetry/diagnostics'
import { markExpectedCondition } from '../telemetry/expected-conditions'
import { withErrorHandler, withDb, ipcErrorThrottleKeyCount } from './validate'

const mockGetDatabase = vi.mocked(getDatabase)
const mockTrackMainError = vi.mocked(trackMainError)

const namedError = (name: string, message = 'boom'): Error => {
  const error = new Error(message)
  error.name = name
  return error
}

describe('withErrorHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes through successful result', async () => {
    // #given
    const handler = withErrorHandler(
      async () => ({ success: true as const, task: { id: '1' } }),
      'Failed to create task'
    )

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({ success: true, task: { id: '1' } })
  })

  it('passes arguments to handler', async () => {
    // #given
    const inner = vi.fn(async (input: { title: string }) => ({
      success: true as const,
      title: input.title
    }))
    const handler = withErrorHandler(inner, 'Failed')

    // #when
    await handler({ title: 'hello' })

    // #then
    expect(inner).toHaveBeenCalledWith({ title: 'hello' })
  })

  it('catches Error and returns formatted response', async () => {
    // #given
    const handler = withErrorHandler(async () => {
      throw new Error('db constraint violated')
    }, 'Failed to create task')

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({ success: false, error: 'db constraint violated' })
  })

  it('uses fallback message for non-Error throws', async () => {
    // #given
    const handler = withErrorHandler(async () => {
      throw 'string error'
    }, 'Failed to create task')

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({ success: false, error: 'Failed to create task' })
  })

  it('uses default fallback when none provided', async () => {
    // #given
    const handler = withErrorHandler(async () => {
      throw 42
    })

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({ success: false, error: 'errors:generic.operationFailed' })
  })

  it('handles sync handlers', async () => {
    // #given
    const handler = withErrorHandler(() => ({ success: true as const, count: 5 }), 'Failed')

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({ success: true, count: 5 })
  })
})

describe('withDb', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls getDatabase and passes db to handler', async () => {
    // #given
    const mockDb = { select: vi.fn() }
    mockGetDatabase.mockReturnValue(mockDb as never)

    const inner = vi.fn(async (db: unknown) => ({
      success: true as const,
      db: db
    }))
    const handler = withDb(inner, 'Failed')

    // #when
    const result = await handler()

    // #then
    expect(mockGetDatabase).toHaveBeenCalled()
    expect(inner).toHaveBeenCalledWith(mockDb)
    expect(result).toEqual({ success: true, db: mockDb })
  })

  it('passes additional arguments after db', async () => {
    // #given
    const mockDb = {}
    mockGetDatabase.mockReturnValue(mockDb as never)

    const inner = vi.fn(async (db: unknown, input: { id: string }) => ({
      success: true as const,
      id: input.id
    }))
    const handler = withDb(inner, 'Failed')

    // #when
    await handler({ id: 'abc' })

    // #then
    expect(inner).toHaveBeenCalledWith(mockDb, { id: 'abc' })
  })

  it('catches handler errors with fallback', async () => {
    // #given
    const mockDb = {}
    mockGetDatabase.mockReturnValue(mockDb as never)

    const handler = withDb(async () => {
      throw new Error('not found')
    }, 'Failed to fetch')

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({ success: false, error: 'not found' })
  })

  it('catches getDatabase errors with vault-friendly key', async () => {
    // #given
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized')
    })

    const handler = withDb(async () => ({ success: true as const }), 'Failed')

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({
      success: false,
      error: 'errors:ipc.noVaultOpen'
    })
  })

  it('uses fallback for non-Error throws from handler', async () => {
    // #given
    const mockDb = {}
    mockGetDatabase.mockReturnValue(mockDb as never)

    const handler = withDb(async () => {
      throw null
    }, 'Failed to update task')

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({ success: false, error: 'Failed to update task' })
  })

  it('handles sync (non-async) handlers', async () => {
    // #given
    const mockDb = {}
    mockGetDatabase.mockReturnValue(mockDb as never)

    const handler = withDb((db) => ({ success: true as const, hasDb: db !== null }), 'Failed')

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({ success: true, hasDb: true })
  })
})

describe('IPC error telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('withErrorHandler tracks the error and still returns the envelope', async () => {
    // #given
    const error = namedError('AlphaError', 'db constraint violated')
    const handler = withErrorHandler(async () => {
      throw error
    }, 'Failed to create task')

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({ success: false, error: 'db constraint violated' })
    expect(mockTrackMainError).toHaveBeenCalledTimes(1)
    expect(mockTrackMainError).toHaveBeenCalledWith('ipc', 'Failed to create task', error)
  })

  it('withErrorHandler does not track successful results', async () => {
    // #given
    const handler = withErrorHandler(async () => ({ success: true as const }), 'Failed')

    // #when
    await handler()

    // #then
    expect(mockTrackMainError).not.toHaveBeenCalled()
  })

  it('withDb tracks handler errors and still returns the envelope', async () => {
    // #given
    mockGetDatabase.mockReturnValue({} as never)
    const error = namedError('BetaError', 'not found')
    const handler = withDb(async () => {
      throw error
    }, 'Failed to fetch')

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({ success: false, error: 'not found' })
    expect(mockTrackMainError).toHaveBeenCalledTimes(1)
    expect(mockTrackMainError).toHaveBeenCalledWith('ipc', 'Failed to fetch', error)
  })

  it('withDb does NOT track the benign noVaultOpen envelope', async () => {
    // #given
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized')
    })
    const handler = withDb(async () => ({ success: true as const }), 'Failed')

    // #when
    const result = await handler()

    // #then
    expect(result).toEqual({ success: false, error: 'errors:ipc.noVaultOpen' })
    expect(mockTrackMainError).not.toHaveBeenCalled()
  })

  it('throttles repeated errors with the same code to one event per window', async () => {
    // #given
    vi.useFakeTimers()
    try {
      const handler = withErrorHandler(async () => {
        throw namedError('GammaError')
      }, 'Failed')

      // #when
      await handler()
      await handler()
      await handler()

      // #then
      expect(mockTrackMainError).toHaveBeenCalledTimes(1)

      // #when time passes beyond the throttle window
      vi.advanceTimersByTime(61_000)
      await handler()

      // #then
      expect(mockTrackMainError).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not throttle errors with different codes', async () => {
    // #given
    const handler = withErrorHandler(async (name: string) => {
      throw namedError(name)
    }, 'Failed')

    // #when
    await handler('DeltaError')
    await handler('EpsilonError')

    // #then
    expect(mockTrackMainError).toHaveBeenCalledTimes(2)
  })

  it('does NOT let one handler mask a different handler throwing the same error name', async () => {
    // #given two unrelated handlers that both throw a bare `Error` — the
    // throttle was keyed only by error.name and shared across ALL handlers, so
    // a benign recurring "Error" hid a genuine one for 60s
    vi.useFakeTimers()
    try {
      const benign = withErrorHandler(async () => {
        throw namedError('Error')
      }, 'Failed to list Ollama models')
      const genuine = withErrorHandler(async () => {
        throw namedError('Error')
      }, 'Failed to save note')

      // #when the benign one fires first, inside the same throttle window
      await benign()
      await genuine()

      // #then both are reported
      expect(mockTrackMainError).toHaveBeenCalledTimes(2)
      expect(mockTrackMainError).toHaveBeenCalledWith(
        'ipc',
        'Failed to list Ollama models',
        expect.anything()
      )
      expect(mockTrackMainError).toHaveBeenCalledWith(
        'ipc',
        'Failed to save note',
        expect.anything()
      )

      // #and each handler is still throttled on its own key
      await benign()
      await genuine()
      expect(mockTrackMainError).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a suppressed expected-condition error does not claim the throttle key', async () => {
    // #given one handler that first hits an expected condition, then a genuine
    // different failure — SAME action, SAME errorCode (a name unique to this test
    // so a bare `Error` claimed by an earlier test cannot interfere). If the
    // suppressed error still claimed the shared throttle key, it would mask the
    // genuine one for the whole window.
    const expected = markExpectedCondition(namedError('MaskProbeError', 'ollama not running'))
    const genuine = namedError('MaskProbeError', 'disk write failed')
    const handler = withErrorHandler(async (which: 'expected' | 'genuine') => {
      throw which === 'expected' ? expected : genuine
    }, 'mask probe')

    // #when the expected condition fires first, inside the same window
    await handler('expected')
    await handler('genuine')

    // #then the genuine failure is still reported — not masked...
    expect(mockTrackMainError).toHaveBeenCalledTimes(1)
    expect(mockTrackMainError).toHaveBeenCalledWith('ipc', 'mask probe', genuine)
    // #and the suppressed error never reached telemetry at all
    expect(mockTrackMainError).not.toHaveBeenCalledWith('ipc', 'mask probe', expected)
  })

  it('bounds the throttle map when distinct codes burst inside one window', async () => {
    // #given a handler whose errors carry a code we never anticipated — the
    // throttle Map grew one entry per `action:errorCode` with no cap, so an
    // error loop producing novel codes retained them for the process lifetime
    vi.useFakeTimers()
    try {
      const handler = withErrorHandler(async (name: string) => {
        throw namedError(name)
      }, 'cap probe')

      // #when 1200 distinct codes arrive without the window ever elapsing
      for (let i = 0; i < 1200; i++) {
        await handler(`CapProbe${i}Error`)
      }

      // #then the map never exceeds the cap
      expect(ipcErrorThrottleKeyCount()).toBeLessThanOrEqual(1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sweeps keys whose throttle window has elapsed', async () => {
    // #given a full map of keys that have all aged out
    vi.useFakeTimers()
    try {
      const handler = withErrorHandler(async (name: string) => {
        throw namedError(name)
      }, 'sweep probe')

      vi.advanceTimersByTime(61_000)
      for (let i = 0; i < 1000; i++) {
        await handler(`SweepProbe${i}Error`)
      }
      vi.advanceTimersByTime(61_000)

      // #when one more error crosses the cap
      await handler('SweepTriggerError')

      // #then every expired key is released, leaving only the live one
      expect(ipcErrorThrottleKeyCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('separates typed codes from the same handler within one window', async () => {
    // #given one handler hitting two different SQLITE_* conditions
    vi.useFakeTimers()
    try {
      const handler = withErrorHandler(async (code: string) => {
        throw Object.assign(new Error('db'), { name: 'SqliteError', code })
      }, 'Failed to update task')

      // #when
      await handler('SQLITE_BUSY')
      await handler('SQLITE_FULL')

      // #then a locked file does not mask a disk-full
      expect(mockTrackMainError).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
