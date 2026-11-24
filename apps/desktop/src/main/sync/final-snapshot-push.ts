// The final CRDT snapshot push `stopSyncRuntime` runs before it destroys the
// provider, bounded on every path (#2522, #5698).
import { createLogger } from '../lib/logger'
import { SHUTDOWN_FINAL_SNAPSHOT_PUSH_MS } from '../shutdown-sequence'
import { getCrdtProvider } from './crdt-provider'

const log = createLogger('SyncRuntime')

export interface StopSyncRuntimeOptions {
  skipFinalSync?: boolean
  /**
   * Upper bound on the final snapshot push. Each note's push retries with
   * backoff (2s + 4s + 8s) on top of its request time and notes go one at a
   * time, so on a slow or flaky network the push alone outlived the whole quit
   * budget and the provider flush behind it never ran (#2522). Past the bound
   * the walk stops and teardown continues, which is what `skipFinalSync` and an
   * offline quit already do. Omitted (a vault switch, a sign-out):
   * `SHUTDOWN_FINAL_SNAPSHOT_PUSH_MS`. Unbounded, a push that read its base
   * from a stalled CRDT store held the close forever, and the store's close
   * behind it never ran (#5698).
   */
  finalSyncTimeoutMs?: number
}

export async function pushFinalSnapshots(
  timeoutMs: number = SHUTDOWN_FINAL_SNAPSHOT_PUSH_MS
): Promise<void> {
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    log.warn('Pre-shutdown CRDT snapshot push skipped: no time left in the shutdown budget')
    return
  }
  const abort = new AbortController()
  const push = getCrdtProvider()
    .pushAllSnapshots(abort.signal)
    .then(
      (pushed) => {
        if (pushed > 0) log.info(`Pushed ${pushed} CRDT snapshot(s) before shutdown`)
        return true
      },
      (err: unknown) => {
        log.warn('Pre-shutdown CRDT snapshot push failed', err)
        return true
      }
    )
  let timer: ReturnType<typeof setTimeout> | undefined
  const finished = await Promise.race([
    push,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
  ])
  clearTimeout(timer)
  if (!finished) {
    abort.abort()
    log.warn('Pre-shutdown CRDT snapshot push cut short; remaining snapshots deferred', {
      timeoutMs,
      unpushedNoteIds: getCrdtProvider().unpushedSnapshotNoteIds()
    })
  }
}
