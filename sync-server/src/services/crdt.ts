/**
 * CRDT Service
 *
 * T017g: R2 is used for storing large CRDT snapshots that exceed D1 blob limits (>1MB).
 * T135-T138: Server-side CRDT storage and retrieval operations.
 *
 * Object naming convention:
 * - Snapshots: {user_id}/crdt/{note_id}/snapshot
 *
 * The D1 crdt_snapshots table stores metadata and small snapshots (<1MB).
 * For larger snapshots, snapshot_data contains a reference to the R2 object (r2:{key}).
 *
 * @module services/crdt
 */

import type {
  CrdtUpdate,
  CrdtUpdateResponse,
  GetCrdtUpdatesResponse,
  GetCrdtSnapshotResponse,
  PushCrdtSnapshotResponse
} from '../contracts/crdt-api'

/**
 * R2 path generators for CRDT objects
 */
export const R2_CRDT_PATHS = {
  /**
   * Generate R2 object key for a CRDT snapshot
   * @param userId - User UUID
   * @param noteId - Note UUID
   * @returns R2 object key
   */
  snapshot: (userId: string, noteId: string): string => `${userId}/crdt/${noteId}/snapshot`
} as const

/**
 * CRDT storage thresholds
 */
export const CRDT_THRESHOLDS = {
  /** Maximum snapshot size to store inline in D1 (1MB) */
  MAX_D1_SNAPSHOT_SIZE: 1024 * 1024,

  /** Maximum number of updates before compaction is recommended */
  MAX_UPDATES_BEFORE_COMPACT: 100,

  /** Minimum time between compactions (in milliseconds) */
  MIN_COMPACT_INTERVAL_MS: 60 * 1000,

  /** Number of updates to keep after snapshot for safety */
  PRUNING_SAFETY_BUFFER: 5
} as const

/**
 * R2 object metadata type for CRDT snapshots
 */
export interface CrdtSnapshotMetadata {
  /** User who owns this snapshot */
  userId: string
  /** Note this snapshot belongs to */
  noteId: string
  /** Sequence number at time of snapshot */
  sequenceNum: number
  /** Size in bytes */
  sizeBytes: number
  /** Timestamp when snapshot was created */
  createdAt: number
}

/**
 * Check if a snapshot should be stored in R2 (exceeds D1 limit)
 * @param sizeBytes - Size of the snapshot in bytes
 * @returns true if should use R2, false for D1 inline storage
 */
export const shouldUseR2Storage = (sizeBytes: number): boolean => {
  return sizeBytes > CRDT_THRESHOLDS.MAX_D1_SNAPSHOT_SIZE
}

/**
 * Build R2 object metadata for a CRDT snapshot
 * @param userId - User UUID
 * @param noteId - Note UUID
 * @param sequenceNum - Current sequence number
 * @param sizeBytes - Size of snapshot data
 * @returns Metadata object for R2 storage
 */
export const buildSnapshotMetadata = (
  userId: string,
  noteId: string,
  sequenceNum: number,
  sizeBytes: number
): CrdtSnapshotMetadata => ({
  userId,
  noteId,
  sequenceNum,
  sizeBytes,
  createdAt: Date.now()
})

// =============================================================================
// Database Row Types
// =============================================================================

type SnapshotBlob = ArrayBuffer | ArrayBufferView | number[] | string

interface CrdtUpdateRow {
  id: string
  user_id: string
  note_id: string
  update_data: ArrayBuffer | ArrayBufferView | number[]
  sequence_num: number
  signer_device_id: string
  signature: ArrayBuffer | ArrayBufferView | number[]
  created_at: number
}

interface CrdtSnapshotRow {
  id: string
  user_id: string
  note_id: string
  snapshot_data: SnapshotBlob
  sequence_num: number
  size_bytes: number
  created_at: number
}

interface SyncItemOwnershipRow {
  id: string
}

// =============================================================================
// Helper Functions
// =============================================================================

const R2_PREFIX = 'r2:'
const R2_PREFIX_BYTES = [0x72, 0x32, 0x3a]

const toUint8Array = (data: ArrayBuffer | ArrayBufferView | number[]): Uint8Array => {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return Uint8Array.from(data)
}

const bytesToAsciiString = (bytes: Uint8Array): string => {
  let text = ''
  for (let i = 0; i < bytes.length; i++) {
    text += String.fromCharCode(bytes[i])
  }
  return text
}

export const arrayBufferToBase64 = (buffer: ArrayBuffer | ArrayBufferView | number[]): string => {
  const bytes = toUint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export const base64ToUint8Array = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const generateId = (): string => crypto.randomUUID()

const isR2Reference = (data: SnapshotBlob): boolean => {
  if (typeof data === 'string') {
    return data.startsWith(R2_PREFIX)
  }
  const bytes = toUint8Array(data)
  if (bytes.length < R2_PREFIX_BYTES.length) {
    return false
  }
  return (
    bytes[0] === R2_PREFIX_BYTES[0] &&
    bytes[1] === R2_PREFIX_BYTES[1] &&
    bytes[2] === R2_PREFIX_BYTES[2]
  )
}

const getR2KeyFromReference = (data: SnapshotBlob): string => {
  if (typeof data === 'string') {
    return data.slice(R2_PREFIX.length)
  }
  const bytes = toUint8Array(data)
  if (bytes.length <= R2_PREFIX.length) {
    return ''
  }
  return bytesToAsciiString(bytes.subarray(R2_PREFIX.length))
}

const createR2Reference = (key: string): Uint8Array => {
  const encoder = new TextEncoder()
  return encoder.encode(`${R2_PREFIX}${key}`)
}

// =============================================================================
// Ownership Verification
// =============================================================================

export const verifyNoteOwnership = async (
  db: D1Database,
  userId: string,
  noteId: string
): Promise<boolean> => {
  const result = await db
    .prepare(
      `SELECT id FROM sync_items
       WHERE user_id = ? AND item_id = ? AND item_type IN ('note', 'journal') AND deleted = 0`
    )
    .bind(userId, noteId)
    .first<SyncItemOwnershipRow>()

  return result !== null
}

export const verifyBulkNoteOwnership = async (
  db: D1Database,
  userId: string,
  noteIds: string[]
): Promise<Set<string>> => {
  if (noteIds.length === 0) {
    return new Set()
  }

  const placeholders = noteIds.map(() => '?').join(', ')
  const result = await db
    .prepare(
      `SELECT item_id FROM sync_items
       WHERE user_id = ? AND item_id IN (${placeholders}) AND item_type IN ('note', 'journal') AND deleted = 0`
    )
    .bind(userId, ...noteIds)
    .all<{ item_id: string }>()

  return new Set(result.results.map((row) => row.item_id))
}

// =============================================================================
// CRDT Updates Operations (T135, T136)
// =============================================================================

export interface StoreCrdtUpdatesResult {
  accepted: Array<{ noteId: string; sequenceNum: number }>
  rejected: Array<{ noteId: string; reason: string }>
}

export const storeCrdtUpdates = async (
  db: D1Database,
  userId: string,
  updates: CrdtUpdate[]
): Promise<StoreCrdtUpdatesResult> => {
  const accepted: Array<{ noteId: string; sequenceNum: number }> = []
  const rejected: Array<{ noteId: string; reason: string }> = []
  const now = Date.now()

  const uniqueNoteIds = [...new Set(updates.map((u) => u.noteId))]
  const ownedNotes = await verifyBulkNoteOwnership(db, userId, uniqueNoteIds)

  for (const update of updates) {
    if (!ownedNotes.has(update.noteId)) {
      rejected.push({
        noteId: update.noteId,
        reason: 'Note not found or not owned by user'
      })
      continue
    }

    const updateData = base64ToUint8Array(update.updateData)
    const id = generateId()

    try {
      const maxResult = await db
        .prepare(
          'SELECT COALESCE(MAX(sequence_num), 0) as max_seq FROM crdt_updates WHERE user_id = ? AND note_id = ?'
        )
        .bind(userId, update.noteId)
        .first<{ max_seq: number }>()

      const nextSequence = (maxResult?.max_seq ?? 0) + 1

      await db
        .prepare(
          `INSERT INTO crdt_updates (id, user_id, note_id, update_data, sequence_num, signer_device_id, signature, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          userId,
          update.noteId,
          updateData,
          nextSequence,
          update.signerDeviceId,
          base64ToUint8Array(update.signature),
          now
        )
        .run()

      accepted.push({ noteId: update.noteId, sequenceNum: nextSequence })
    } catch (error) {
      rejected.push({
        noteId: update.noteId,
        reason: error instanceof Error ? error.message : 'Database error'
      })
    }
  }

  return { accepted, rejected }
}

export const getCrdtUpdates = async (
  db: D1Database,
  userId: string,
  noteId: string,
  sinceSequence: number,
  limit: number
): Promise<GetCrdtUpdatesResponse> => {
  const rows = await db
    .prepare(
      `SELECT update_data, sequence_num, signer_device_id, signature, created_at
       FROM crdt_updates
       WHERE user_id = ? AND note_id = ? AND sequence_num > ?
       ORDER BY sequence_num ASC
       LIMIT ?`
    )
    .bind(userId, noteId, sinceSequence, limit + 1)
    .all<
      Pick<
        CrdtUpdateRow,
        'update_data' | 'sequence_num' | 'signer_device_id' | 'signature' | 'created_at'
      >
    >()

  const hasMore = rows.results.length > limit
  const updates: CrdtUpdateResponse[] = rows.results.slice(0, limit).map((row) => ({
    sequenceNum: row.sequence_num,
    updateData: arrayBufferToBase64(row.update_data),
    signature: arrayBufferToBase64(row.signature),
    signerDeviceId: row.signer_device_id,
    createdAt: row.created_at
  }))

  const latestSequence = await getLatestUpdateSequence(db, userId, noteId)

  return {
    noteId,
    updates,
    hasMore,
    latestSequence,
    serverTime: Date.now()
  }
}

export const getLatestUpdateSequence = async (
  db: D1Database,
  userId: string,
  noteId: string
): Promise<number> => {
  const result = await db
    .prepare(
      `SELECT MAX(sequence_num) as max_seq
       FROM crdt_updates
       WHERE user_id = ? AND note_id = ?`
    )
    .bind(userId, noteId)
    .first<{ max_seq: number | null }>()

  return result?.max_seq ?? 0
}

// =============================================================================
// CRDT Snapshot Operations (T137, T138)
// =============================================================================

export const storeCrdtSnapshot = async (
  db: D1Database,
  bucket: R2Bucket,
  userId: string,
  noteId: string,
  snapshotData: string,
  sequenceNum: number,
  sizeBytes: number
): Promise<PushCrdtSnapshotResponse> => {
  const now = Date.now()
  const useR2 = shouldUseR2Storage(sizeBytes)
  let storageType: 'd1' | 'r2' = 'd1'
  let dataToStore: Uint8Array

  if (useR2) {
    const r2Key = R2_CRDT_PATHS.snapshot(userId, noteId)
    const snapshotBytes = base64ToUint8Array(snapshotData)

    await bucket.put(r2Key, snapshotBytes, {
      customMetadata: {
        userId,
        noteId,
        sequenceNum: String(sequenceNum),
        sizeBytes: String(sizeBytes),
        createdAt: String(now)
      }
    })

    dataToStore = createR2Reference(r2Key)
    storageType = 'r2'
  } else {
    dataToStore = base64ToUint8Array(snapshotData)
  }

  const id = generateId()

  await db
    .prepare(
      `INSERT INTO crdt_snapshots (id, user_id, note_id, snapshot_data, sequence_num, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, note_id) DO UPDATE SET
         snapshot_data = excluded.snapshot_data,
         sequence_num = excluded.sequence_num,
         size_bytes = excluded.size_bytes,
         created_at = excluded.created_at`
    )
    .bind(id, userId, noteId, dataToStore, sequenceNum, sizeBytes, now)
    .run()

  const updatesPruned = await pruneCrdtUpdatesBeforeSnapshot(db, userId, noteId, sequenceNum)

  return {
    success: true,
    noteId,
    sequenceNum,
    storageType,
    updatesPruned,
    serverTime: now
  }
}

export const getCrdtSnapshot = async (
  db: D1Database,
  bucket: R2Bucket,
  userId: string,
  noteId: string
): Promise<GetCrdtSnapshotResponse> => {
  const row = await db
    .prepare(
      `SELECT snapshot_data, sequence_num, size_bytes, created_at
       FROM crdt_snapshots
       WHERE user_id = ? AND note_id = ?`
    )
    .bind(userId, noteId)
    .first<Pick<CrdtSnapshotRow, 'snapshot_data' | 'sequence_num' | 'size_bytes' | 'created_at'>>()

  if (!row) {
    return {
      noteId,
      sequenceNum: 0,
      sizeBytes: 0,
      exists: false
    }
  }

  let snapshotData: string

  if (isR2Reference(row.snapshot_data)) {
    const r2Key = getR2KeyFromReference(row.snapshot_data)
    const r2Object = await bucket.get(r2Key)

    if (!r2Object) {
      console.error(`[CRDT] R2 object missing for D1 reference: ${r2Key}`)
      return {
        noteId,
        sequenceNum: row.sequence_num,
        sizeBytes: row.size_bytes,
        createdAt: row.created_at,
        exists: false,
        corrupted: true
      }
    }

    const arrayBuffer = await r2Object.arrayBuffer()
    snapshotData = arrayBufferToBase64(arrayBuffer)
  } else {
    if (typeof row.snapshot_data === 'string') {
      snapshotData = row.snapshot_data
    } else {
      snapshotData = arrayBufferToBase64(row.snapshot_data)
    }
  }

  return {
    noteId,
    snapshotData,
    sequenceNum: row.sequence_num,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    exists: true
  }
}

// =============================================================================
// Pruning Operations (T137a)
// =============================================================================

export const pruneCrdtUpdatesBeforeSnapshot = async (
  db: D1Database,
  userId: string,
  noteId: string,
  snapshotSequence: number
): Promise<number> => {
  const cutoffSequence = snapshotSequence - CRDT_THRESHOLDS.PRUNING_SAFETY_BUFFER
  if (cutoffSequence <= 0) {
    return 0
  }

  const result = await db
    .prepare(
      `DELETE FROM crdt_updates
       WHERE user_id = ? AND note_id = ? AND sequence_num < ?`
    )
    .bind(userId, noteId, cutoffSequence)
    .run()

  return result.meta.changes ?? 0
}

export const cleanupOrphanedCrdtUpdates = async (db: D1Database): Promise<number> => {
  const result = await db
    .prepare(
      `DELETE FROM crdt_updates
       WHERE (user_id, note_id) IN (
         SELECT cu.user_id, cu.note_id
         FROM crdt_updates cu
         JOIN crdt_snapshots cs ON cu.user_id = cs.user_id AND cu.note_id = cs.note_id
         WHERE cu.sequence_num < cs.sequence_num - ?
       )`
    )
    .bind(CRDT_THRESHOLDS.PRUNING_SAFETY_BUFFER)
    .run()

  return result.meta.changes ?? 0
}
