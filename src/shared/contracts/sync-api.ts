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
  'journal'
] as const

export const SYNC_OPERATIONS = ['create', 'update', 'delete'] as const

export const ENCRYPTABLE_ITEM_TYPES = [
  'note',
  'task',
  'project',
  'settings',
  'inbox',
  'filter',
  'journal'
] as const
export type EncryptableItemType = (typeof ENCRYPTABLE_ITEM_TYPES)[number]

// ============================================================================
// Types
// ============================================================================

export type SyncItemType = (typeof SYNC_ITEM_TYPES)[number]
export type SyncOperation = (typeof SYNC_OPERATIONS)[number]

export type VectorClock = Record<string, number>

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

export interface SyncStatus {
  connected: boolean
  lastSyncAt?: number
  pendingItems: number
  serverTime: number
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

export const PushItemSchema = z.object({
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

export const PushRequestSchema = z.object({
  items: z.array(PushItemSchema).min(1).max(100)
})

export const PushResponseSchema = z.object({
  accepted: z.array(z.string().min(1)),
  rejected: z.array(
    z.object({
      id: z.string().min(1),
      reason: z.string()
    })
  ),
  serverTime: z.number().int().min(0)
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

export const SyncManifestSchema = z.object({
  items: z.array(SyncItemRefSchema),
  serverTime: z.number().int().min(0)
})

export const ChangesResponseSchema = z.object({
  items: z.array(SyncItemRefSchema),
  deleted: z.array(z.string().min(1)),
  hasMore: z.boolean(),
  nextCursor: z.number().int().min(0)
})

export const SyncStatusSchema = z.object({
  connected: z.boolean(),
  lastSyncAt: z.number().int().min(0).optional(),
  pendingItems: z.number().int().min(0),
  serverTime: z.number().int().min(0)
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

export const PullResponseSchema = z.object({
  items: z.array(PullItemResponseSchema)
})

export type PullItemResponse = z.infer<typeof PullItemResponseSchema>

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
export type PushResponseInput = z.infer<typeof PushResponseSchema>
export type SyncItemRefInput = z.infer<typeof SyncItemRefSchema>
export type SyncManifestInput = z.infer<typeof SyncManifestSchema>
export type ChangesResponseInput = z.infer<typeof ChangesResponseSchema>
export type SyncStatusInput = z.infer<typeof SyncStatusSchema>
export type ConflictResponseInput = z.infer<typeof ConflictResponseSchema>
export type DeviceSyncStateInput = z.infer<typeof DeviceSyncStateSchema>
export type PullRequestInput = z.infer<typeof PullRequestSchema>
export type CursorPositionInput = z.infer<typeof CursorPositionSchema>
export type SignatureMetadataInput = z.infer<typeof SignatureMetadataSchema>
