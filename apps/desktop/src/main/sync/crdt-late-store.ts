/**
 * The store side of switching an in-memory session to the store its probe
 * timed out on (`LateCrdtStore`), one note at a time. The provider owns the
 * switch (`CrdtProvider.adoptLateStore`).
 *
 * @module sync/crdt-late-store
 */
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import type { CrdtPersistence } from './crdt-persistence'

/**
 * Whether `stored` and `live` are two separate histories of one note: the live
 * body is not empty, the store holds state, and no client wrote to both. A doc
 * this session seeded from the vault file shares no Yjs items with the store's
 * copy of the same body, so merging the two would show the body twice (#2536).
 */
export function forksFrom(stored: Y.Doc, live: Y.Doc): boolean {
  if (live.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0) return false
  const storedClients = Y.decodeStateVector(Y.encodeStateVector(stored))
  if (storedClients.size === 0) return false
  for (const client of Y.decodeStateVector(Y.encodeStateVector(live)).keys()) {
    if (storedClients.has(client)) return false
  }
  return true
}

export interface StoredNote {
  /** The note as the store holds it after the write. The caller destroys it. */
  stored: Y.Doc
  /** `doc`'s state vector at the write. */
  written: Uint8Array
  /** The store's earlier copy forked from `doc` (`forksFrom`) and was cleared. */
  replaced: boolean
}

/**
 * Writes `doc`'s whole state into the store, then reads the note back. A
 * stored copy that forks from `doc` is cleared first: the session showed and
 * wrote `doc`, so its history replaces the store's. Throws when the read lacks
 * the write or still holds the cleared copy, since y-leveldb resolves a store
 * call that failed.
 */
export async function writeNote(
  persistence: CrdtPersistence,
  noteId: string,
  doc: Y.Doc
): Promise<StoredNote> {
  const before = await persistence.getYDoc(noteId)
  const replaced = forksFrom(before, doc)
  const cleared = replaced ? Y.decodeStateVector(Y.encodeStateVector(before)) : new Map()
  before.destroy()
  if (replaced) await persistence.clearDocument(noteId)
  const written = Y.encodeStateVector(doc)
  await persistence.storeUpdate(noteId, Y.encodeStateAsUpdate(doc))
  const stored = await persistence.getYDoc(noteId)
  const held = Y.decodeStateVector(Y.encodeStateVector(stored))
  const lacksWrite = [...Y.decodeStateVector(written)].some(
    ([client, clock]) => (held.get(client) ?? 0) < clock
  )
  if (lacksWrite || [...cleared.keys()].some((client) => held.has(client))) {
    stored.destroy()
    throw new Error('The CRDT store does not hold the state written to it')
  }
  return { stored, written, replaced }
}
