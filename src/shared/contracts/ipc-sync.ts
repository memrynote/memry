/**
 * IPC Channel Definitions for Sync and Crypto
 *
 * Defines all IPC channels for communication between renderer and main process
 * for sync engine and cryptographic operations.
 */

import { z } from 'zod'
import type { SyncState, SyncStatus, Device, LinkingSession, UserPublic } from './sync-api'
import type { EncryptedItem, EncryptedCrdtItem, VerificationResult } from './crypto'

// =============================================================================
// Sync IPC Channels
// =============================================================================

/**
 * Sync-related IPC channels
 */
export const SyncChannels = {
  /** Request-response channels (ipcMain.handle / ipcRenderer.invoke) */
  invoke: {
    // Status & Control
    GET_SYNC_STATUS: 'sync:get-status',
    TRIGGER_SYNC: 'sync:trigger',
    PAUSE_SYNC: 'sync:pause',
    RESUME_SYNC: 'sync:resume',
    GET_SYNC_HISTORY: 'sync:get-history',
    CLEAR_SYNC_QUEUE: 'sync:clear-queue',

    // First Device Setup
    SETUP_FIRST_DEVICE: 'sync:setup-first-device',
    VERIFY_RECOVERY_PHRASE: 'sync:verify-recovery-phrase',
    GET_RECOVERY_PHRASE: 'sync:get-recovery-phrase',

    // Device Linking
    CREATE_LINKING_SESSION: 'sync:create-linking-session',
    SCAN_LINKING_QR: 'sync:scan-linking-qr',
    APPROVE_LINKING: 'sync:approve-linking',
    COMPLETE_LINKING: 'sync:complete-linking',
    CANCEL_LINKING: 'sync:cancel-linking',
    GET_LINKING_STATUS: 'sync:get-linking-status',

    // Device Management
    GET_DEVICES: 'sync:get-devices',
    GET_CURRENT_DEVICE: 'sync:get-current-device',
    RENAME_DEVICE: 'sync:rename-device',
    REVOKE_DEVICE: 'sync:revoke-device',

    // User Account
    GET_USER: 'sync:get-user',
    DELETE_ACCOUNT: 'sync:delete-account',

    // Conflict Resolution
    GET_CONFLICTS: 'sync:get-conflicts',
    RESOLVE_CONFLICT: 'sync:resolve-conflict'
  },

  /** Event channels (ipcMain.emit / ipcRenderer.on) */
  events: {
    // Status Events
    STATUS_CHANGED: 'sync:status-changed',
    PROGRESS_UPDATE: 'sync:progress-update',
    ERROR_OCCURRED: 'sync:error-occurred',

    // Item Events
    ITEM_SYNCED: 'sync:item-synced',
    ITEM_CONFLICT: 'sync:item-conflict',

    // Linking Events
    LINKING_SCANNED: 'sync:linking-scanned',
    LINKING_APPROVED: 'sync:linking-approved',
    LINKING_COMPLETED: 'sync:linking-completed',
    LINKING_EXPIRED: 'sync:linking-expired',

    // Device Events
    DEVICE_LINKED: 'sync:device-linked',
    DEVICE_REVOKED: 'sync:device-revoked'
  }
} as const

// =============================================================================
// Crypto IPC Channels
// =============================================================================

/**
 * Crypto-related IPC channels
 */
export const CryptoChannels = {
  /** Request-response channels */
  invoke: {
    // Key Derivation
    DERIVE_KEYS: 'crypto:derive-keys',
    GENERATE_RECOVERY_PHRASE: 'crypto:generate-recovery-phrase',
    VERIFY_MASTER_KEY: 'crypto:verify-master-key',

    // Encryption/Decryption
    ENCRYPT_ITEM: 'crypto:encrypt-item',
    DECRYPT_ITEM: 'crypto:decrypt-item',
    ENCRYPT_ATTACHMENT: 'crypto:encrypt-attachment',
    DECRYPT_ATTACHMENT: 'crypto:decrypt-attachment',

    // Signatures
    SIGN_ITEM: 'crypto:sign-item',
    VERIFY_SIGNATURE: 'crypto:verify-signature',

    // Key Management
    STORE_KEYS: 'crypto:store-keys',
    RETRIEVE_KEYS: 'crypto:retrieve-keys',
    DELETE_KEYS: 'crypto:delete-keys',
    HAS_KEYS: 'crypto:has-keys',

    // Device Linking Crypto
    GENERATE_LINKING_KEYPAIR: 'crypto:generate-linking-keypair',
    DERIVE_LINKING_KEYS: 'crypto:derive-linking-keys',
    ENCRYPT_MASTER_KEY: 'crypto:encrypt-master-key',
    DECRYPT_MASTER_KEY: 'crypto:decrypt-master-key',
    COMPUTE_LINKING_PROOF: 'crypto:compute-linking-proof',
    VERIFY_LINKING_PROOF: 'crypto:verify-linking-proof'
  },

  /** Event channels */
  events: {
    // Key Events
    KEYS_DERIVED: 'crypto:keys-derived',
    KEYS_STORED: 'crypto:keys-stored',
    KEYS_DELETED: 'crypto:keys-deleted'
  }
} as const

// =============================================================================
// Auth IPC Channels
// =============================================================================

/**
 * Authentication-related IPC channels
 */
export const AuthChannels = {
  invoke: {
    // OAuth
    START_OAUTH: 'auth:start-oauth',
    HANDLE_OAUTH_CALLBACK: 'auth:handle-oauth-callback',

    // Session
    GET_SESSION: 'auth:get-session',
    REFRESH_SESSION: 'auth:refresh-session',
    LOGOUT: 'auth:logout',

    // Token Management
    GET_ACCESS_TOKEN: 'auth:get-access-token',
    GET_REFRESH_TOKEN: 'auth:get-refresh-token'
  },

  events: {
    SESSION_CHANGED: 'auth:session-changed',
    SESSION_EXPIRED: 'auth:session-expired',
    OAUTH_CALLBACK: 'auth:oauth-callback'
  }
} as const

// =============================================================================
// Request/Response Types for IPC
// =============================================================================

// --- Sync Status ---

export interface GetSyncStatusResponse {
  state: SyncState
  isOnline: boolean
}

export interface TriggerSyncRequest {
  /** Force full sync even if recently synced */
  force?: boolean
  /** Only sync specific item types */
  types?: string[]
}

export interface TriggerSyncResponse {
  success: boolean
  itemsSynced: number
  errors?: string[]
}

// --- First Device Setup ---

export interface SetupFirstDeviceRequest {
  /** Device name */
  deviceName: string
  /** Platform */
  platform: 'macos' | 'windows' | 'linux'
  /** OS version */
  osVersion: string
  /** App version */
  appVersion: string
}

export interface SetupFirstDeviceResponse {
  /** Generated recovery phrase (24 words) */
  recoveryPhrase: string[]
  /** Device info */
  device: Device
  /** User info */
  user: UserPublic
}

export interface VerifyRecoveryPhraseRequest {
  /** User-entered phrase */
  phrase: string[]
}

export interface VerifyRecoveryPhraseResponse {
  valid: boolean
  error?: string
}

// --- Device Linking ---

export interface CreateLinkingSessionResponse {
  /** Session ID */
  sessionId: string
  /** QR code data URL */
  qrCodeDataUrl: string
  /** Expiration timestamp */
  expiresAt: number
}

export interface ScanLinkingQRRequest {
  /** QR code content (JSON string) */
  qrContent: string
  /** New device info */
  deviceName: string
  platform: 'macos' | 'windows' | 'linux'
  osVersion: string
  appVersion: string
}

export interface ScanLinkingQRResponse {
  success: boolean
  sessionId?: string
  error?: string
}

export interface ApproveLinkingRequest {
  sessionId: string
}

export interface ApproveLinkingResponse {
  success: boolean
  error?: string
}

export interface CompleteLinkingRequest {
  sessionId: string
}

export interface CompleteLinkingResponse {
  success: boolean
  device?: Device
  error?: string
}

export interface GetLinkingStatusRequest {
  sessionId: string
}

export interface GetLinkingStatusResponse {
  session: LinkingSession | null
}

// --- Device Management ---

export interface GetDevicesResponse {
  devices: Device[]
  currentDeviceId: string
}

export interface RenameDeviceRequest {
  deviceId: string
  newName: string
}

export interface RenameDeviceResponse {
  success: boolean
  device?: Device
  error?: string
}

export interface RevokeDeviceRequest {
  deviceId: string
}

export interface RevokeDeviceResponse {
  success: boolean
  error?: string
}

// --- Conflict Resolution ---

export interface SyncConflict {
  itemId: string
  itemType: string
  localItem: EncryptedItem | EncryptedCrdtItem
  remoteItem: EncryptedItem | EncryptedCrdtItem
  detectedAt: number
}

export interface GetConflictsResponse {
  conflicts: SyncConflict[]
}

export interface ResolveConflictRequest {
  itemId: string
  resolution: 'local' | 'remote' | 'merge'
}

export interface ResolveConflictResponse {
  success: boolean
  resolvedItem?: EncryptedItem | EncryptedCrdtItem
  error?: string
}

// --- Crypto Operations ---

export interface DeriveKeysRequest {
  /** BIP39 mnemonic */
  phrase: string[]
  /** KDF salt from server (Base64) */
  kdfSalt: string
}

export interface DeriveKeysResponse {
  success: boolean
  /** Key verifier to send to server (Base64) */
  keyVerifier?: string
  error?: string
}

export interface EncryptItemRequest {
  /** Item ID */
  id: string
  /** Item type */
  type: string
  /** Plaintext data (JSON string) */
  data: string
  /** Optional operation type */
  operation?: 'create' | 'update' | 'delete'
}

export interface EncryptItemResponse {
  success: boolean
  item?: EncryptedItem
  error?: string
}

export interface DecryptItemRequest {
  item: EncryptedItem
}

export interface DecryptItemResponse {
  success: boolean
  /** Decrypted data (JSON string) */
  data?: string
  error?: string
}

export interface SignItemRequest {
  item: EncryptedItem
}

export interface SignItemResponse {
  success: boolean
  /** Signature (Base64) */
  signature?: string
  signerDeviceId?: string
  error?: string
}

export interface VerifySignatureRequest {
  item: EncryptedItem
  /** Public key of signer device (Base64) */
  signerPublicKey: string
}

export interface VerifySignatureResponse extends VerificationResult {}

export interface HasKeysResponse {
  hasKeys: boolean
  deviceId?: string
  userId?: string
}

// --- Auth Operations ---

export interface StartOAuthRequest {
  provider: 'google'
}

export interface StartOAuthResponse {
  success: boolean
  /** URL to open in browser (for web-based OAuth) */
  authUrl?: string
  error?: string
}

export interface GetSessionResponse {
  isAuthenticated: boolean
  user?: UserPublic
  expiresAt?: number
}

export interface LogoutResponse {
  success: boolean
}

// --- Event Payloads ---

export interface SyncStatusChangedEvent {
  previousStatus: SyncStatus
  currentStatus: SyncStatus
  timestamp: number
}

export interface SyncProgressUpdateEvent {
  phase: 'pulling' | 'pushing' | 'resolving'
  current: number
  total: number
  itemType?: string
}

export interface SyncErrorEvent {
  error: string
  itemId?: string
  recoverable: boolean
  timestamp: number
}

export interface ItemSyncedEvent {
  itemId: string
  itemType: string
  operation: 'created' | 'updated' | 'deleted'
  timestamp: number
}

export interface ItemConflictEvent {
  itemId: string
  itemType: string
  conflict: SyncConflict
}

export interface DeviceLinkedEvent {
  device: Device
  isCurrentDevice: boolean
}

export interface DeviceRevokedEvent {
  deviceId: string
  deviceName: string
}

// =============================================================================
// Zod Schemas for Validation
// =============================================================================

export const TriggerSyncRequestSchema = z.object({
  force: z.boolean().optional(),
  types: z.array(z.string()).optional()
})

export const SetupFirstDeviceRequestSchema = z.object({
  deviceName: z.string().min(1).max(100),
  platform: z.enum(['macos', 'windows', 'linux']),
  osVersion: z.string(),
  appVersion: z.string()
})

export const VerifyRecoveryPhraseRequestSchema = z.object({
  phrase: z.array(z.string()).length(24)
})

export const ScanLinkingQRRequestSchema = z.object({
  qrContent: z.string(),
  deviceName: z.string().min(1).max(100),
  platform: z.enum(['macos', 'windows', 'linux']),
  osVersion: z.string(),
  appVersion: z.string()
})

export const RenameDeviceRequestSchema = z.object({
  deviceId: z.string().uuid(),
  newName: z.string().min(1).max(100)
})

export const RevokeDeviceRequestSchema = z.object({
  deviceId: z.string().uuid()
})

export const ResolveConflictRequestSchema = z.object({
  itemId: z.string().uuid(),
  resolution: z.enum(['local', 'remote', 'merge'])
})

export const DeriveKeysRequestSchema = z.object({
  phrase: z.array(z.string()).length(24),
  kdfSalt: z.string()
})

export const EncryptItemRequestSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  data: z.string(),
  operation: z.enum(['create', 'update', 'delete']).optional()
})

export const StartOAuthRequestSchema = z.object({
  provider: z.literal('google')
})

// =============================================================================
// Type Guards
// =============================================================================

export function isSyncChannel(channel: string): boolean {
  const allChannels = [...Object.values(SyncChannels.invoke), ...Object.values(SyncChannels.events)]
  return allChannels.includes(channel as (typeof allChannels)[number])
}

export function isCryptoChannel(channel: string): boolean {
  const allChannels = [...Object.values(CryptoChannels.invoke), ...Object.values(CryptoChannels.events)]
  return allChannels.includes(channel as (typeof allChannels)[number])
}

export function isAuthChannel(channel: string): boolean {
  const allChannels = [...Object.values(AuthChannels.invoke), ...Object.values(AuthChannels.events)]
  return allChannels.includes(channel as (typeof allChannels)[number])
}
