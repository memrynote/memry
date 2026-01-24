/**
 * Sync API Contracts
 *
 * Defines all types and schemas for the sync engine communication
 * between client and server.
 */

import { z } from 'zod'

// =============================================================================
// Constants
// =============================================================================

export const SYNC_ITEM_TYPES = [
  'task',
  'note',
  'inbox',
  'filter',
  'project',
  'settings',
  'journal'
] as const
export type SyncItemType = (typeof SYNC_ITEM_TYPES)[number]

export const SYNC_OPERATIONS = ['create', 'update', 'delete'] as const
export type SyncOperation = (typeof SYNC_OPERATIONS)[number]

export const SYNC_STATUS = ['idle', 'syncing', 'offline', 'error', 'paused'] as const
export type SyncStatus = (typeof SYNC_STATUS)[number]

export const DEVICE_PLATFORMS = ['macos', 'windows', 'linux', 'ios', 'android'] as const
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number]

export const AUTH_METHODS = ['email', 'oauth'] as const
export type AuthMethod = (typeof AUTH_METHODS)[number]

export const AUTH_PROVIDERS = ['google'] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]

export const LINKING_SESSION_STATUS = [
  'pending',
  'scanned',
  'approved',
  'completed',
  'expired'
] as const
export type LinkingSessionStatus = (typeof LINKING_SESSION_STATUS)[number]

// =============================================================================
// Zod Schemas
// =============================================================================

// Vector Clock Schema
export const VectorClockSchema = z.record(z.string(), z.number().int().nonnegative())
export type VectorClock = z.infer<typeof VectorClockSchema>

// Field-level vector clocks (used for settings merge)
export const FieldClocksSchema = z.record(z.string(), VectorClockSchema)
export type FieldClocks = z.infer<typeof FieldClocksSchema>

// Base64 string validation (simple check for valid base64 chars)
const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Invalid Base64 string')

// UUID validation
const UuidSchema = z.string().uuid()

// Sync Item Schema (canonical fields for server storage)
export const SyncItemSchema = z.object({
  item_type: z.enum(SYNC_ITEM_TYPES),
  item_id: UuidSchema,
  user_id: UuidSchema,
  encrypted_data: z.instanceof(Uint8Array).or(Base64Schema),
  encrypted_key: z.instanceof(Uint8Array).or(Base64Schema),
  key_nonce: z.instanceof(Uint8Array).or(Base64Schema),
  data_nonce: z.instanceof(Uint8Array).or(Base64Schema),
  // Vector clock for non-CRDT items (JSON string) - optional
  clock: z.string().optional(),
  // State vector for CRDT items (Base64 Yjs state vector) - optional
  state_vector: z.string().optional(),
  deleted: z.boolean(),
  crypto_version: z.number().int().positive(),
  size_bytes: z.number().int().nonnegative(),
  content_hash: z.string().length(64), // SHA-256 hex
  signer_device_id: UuidSchema,
  signature: z.instanceof(Uint8Array).or(Base64Schema),
  server_cursor: z.number().int().nonnegative(),
  created_at: z.number().int().positive(),
  updated_at: z.number().int().positive()
})

export type SyncItem = z.infer<typeof SyncItemSchema>

// Sync Item for client push requests (excludes server-managed fields)
// Used when clients push items to the server
export const SyncItemPushSchema = z.object({
  itemType: z.enum(SYNC_ITEM_TYPES),
  itemId: UuidSchema,
  encryptedData: Base64Schema,
  encryptedKey: Base64Schema,
  keyNonce: Base64Schema,
  dataNonce: Base64Schema,
  // Vector clock for non-CRDT items (tasks, projects, settings, etc.)
  clock: VectorClockSchema.optional(),
  // Field-level clocks for settings
  fieldClocks: FieldClocksSchema.optional(),
  // State vector for CRDT items (notes) - Yjs state vector
  stateVector: Base64Schema.optional(),
  deleted: z.boolean(),
  cryptoVersion: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  contentHash: z.string(),
  signerDeviceId: UuidSchema,
  signature: Base64Schema
})

export type SyncItemPush = z.infer<typeof SyncItemPushSchema>

// Sync Item for API responses (includes server-managed fields)
// Used when server returns items to clients
export const SyncItemResponseSchema = z.object({
  itemType: z.enum(SYNC_ITEM_TYPES),
  itemId: UuidSchema,
  userId: UuidSchema,
  encryptedData: Base64Schema,
  encryptedKey: Base64Schema,
  keyNonce: Base64Schema,
  dataNonce: Base64Schema,
  // Vector clock for non-CRDT items (tasks, projects, settings, etc.)
  clock: VectorClockSchema.optional(),
  // Field-level clocks for settings
  fieldClocks: FieldClocksSchema.optional(),
  // State vector for CRDT items (notes) - Yjs state vector
  stateVector: Base64Schema.optional(),
  deleted: z.boolean(),
  cryptoVersion: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative(),
  contentHash: z.string(),
  signerDeviceId: UuidSchema,
  signature: Base64Schema,
  // Server-managed fields
  serverCursor: z.number().int().nonnegative(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive()
})

export type SyncItemResponse = z.infer<typeof SyncItemResponseSchema>

// =============================================================================
// User Types
// =============================================================================

export const UserSchema = z.object({
  id: UuidSchema,
  email: z.email().max(255),
  emailVerified: z.boolean(),
  authMethod: z.enum(AUTH_METHODS),
  authProvider: z.enum(AUTH_PROVIDERS).optional(),
  authProviderId: z.string().optional(),
  kdfSalt: Base64Schema.optional(), // Set after recovery phrase setup
  keyVerifier: Base64Schema.optional(), // Set after recovery phrase setup
  storageUsed: z.number().int().nonnegative(),
  storageLimit: z.number().int().positive(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive()
})

export type User = z.infer<typeof UserSchema>

// Client-safe user (excludes sensitive fields)
export const UserPublicSchema = UserSchema.omit({
  kdfSalt: true,
  keyVerifier: true,
  authProviderId: true
})

export type UserPublic = z.infer<typeof UserPublicSchema>

// =============================================================================
// Device Types
// =============================================================================

export const DeviceSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema.optional(), // Only on server
  name: z.string().min(1).max(100),
  platform: z.enum(DEVICE_PLATFORMS),
  osVersion: z.string().optional(),
  appVersion: z.string(),
  authPublicKey: Base64Schema, // Device signing public key (Ed25519)
  linkedAt: z.number().int().positive(),
  lastSyncAt: z.number().int().positive().optional(),
  isCurrentDevice: z.boolean().optional(), // Only on client
  revokedAt: z.number().int().positive().optional() // Only on server
})

export type Device = z.infer<typeof DeviceSchema>

// =============================================================================
// Linking Session Types
// =============================================================================

export const LinkingSessionSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  initiatorDeviceId: UuidSchema,
  ephemeralPublicKey: Base64Schema, // X25519 public key
  newDevicePublicKey: Base64Schema.optional(), // Set after scan
  newDeviceConfirm: Base64Schema.optional(), // HMAC proof
  encryptedMasterKey: Base64Schema.optional(), // Set after approval
  encryptedKeyNonce: Base64Schema.optional(),
  keyConfirm: Base64Schema.optional(), // Key confirmation
  status: z.enum(LINKING_SESSION_STATUS),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  completedAt: z.number().int().positive().optional()
})

export type LinkingSession = z.infer<typeof LinkingSessionSchema>

// QR Code payload for device linking
export const LinkingQRPayloadSchema = z.object({
  sessionId: UuidSchema,
  token: z.string().min(32),
  ephemeralPublicKey: Base64Schema,
  serverUrl: z.string().url()
})

export type LinkingQRPayload = z.infer<typeof LinkingQRPayloadSchema>

// =============================================================================
// Sync Queue Types (Local)
// =============================================================================

export const SyncQueueItemSchema = z.object({
  id: UuidSchema,
  type: z.enum([
    'note_update',
    'task',
    'project',
    'settings',
    'attachment',
    'inbox',
    'filter',
    'journal'
  ]),
  itemId: UuidSchema,
  operation: z.enum(SYNC_OPERATIONS),
  payload: z.string(), // Encrypted JSON (Base64)
  priority: z.number().int().default(0),
  attempts: z.number().int().nonnegative().default(0),
  lastAttempt: z.number().int().positive().optional(),
  errorMessage: z.string().optional(),
  createdAt: z.number().int().positive()
})

export type SyncQueueItem = z.infer<typeof SyncQueueItemSchema>

// =============================================================================
// Sync State Types
// =============================================================================

export const SyncStateSchema = z.object({
  lastSyncAt: z.number().int().positive().optional(),
  syncStatus: z.enum(SYNC_STATUS),
  pendingCount: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  serverCursor: z.number().int().nonnegative(),
  deviceClock: VectorClockSchema
})

export type SyncState = z.infer<typeof SyncStateSchema>

// =============================================================================
// Sync History Types
// =============================================================================

export const SyncHistoryEntrySchema = z.object({
  id: UuidSchema,
  type: z.enum(['push', 'pull', 'error']),
  itemCount: z.number().int().nonnegative(),
  direction: z.enum(['upload', 'download']).optional(),
  details: z
    .object({
      notes: z.number().int().nonnegative().optional(),
      tasks: z.number().int().nonnegative().optional(),
      attachments: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
      failedItems: z.array(z.string()).optional()
    })
    .optional(),
  durationMs: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().positive()
})

export type SyncHistoryEntry = z.infer<typeof SyncHistoryEntrySchema>

// =============================================================================
// Device Sync State (Server)
// =============================================================================

export const DeviceSyncStateSchema = z.object({
  deviceId: UuidSchema,
  lastCursorSeen: z.number().int().nonnegative(),
  updatedAt: z.number().int().positive()
})

export type DeviceSyncState = z.infer<typeof DeviceSyncStateSchema>

// =============================================================================
// API Request/Response Types
// =============================================================================

// Push items to server (uses SyncItemPushSchema - no server-managed fields)
export const PushSyncRequestSchema = z.object({
  items: z.array(SyncItemPushSchema),
  deviceClock: VectorClockSchema
})

export type PushSyncRequest = z.infer<typeof PushSyncRequestSchema>

export const PushSyncResponseSchema = z.object({
  accepted: z.array(UuidSchema),
  rejected: z.array(
    z.object({
      itemId: UuidSchema,
      reason: z.string()
    })
  ),
  conflicts: z.array(
    z.object({
      itemId: UuidSchema,
      serverItem: SyncItemResponseSchema
    })
  ),
  serverCursor: z.number().int().nonnegative()
})

export type PushSyncResponse = z.infer<typeof PushSyncResponseSchema>

// Pull items from server
export const PullSyncRequestSchema = z.object({
  cursor: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(100).default(50),
  types: z.array(z.enum(SYNC_ITEM_TYPES)).optional()
})

export type PullSyncRequest = z.infer<typeof PullSyncRequestSchema>

export const PullSyncResponseSchema = z.object({
  items: z.array(SyncItemResponseSchema),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nonnegative(),
  serverTime: z.number().int().positive()
})

export type PullSyncResponse = z.infer<typeof PullSyncResponseSchema>

// Sync status endpoint
export const SyncStatusResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'maintenance']),
  serverCursor: z.number().int().nonnegative(),
  pendingItems: z.number().int().nonnegative(),
  lastSyncAt: z.number().int().positive().optional(),
  storageUsed: z.number().int().nonnegative(),
  storageLimit: z.number().int().positive()
})

export type SyncStatusResponse = z.infer<typeof SyncStatusResponseSchema>

// =============================================================================
// Tombstone Policy
// =============================================================================

export const TOMBSTONE_POLICY = {
  // How long tombstones are kept after deletion (90 days)
  retentionPeriod: 90 * 24 * 60 * 60 * 1000,

  // Minimum sync window - tombstones younger than this are never purged (7 days)
  minRetention: 7 * 24 * 60 * 60 * 1000,

  // How often to run cleanup job (daily)
  cleanupInterval: 24 * 60 * 60 * 1000,

  // Batch size for cleanup operations
  cleanupBatchSize: 1000
} as const

// =============================================================================
// Synced Settings
// =============================================================================

export const SyncedSettingsSchema = z.object({
  general: z.object({
    defaultView: z.enum(['inbox', 'today', 'upcoming', 'all']),
    weekStartsOn: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6)
    ]),
    dateFormat: z.enum(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD']),
    timeFormat: z.enum(['12h', '24h']),
    language: z.string().min(2).max(5) // ISO 639-1 code
  }),

  tasks: z.object({
    defaultProject: z.string().uuid().nullable(),
    defaultPriority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    autoArchiveCompleted: z.boolean(),
    archiveAfterDays: z.number().int().positive()
  }),

  notes: z.object({
    defaultFolder: z.string(),
    autoSaveInterval: z.number().int().positive(),
    spellCheck: z.boolean()
  }),

  sync: z.object({
    autoSync: z.boolean(),
    syncOnStartup: z.boolean(),
    conflictResolution: z.enum(['local', 'remote', 'newest'])
  })
})

export type SyncedSettings = z.infer<typeof SyncedSettingsSchema>

export const SyncedSettingsPayloadSchema = z.object({
  settings: SyncedSettingsSchema,
  fieldClocks: FieldClocksSchema
})

export type SyncedSettingsPayload = z.infer<typeof SyncedSettingsPayloadSchema>

// =============================================================================
// OTP Types
// =============================================================================

export const OtpCodeSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  codeHash: z.string().length(64), // SHA-256 hash
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
  used: z.boolean()
})

export type OtpCode = z.infer<typeof OtpCodeSchema>

export const OTP_SECURITY = {
  // Code format: 6 digits
  codeLength: 6,
  codeMin: 0,
  codeMax: 999999,

  // Code expiry: 10 minutes
  expiryMs: 10 * 60 * 1000,

  // Max failed attempts per code
  maxAttempts: 5,

  // Rate limit: 3 requests per 10 minutes per email
  rateLimitRequests: 3,
  rateLimitWindowMs: 10 * 60 * 1000
} as const

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Validate a sync item response against the schema
 */
export function validateSyncItem(item: unknown): SyncItemResponse {
  return SyncItemResponseSchema.parse(item)
}

/**
 * Validate a sync item for push against the schema
 */
export function validateSyncItemPush(item: unknown): SyncItemPush {
  return SyncItemPushSchema.parse(item)
}

/**
 * Validate a push sync request
 */
export function validatePushRequest(request: unknown): PushSyncRequest {
  return PushSyncRequestSchema.parse(request)
}

/**
 * Validate a pull sync request
 */
export function validatePullRequest(request: unknown): PullSyncRequest {
  return PullSyncRequestSchema.parse(request)
}
