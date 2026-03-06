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

export async function flushAllPendingSaves(): Promise<void> {
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
