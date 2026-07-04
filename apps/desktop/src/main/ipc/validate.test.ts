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
import { withErrorHandler, withDb } from './validate'

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
})
