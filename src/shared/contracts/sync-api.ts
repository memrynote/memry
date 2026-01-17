/**
 * Sync API Types
 *
 * Shared types for sync operations between client and server.
 *
 * @module shared/contracts/sync-api
 */

import { z } from 'zod'

// =============================================================================
// Vector Clock Types
// =============================================================================

/**
 * Vector clock for tracking causality in distributed systems.
 * Maps device IDs to logical timestamps.
 */
export interface VectorClock {
  [deviceId: string]: number
}

/**
 * Zod schema for vector clock validation
 */
export const VectorClockSchema = z.record(z.string(), z.number())

// =============================================================================
// Sync Status Types
// =============================================================================

/**
 * Possible sync states
 */
export type SyncState = 'initializing' | 'idle' | 'syncing' | 'offline' | 'error'

/**
 * Sync status context with detailed information
 */
export interface SyncStatus {
  state: SyncState
  lastSyncAt?: number
  pendingCount: number
  errorMessage?: string
  retryCount: number
  isOnline: boolean
}

/**
 * Zod schema for sync status
 */
export const SyncStatusSchema = z.object({
  state: z.enum(['initializing', 'idle', 'syncing', 'offline', 'error']),
  lastSyncAt: z.number().optional(),
  pendingCount: z.number(),
  errorMessage: z.string().optional(),
  retryCount: z.number(),
  isOnline: z.boolean()
})

// =============================================================================
// Sync Item Types
// =============================================================================

/**
 * Types of items that can be synced
 */
export type SyncItemType =
  | 'note'
  | 'task'
  | 'project'
  | 'settings'
  | 'attachment'
  | 'inbox_item'
  | 'saved_filter'

/**
 * Sync operation types
 */
export type SyncOperation = 'create' | 'update' | 'delete'

/**
 * Base sync item metadata
 */
export interface SyncItemBase {
  id: string
  type: SyncItemType
  version: number
  createdAt: number
  modifiedAt: number
  deletedAt?: number
}

/**
 * Sync item with encrypted payload
 */
export interface SyncItem extends SyncItemBase {
  blobKey: string
  size: number
  stateVector?: string // For CRDT items (notes)
  clock?: VectorClock // For non-CRDT items
}

/**
 * Zod schema for sync item
 */
export const SyncItemSchema = z.object({
  id: z.string(),
  type: z.enum(['note', 'task', 'project', 'settings', 'attachment', 'inbox_item', 'saved_filter']),
  version: z.number(),
  createdAt: z.number(),
  modifiedAt: z.number(),
  deletedAt: z.number().optional(),
  blobKey: z.string(),
  size: z.number(),
  stateVector: z.string().optional(),
  clock: VectorClockSchema.optional()
})

// =============================================================================
// Sync Queue Types
// =============================================================================

/**
 * Status of a sync queue item
 */
export type SyncQueueStatus = 'pending' | 'in_progress' | 'failed'

/**
 * Item in the local sync queue
 */
export interface SyncQueueItem {
  id: string
  type: SyncItemType
  itemId: string
  operation: SyncOperation
  payload: string // Encrypted JSON (Base64)
  priority: number
  attempts: number
  lastAttempt?: number
  errorMessage?: string
  createdAt: number
  status: SyncQueueStatus
}

/**
 * Zod schema for sync queue item
 */
export const SyncQueueItemSchema = z.object({
  id: z.string(),
  type: z.enum(['note', 'task', 'project', 'settings', 'attachment', 'inbox_item', 'saved_filter']),
  itemId: z.string(),
  operation: z.enum(['create', 'update', 'delete']),
  payload: z.string(),
  priority: z.number(),
  attempts: z.number(),
  lastAttempt: z.number().optional(),
  errorMessage: z.string().optional(),
  createdAt: z.number(),
  status: z.enum(['pending', 'in_progress', 'failed'])
})

// =============================================================================
// Device Types
// =============================================================================

/**
 * Supported platforms
 */
export type DevicePlatform = 'macos' | 'windows' | 'linux' | 'ios' | 'android'

/**
 * Device information
 */
export interface Device {
  id: string
  name: string
  platform: DevicePlatform
  osVersion?: string
  appVersion: string
  linkedAt: number
  lastSyncAt?: number
  isCurrentDevice?: boolean
  revokedAt?: number
}

/**
 * Zod schema for device
 */
export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(['macos', 'windows', 'linux', 'ios', 'android']),
  osVersion: z.string().optional(),
  appVersion: z.string(),
  linkedAt: z.number(),
  lastSyncAt: z.number().optional(),
  isCurrentDevice: z.boolean().optional(),
  revokedAt: z.number().optional()
})

// =============================================================================
// Linking Session Types
// =============================================================================

/**
 * Linking session states
 */
export type LinkingSessionStatus = 'pending' | 'scanned' | 'approved' | 'completed' | 'expired'

/**
 * QR code payload for device linking
 */
export interface LinkingQRPayload {
  sessionId: string
  token: string
  ephemeralPublicKey: string // Base64
  expiresAt: number
}

/**
 * Zod schema for QR payload
 */
export const LinkingQRPayloadSchema = z.object({
  sessionId: z.string(),
  token: z.string(),
  ephemeralPublicKey: z.string(),
  expiresAt: z.number()
})

/**
 * Linking session data
 */
export interface LinkingSession {
  id: string
  status: LinkingSessionStatus
  createdAt: number
  expiresAt: number
  newDeviceName?: string
  newDevicePlatform?: DevicePlatform
}

/**
 * Zod schema for linking session
 */
export const LinkingSessionSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'scanned', 'approved', 'completed', 'expired']),
  createdAt: z.number(),
  expiresAt: z.number(),
  newDeviceName: z.string().optional(),
  newDevicePlatform: z.enum(['macos', 'windows', 'linux', 'ios', 'android']).optional()
})

// =============================================================================
// Push/Pull Types
// =============================================================================

/**
 * Request to push items to the server
 */
export interface SyncPushRequest {
  items: SyncPushItem[]
  deviceClock: VectorClock
}

/**
 * Individual item in a push request
 */
export interface SyncPushItem {
  id: string
  type: SyncItemType
  operation: SyncOperation
  encryptedData: string // Base64
  signature: string // Base64
  clock?: VectorClock
  stateVector?: string
}

/**
 * Zod schema for push request
 */
export const SyncPushRequestSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.enum([
        'note',
        'task',
        'project',
        'settings',
        'attachment',
        'inbox_item',
        'saved_filter'
      ]),
      operation: z.enum(['create', 'update', 'delete']),
      encryptedData: z.string(),
      signature: z.string(),
      clock: VectorClockSchema.optional(),
      stateVector: z.string().optional()
    })
  ),
  deviceClock: VectorClockSchema
})

/**
 * Response from push operation
 */
export interface SyncPushResponse {
  success: boolean
  accepted: string[] // Item IDs that were accepted
  conflicts: SyncConflict[] // Items with conflicts
  serverClock: VectorClock
}

/**
 * Conflict information for an item
 */
export interface SyncConflict {
  id: string
  type: SyncItemType
  serverVersion: number
  serverClock: VectorClock
}

/**
 * Zod schema for push response
 */
export const SyncPushResponseSchema = z.object({
  success: z.boolean(),
  accepted: z.array(z.string()),
  conflicts: z.array(
    z.object({
      id: z.string(),
      type: z.enum([
        'note',
        'task',
        'project',
        'settings',
        'attachment',
        'inbox_item',
        'saved_filter'
      ]),
      serverVersion: z.number(),
      serverClock: VectorClockSchema
    })
  ),
  serverClock: VectorClockSchema
})

/**
 * Request to pull items from the server
 */
export interface SyncPullRequest {
  since?: number // Timestamp for incremental sync
  types?: SyncItemType[] // Filter by type
  limit?: number
  deviceClock: VectorClock
}

/**
 * Zod schema for pull request
 */
export const SyncPullRequestSchema = z.object({
  since: z.number().optional(),
  types: z
    .array(
      z.enum(['note', 'task', 'project', 'settings', 'attachment', 'inbox_item', 'saved_filter'])
    )
    .optional(),
  limit: z.number().optional(),
  deviceClock: VectorClockSchema
})

/**
 * Response from pull operation
 */
export interface SyncPullResponse {
  items: SyncPullItem[]
  hasMore: boolean
  serverClock: VectorClock
  serverTimestamp: number
}

/**
 * Individual item in a pull response
 */
export interface SyncPullItem {
  id: string
  type: SyncItemType
  version: number
  operation?: SyncOperation // Optional for backwards compatibility with server
  encryptedData: string // Base64
  signature: string // Base64
  clock?: VectorClock
  stateVector?: string
  modifiedAt: number
  deletedAt?: number
}

/**
 * Zod schema for pull response
 */
export const SyncPullResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.enum([
        'note',
        'task',
        'project',
        'settings',
        'attachment',
        'inbox_item',
        'saved_filter'
      ]),
      version: z.number(),
      operation: z.enum(['create', 'update', 'delete']).optional(), // Optional for backwards compatibility
      encryptedData: z.string(),
      signature: z.string(),
      clock: VectorClockSchema.optional(),
      stateVector: z.string().optional(),
      modifiedAt: z.number(),
      deletedAt: z.number().optional()
    })
  ),
  hasMore: z.boolean(),
  serverClock: VectorClockSchema,
  serverTimestamp: z.number()
})

// =============================================================================
// Sync History Types
// =============================================================================

/**
 * Types of sync history entries
 */
export type SyncHistoryType = 'push' | 'pull' | 'error'

/**
 * Direction of sync operation
 */
export type SyncDirection = 'upload' | 'download'

/**
 * Sync history entry
 */
export interface SyncHistoryEntry {
  id: string
  type: SyncHistoryType
  itemCount: number
  direction?: SyncDirection
  details?: {
    notes?: number
    tasks?: number
    attachments?: number
    error?: string
    failedItems?: string[]
  }
  durationMs?: number
  createdAt: number
}

/**
 * Zod schema for sync history entry
 */
export const SyncHistoryEntrySchema = z.object({
  id: z.string(),
  type: z.enum(['push', 'pull', 'error']),
  itemCount: z.number(),
  direction: z.enum(['upload', 'download']).optional(),
  details: z
    .object({
      notes: z.number().optional(),
      tasks: z.number().optional(),
      attachments: z.number().optional(),
      error: z.string().optional(),
      failedItems: z.array(z.string()).optional()
    })
    .optional(),
  durationMs: z.number().optional(),
  createdAt: z.number()
})

// =============================================================================
// Synced Settings Types
// =============================================================================

/**
 * Settings that sync across devices
 */
export interface SyncedSettings {
  general: {
    defaultView: 'inbox' | 'today' | 'upcoming' | 'all'
    weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6
    dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD'
    timeFormat: '12h' | '24h'
    language: string
  }
  tasks: {
    defaultProject: string | null
    defaultPriority: 1 | 2 | 3 | 4
    autoArchiveCompleted: boolean
    archiveAfterDays: number
  }
  notes: {
    defaultFolder: string
    autoSaveInterval: number
    spellCheck: boolean
  }
  sync: {
    autoSync: boolean
    syncOnStartup: boolean
    conflictResolution: 'local' | 'remote' | 'newest'
  }
}

/**
 * Zod schema for synced settings
 */
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
    language: z.string()
  }),
  tasks: z.object({
    defaultProject: z.string().nullable(),
    defaultPriority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    autoArchiveCompleted: z.boolean(),
    archiveAfterDays: z.number()
  }),
  notes: z.object({
    defaultFolder: z.string(),
    autoSaveInterval: z.number(),
    spellCheck: z.boolean()
  }),
  sync: z.object({
    autoSync: z.boolean(),
    syncOnStartup: z.boolean(),
    conflictResolution: z.enum(['local', 'remote', 'newest'])
  })
})

// =============================================================================
// User Types (for auth)
// =============================================================================

/**
 * Authentication methods
 */
export type AuthMethod = 'email' | 'oauth'

/**
 * OAuth providers
 */
export type OAuthProvider = 'google'

/**
 * Public user information (safe to send to client)
 */
export interface UserPublic {
  id: string
  email: string
  emailVerified: boolean
  authMethod: AuthMethod
  authProvider?: OAuthProvider
  storageUsed: number
  storageLimit: number
  createdAt: number
}

/**
 * Zod schema for public user
 */
export const UserPublicSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  emailVerified: z.boolean(),
  authMethod: z.enum(['email', 'oauth']),
  authProvider: z.literal('google').optional(),
  storageUsed: z.number(),
  storageLimit: z.number(),
  createdAt: z.number()
})

// =============================================================================
// Auth Request/Response Types
// =============================================================================

/**
 * Email signup request
 */
export interface EmailSignupRequest {
  email: string
  password: string
  deviceName: string
  devicePlatform: DevicePlatform
}

/**
 * Zod schema for email signup
 */
export const EmailSignupRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(128),
  deviceName: z.string().min(1).max(100),
  devicePlatform: z.enum(['macos', 'windows', 'linux', 'ios', 'android'])
})

/**
 * Email login request
 */
export interface EmailLoginRequest {
  email: string
  password: string
  deviceName: string
  devicePlatform: DevicePlatform
}

/**
 * Zod schema for email login
 */
export const EmailLoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  deviceName: z.string().min(1).max(100),
  devicePlatform: z.enum(['macos', 'windows', 'linux', 'ios', 'android'])
})

/**
 * Auth result returned after successful login/signup
 */
export interface AuthResult {
  user: UserPublic
  device: Device
  accessToken: string
  refreshToken: string
  kdfSalt: string // Base64 (needed for key derivation)
}

/**
 * Zod schema for auth result
 */
export const AuthResultSchema = z.object({
  user: UserPublicSchema,
  device: DeviceSchema,
  accessToken: z.string(),
  refreshToken: z.string(),
  kdfSalt: z.string()
})

/**
 * First device setup request (after account creation)
 */
export interface FirstDeviceSetupRequest {
  kdfSalt: string // Base64
  keyVerifier: string // Base64 (HMAC of master key)
}

/**
 * Zod schema for first device setup
 */
export const FirstDeviceSetupRequestSchema = z.object({
  kdfSalt: z.string(),
  keyVerifier: z.string()
})
