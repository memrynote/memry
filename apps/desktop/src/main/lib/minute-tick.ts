/**
 * Shared Minute Tick
 *
 * One 60-second timer for every main-process poller that runs on a minute
 * cadence (reminders, inbox snooze, inbox review). Three independent timers
 * meant three process wakeups a minute for the whole app lifetime; one shared
 * timer means one. The timer is `unref`'d so polling alone never holds the
 * event loop open.
 *
 * @module main/lib/minute-tick
 */

import { createLogger } from './logger'

const logger = createLogger('MinuteTick')

/** Shared cadence for main-process minute pollers. */
export const MINUTE_TICK_INTERVAL_MS = 60 * 1000

const listeners = new Map<string, () => void>()
let timer: ReturnType<typeof setInterval> | null = null

function runTick(): void {
  for (const [id, listener] of listeners) {
    try {
      listener()
    } catch (error) {
      // A throwing listener must not take the shared timer down with it.
      logger.error(`Minute tick listener "${id}" failed:`, error)
    }
  }
}

/**
 * Subscribe to the shared minute tick, starting the timer on first use.
 * Re-registering the same id is a no-op (matches the schedulers' start guards).
 */
export function registerMinuteTick(id: string, listener: () => void): void {
  if (listeners.has(id)) {
    logger.warn(`Minute tick listener "${id}" already registered`)
    return
  }

  listeners.set(id, listener)

  if (!timer) {
    timer = setInterval(runTick, MINUTE_TICK_INTERVAL_MS)
    // Polling must never be the reason the process stays awake.
    timer.unref()
  }
}

/** Unsubscribe, clearing the shared timer once the last listener is gone. */
export function unregisterMinuteTick(id: string): void {
  listeners.delete(id)

  if (listeners.size === 0 && timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Whether a given poller is subscribed. */
export function hasMinuteTick(id: string): boolean {
  return listeners.has(id)
}

/** Whether the shared timer is currently running. */
export function isMinuteTickRunning(): boolean {
  return timer !== null
}

/** Subscribed poller ids, in registration order. */
export function getMinuteTickIds(): string[] {
  return [...listeners.keys()]
}
