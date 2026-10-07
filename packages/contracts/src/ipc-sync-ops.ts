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
  GET_NOTE_SYNC_STATE: 'sync:get-note-sync-state',
  GET_UNSENT_NOTES: 'sync:get-unsent-notes',
  GET_QUARANTINED_ITEMS: 'sync:get-quarantined-items',
  CHECK_DEVICE_STATUS: 'sync:check-device-status',
  EMERGENCY_WIPE: 'sync:emergency-wipe',
  GET_VAULT_BINDING: 'sync:get-vault-binding',
  RESOLVE_VAULT_BINDING: 'sync:resolve-vault-binding'
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
  // The plan is ACTIVE and a limit inside it was hit: this vault is one more
  // than the plan syncs. Also an HTTP 402, and the exact opposite of
  // `sync_payment_required` — reporting it as a billing failure tells a paying
  // user to pay again (docs/protocol/11-client-policy.md §11.7.1).
  | 'sync_vault_limit_exceeded'
  | 'certificate_pin_failed'
  // This device's keychain signing key is not the key its device id is
  // registered under, so the server rejects every signature it produces
  // (SYNC_INVALID_SIGNATURE) and no retry can ever succeed. Only
  // re-registration fixes it.
  | 'device_key_mismatch'
  // The refresh token or vault master key exists on this device but could not
  // be read from the OS keychain / safeStorage this run (locked keyring, Secret
  // Service not up yet). Sync is paused and retries; nothing was signed out.
  | 'keychain_unavailable'
  | 'unknown'

export interface GetSyncStatusResult {
  status: SyncStatusValue
  lastSyncAt?: number
  pendingCount: number
  error?: string
  errorCategory?: SyncErrorCategory
  offlineSince?: number
}

/**
 * Whether the open vault syncs with the signed-in account.
 * - `bound`: it does (or no gate applies: signed out, free plan, no vault).
 * - `local-only`: this account chose to keep it on this device.
 * - `foreign`: another account synced it; it never syncs with this one.
 * - `needs-decision`: it has local content the account does not know yet;
 *   sync waits for the user.
 * - `unknown`: the account's vault list could not be fetched; retried.
 */
export type VaultBindingState =
  | { status: 'bound' }
  | { status: 'local-only' }
  | { status: 'foreign' }
  | { status: 'unknown' }
  | {
      status: 'needs-decision'
      accountVaultCount: number
      /** The account vault a merge would join; null when the account has none. */
      mergeTarget: { vaultUuid: string; name: string | null } | null
    }

/**
 * - `sync`: add this vault to the account as its own vault.
 * - `merge`: join the account's existing vault (`mergeTarget`).
 * - `local`: keep it on this device; do not ask again for this account.
 */
export type VaultBindingChoice = 'sync' | 'merge' | 'local'

export interface ResolveVaultBindingResult {
  success: boolean
  state: VaultBindingState
  error?: string
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

/**
 * Where a note's body stands with the server (#2647).
 *
 * - `not_syncing`: this install does not sync (signed out, free plan, no runtime).
 * - `local_only`: the note is marked local-only and never leaves the device.
 * - `pending`: changes are waiting on this device.
 * - `sent`: a body push is out and the server has not answered it yet.
 * - `confirmed`: nothing is waiting, and the server stored the last body push
 *   at `bodyConfirmedAt`.
 * - `not_recorded`: nothing is waiting, but no body push of this note has been
 *   confirmed since this device started recording them. Notes untouched since
 *   the update read this way until their next edit.
 * - `rejected`: the server refused the latest body push for good; those changes
 *   were not stored.
 *
 * Only the server storing a body push or a whole-doc snapshot confirms a body.
 * A record push the server calls a replay never does.
 */
export type NoteSyncStateValue =
  'not_syncing' | 'local_only' | 'pending' | 'sent' | 'confirmed' | 'not_recorded' | 'rejected'

/** Times are epoch milliseconds. */
export interface NoteSyncState {
  state: NoteSyncStateValue
  /** Oldest change still waiting on this device. */
  waitingSince: number | null
  lastSentAt: number | null
  bodyConfirmedAt: number | null
  /** Latest body push that failed and will be retried. */
  lastFailedAt: number | null
  lastRejectedAt: number | null
}

/**
 * Why a note is in the unsent list:
 * - `body`: CRDT body updates are queued.
 * - `record`: title, tags, properties or another record field are queued.
 * - `file_not_taken`: the file holds text the note's synced body has not taken
 *   yet, including notes found at the first launch after #2646.
 * - `rejected`: the server refused the latest body push.
 */
export type UnsentNoteReason = 'body' | 'record' | 'file_not_taken' | 'rejected'

export interface UnsentNoteEntry {
  id: string
  title: string
  path: string
  state: NoteSyncStateValue
  waitingSince: number | null
  reasons: UnsentNoteReason[]
}

export interface UnsentNotesResult {
  /** Every note with unsent changes, even past the listed ones. */
  total: number
  notes: UnsentNoteEntry[]
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const GetHistorySchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional()
})

export const GetNoteSyncStateSchema = z.object({
  noteId: z.string().min(1)
})

export const ResolveVaultBindingSchema = z.object({
  choice: z.enum(['sync', 'merge', 'local'])
})

export const UpdateSyncedSettingSchema = z.object({
  fieldPath: z.string().min(1),
  value: z.unknown()
})

// ============================================================================
// Type Inference
// ============================================================================

export type GetHistorySchemaInput = z.infer<typeof GetHistorySchema>
