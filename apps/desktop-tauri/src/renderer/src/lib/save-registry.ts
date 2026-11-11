import { createLogger } from '@/lib/logger'

const log = createLogger('SaveRegistry')

type FlushFn = () => Promise<void> | void

const pendingSaves = new Map<string, FlushFn>()

export function registerPendingSave(key: string, flushFn: FlushFn): void {
  pendingSaves.set(key, flushFn)
}

/** Drops the key's flush; with `flushFn`, only while that flush is still the one registered. */
export function unregisterPendingSave(key: string, flushFn?: FlushFn): void {
  if (flushFn && pendingSaves.get(key) !== flushFn) return
  pendingSaves.delete(key)
}

// The flush still writing, if any. A registered flush clears its pending edit before it awaits
// the write, so a second flush started meanwhile would find nothing and report done early: at a
// Windows sign-out the quit sequence's flush follows one that may still be saving.
let running: Promise<number> | null = null

/**
 * Flushes every registered save, after any flush already running has finished. Resolves with the
 * number of flushes that failed, so a caller about to act on the saved files can refuse.
 */
export function flushAllPendingSaves(): Promise<number> {
  const previous = running
  const run = (async () => {
    await previous
    return flushRegistered()
  })()
  running = run
  void run.finally(() => {
    if (running === run) running = null
  })
  return run
}

async function flushRegistered(): Promise<number> {
  const entries = Array.from(pendingSaves.entries())
  if (entries.length === 0) {
    log.info('flushAll: nothing registered')
    return 0
  }

  const keys = entries.map(([k]) => k)
  log.info('flushAll: flushing', { keys })
  const results = await Promise.allSettled(entries.map(([, fn]) => Promise.resolve(fn())))
  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length > 0) {
    log.error('flushAll: some flushes failed', { failed: failed.length })
  }
  log.info('flushAll: done', { total: entries.length, failed: failed.length })
  return failed.length
}

export function hasPendingSaves(): boolean {
  return pendingSaves.size > 0
}
