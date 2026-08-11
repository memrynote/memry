// Crash-durable mirror for the in-memory telemetry queues. A hard crash (main-
// process abort, OOM kill, force-quit) discards everything queued since the last
// 30s flush — including the `app_crashed` event the launch just recorded, which
// is exactly the evidence the crash marker exists to produce. Every enqueue
// reaches disk, so the next launch drains what the dead process left behind.
//
// On-disk format is a journal: a `{"version":2}` header line followed by one
// JSON item per line. An enqueue appends its own line instead of re-serialising
// the whole queue, which used to make each event cost O(queue) — brutal when the
// endpoint is unreachable and the queue sits pegged at its 500-item limit. The
// file is compacted (rewritten) on drains, trims, and once the journal has grown
// well past the queue limit, so it stays bounded.
//
// Version handling. `{"version":1,"items":[...]}` is the previous format and is
// still READ, so an upgrading install keeps whatever its last session queued;
// the next write upgrades the file in place. Builds older than the mirror never
// read the file at all, and the v1 reader rejects a v2 journal as unparseable
// and discards it, so a downgrade loses one session's queue rather than wedging
// startup. A version this build does not recognise is discarded, never parsed.
import fs from 'node:fs'

import { createLogger } from '../lib/logger'

const logger = createLogger('TelemetryQueueStore')

const LEGACY_FORMAT_VERSION = 1
const FORMAT_VERSION = 2

// Trimming drops from the head, which an append-only journal cannot express, so
// the file is allowed to hold trimmed-away items until it is worth rewriting.
// Both queues cap at 500, so this compacts roughly once per 500 enqueues and the
// restored set is at most this long before the caller trims it back down.
const COMPACT_AFTER_LINES = 1000

export interface QueueStore<T> {
  /** Items left behind by the previous process. Never throws; `[]` on any fault. */
  load(): T[]
  /**
   * Record one newly enqueued item as a single appended line. `currentItems` is
   * only read on the compaction pass, when the journal is rewritten from it.
   * Never throws — a full or read-only disk must not break logging.
   */
  append(item: T, currentItems: readonly T[]): void
  /** Rewrite the mirror from `items` (drain, trim). Never throws. */
  save(items: readonly T[]): void
  /** Remove the mirror (clean drain, or telemetry turned off). */
  clear(): void
}

export const createQueueStore = <T>(filePath: string): QueueStore<T> => {
  // Writes run on every enqueue, so a persistently unwritable disk would log
  // once per line without this latch.
  let writeFailureLogged = false
  // False until this process has written a header, so an append can never be the
  // call that creates the file — a headerless journal reads back as garbage.
  let journalStarted = false
  let journalLines = 0

  const encodeItem = (item: T): string => `${JSON.stringify(item)}\n`

  const onWriteFailure = (error: unknown): void => {
    if (writeFailureLogged) return
    writeFailureLogged = true
    logger.warn('Failed to persist telemetry queue; a crash would lose it', { error })
  }

  const clear = (): void => {
    journalStarted = false
    journalLines = 0
    try {
      fs.rmSync(filePath, { force: true })
    } catch {
      // Best effort: a stale mirror is drained-and-overwritten, never replayed
      // twice, because load() is only called once per queue.
    }
  }

  const save = (items: readonly T[]): void => {
    const header = `${JSON.stringify({ version: FORMAT_VERSION })}\n`
    try {
      fs.writeFileSync(filePath, header + items.map(encodeItem).join(''), 'utf-8')
      journalStarted = true
      journalLines = items.length
      writeFailureLogged = false
    } catch (error) {
      onWriteFailure(error)
    }
  }

  const parse = (raw: string): T[] | null => {
    const firstBreak = raw.indexOf('\n')
    const headerLine = firstBreak === -1 ? raw : raw.slice(0, firstBreak)
    let header: { version?: unknown; items?: unknown }
    try {
      header = JSON.parse(headerLine) as { version?: unknown; items?: unknown }
    } catch {
      return null
    }
    if (!header || typeof header !== 'object') return null
    if (header.version === LEGACY_FORMAT_VERSION) {
      return Array.isArray(header.items) ? (header.items as T[]) : null
    }
    if (header.version !== FORMAT_VERSION) return null

    const items: T[] = []
    if (firstBreak === -1) return items
    for (const line of raw.slice(firstBreak + 1).split('\n')) {
      if (line.length === 0) continue
      try {
        items.push(JSON.parse(line) as T)
      } catch {
        // Only the tail can be half-written: the crash this mirror exists for
        // can land mid-append. Drop the partial line, keep the rest.
      }
    }
    return items
  }

  return {
    load: () => {
      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf-8')
      } catch {
        return [] // no mirror: the previous session drained cleanly, or first launch
      }
      const items = parse(raw)
      if (items) return items
      // Truncated by the very crash it was written to survive, or written by a
      // format this build does not know. Startup must never depend on it.
      logger.warn('Discarding unreadable telemetry queue mirror')
      clear()
      return []
    },
    append: (item, currentItems) => {
      // No header yet (fresh session, or a file this process has not written),
      // or the journal has outgrown its bound — either way, rewrite it whole.
      if (!journalStarted || journalLines >= COMPACT_AFTER_LINES) {
        save(currentItems)
        return
      }
      try {
        fs.appendFileSync(filePath, encodeItem(item), 'utf-8')
        journalLines += 1
        writeFailureLogged = false
      } catch (error) {
        onWriteFailure(error)
      }
    },
    save,
    clear
  }
}
