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
  GET_STORAGE_BREAKDOWN: 'sync:get-storage-breakdown'
} as const

// ============================================================================
// Types
// ============================================================================

export type SyncStatusValue = 'idle' | 'syncing' | 'offline' | 'error'

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
