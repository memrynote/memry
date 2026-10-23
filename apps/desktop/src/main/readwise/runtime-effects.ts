import { net } from 'electron'
import type { ReadwiseCadence } from '@memry/contracts/import-channels'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { registerMinuteTick, unregisterMinuteTick } from '../lib/minute-tick'
import { getStatus } from '../vault'
import { ReadwiseError } from './client'
import { canPull } from './pull-gate'
import { getReadwiseToken } from './secrets'
import { readReadwiseOptions } from './settings'
import { getReadwiseSyncService, type ReadwiseSyncService, type RunResult } from './sync-service'
import { getCursor, getLastRun } from './sync-state'
import { trackReadwiseSync } from './telemetry'

const log = createLogger('Readwise:Scheduler')

/**
 * The Readwise scheduler (#1408, #1416). It starts runs; the engine
 * (`sync-service.ts`) owns what a run does. It rides the shared minute tick,
 * so it adds no timer and no process wakeup of its own.
 *
 * - Cadence is the synced `cadence` option: Manual never starts a run, Hourly
 *   and Daily start one when the interval since the last attempt has passed.
 * - One run at a time. Sync now joins a run the scheduler already has going.
 * - It never runs without a token, and never before the first import: that
 *   import shows the preview in the dialog, which the user must see first.
 * - A revoked token (`needsAttention`) stops the schedule until the user
 *   connects again. Other failures back off, and a network error never moves
 *   the cursor (the engine moves it only when a run completes).
 */

export const READWISE_TICK_ID = 'readwise-sync'

const HOUR_MS = 60 * 60 * 1000
export const CADENCE_INTERVAL_MS: Record<Exclude<ReadwiseCadence, 'manual'>, number> = {
  hourly: HOUR_MS,
  daily: 24 * HOUR_MS
}

/** A failed run is retried after this, doubling per consecutive failure. */
export const BACKOFF_BASE_MS = 5 * 60 * 1000
export const BACKOFF_MAX_MS = 6 * HOUR_MS
/** The minute tick drifts by a few seconds; a run due on this tick should not wait a full minute more. */
const TICK_TOLERANCE_MS = 5 * 1000

export class ReadwiseRunInProgressError extends Error {
  constructor() {
    super('A Readwise run is already in progress')
    this.name = 'ReadwiseRunInProgressError'
  }
}

export class ReadwiseUnavailableError extends Error {
  constructor(readonly reason: 'not-connected' | 'other-device') {
    super(
      reason === 'not-connected'
        ? 'Readwise is not connected'
        : 'Readwise does not sync on this device'
    )
    this.name = 'ReadwiseUnavailableError'
  }
}

export interface SchedulerDeps {
  now: () => number
  isOnline: () => boolean
  canPull: () => boolean
  getService: () => ReadwiseSyncService
}

const defaultDeps: SchedulerDeps = {
  now: () => Date.now(),
  isOnline: () => net.isOnline(),
  canPull: () => canPull(),
  getService: getReadwiseSyncService
}

export class ReadwiseScheduler {
  private current: Promise<RunResult> | null = null
  private abort: AbortController | null = null
  /** Start of the last run this process began. Null: none yet, so the launch run is due. */
  private lastAttemptAt: number | null = null
  private failures = 0
  private nextRetryAt = 0

  constructor(private readonly deps: SchedulerDeps = defaultDeps) {}

  /** Subscribes to the minute tick and takes the launch run, off the startup path. */
  start(): void {
    registerMinuteTick(READWISE_TICK_ID, () => void this.tick())
    void this.tick()
  }

  stop(): void {
    unregisterMinuteTick(READWISE_TICK_ID)
    this.abort?.abort()
  }

  get isRunning(): boolean {
    return this.current !== null
  }

  /** The token to run with when a run is due now, else null. */
  private async due(): Promise<string | null> {
    if (this.current || this.deps.getService().isRunning) return null
    const vaultPath = getStatus().path
    if (!vaultPath) return null
    const db = getDatabase()
    const { cadence } = readReadwiseOptions(db)
    if (cadence === 'manual') return null
    if (getCursor(db) === null) return null
    if (getLastRun(db)?.needsAttention) return null
    const now = this.deps.now()
    if (now + TICK_TOLERANCE_MS < this.nextRetryAt) return null
    // After a failure the backoff sets the retry time, not the cadence.
    if (
      this.failures === 0 &&
      this.lastAttemptAt !== null &&
      now + TICK_TOLERANCE_MS < this.lastAttemptAt + CADENCE_INTERVAL_MS[cadence]
    ) {
      return null
    }
    if (!this.deps.canPull()) return null
    if (!this.deps.isOnline()) return null
    return await getReadwiseToken(vaultPath)
  }

  /** One scheduler decision: start a run if one is due. Never throws. */
  async tick(): Promise<void> {
    try {
      const token = await this.due()
      if (token === null) return
      // Another caller may have started a run while the token was read.
      if (this.current) return
      await this.beginRun(token, 'scheduled').catch(() => undefined)
    } catch (error) {
      log.warn('Readwise schedule check failed', { error })
    }
  }

  /**
   * Sync now: runs at once and resolves when the run completes. Joins the
   * scheduler's own run if one is in progress. A run the import dialog started
   * cannot be joined, so it is refused.
   */
  async syncNow(): Promise<RunResult> {
    if (this.current) return await this.current
    if (this.deps.getService().isRunning) throw new ReadwiseRunInProgressError()
    const vaultPath = getStatus().path
    const token = vaultPath ? await getReadwiseToken(vaultPath) : null
    if (token === null) throw new ReadwiseUnavailableError('not-connected')
    if (!this.deps.canPull()) throw new ReadwiseUnavailableError('other-device')
    // The token read yielded: re-check before taking the slot.
    // oxlint-disable-next-line typescript/return-await, typescript/await-thenable -- TS narrows `this.current` to null here; the await above may have set it
    if (this.current) return await this.current
    return await this.beginRun(token, 'manual')
  }

  /** When the schedule next starts a run (epoch ms), or null when nothing will: Manual, parked, or no first import yet. */
  nextRunAt(): number | null {
    const db = getDatabase()
    const { cadence } = readReadwiseOptions(db)
    if (cadence === 'manual' || getCursor(db) === null || getLastRun(db)?.needsAttention) {
      return null
    }
    const now = this.deps.now()
    if (this.failures > 0) return Math.max(this.nextRetryAt, now)
    if (this.lastAttemptAt === null) return now
    return Math.max(this.lastAttemptAt + CADENCE_INTERVAL_MS[cadence], now)
  }

  private beginRun(token: string, origin: 'scheduled' | 'manual'): Promise<RunResult> {
    const startedAt = this.deps.now()
    this.lastAttemptAt = startedAt
    const abort = new AbortController()
    this.abort = abort
    const run = this.deps
      .getService()
      .run(token, { signal: abort.signal, book: () => undefined })
      .then(
        (result) => {
          this.failures = 0
          this.nextRetryAt = 0
          trackReadwiseSync(origin, this.deps.now() - startedAt, { result })
          return result
        },
        (error: unknown) => {
          this.noteFailure(error, origin)
          trackReadwiseSync(origin, this.deps.now() - startedAt, { error })
          throw error
        }
      )
      .finally(() => {
        this.current = null
        this.abort = null
      })
    this.current = run
    return run
  }

  private noteFailure(error: unknown, origin: string): void {
    // A revoked token is parked by the engine (`needsAttention`); the schedule
    // checks that flag. Everything else backs off.
    this.failures += 1
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS)
    this.nextRetryAt = this.deps.now() + delay
    const code = error instanceof ReadwiseError ? error.code : 'unexpected'
    log.warn('A Readwise run failed', { origin, code, failures: this.failures, retryInMs: delay })
  }
}

let scheduler: ReadwiseScheduler | null = null

export function getReadwiseScheduler(): ReadwiseScheduler {
  scheduler ??= new ReadwiseScheduler()
  return scheduler
}

export function startReadwiseScheduler(): void {
  getReadwiseScheduler().start()
}

export function stopReadwiseScheduler(): void {
  scheduler?.stop()
  scheduler = null
}
