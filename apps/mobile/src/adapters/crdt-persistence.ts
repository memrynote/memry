import type { CrdtDocState, CrdtPersistenceAdapter } from '@memry/sync-client/adapters'
import type { VaultDb } from '../db/index'

/**
 * Seam 3 on mobile: `yjs_updates` / `yjs_snapshots` tables (T041).
 * `appendUpdate` resolves only after the row is committed — SQLite in WAL
 * mode is durable at commit, which satisfies the seam's durability rule.
 *
 * Namespace note, on record: server-pulled CRDT data is keyed by the bare
 * note id with the SERVER's sequence numbers (written by MobilePullStore).
 * This adapter owns LOCALLY-originated updates and uses the `local.<docId>`
 * namespace with its own monotonic sequence, so a local append can never
 * collide with (and silently drop) a future server row. Phase 4's doc
 * manager reads both halves when it materializes a doc.
 */

const LOCAL_PREFIX = 'local.'

export function createMobileCrdtPersistence(db: VaultDb): CrdtPersistenceAdapter {
  const localId = (docId: string) => `${LOCAL_PREFIX}${docId}`

  return {
    async appendUpdate(docId, update) {
      await db.withTransactionAsync(async () => {
        const row = await db.getFirstAsync<{ max_seq: number | null }>(
          'SELECT MAX(seq) AS max_seq FROM yjs_updates WHERE doc_id = ?',
          [localId(docId)]
        )
        const nextSeq = (row?.max_seq ?? 0) + 1
        await db.runAsync(
          'INSERT INTO yjs_updates (doc_id, seq, update_blob, created_at) VALUES (?, ?, ?, ?)',
          [localId(docId), nextSeq, update, Date.now()]
        )
      })
    },

    async loadDoc(docId): Promise<CrdtDocState> {
      const snap = await db.getFirstAsync<{ snapshot: Uint8Array }>(
        'SELECT snapshot FROM yjs_snapshots WHERE doc_id = ?',
        [localId(docId)]
      )
      const rows = await db.getAllAsync<{ update_blob: Uint8Array }>(
        'SELECT update_blob FROM yjs_updates WHERE doc_id = ? ORDER BY seq ASC',
        [localId(docId)]
      )
      return {
        updates: rows.map((r) => new Uint8Array(r.update_blob)),
        snapshot: snap ? new Uint8Array(snap.snapshot) : undefined
      }
    },

    async saveSnapshot(docId, snapshot, upToSeq) {
      await db.runAsync(
        `INSERT INTO yjs_snapshots (doc_id, snapshot, last_seq, compacted_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET snapshot = excluded.snapshot, last_seq = excluded.last_seq, compacted_at = excluded.compacted_at`,
        [localId(docId), snapshot, upToSeq, Date.now()]
      )
    },

    async compact(docId) {
      const snap = await db.getFirstAsync<{ last_seq: number }>(
        'SELECT last_seq FROM yjs_snapshots WHERE doc_id = ?',
        [localId(docId)]
      )
      if (!snap) return
      await db.runAsync('DELETE FROM yjs_updates WHERE doc_id = ? AND seq <= ?', [
        localId(docId),
        snap.last_seq
      ])
    },

    async listDocs() {
      const rows = await db.getAllAsync<{ doc_id: string }>(
        `SELECT DISTINCT doc_id FROM yjs_updates WHERE doc_id LIKE '${LOCAL_PREFIX}%'
         UNION SELECT doc_id FROM yjs_snapshots WHERE doc_id LIKE '${LOCAL_PREFIX}%'`
      )
      return rows.map((r) => r.doc_id.slice(LOCAL_PREFIX.length))
    },

    async deleteDoc(docId) {
      await db.runAsync('DELETE FROM yjs_updates WHERE doc_id = ?', [localId(docId)])
      await db.runAsync('DELETE FROM yjs_snapshots WHERE doc_id = ?', [localId(docId)])
    }
  }
}
