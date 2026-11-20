/**
 * Read-only detector for note bodies that shipped builds duplicated with a
 * markdown seed (#5286, #5289).
 *
 * A device seeded a note whose doc read empty while the server held its body.
 * Both writes started from an empty fragment, so each is a top-level item
 * whose left and right origins are both null. Any later insert sees the
 * fragment's existing items and records one of them as an origin. Two such
 * roots therefore mean two devices each wrote the note's first content
 * without seeing the other's.
 *
 * - `forked`: two or more live roots.
 * - `duplicated`: a forked body where one root's text equals or contains
 *   another's. That is the seed shape: the seed parsed the same markdown the
 *   server body was written from.
 *
 * False positives for `duplicated`: two devices that imported the same file
 * into a note before either synced, which is the same duplication from a
 * different cause. A root's text inside a longer root (a one-word body inside a
 * longer concurrent first write) also counts. A paragraph repeated inside one
 * body is never counted, because it sits under one root.
 *
 * Detect only: the scan never writes to the store, the vault or the server.
 */

import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createLogger } from '../lib/logger'
import type { CrdtStoreReader } from './crdt-persistence'

const log = createLogger('CrdtSeedDuplicates')

/** Off the bootstrap's busiest minutes; the scan only reads. */
const SCAN_DELAY_MS = 10 * 60 * 1000
/** Bounds the local log line; the count is always exact. */
const MAX_LOGGED_IDS = 500

export type BodyShape = 'clean' | 'forked' | 'duplicated'

export interface SeedDuplicateScan {
  scanned: number
  forked: number
  duplicated: string[]
  unreadable: number
}

function textOf(type: unknown): string {
  if (type instanceof Y.XmlText) {
    return type
      .toDelta()
      .map((op: { insert?: unknown }) => (typeof op.insert === 'string' ? op.insert : ''))
      .join('')
  }
  if (type instanceof Y.XmlElement || type instanceof Y.XmlFragment) {
    return type
      .toArray()
      .map((child) => textOf(child))
      .join('\n')
  }
  return ''
}

export function classifyBody(doc: Y.Doc): BodyShape {
  const roots: string[] = []
  for (let item = doc.getXmlFragment(CRDT_FRAGMENT_NAME)._start; item; item = item.right) {
    if (item.deleted || item.origin !== null || item.rightOrigin !== null) continue
    if (!(item.content instanceof Y.ContentType)) continue
    roots.push(textOf(item.content.type).replace(/\s+/g, ' ').trim())
  }
  if (roots.length < 2) return 'clean'
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const [a, b] = [roots[i], roots[j]]
      if (a && b && (a.includes(b) || b.includes(a))) return 'duplicated'
    }
  }
  return 'forked'
}

export async function scanSeedDuplicates(store: CrdtStoreReader): Promise<SeedDuplicateScan> {
  const scan: SeedDuplicateScan = { scanned: 0, forked: 0, duplicated: [], unreadable: 0 }
  for (const docName of await store.docNames()) {
    const doc = new Y.Doc()
    try {
      const updates = await store.updates(docName)
      doc.transact(() => {
        for (const update of updates) Y.applyUpdate(doc, update)
      })
      const shape = classifyBody(doc)
      if (shape === 'duplicated') scan.duplicated.push(docName)
      if (shape !== 'clean') scan.forked++
      scan.scanned++
    } catch (error) {
      scan.unreadable++
      log.debug('Seed duplicate scan could not read a doc', { noteId: docName, error })
    } finally {
      doc.destroy()
    }
  }
  return scan
}

let scheduled = false

/**
 * Once per process, after the first full sync of the session settles. The
 * store is read when the timer fires, so a vault switched in between is the one
 * scanned.
 */
export function scheduleSeedDuplicateScan(provider: {
  readOnlyStore(): CrdtStoreReader | null
}): void {
  if (scheduled) return
  scheduled = true
  setTimeout(() => void runScan(provider.readOnlyStore()), SCAN_DELAY_MS).unref()
}

async function runScan(store: CrdtStoreReader | null): Promise<void> {
  if (!store) {
    log.info('Seed duplicate scan skipped: no CRDT store')
    return
  }
  const started = performance.now()
  try {
    const scan = await scanSeedDuplicates(store)
    const count = scan.duplicated.length
    // Ids stay in the local log (info is below the shipped level); the warn
    // line below carries counts only, into the incident ring and shipped logs.
    log.info('Seed duplicate scan finished', {
      scanned: scan.scanned,
      forked: scan.forked,
      duplicated: count,
      unreadable: scan.unreadable,
      durationMs: Math.round(performance.now() - started),
      noteIds: scan.duplicated.slice(0, MAX_LOGGED_IDS)
    })
    if (count > 0) {
      log.warn('Note bodies duplicated by a markdown seed', {
        duplicated: count,
        forked: scan.forked,
        scanned: scan.scanned
      })
    }
  } catch (error) {
    log.warn('Seed duplicate scan failed', { error })
  }
}
