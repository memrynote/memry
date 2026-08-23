import type {
  CrdtPullStore,
  DecodedRecordItem,
  PullStore,
  RecordItemRef
} from '@memry/sync-client/pull'
import { createLogger } from '../lib/logger'
import { getMeta, setMeta, type VaultDb } from './index'

const log = createLogger('MobilePullStore')

const RECORD_CURSOR_SCOPE = 'record'

interface NotePayloadProjection {
  title?: string
  folderPath?: string | null
  content?: string | null
  fileType?: string
}

/**
 * SQLite `PullStore` + `CrdtPullStore` for the shared pull engine. Rules that
 * matter here:
 *
 * - `payload` stores the decrypted JSON string VERBATIM (unknown-field
 *   round-trip; mobile never re-serializes what it does not model);
 * - projections (folders, note titles/paths, first-materialization bodies)
 *   are parsed from a copy and are rebuildable;
 * - deletes remove the note body row explicitly (no FK cascade — a body can
 *   arrive before its item row in on-demand flows);
 * - every write is durable before resolve: the engine advances the server
 *   cursor on the strength of these writes.
 */
export class MobilePullStore implements PullStore, CrdtPullStore {
  constructor(
    private readonly db: VaultDb,
    private readonly vaultId: string
  ) {}

  // ---- PullStore ----------------------------------------------------------

  async getRecordCursor(): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ cursor: string | null }>(
      'SELECT cursor FROM sync_cursors WHERE scope = ?',
      [RECORD_CURSOR_SCOPE]
    )
    return row?.cursor ?? null
  }

  async setRecordCursor(cursor: string): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO sync_cursors (scope, cursor, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      [RECORD_CURSOR_SCOPE, cursor, Date.now()]
    )
  }

  async applyRecordRefs(refs: RecordItemRef[], bareDeleteIds: string[]): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      const upsert = await this.db.prepareAsync(
        `INSERT INTO sync_items (id, type, vault_id, updated_at, deleted_at, payload_state)
         VALUES (?, ?, ?, ?, ?, 'metadata-only')
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at`
      )
      try {
        for (const ref of refs) {
          await upsert.executeAsync([
            ref.id,
            ref.type,
            this.vaultId,
            ref.modifiedAt,
            ref.deleted ? ref.modifiedAt || Date.now() : null
          ])
        }
      } finally {
        await upsert.finalizeAsync()
      }

      for (const id of bareDeleteIds) {
        const updated = await this.db.runAsync(
          'UPDATE sync_items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
          [Date.now(), id]
        )
        if (updated.changes === 0) {
          await this.db.runAsync(
            `INSERT INTO sync_items (id, type, vault_id, updated_at, deleted_at, payload_state)
             VALUES (?, 'unknown', ?, ?, ?, 'metadata-only')
             ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at`,
            [id, this.vaultId, Date.now(), Date.now()]
          )
        }
        await this.db.runAsync('DELETE FROM note_bodies WHERE item_id = ?', [id])
      }
    })
  }

  async applyRecordItems(items: DecodedRecordItem[]): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      for (const item of items) {
        if (item.operation === 'delete') {
          await this.applyDelete(item)
        } else {
          await this.applyUpsert(item)
        }
      }
    })
  }

  private async applyDelete(item: DecodedRecordItem): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO sync_items (id, type, vault_id, updated_at, deleted_at, vector_clock, payload_state)
       VALUES (?, ?, ?, ?, ?, ?, 'full')
       ON CONFLICT(id) DO UPDATE SET
         deleted_at = excluded.deleted_at,
         vector_clock = excluded.vector_clock,
         updated_at = excluded.updated_at,
         payload = NULL`,
      [
        item.id,
        item.type,
        this.vaultId,
        item.deletedAt ?? Date.now(),
        item.deletedAt ?? Date.now(),
        item.clock ? JSON.stringify(item.clock) : null
      ]
    )
    await this.db.runAsync('DELETE FROM note_bodies WHERE item_id = ?', [item.id])
    await this.db.runAsync('DELETE FROM yjs_updates WHERE doc_id = ?', [item.id])
    await this.db.runAsync('DELETE FROM yjs_snapshots WHERE doc_id = ?', [item.id])
  }

  private async applyUpsert(item: DecodedRecordItem): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO sync_items (id, type, vault_id, updated_at, deleted_at, vector_clock, payload_state, payload)
       VALUES (?, ?, ?, ?, NULL, ?, 'full', ?)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         updated_at = excluded.updated_at,
         deleted_at = NULL,
         vector_clock = excluded.vector_clock,
         payload_state = 'full',
         payload = excluded.payload`,
      [
        item.id,
        item.type,
        this.vaultId,
        Date.now(),
        item.clock ? JSON.stringify(item.clock) : null,
        item.payloadJson ?? null
      ]
    )

    if ((item.type === 'note' || item.type === 'journal') && item.payloadJson) {
      await this.projectNote(item.id, item.payloadJson, item.operation === 'create')
    }
    if (item.type === 'folder_config' && item.payloadJson) {
      // Folder tree is derived from note folderPaths plus folder_config rows;
      // config payloads carry ordering/emoji which the browse UI reads from
      // the verbatim payload, so nothing extra is projected here.
    }
  }

  private async projectNote(itemId: string, payloadJson: string, isCreate: boolean): Promise<void> {
    let payload: NotePayloadProjection
    try {
      payload = JSON.parse(payloadJson) as NotePayloadProjection
    } catch {
      log.warn('Note payload unparseable; projection skipped', { itemId })
      return
    }

    const folderPath = payload.folderPath ?? ''
    if (folderPath) {
      await this.ensureFolders(folderPath)
    }

    const title = payload.title ?? 'Untitled'
    const relPath = folderPath ? `${folderPath}/${title}.md` : `${title}.md`

    // First materialization only: desktop's rule — record payloads carry
    // content on CREATE pushes; for an existing body the CRDT path owns it.
    const hasBody = await this.db.getFirstAsync<{ one: number }>(
      'SELECT 1 AS one FROM note_bodies WHERE item_id = ?',
      [itemId]
    )
    if (typeof payload.content === 'string' && (isCreate || hasBody === null)) {
      await this.db.runAsync(
        `INSERT INTO note_bodies (item_id, path, markdown, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET path = excluded.path, markdown = excluded.markdown, fetched_at = excluded.fetched_at`,
        [itemId, relPath, payload.content, Date.now()]
      )
    } else if (hasBody !== null) {
      await this.db.runAsync('UPDATE note_bodies SET path = ? WHERE item_id = ?', [relPath, itemId])
    }
  }

  private async ensureFolders(folderPath: string): Promise<void> {
    const segments = folderPath.split('/').filter(Boolean)
    let parentId: string | null = null
    let pathSoFar = ''
    for (const segment of segments) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment
      await this.db.runAsync(
        `INSERT INTO folders (id, parent_id, name) VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [pathSoFar, parentId, segment]
      )
      parentId = pathSoFar
    }
  }

  async markItemCorrupt(id: string, reason: string): Promise<void> {
    await setMeta(this.db, `corrupt.${id}`, reason)
  }

  // ---- CrdtPullStore ------------------------------------------------------

  async getNoteSince(noteId: string): Promise<number> {
    const value = await getMeta(this.db, `crdt.since.${noteId}`)
    return value ? Number(value) : 0
  }

  async setNoteSince(noteId: string, seq: number): Promise<void> {
    await setMeta(this.db, `crdt.since.${noteId}`, String(seq))
  }

  async getSnapshotRevision(noteId: string): Promise<string | null> {
    return getMeta(this.db, `crdt.revision.${noteId}`)
  }

  async saveSnapshot(
    noteId: string,
    snapshot: Uint8Array,
    upToSeq: number,
    revision: string | null
  ): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      await this.db.runAsync(
        `INSERT INTO yjs_snapshots (doc_id, snapshot, last_seq, compacted_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET snapshot = excluded.snapshot, last_seq = excluded.last_seq, compacted_at = excluded.compacted_at`,
        [noteId, snapshot, upToSeq, Date.now()]
      )
      // Updates at or below the snapshot watermark are folded into it.
      await this.db.runAsync('DELETE FROM yjs_updates WHERE doc_id = ? AND seq <= ?', [
        noteId,
        upToSeq
      ])
      if (revision !== null) {
        await setMeta(this.db, `crdt.revision.${noteId}`, revision)
      }
    })
  }

  async appendUpdate(noteId: string, update: Uint8Array, serverSeq: number): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO yjs_updates (doc_id, seq, update_blob, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(doc_id, seq) DO NOTHING`,
      [noteId, serverSeq, update, Date.now()]
    )
  }

  // ---- read helpers for the browse UI and windowing -----------------------

  async listItemIdsMissingPayload(types: string[], limit: number): Promise<string[]> {
    const placeholders = types.map(() => '?').join(',')
    const rows = await this.db.getAllAsync<{ id: string }>(
      `SELECT id FROM sync_items
       WHERE payload_state = 'metadata-only' AND deleted_at IS NULL AND type IN (${placeholders})
       ORDER BY updated_at DESC LIMIT ?`,
      [...types, limit]
    )
    return rows.map((r) => r.id)
  }

  async loadCrdtDoc(
    noteId: string
  ): Promise<{ snapshot: Uint8Array | null; updates: Uint8Array[] }> {
    const snap = await this.db.getFirstAsync<{ snapshot: Uint8Array }>(
      'SELECT snapshot FROM yjs_snapshots WHERE doc_id = ?',
      [noteId]
    )
    const updates = await this.db.getAllAsync<{ update_blob: Uint8Array }>(
      'SELECT update_blob FROM yjs_updates WHERE doc_id = ? ORDER BY seq ASC',
      [noteId]
    )
    return {
      snapshot: snap ? new Uint8Array(snap.snapshot) : null,
      updates: updates.map((u) => new Uint8Array(u.update_blob))
    }
  }
}
