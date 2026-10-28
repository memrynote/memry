import { createLogger } from '@/lib/logger'

const log = createLogger('SaveRegistry')

type FlushFn = () => Promise<void> | void

const pendingSaves = new Map<string, FlushFn>()

export function registerPendingSave(key: string, flushFn: FlushFn): void {
  pendingSaves.set(key, flushFn)
}

export function unregisterPendingSave(key: string): void {
  pendingSaves.delete(key)
}

// The flush still writing, if any. A registered flush clears its pending edit before it awaits
// the write, so a second flush started meanwhile would find nothing and report done early: at a
// Windows sign-out the quit sequence's flush follows one that may still be saving.
let running: Promise<void> | null = null

/** Flushes every registered save, after any flush already running has finished. */
export function flushAllPendingSaves(): Promise<void> {
  const previous = running
  const run = (async () => {
    await previous
    await flushRegistered()
  })()
  running = run
  void run.finally(() => {
    if (running === run) running = null
  })
  return run
}

async function flushRegistered(): Promise<void> {
  const entries = Array.from(pendingSaves.entries())
  if (entries.length === 0) {
    log.info('flushAll: nothing registered')
    return
  }

  const keys = entries.map(([k]) => k)
  log.info('flushAll: flushing', { keys })
  const results = await Promise.allSettled(entries.map(([, fn]) => Promise.resolve(fn())))
  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length > 0) {
    log.error('flushAll: some flushes failed', { failed: failed.length })
  }
  log.info('flushAll: done', { total: entries.length, failed: failed.length })
}

export function hasPendingSaves(): boolean {
  return pendingSaves.size > 0
}
