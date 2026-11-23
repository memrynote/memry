/**
 * Finds note bodies that shipped builds duplicated with a markdown seed
 * (#5286), and removes the second copy when it is an exact copy (#5289).
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
 * - `exact`: the fragment holds exactly two live items, both roots, and their
 *   block trees are equal (node names, attributes other than the block `id`,
 *   and text with its marks). Only this shape is repaired.
 *
 * False positives for `duplicated`: two devices that imported the same file
 * into a note, or created the same day's journal from one template, before
 * either synced. Removing the second copy of such a body loses nothing either,
 * because the two copies are equal. A root's text inside a longer root also
 * counts as `duplicated`, but never as `exact`. A paragraph repeated inside one
 * body is never counted, because it sits under one root.
 */

import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createLogger } from '../lib/logger'
import type { CrdtStoreReader } from './crdt-persistence'

const log = createLogger('CrdtSeedDuplicates')

/** Off the bootstrap's busiest minutes. */
const SCAN_DELAY_MS = 10 * 60 * 1000
/** Bounds the local log line; the count is always exact. */
const MAX_LOGGED_IDS = 500
/**
 * The repair's transaction origin. The provider persists and pushes any origin
 * other than the network, and schedules a file write-back only for network and
 * editor origins, so the repair writes no vault file.
 */
export const ORIGIN_SEED_REPAIR = 'seed-duplicate-repair'

export type BodyShape = 'clean' | 'forked' | 'duplicated' | 'exact'

export interface SeedDuplicateScan {
  scanned: number
  forked: number
  /** Every duplicated body, the exact ones included. */
  duplicated: string[]
  exact: string[]
  unreadable: number
}

/** The provider's doc operations the repair runs through. */
export interface SeedRepairHost {
  /** Changes whenever the store underneath the provider is replaced (vault switch, reopen). */
  readonly storeId: string | null
  readOnlyStore(): CrdtStoreReader | null
  holdDoc(noteId: string): () => Promise<void>
  open(noteId: string, windowId: undefined, options: { skipSeed: boolean }): Promise<Y.Doc>
  seedRepairDone(noteId: string): Promise<boolean>
  markSeedRepairDone(noteId: string): Promise<void>
  whenPersisted(noteId: string): Promise<void>
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

/** Equal block trees. Block ids differ between two parses of one file, so they are ignored. */
function sameTree(a: unknown, b: unknown): boolean {
  if (a instanceof Y.XmlText && b instanceof Y.XmlText) {
    return JSON.stringify(a.toDelta()) === JSON.stringify(b.toDelta())
  }
  if (!(a instanceof Y.XmlElement) || !(b instanceof Y.XmlElement)) return false
  if (a.nodeName !== b.nodeName) return false
  const { id: _aId, ...aAttrs } = a.getAttributes()
  const { id: _bId, ...bAttrs } = b.getAttributes()
  if (JSON.stringify(aAttrs) !== JSON.stringify(bAttrs)) return false
  const [aChildren, bChildren] = [a.toArray(), b.toArray()]
  return (
    aChildren.length === bChildren.length &&
    aChildren.every((child, i) => sameTree(child, bChildren[i]))
  )
}

/** Equal bodies: the same block trees, block ids aside. */
export function sameBody(a: Y.Doc, b: Y.Doc): boolean {
  const aBlocks = a.getXmlFragment(CRDT_FRAGMENT_NAME).toArray()
  const bBlocks = b.getXmlFragment(CRDT_FRAGMENT_NAME).toArray()
  return aBlocks.length === bBlocks.length && aBlocks.every((x, i) => sameTree(x, bBlocks[i]))
}

export function classifyBody(doc: Y.Doc): BodyShape {
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const roots: Y.AbstractType<unknown>[] = []
  for (let item = fragment._start; item; item = item.right) {
    if (item.deleted || item.origin !== null || item.rightOrigin !== null) continue
    if (!(item.content instanceof Y.ContentType)) continue
    roots.push(item.content.type)
  }
  if (roots.length < 2) return 'clean'
  if (roots.length === 2 && fragment.length === 2 && sameTree(roots[0], roots[1])) return 'exact'
  const texts = roots.map((root) => textOf(root).replace(/\s+/g, ' ').trim())
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const [a, b] = [texts[i], texts[j]]
      if (a && b && (a.includes(b) || b.includes(a))) return 'duplicated'
    }
  }
  return 'forked'
}

/**
 * Deletes the second root of an `exact` body. Yjs orders concurrent roots the
 * same way on every device, so two devices repairing at once delete the same
 * item, and their deletes merge to one copy. The editor and the markdown
 * write-back show the first root only, so what the user sees does not change.
 */
export function removeSeedCopy(doc: Y.Doc): boolean {
  // An update parked behind a missing one may edit the second copy; deleting
  // the copy now would swallow that edit when it applies.
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) return false
  if (classifyBody(doc) !== 'exact') return false
  doc.transact(() => doc.getXmlFragment(CRDT_FRAGMENT_NAME).delete(1, 1), ORIGIN_SEED_REPAIR)
  return true
}

export async function scanSeedDuplicates(store: CrdtStoreReader): Promise<SeedDuplicateScan> {
  const scan: SeedDuplicateScan = {
    scanned: 0,
    forked: 0,
    duplicated: [],
    exact: [],
    unreadable: 0
  }
  for (const docName of await store.docNames()) {
    const doc = new Y.Doc()
    try {
      const updates = await store.updates(docName)
      doc.transact(() => {
        for (const update of updates) Y.applyUpdate(doc, update)
      })
      const shape = classifyBody(doc)
      if (shape === 'exact') scan.exact.push(docName)
      if (shape === 'exact' || shape === 'duplicated') scan.duplicated.push(docName)
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

/**
 * Once per note: a note repaired before keeps any copy that comes back. The
 * open doc is checked again, because it holds edits the scan's store read may
 * predate. A vault switch replaces the store under the same note ids, so the
 * store is checked after each await that can span one.
 */
async function repairNote(
  host: SeedRepairHost,
  noteId: string,
  storeId: string | null
): Promise<boolean> {
  if (await host.seedRepairDone(noteId)) return false
  const release = host.holdDoc(noteId)
  try {
    const doc = await host.open(noteId, undefined, { skipSeed: true })
    if (host.storeId !== storeId || !removeSeedCopy(doc)) return false
    // The marker only after the delete is in the store: a marker without it
    // would keep the duplicate forever.
    await host.whenPersisted(noteId)
    if (host.storeId !== storeId) return false
    await host.markSeedRepairDone(noteId)
    return true
  } finally {
    await release()
  }
}

export async function repairSeedDuplicates(host: SeedRepairHost): Promise<void> {
  const store = host.readOnlyStore()
  if (!store) {
    log.info('Seed duplicate repair skipped: no CRDT store')
    return
  }
  const storeId = host.storeId
  const started = performance.now()
  try {
    const scan = await scanSeedDuplicates(store)
    const removed: string[] = []
    let failed = 0
    for (const noteId of scan.exact) {
      if (host.storeId !== storeId) {
        log.info('Seed duplicate repair stopped: the store changed')
        break
      }
      try {
        if (await repairNote(host, noteId, storeId)) removed.push(noteId)
      } catch (error) {
        failed++
        log.info('Seed duplicate repair could not change a note', { noteId, error })
      }
    }
    const counts = {
      scanned: scan.scanned,
      forked: scan.forked,
      duplicated: scan.duplicated.length,
      exact: scan.exact.length,
      removed: removed.length,
      failed,
      unreadable: scan.unreadable
    }
    // Ids stay in the local log (info is below the shipped level); the warn
    // line below carries counts only, into the incident ring and shipped logs.
    log.info('Seed duplicate repair finished', {
      ...counts,
      durationMs: Math.round(performance.now() - started),
      noteIds: removed.slice(0, MAX_LOGGED_IDS),
      keptIds: scan.duplicated.filter((id) => !removed.includes(id)).slice(0, MAX_LOGGED_IDS)
    })
    if (scan.duplicated.length > 0) log.warn('Note bodies duplicated by a markdown seed', counts)
  } catch (error) {
    log.warn('Seed duplicate repair failed', { error })
  }
}

let scheduled = false

/**
 * Once per process, from a full sync that delivered its pull and left no note
 * body owed. When the timer fires, the store must still be the one that sync
 * settled and `settled()` must still hold; otherwise nothing is read, and the
 * next settled sync schedules again.
 */
export function scheduleSeedDuplicateRepair(host: SeedRepairHost, settled: () => boolean): void {
  if (scheduled) return
  scheduled = true
  const storeId = host.storeId
  setTimeout(() => {
    if (storeId === null || host.storeId !== storeId || !settled()) {
      scheduled = false
      log.info('Seed duplicate repair deferred: the store changed or note bodies are owed')
      return
    }
    void repairSeedDuplicates(host)
  }, SCAN_DELAY_MS).unref()
}
