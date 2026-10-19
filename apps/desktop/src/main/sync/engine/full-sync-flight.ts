import type { SyncRunOutcome } from './sync-context'

/**
 * One full sync at a time (#3382). A request made while a run is going gets
 * the one follow-up run that starts when it ends, so every request is answered
 * by a run that started after it was made, and a burst of requests costs at
 * most two runs.
 *
 * Without this, each Sync Now click started its own full sync next to the
 * running one. One stuck device ran 14 manifest scans at once and drew 332
 * rate-limit refusals in a quarter of an hour.
 */
export class FullSyncFlight {
  private running: Promise<SyncRunOutcome> | null = null
  private queued: Promise<SyncRunOutcome> | null = null

  constructor(private readonly runOnce: () => Promise<SyncRunOutcome>) {}

  run(): Promise<SyncRunOutcome> {
    if (this.queued) return this.queued
    if (!this.running) return this.start()
    const settled = (): void => {}
    this.queued = this.running.then(settled, settled).then(() => {
      this.queued = null
      return this.start()
    })
    return this.queued
  }

  private start(): Promise<SyncRunOutcome> {
    const run = this.runOnce().finally(() => {
      if (this.running === run) this.running = null
    })
    this.running = run
    return run
  }
}
