import { createLogger } from '../../lib/logger'
import { ProviderRateLimitError } from '../provider/errors'

const log = createLogger('Calendar:PollRunner')

export interface PollRunResult {
  /** A provider asked us to slow down: wait at least this long before the next pass. */
  retryAfterMs?: number
}

export interface PollRunner {
  start(): void
  stop(): void
  /** Run a pass now, outside the schedule. Ignored while a pass is running. */
  trigger(): void
  isRunning(): boolean
}

export interface PollRunnerOptions {
  name: string
  intervalMs: number
  run: () => Promise<PollRunResult | void>
  /** False skips the pass (no open vault). */
  isReady?: () => boolean
  timers?: {
    setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
  }
}

/**
 * Scheduling for providers without push (`supportsPush: false`, #1393): one
 * pass per interval, never two at once, and a `ProviderRateLimitError` (or a
 * pass reporting `retryAfterMs`) pushes the next pass out by at least what
 * the server asked for. Each provider gets its own runner, so one provider's
 * backoff never delays another's.
 */
export function createPollRunner(options: PollRunnerOptions): PollRunner {
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle)
  }
  let handle: ReturnType<typeof setTimeout> | null = null
  let started = false
  let running = false

  function schedule(delayMs: number): void {
    if (!started) return
    if (handle) timers.clearTimeout(handle)
    handle = timers.setTimeout(() => void pass(), delayMs)
  }

  async function pass(): Promise<void> {
    if (running) return
    if (options.isReady && !options.isReady()) {
      schedule(options.intervalMs)
      return
    }
    running = true
    let delay = options.intervalMs
    try {
      const result = await options.run()
      if (result?.retryAfterMs) delay = Math.max(delay, result.retryAfterMs)
    } catch (error) {
      if (error instanceof ProviderRateLimitError) {
        delay = Math.max(delay, error.retryAfterMs)
        log.warn(`${options.name}: rate limited; waiting before the next pass`, {
          retryAfterMs: error.retryAfterMs
        })
      } else {
        log.warn(`${options.name}: pass failed`, error)
      }
    } finally {
      running = false
    }
    schedule(delay)
  }

  return {
    start() {
      if (started) return
      started = true
      void pass()
    },
    stop() {
      started = false
      if (handle) timers.clearTimeout(handle)
      handle = null
    },
    trigger() {
      if (!started || running) return
      void pass()
    },
    isRunning: () => running
  }
}
