import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const scopedLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}
const isAppShuttingDownMock = vi.fn(() => false)

vi.mock('./lib/logger', () => ({
  createLogger: vi.fn(() => scopedLogger)
}))

vi.mock('./app-shutdown', () => ({
  isAppShuttingDown: isAppShuttingDownMock
}))

// The queue and its latches are module state, so each test gets a fresh copy.
async function importPostReveal(): Promise<typeof import('./post-reveal')> {
  vi.resetModules()
  return import('./post-reveal')
}

describe('post-reveal queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    scopedLogger.warn.mockClear()
    isAppShuttingDownMock.mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds registered work until the delay after the reveal has elapsed', async () => {
    const { onceWindowShown, schedulePostRevealTasks, POST_REVEAL_DELAY_MS } =
      await importPostReveal()
    const task = vi.fn()

    onceWindowShown('updater', task)
    schedulePostRevealTasks()
    expect(task).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(POST_REVEAL_DELAY_MS)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('runs each name at most once across repeated reveals', async () => {
    const { onceWindowShown, schedulePostRevealTasks, POST_REVEAL_DELAY_MS } =
      await importPostReveal()
    const task = vi.fn()

    onceWindowShown('updater', task)
    schedulePostRevealTasks()
    await vi.advanceTimersByTimeAsync(POST_REVEAL_DELAY_MS)

    // A macOS dock reopen re-creates and re-reveals the window.
    onceWindowShown('updater', task)
    schedulePostRevealTasks()
    await vi.advanceTimersByTimeAsync(POST_REVEAL_DELAY_MS)

    expect(task).toHaveBeenCalledTimes(1)
  })

  it('runs work registered after the drain immediately', async () => {
    const { onceWindowShown, schedulePostRevealTasks, POST_REVEAL_DELAY_MS } =
      await importPostReveal()
    const task = vi.fn()

    schedulePostRevealTasks()
    await vi.advanceTimersByTimeAsync(POST_REVEAL_DELAY_MS)

    onceWindowShown('late', task)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('starts nothing when the app is quitting inside the delay', async () => {
    const { onceWindowShown, schedulePostRevealTasks, POST_REVEAL_DELAY_MS } =
      await importPostReveal()
    const task = vi.fn()
    const later = vi.fn()

    onceWindowShown('updater', task)
    schedulePostRevealTasks()
    isAppShuttingDownMock.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(POST_REVEAL_DELAY_MS)

    onceWindowShown('late', later)
    expect(task).not.toHaveBeenCalled()
    expect(later).not.toHaveBeenCalled()
  })

  it('keeps later tasks running when one throws', async () => {
    const { onceWindowShown, schedulePostRevealTasks, POST_REVEAL_DELAY_MS } =
      await importPostReveal()
    const survivor = vi.fn()

    onceWindowShown('boom', () => {
      throw new Error('nope')
    })
    onceWindowShown('survivor', survivor)
    schedulePostRevealTasks()
    await vi.advanceTimersByTimeAsync(POST_REVEAL_DELAY_MS)

    expect(survivor).toHaveBeenCalledTimes(1)
    expect(scopedLogger.warn).toHaveBeenCalledWith(
      'deferred startup task failed: boom',
      expect.any(Error)
    )
  })

  it('reports a rejected async task without an unhandled rejection', async () => {
    const { onceWindowShown, schedulePostRevealTasks, POST_REVEAL_DELAY_MS } =
      await importPostReveal()

    onceWindowShown('async-boom', async () => {
      throw new Error('nope')
    })
    schedulePostRevealTasks()
    await vi.advanceTimersByTimeAsync(POST_REVEAL_DELAY_MS)

    expect(scopedLogger.warn).toHaveBeenCalledWith(
      'deferred startup task failed: async-boom',
      expect.any(Error)
    )
  })
})
