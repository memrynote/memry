import * as Y from 'yjs'
import type { CrdtDocState, CrdtPersistenceAdapter } from '@memry/sync-client/adapters'
import type { CrdtPersistence } from '../crdt-persistence'

/**
 * Seam 3 implemented over the y-leveldb store desktop already trusts.
 *
 * y-leveldb merges stored updates internally, so `loadDoc` cannot return the
 * original per-edit updates — it returns the merged state as a single-element
 * update list, which is a valid `CrdtDocState` by construction (applying it
 * reproduces the doc byte-for-byte). `upToSeq` bookkeeping rides the store's
 * per-document meta, the same keyspace the snapshot watermark uses, so it is
 * wiped together with the document it describes.
 */

/** y-leveldb's instance surface beyond desktop's `CrdtPersistence` slice. */
interface LeveldbBacked extends CrdtPersistence {
  getAllDocNames?(): Promise<string[]>
}

const SNAPSHOT_SEQ_META_KEY = 'adapter-snapshot-up-to-seq'

export class DesktopCrdtPersistenceAdapter implements CrdtPersistenceAdapter {
  constructor(private readonly store: LeveldbBacked) {}

  async appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    // storeUpdate resolves after leveldb has accepted the write — the same
    // durability point every current desktop caller relies on.
    await this.store.storeUpdate(docId, update)
  }

  async loadDoc(docId: string): Promise<CrdtDocState> {
    const doc = await this.store.getYDoc(docId)
    try {
      const merged = Y.encodeStateAsUpdate(doc)
      const upToSeq = await this.store.getMeta(docId, SNAPSHOT_SEQ_META_KEY)
      return {
        updates: [merged],
        ...(typeof upToSeq === 'number' ? { snapshot: merged } : {})
      }
    } finally {
      doc.destroy()
    }
  }

  async saveSnapshot(docId: string, snapshot: Uint8Array, upToSeq: number): Promise<void> {
    await this.store.storeUpdate(docId, snapshot)
    await this.store.flushDocument(docId)
    await this.store.setMeta(docId, SNAPSHOT_SEQ_META_KEY, upToSeq)
  }

  async compact(docId: string): Promise<void> {
    // flushDocument is y-leveldb's compaction: merge every stored update into
    // one row and drop the incrementals.
    await this.store.flushDocument(docId)
  }

  async listDocs(): Promise<string[]> {
    if (typeof this.store.getAllDocNames === 'function') {
      return this.store.getAllDocNames()
    }
    // Desktop's CrdtPersistence interface does not expose enumeration; the
    // y-leveldb instance always has it. Reaching this line means the store is
    // an in-memory stand-in, where "no docs" is the honest answer.
    return []
  }

  async deleteDoc(docId: string): Promise<void> {
    await this.store.clearDocument(docId)
  }
}
