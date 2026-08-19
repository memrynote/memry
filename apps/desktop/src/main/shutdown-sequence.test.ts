import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  completeWithin,
  runShutdownSequence,
  SHUTDOWN_BUDGET_MS,
  SHUTDOWN_HARD_BACKSTOP_MS,
  SHUTDOWN_LAST_CHANCE_MS,
  type ShutdownStep
} from './shutdown-sequence'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const never = (): Promise<void> => new Promise<void>(() => {})

describe('runShutdownSequence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs every step in order and reports how long the quit took', async () => {
    // #given two steps that each take 100ms
    const ran: string[] = []
    const steps: ShutdownStep[] = [
      {
        name: 'flush-writebacks',
        run: async () => {
          ran.push('flush-writebacks')
          await delay(100)
        }
      },
      {
        name: 'close-vault',
        run: async () => {
          ran.push('close-vault')
          await delay(100)
        }
      }
    ]

    // #when the sequence runs inside a budget that comfortably fits them
    const sequence = runShutdownSequence(steps, { budgetMs: 1000 })
    await vi.advanceTimersByTimeAsync(200)
    const outcome = await sequence

    // #then both ran, in order, and the quit is reported as clean
    expect(ran).toEqual(['flush-writebacks', 'close-vault'])
    expect(outcome).toEqual({
      status: 'complete',
      overrunStep: null,
      overrunStepMs: 0,
      elapsedMs: 200
    })
  })

  it('names the step that was still running when the budget ran out', async () => {
    // #given a teardown step that never settles
    const steps: ShutdownStep[] = [
      { name: 'flush-windows', run: () => delay(100) },
      { name: 'stop-sync-runtime', run: () => never() }
    ]

    // #when the budget expires
    const sequence = runShutdownSequence(steps, { budgetMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    const outcome = await sequence

    // #then the failure is attributable to a step, not to "shutdown was slow"
    expect(outcome.status).toBe('timeout')
    expect(outcome.overrunStep).toBe('stop-sync-runtime')
    expect(outcome.overrunStepMs).toBe(900)
    expect(outcome.elapsedMs).toBe(1000)
  })

  it('lets the durability work finish even when a later step hangs forever', async () => {
    // #given the write-back flush ordered ahead of a wedged teardown step —
    // the exact shape of #1586, where a hung step consumed the whole budget and
    // the forced exit dropped the user's pending note write-backs
    let writebacksFlushed = false
    const steps: ShutdownStep[] = [
      {
        name: 'flush-writebacks',
        run: async () => {
          await delay(50)
          writebacksFlushed = true
        }
      },
      { name: 'stop-utility-processes', run: () => never() }
    ]

    // #when the budget expires on the hung step
    const sequence = runShutdownSequence(steps, { budgetMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    const outcome = await sequence

    // #then the pending writes had already landed
    expect(writebacksFlushed).toBe(true)
    expect(outcome.overrunStep).toBe('stop-utility-processes')
  })

  it('caps a bounded wait to what is left of the shared deadline', async () => {
    // #given two steps that each want a 2,000ms bounded wait
    const requested: number[] = []
    const steps: ShutdownStep[] = [
      {
        name: 'flush-windows',
        run: async (deadline) => {
          requested.push(deadline.cap(2000))
          await delay(900)
        }
      },
      {
        name: 'stop-capture-server',
        run: (deadline) => {
          requested.push(deadline.cap(2000))
        }
      }
    ]

    // #when they run under a 1,000ms budget
    const sequence = runShutdownSequence(steps, { budgetMs: 1000 })
    await vi.advanceTimersByTimeAsync(900)
    await sequence

    // #then neither could ask for more than the budget still holds, so their
    // waits can never sum past it
    expect(requested).toEqual([1000, 100])
  })

  it('holds the whole chain to the budget however many steps overrun', async () => {
    // #given four steps that each want 3,000ms — 12,000ms in a row
    const steps: ShutdownStep[] = [1, 2, 3, 4].map((n) => ({
      name: `step-${n}`,
      run: () => delay(3000)
    }))

    // #when the budget is 1,000ms
    const sequence = runShutdownSequence(steps, { budgetMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    const outcome = await sequence

    // #then the quit still ends at the budget, on the first step
    expect(outcome.status).toBe('timeout')
    expect(outcome.elapsedMs).toBe(1000)
    expect(outcome.overrunStep).toBe('step-1')
  })

  it('rejects when a step rejects, so "cleanup failed" stays its own signal', async () => {
    // #given a step that throws
    const boom = new Error('boom')

    // #when the sequence runs
    const sequence = runShutdownSequence(
      [{ name: 'close-vault', run: () => Promise.reject(boom) }],
      {
        budgetMs: 1000
      }
    )

    // #then the rejection propagates rather than reading as a timeout
    await expect(sequence).rejects.toBe(boom)
  })

  it('does not surface a step that rejects after the budget already expired', async () => {
    // #given a step that fails late, long after the forced exit path is taken
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const steps: ShutdownStep[] = [
      {
        name: 'stop-sync-runtime',
        run: async () => {
          await delay(2000)
          throw new Error('late failure')
        }
      }
    ]

    try {
      // #when the budget expires first and the step fails afterwards
      const sequence = runShutdownSequence(steps, { budgetMs: 1000 })
      await vi.advanceTimersByTimeAsync(1000)
      const outcome = await sequence
      expect(outcome.status).toBe('timeout')

      await vi.advanceTimersByTimeAsync(2000)
      vi.useRealTimers()
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    // #then the late rejection was absorbed rather than left unhandled while
    // the process is already on its way out
    expect(unhandled).toEqual([])
  })
})

describe('completeWithin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports success when the work finishes inside the window', async () => {
    const race = completeWithin(delay(100), 500)
    await vi.advanceTimersByTimeAsync(100)
    await expect(race).resolves.toBe(true)
  })

  it('gives up when the work does not finish, so the exit is never blocked', async () => {
    const race = completeWithin(never(), 500)
    await vi.advanceTimersByTimeAsync(500)
    await expect(race).resolves.toBe(false)
  })
})

describe('shutdown budget arithmetic', () => {
  it('fits the bounded waits the chain contains', () => {
    // Before #1586 these summed to 11,000ms against a 5,000ms budget: a 2,000ms
    // renderer flush handshake plus THREE sequential 3,000ms utility-process
    // stops. The stops now run concurrently, so they cost 3,000ms once.
    const RENDERER_FLUSH_HANDSHAKE_MS = 2_000
    const UTILITY_PROCESS_STOPS_MS = 3_000
    expect(RENDERER_FLUSH_HANDSHAKE_MS + UTILITY_PROCESS_STOPS_MS).toBeLessThan(SHUTDOWN_BUDGET_MS)
  })

  it('keeps the hard backstop beyond the budget and its last-chance flush', () => {
    // The backstop has to be the LAST thing that can fire, or a quit could be
    // force-exited while the durability flush is still writing.
    expect(SHUTDOWN_HARD_BACKSTOP_MS).toBeGreaterThan(SHUTDOWN_BUDGET_MS + SHUTDOWN_LAST_CHANCE_MS)
  })
})
