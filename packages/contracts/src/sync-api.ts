import { z } from 'zod'

// ============================================================================
// Constants
// ============================================================================

export const SYNC_ITEM_TYPES = [
  'note',
  'task',
  'project',
  'settings',
  'attachment',
  'inbox',
  'filter',
  'journal',
  'tag_definition',
  'tag_category',
  'folder_config',
  'custom_icon',
  'calendar_event',
  'calendar_source',
  'calendar_binding',
  'calendar_external_event',
  'agent_conversation',
  'agent_message',
  'canvas',
  'canvas_folder',
  'bookmark',
  'reminder',
  'template',
  'task_activity',
  'home_page'
] as const

export const RECORD_SYNC_ITEM_TYPES = [
  'note',
  'task',
  'project',
  'settings',
  'inbox',
  'filter',
  'journal',
  'tag_definition',
  'tag_category',
  'folder_config',
  'custom_icon',
  'calendar_event',
  'calendar_source',
  'calendar_binding',
  'calendar_external_event',
  'agent_conversation',
  'agent_message',
  'canvas',
  'canvas_folder',
  'bookmark',
  'reminder',
  'template',
  'task_activity',
  'home_page'
] as const

export const RECORD_CLOCK_REQUIRED_ITEM_TYPES = [
  'note',
  'task',
  'project',
  'inbox',
  'filter',
  'journal',
  'tag_definition',
  'tag_category',
  'folder_config',
  'custom_icon',
  'calendar_event',
  'calendar_source',
  'calendar_binding',
  'calendar_external_event',
  'agent_conversation',
  'agent_message',
  'canvas',
  'canvas_folder',
  'bookmark',
  'reminder',
  'template',
  'task_activity',
  'home_page'
] as const

export const CRDT_SYNC_ITEM_TYPES = ['note'] as const

/**
 * The record sync item types understood by every client shipped BEFORE
 * per-request sync-type negotiation existed.
 *
 * FROZEN — never add to this list, not even when adding a new sync item type.
 *
 * A pre-negotiation binary sends no `X-Memry-Sync-Types` header, so the server
 * serves it exactly these types. Without this, a newer item type reaches a
 * binary whose `z.enum(RECORD_SYNC_ITEM_TYPES)` rejects it, which fails the
 * whole-page `RecordPullResponseSchema.safeParse` and silently drops a page of
 * notes and tasks while the device cursor advances past them.
 */
export const LEGACY_RECORD_SYNC_ITEM_TYPES = [
  'note',
  'task',
  'project',
  'settings',
  'inbox',
  'filter',
  'journal',
  'tag_definition',
  'folder_config',
  'calendar_event',
  'calendar_source',
  'calendar_binding',
  'calendar_external_event',
  'agent_conversation',
  'agent_message'
] as const

export type LegacyRecordSyncItemType = (typeof LEGACY_RECORD_SYNC_ITEM_TYPES)[number]

export const SYNC_OPERATIONS = ['create', 'update', 'delete'] as const

export const ENCRYPTABLE_ITEM_TYPES = [
  'note',
  'task',
  'project',
  'settings',
  'inbox',
  'filter',
  'journal',
  'tag_definition',
  'tag_category',
  'folder_config',
  'custom_icon',
  'calendar_event',
  'calendar_source',
  'calendar_binding',
  'calendar_external_event',
  'agent_conversation',
  'agent_message',
  'canvas',
  'canvas_folder',
  'bookmark',
  'reminder',
  'template',
  'task_activity',
  'home_page'
] as const
export type EncryptableItemType = (typeof ENCRYPTABLE_ITEM_TYPES)[number]

// ============================================================================
// Types
// ============================================================================

export type SyncItemType = (typeof SYNC_ITEM_TYPES)[number]
export type RecordSyncItemType = (typeof RECORD_SYNC_ITEM_TYPES)[number]
export type RecordClockRequiredItemType = (typeof RECORD_CLOCK_REQUIRED_ITEM_TYPES)[number]
export type CrdtSyncItemType = (typeof CRDT_SYNC_ITEM_TYPES)[number]
export type SyncOperation = (typeof SYNC_OPERATIONS)[number]

/**
 * Logical clock ticks keyed by device id.
 * `_offline` is a reserved pseudo-device key used for offline-local edits
 * before ticks are rebound to a concrete device id.
 */
export type VectorClock = Record<string, number>
export type FieldClocks = Record<string, VectorClock>
export const OFFLINE_CLOCK_DEVICE_ID = '_offline' as const

export interface SyncItem {
  id: string
  userId: string
  itemType: SyncItemType
  itemId: string
  blobKey: string
  sizeBytes: number
  contentHash: string
  version: number
  cryptoVersion: number
  serverCursor: number
  signerDeviceId: string
  signature: string
  stateVector?: string
  clock?: VectorClock
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

export interface EncryptedItemPayload {
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
}

export interface SyncQueueItem {
  id: string
  type: SyncItemType
  itemId: string
  operation: SyncOperation
  payload: string
  priority: number
  attempts: number
  lastAttempt?: number
  errorMessage?: string
  createdAt: number
}

export interface PushItem {
  id: string
  type: SyncItemType
  operation: SyncOperation
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  signerDeviceId: string
  clock?: VectorClock
  stateVector?: string
  deletedAt?: number
}

export interface PushRequest {
  items: PushItem[]
}

export interface PushResponse {
  accepted: string[]
  rejected: Array<{ id: string; reason: string }>
  serverTime: number
  maxCursor: number
}

export interface SyncItemRef {
  id: string
  type: SyncItemType
  version: number
  modifiedAt: number
  size: number
  stateVector?: string
}

export interface SyncManifest {
  items: SyncItemRef[]
  serverTime: number
}

export interface ChangesResponse {
  items: SyncItemRef[]
  deleted: string[]
  hasMore: boolean
  nextCursor: number
}

/** Platforms the server can hold a write policy for (sync protocol §1). */
export const CLIENT_PLATFORMS = ['ios', 'android', 'desktop'] as const
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number]

/**
 * The calling platform's current write policy, echoed on sync status so a
 * client learns about a flipped kill switch or a raised version floor WITHOUT
 * having to attempt a write and be rejected.
 *
 * Optional and only present when the request identified itself with
 * `x-memry-client`; a legacy desktop client sees the exact response it always
 * has.
 */
export interface ClientPolicy {
  platform: ClientPlatform
  writesEnabled: boolean
  minWriteVersion?: string
}

export interface SyncStatus {
  connected: boolean
  lastSyncAt?: number
  pendingItems: number
  serverTime: number
  clientPolicy?: ClientPolicy
}

export interface ConflictResponse {
  conflicts: Array<{
    id: string
    localClock: VectorClock
    serverClock: VectorClock
    serverVersion: EncryptedItemPayload
  }>
}

export interface DeviceSyncState {
  deviceId: string
  lastCursorSeen: number
  updatedAt: number
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const VectorClockSchema = z.record(z.string(), z.number().int().nonnegative())
export const FieldClocksSchema = z.record(z.string(), VectorClockSchema)

export const EncryptedItemPayloadSchema = z.object({
  encryptedKey: z.string().min(1),
  keyNonce: z.string().min(1),
  encryptedData: z.string().min(1),
  dataNonce: z.string().min(1)
})

export const SyncItemSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1),
  itemType: z.enum(SYNC_ITEM_TYPES),
  itemId: z.string().min(1),
  blobKey: z.string().min(1),
  sizeBytes: z.number().int().min(0),
  contentHash: z.string().min(1),
  version: z.number().int().min(1).default(1),
  cryptoVersion: z.number().int().min(1).default(1),
  serverCursor: z.number().int().min(0),
  signerDeviceId: z.string().min(1),
  signature: z.string().min(1),
  stateVector: z.string().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  deletedAt: z.number().int().min(0).optional()
})

export const SyncQueueItemSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(SYNC_ITEM_TYPES),
  itemId: z.string().min(1),
  operation: z.enum(SYNC_OPERATIONS),
  payload: z.string().min(1),
  priority: z.number().int().min(0).default(0),
  attempts: z.number().int().min(0).default(0),
  lastAttempt: z.number().int().min(0).optional(),
  errorMessage: z.string().optional(),
  createdAt: z.number().int().min(0)
})

const PushItemBaseSchema = z.object({
  id: z.string().min(1),
  type: z.enum(SYNC_ITEM_TYPES),
  operation: z.enum(SYNC_OPERATIONS),
  encryptedKey: z.string().min(1),
  keyNonce: z.string().min(1),
  encryptedData: z.string().min(1),
  dataNonce: z.string().min(1),
  signature: z.string().min(1),
  signerDeviceId: z.string().min(1),
  clock: VectorClockSchema.optional(),
  stateVector: z.string().optional(),
  deletedAt: z.number().int().min(0).optional()
})

const recordClockRequiredItemTypeSet = new Set<RecordSyncItemType>(RECORD_CLOCK_REQUIRED_ITEM_TYPES)

export const PushItemSchema = PushItemBaseSchema

export const PushRequestSchema = z.object({
  items: z.array(PushItemSchema).min(1).max(100)
})

export const RecordPushItemSchema = PushItemBaseSchema.omit({ type: true, stateVector: true })
  .extend({
    type: z.enum(RECORD_SYNC_ITEM_TYPES)
  })
  .superRefine((item, ctx) => {
    if (recordClockRequiredItemTypeSet.has(item.type) && item.clock === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clock'],
        message: `Record sync item type "${item.type}" requires clock metadata`
      })
    }
  })

export const RecordPushRequestSchema = z.object({
  items: z.array(RecordPushItemSchema).min(1).max(100)
})

export const PushResponseSchema = z.object({
  accepted: z.array(z.string().min(1)),
  rejected: z.array(
    z.object({
      id: z.string().min(1),
      reason: z.string()
    })
  ),
  serverTime: z.number().int().min(0),
  maxCursor: z.number().int().min(0)
})

export const PullRequestSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1).max(100)
})

export const SyncItemRefSchema = z.object({
  id: z.string().min(1),
  type: z.enum(SYNC_ITEM_TYPES),
  version: z.number().int().min(1),
  modifiedAt: z.number().int().min(0),
  size: z.number().int().min(0),
  stateVector: z.string().optional()
})

export const RecordSyncItemRefSchema = SyncItemRefSchema.omit({
  type: true,
  stateVector: true
}).extend({
  type: z.enum(RECORD_SYNC_ITEM_TYPES)
})

export const SyncManifestSchema = z.object({
  items: z.array(SyncItemRefSchema),
  serverTime: z.number().int().min(0)
})

export const RecordSyncManifestSchema = z.object({
  items: z.array(RecordSyncItemRefSchema),
  serverTime: z.number().int().min(0),
  /**
   * Present only on a paginated response (`GET /sync/manifest?limit=N`) that
   * has more rows: pass it back as `cursor` to fetch the next page. Absent on
   * the final page and on every param-less (legacy, everything-at-once) call.
   */
  nextCursor: z.number().int().min(0).optional()
})

export const ChangesResponseSchema = z.object({
  items: z.array(SyncItemRefSchema),
  deleted: z.array(z.string().min(1)),
  hasMore: z.boolean(),
  nextCursor: z.number().int().min(0)
})

export const RecordChangesResponseSchema = z.object({
  items: z.array(RecordSyncItemRefSchema),
  deleted: z.array(z.string().min(1)),
  hasMore: z.boolean(),
  nextCursor: z.number().int().min(0)
})

export const ClientPlatformSchema = z.enum(CLIENT_PLATFORMS)

export const ClientPolicySchema = z.object({
  platform: ClientPlatformSchema,
  writesEnabled: z.boolean(),
  minWriteVersion: z.string().min(1).optional()
})

export const SyncStatusSchema = z.object({
  connected: z.boolean(),
  lastSyncAt: z.number().int().min(0).optional(),
  pendingItems: z.number().int().min(0),
  serverTime: z.number().int().min(0),
  clientPolicy: ClientPolicySchema.optional()
})

export const ConflictResponseSchema = z.object({
  conflicts: z.array(
    z.object({
      id: z.string().min(1),
      localClock: VectorClockSchema,
      serverClock: VectorClockSchema,
      serverVersion: EncryptedItemPayloadSchema
    })
  )
})

export const DeviceSyncStateSchema = z.object({
  deviceId: z.string().min(1),
  lastCursorSeen: z.number().int().min(0),
  updatedAt: z.number().int().min(0)
})

// ============================================================================
// Pack Compaction — derived cache bootstrap (#1839)
// ============================================================================

/**
 * What a pack file compacts. `record` packs hold sync-item payload blobs and
 * their min/max are server_cursor values; `crdt_snapshot` packs hold note-body
 * snapshots and their min/max are created_at epoch-second bounds.
 * `crdt_update` is reserved: updates live in D1 today and have no R2
 * small-object GET floor to kill.
 */
export const PACK_KINDS = ['record', 'crdt_snapshot', 'crdt_update'] as const

export const PackKindSchema = z.enum(PACK_KINDS)

/**
 * One pack in `GET /sync/packs`. A pack is an immutable, versioned byte-concat
 * of encrypted blobs + a trailing index block (see the server's pack-format
 * module for the exact layout); the server never decrypts any of it.
 *
 * `url` is a presigned GET valid for minutes (expiresAt, epoch seconds) and is
 * present only when the deployment opted into presigned transfers (#1836);
 * absent means "use the item-granular endpoints".
 *
 * Tail semantics: packs cover the cursor ranges they advertise. Everything
 * above the highest covered point stays item-granular, and holes inside a
 * range (replaced/deleted items are dead bytes) fall back to item GETs —
 * membership is verified against the pack's own index block, never assumed.
 */
export const PackSummarySchema = z.object({
  id: z.string().min(1),
  itemKind: PackKindSchema,
  packKey: z.string().min(1),
  minCursor: z.number().int().min(0),
  maxCursor: z.number().int().min(0),
  itemCount: z.number().int().min(0),
  byteSize: z.number().int().min(1),
  createdAt: z.number().int().min(0),
  url: z.string().url().optional(),
  /** Epoch seconds at which `url` stops working; mirrors the presign TTL. */
  expiresAt: z.number().int().min(0).optional()
})

export const PackListResponseSchema = z.object({
  packs: z.array(PackSummarySchema),
  serverTime: z.number().int().min(0),
  /**
   * Opaque keyset token (max_cursor + row id of the last returned pack).
   * Pass back as `cursor` on GET /sync/packs to fetch the next (older) page;
   * absent on the final page. Packs arrive newest-first (max_cursor DESC).
   */
  nextCursor: z.string().min(1).optional()
})

export type PackKind = z.infer<typeof PackKindSchema>
export type PackSummary = z.infer<typeof PackSummarySchema>
export type PackListResponse = z.infer<typeof PackListResponseSchema>

// ============================================================================
// Pull Response (validated client-side)
// ============================================================================

export const PullItemResponseSchema = z.object({
  id: z.string().min(1),
  type: z.enum(SYNC_ITEM_TYPES),
  operation: z.enum(SYNC_OPERATIONS),
  cryptoVersion: z.number().int().min(1).optional(),
  signature: z.string().min(1),
  signerDeviceId: z.string().min(1),
  deletedAt: z.number().int().min(0).optional(),
  clock: VectorClockSchema.optional(),
  stateVector: z.string().optional(),
  blob: EncryptedItemPayloadSchema
})

export const RecordPullItemResponseSchema = PullItemResponseSchema.omit({
  type: true,
  stateVector: true
}).extend({
  type: z.enum(RECORD_SYNC_ITEM_TYPES)
})

export const PullResponseSchema = z.object({
  items: z.array(PullItemResponseSchema)
})

export type PullItemResponse = z.infer<typeof PullItemResponseSchema>

export const RecordPullResponseSchema = z.object({
  items: z.array(RecordPullItemResponseSchema)
})

export type RecordPullItemResponse = z.infer<typeof RecordPullItemResponseSchema>
export type RecordPullResponse = z.infer<typeof RecordPullResponseSchema>

// ============================================================================
// Device Keys (key distribution for multi-device signature verification)
// ============================================================================

export const DeviceKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  signingPublicKey: z.string(),
  revokedAt: z.number().nullable()
})

export const DeviceKeysResponseSchema = z.object({
  devices: z.array(DeviceKeySchema)
})

export type DeviceKeysResponse = z.infer<typeof DeviceKeysResponseSchema>

// ============================================================================
// Cursor & Signature Metadata (T041g)
// ============================================================================

export interface CursorPosition {
  cursor: number
  deviceId: string
  updatedAt: number
}

export interface SignatureMetadata {
  signerDeviceId: string
  signerPublicKey: string
  signedAt: number
  algorithm: 'ed25519'
}

export const CursorPositionSchema = z.object({
  cursor: z.number().int().min(0),
  deviceId: z.string().min(1),
  updatedAt: z.number().int().min(0)
})

export const SignatureMetadataSchema = z.object({
  signerDeviceId: z.string().min(1),
  signerPublicKey: z.string().min(1),
  signedAt: z.number().int().min(0),
  algorithm: z.literal('ed25519')
})

// ============================================================================
// Type Inference
// ============================================================================

export type SyncItemInput = z.infer<typeof SyncItemSchema>
export type EncryptedItemPayloadInput = z.infer<typeof EncryptedItemPayloadSchema>
export type SyncQueueItemInput = z.infer<typeof SyncQueueItemSchema>
export type PushItemInput = z.infer<typeof PushItemSchema>
export type PushRequestInput = z.infer<typeof PushRequestSchema>
export type RecordPushItemInput = z.infer<typeof RecordPushItemSchema>
export type RecordPushRequestInput = z.infer<typeof RecordPushRequestSchema>
export type PushResponseInput = z.infer<typeof PushResponseSchema>
export type SyncItemRefInput = z.infer<typeof SyncItemRefSchema>
export type RecordSyncItemRefInput = z.infer<typeof RecordSyncItemRefSchema>
export type SyncManifestInput = z.infer<typeof SyncManifestSchema>
export type RecordSyncManifest = z.infer<typeof RecordSyncManifestSchema>
export type ChangesResponseInput = z.infer<typeof ChangesResponseSchema>
export type RecordChangesResponse = z.infer<typeof RecordChangesResponseSchema>
export type SyncStatusInput = z.infer<typeof SyncStatusSchema>
export type ConflictResponseInput = z.infer<typeof ConflictResponseSchema>
export type DeviceSyncStateInput = z.infer<typeof DeviceSyncStateSchema>
export type PullRequestInput = z.infer<typeof PullRequestSchema>
export type CursorPositionInput = z.infer<typeof CursorPositionSchema>
export type SignatureMetadataInput = z.infer<typeof SignatureMetadataSchema>
