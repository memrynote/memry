import { z } from 'zod'

// ============================================================================
// Channel Name Constants
// ============================================================================

export const SYNC_OP_CHANNELS = {
  GET_STATUS: 'sync:get-status',
  TRIGGER_SYNC: 'sync:trigger-sync',
  GET_HISTORY: 'sync:get-history',
  GET_QUEUE_SIZE: 'sync:get-queue-size',
  PAUSE: 'sync:pause',
  RESUME: 'sync:resume',
  UPDATE_SYNCED_SETTING: 'sync:update-synced-setting',
  GET_SYNCED_SETTINGS: 'sync:get-synced-settings',
  GET_STORAGE_BREAKDOWN: 'sync:get-storage-breakdown',
  GET_LARGE_NOTES: 'sync:get-large-notes',
  GET_QUARANTINED_ITEMS: 'sync:get-quarantined-items',
  CHECK_DEVICE_STATUS: 'sync:check-device-status',
  EMERGENCY_WIPE: 'sync:emergency-wipe'
} as const

// ============================================================================
// Types
// ============================================================================

export type SyncStatusValue = 'idle' | 'syncing' | 'offline' | 'error' | 'local_only'

export type SyncErrorCategory =
  | 'network_offline'
  | 'network_timeout'
  | 'server_error'
  | 'auth_expired'
  | 'device_revoked'
  | 'rate_limited'
  | 'crypto_failure'
  | 'version_incompatible'
  | 'storage_quota_exceeded'
  // One file is over the plan's per-file limit — distinct from being out of
  // storage, and not fixable by freeing space.
  | 'file_too_large'
  // One note's sync payload is over the server's per-request body limit —
  // a payload problem, not an account-storage problem.
  | 'note_too_large'
  | 'sync_payment_required'
  | 'certificate_pin_failed'
  | 'unknown'

export interface GetSyncStatusResult {
  status: SyncStatusValue
  lastSyncAt?: number
  pendingCount: number
  error?: string
  errorCategory?: SyncErrorCategory
  offlineSince?: number
}

export interface TriggerSyncResult {
  success: boolean
  error?: string
}

export interface GetHistoryInput {
  limit?: number
  offset?: number
}

export interface SyncHistoryEntry {
  id: string
  type: 'push' | 'pull' | 'error'
  itemCount: number
  direction?: string
  details?: Record<string, unknown>
  durationMs?: number
  createdAt: number
}

export interface GetHistoryResult {
  entries: SyncHistoryEntry[]
  total: number
}

export interface GetQueueSizeResult {
  pending: number
  failed: number
}

export interface PauseSyncResult {
  success: boolean
  wasPaused: boolean
}

export interface ResumeSyncResult {
  success: boolean
  pendingCount: number
}

export interface UpdateSyncedSettingInput {
  fieldPath: string
  value: unknown
}

export interface UpdateSyncedSettingResult {
  success: boolean
  error?: string
}

export interface StorageBreakdownResult {
  used: number
  limit: number
  breakdown: {
    notes: number
    attachments: number
    crdt: number
    other: number
  }
}

/**
 * A note at or over the per-note sync ceiling. The storage breakdown answers
 * "how much am I using"; this answers "which note is about to stop syncing",
 * which the four aggregate categories cannot express.
 */
export interface LargeNoteEntry {
  id: string
  title: string
  path: string
  sizeBytes: number
  /** `over` has already stopped syncing; `approaching` still syncs. */
  status: 'approaching' | 'over'
}

export interface LargeNotesResult {
  /** Largest note the sync path accepts, so the renderer need not restate it. */
  maxBytes: number
  notes: LargeNoteEntry[]
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const GetHistorySchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional()
})

export const UpdateSyncedSettingSchema = z.object({
  fieldPath: z.string().min(1),
  value: z.unknown()
})

// ============================================================================
// Type Inference
// ============================================================================

export type GetHistorySchemaInput = z.infer<typeof GetHistorySchema>
