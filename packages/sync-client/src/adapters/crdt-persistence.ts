/**
 * Seam 3 — durable CRDT storage. Replaces desktop's `y-leveldb` usage.
 *
 * Durability rule: `appendUpdate` resolves only after the bytes are on disk.
 * Memory-only CRDT state is assumed lost, so a resolve-before-fsync adapter
 * turns a crash into silent data loss.
 */
export interface CrdtDocState {
  updates: Uint8Array[]
  snapshot?: Uint8Array
}

export interface CrdtPersistenceAdapter {
  appendUpdate(docId: string, update: Uint8Array): Promise<void>
  loadDoc(docId: string): Promise<CrdtDocState>
  saveSnapshot(docId: string, snapshot: Uint8Array, upToSeq: number): Promise<void>
  compact(docId: string): Promise<void>
  listDocs(): Promise<string[]>
  /** Tombstone flow. */
  deleteDoc(docId: string): Promise<void>
}
