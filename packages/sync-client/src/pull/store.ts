import type { RecordSyncItemType, VectorClock } from '@memry/contracts/sync-api'

/**
 * What the engine hands the shell after a pull item is decrypted and verified.
 *
 * `payloadJson` is the decrypted payload EXACTLY as received (spec edge case:
 * unknown fields written by newer clients must round-trip untouched, so the
 * shell stores this string verbatim and only ever parses a copy for its own
 * projections).
 */
export interface DecodedRecordItem {
  id: string
  type: RecordSyncItemType
  operation: 'create' | 'update' | 'delete'
  deletedAt?: number
  clock?: VectorClock
  payloadJson?: string
}

/** A change-feed ref, before its blob has been pulled (payload_state: metadata-only). */
export interface RecordItemRef {
  id: string
  type: RecordSyncItemType
  modifiedAt: number
  size: number
  deleted: boolean
}

/**
 * Durable state the pull engine reads and writes, implemented by the shell
 * (mobile: SQLite). Every method must be durable before it resolves — the
 * engine advances the server cursor on the strength of these writes.
 */
export interface PullStore {
  getRecordCursor(): Promise<string | null>
  setRecordCursor(cursor: string): Promise<void>
  /**
   * Refs-only pass (windowed first sync). Upsert; never regress payload_state.
   * `bareDeleteIds` are ids the feed reported deleted with no ref row (their
   * type is not on the wire): mark existing rows deleted, record a bare
   * tombstone otherwise.
   */
  applyRecordRefs(refs: RecordItemRef[], bareDeleteIds: string[]): Promise<void>
  /** Decrypted full items, already sorted in FK-parent-first apply order. */
  applyRecordItems(items: DecodedRecordItem[]): Promise<void>
  /** Undecryptable/unverifiable item — recorded, never silently dropped. */
  markItemCorrupt(id: string, reason: string): Promise<void>
}

/** Per-note CRDT bookkeeping (server sequence numbers, snapshot identity). */
export interface CrdtPullStore {
  /** Highest server sequenceNum applied for this note; 0 when none. */
  getNoteSince(noteId: string): Promise<number>
  setNoteSince(noteId: string, seq: number): Promise<void>
  getSnapshotRevision(noteId: string): Promise<string | null>
  /**
   * Persist a decrypted snapshot/update durably (mobile: yjs_snapshots /
   * yjs_updates). Called in server order; must be on disk before resolving.
   */
  saveSnapshot(
    noteId: string,
    snapshot: Uint8Array,
    upToSeq: number,
    revision: string | null
  ): Promise<void>
  appendUpdate(noteId: string, update: Uint8Array, serverSeq: number): Promise<void>
}
