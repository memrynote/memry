// Crash-durable mirror for the in-memory telemetry queues. A hard crash (main-
// process abort, OOM kill, force-quit) discards everything queued since the last
// 30s flush — including the `app_crashed` event the launch just recorded, which
// is exactly the evidence the crash marker exists to produce. The mirror is
// rewritten on every enqueue, so the next launch drains what the dead process
// left behind.
//
// On-disk format is `{"version":1,"items":[...]}`. Builds older than this one
// never read the file at all, so a newer build's mirror is inert for them; a
// version this build does not recognise is discarded rather than parsed. Neither
// direction can wedge startup.
import fs from 'node:fs'

import { createLogger } from '../lib/logger'

const logger = createLogger('TelemetryQueueStore')

const FORMAT_VERSION = 1

export interface QueueStore<T> {
  /** Items left behind by the previous process. Never throws; `[]` on any fault. */
  load(): T[]
  /** Rewrite the mirror. Never throws — a full or read-only disk must not break logging. */
  save(items: readonly T[]): void
  /** Remove the mirror (clean drain, or telemetry turned off). */
  clear(): void
}

export const createQueueStore = <T>(filePath: string): QueueStore<T> => {
  // save() runs on every enqueue, so a persistently unwritable disk would log
  // once per line without this latch.
  let writeFailureLogged = false

  const clear = (): void => {
    try {
      fs.rmSync(filePath, { force: true })
    } catch {
      // Best effort: a stale mirror is drained-and-overwritten, never replayed
      // twice, because load() is only called once per queue.
    }
  }

  return {
    load: () => {
      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf-8')
      } catch {
        return [] // no mirror: the previous session drained cleanly, or first launch
      }
      try {
        const parsed = JSON.parse(raw) as { version?: unknown; items?: unknown }
        if (parsed && parsed.version === FORMAT_VERSION && Array.isArray(parsed.items)) {
          return parsed.items as T[]
        }
      } catch {
        // fall through to the discard path
      }
      // Truncated by the very crash it was written to survive, or written by a
      // format this build does not know. Startup must never depend on it.
      logger.warn('Discarding unreadable telemetry queue mirror')
      clear()
      return []
    },
    save: (items) => {
      try {
        fs.writeFileSync(filePath, JSON.stringify({ version: FORMAT_VERSION, items }), 'utf-8')
        writeFailureLogged = false
      } catch (error) {
        if (!writeFailureLogged) {
          writeFailureLogged = true
          logger.warn('Failed to persist telemetry queue; a crash would lose it', { error })
        }
      }
    },
    clear
  }
}
