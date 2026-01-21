/**
 * CRDT Service - R2 Object Layout
 *
 * T017g: R2 is used for storing large CRDT snapshots that exceed D1 blob limits (>1MB).
 *
 * Object naming convention:
 * - Snapshots: {user_id}/crdt/{note_id}/snapshot
 *
 * The D1 crdt_snapshots table stores metadata and small snapshots (<1MB).
 * For larger snapshots, snapshot_data contains a reference to the R2 object.
 *
 * @module services/crdt
 */

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
  snapshot: (userId: string, noteId: string): string =>
    `${userId}/crdt/${noteId}/snapshot`,
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
  MIN_COMPACT_INTERVAL_MS: 60 * 1000, // 1 minute
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
  createdAt: Date.now(),
})
