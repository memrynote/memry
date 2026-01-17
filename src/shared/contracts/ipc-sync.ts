/**
 * IPC Channel Definitions for Sync and Crypto Operations
 *
 * Defines all IPC channels used for communication between the main process
 * and renderer process for sync and cryptographic operations.
 *
 * @module shared/contracts/ipc-sync
 */

import { z } from 'zod'
import type {
  SyncStatus,
  SyncHistoryEntry,
  LinkingSession,
  SyncedSettings,
  DevicePlatform
} from './sync-api'

// Re-export types that are used in handler response types
export type { Device, LinkingQRPayload, UserPublic, AuthResult } from './sync-api'
export type { KeyRotationProgress, RecoveryPhraseValidation } from './crypto'

// =============================================================================
// IPC Channel Names
// =============================================================================

/**
 * All sync-related IPC channels
 */
export const SYNC_CHANNELS = {
  // Setup
  SETUP_FIRST_DEVICE: 'sync:setup-first-device',
  GET_SETUP_STATUS: 'sync:get-setup-status',

  // Auth (Email)
  EMAIL_SIGNUP: 'sync:email-signup',
  EMAIL_LOGIN: 'sync:email-login',
  EMAIL_VERIFY: 'sync:email-verify',
  RESEND_VERIFICATION: 'sync:resend-verification',
  FORGOT_PASSWORD: 'sync:forgot-password',
  RESET_PASSWORD: 'sync:reset-password',
  CHANGE_PASSWORD: 'sync:change-password',
  LOGOUT: 'sync:logout',

  // Auth (OAuth)
  OAUTH_START: 'sync:oauth-start',
  OAUTH_CALLBACK: 'sync:oauth-callback',

  // Sync Status
  GET_STATUS: 'sync:get-status',
  TRIGGER_SYNC: 'sync:trigger-sync',
  PAUSE_SYNC: 'sync:pause-sync',
  RESUME_SYNC: 'sync:resume-sync',
  GET_QUEUE_SIZE: 'sync:get-queue-size',

  // Sync History
  GET_HISTORY: 'sync:get-history',
  CLEAR_HISTORY: 'sync:clear-history',

  // Devices
  GET_DEVICES: 'sync:get-devices',
  REMOVE_DEVICE: 'sync:remove-device',
  RENAME_DEVICE: 'sync:rename-device',

  // Device Linking (QR)
  GENERATE_LINKING_QR: 'sync:generate-linking-qr',
  LINK_VIA_QR: 'sync:link-via-qr',
  APPROVE_LINKING: 'sync:approve-linking',
  CANCEL_LINKING: 'sync:cancel-linking',
  GET_LINKING_STATUS: 'sync:get-linking-status',

  // Device Linking (Recovery Phrase)
  LINK_VIA_RECOVERY: 'sync:link-via-recovery',

  // Settings
  GET_SYNCED_SETTINGS: 'sync:get-synced-settings',
  UPDATE_SYNCED_SETTINGS: 'sync:update-synced-settings',

  // Events (renderer -> main, for subscriptions)
  SUBSCRIBE_STATUS: 'sync:subscribe-status',
  UNSUBSCRIBE_STATUS: 'sync:unsubscribe-status'
} as const

/**
 * All crypto-related IPC channels
 */
export const CRYPTO_CHANNELS = {
  // Recovery Phrase
  GENERATE_RECOVERY_PHRASE: 'crypto:generate-recovery-phrase',
  VALIDATE_RECOVERY_PHRASE: 'crypto:validate-recovery-phrase',
  CONFIRM_RECOVERY_PHRASE: 'crypto:confirm-recovery-phrase',

  // Key Operations
  DERIVE_KEYS: 'crypto:derive-keys',
  GET_PUBLIC_KEY: 'crypto:get-public-key',

  // Encryption/Decryption
  ENCRYPT_ITEM: 'crypto:encrypt-item',
  DECRYPT_ITEM: 'crypto:decrypt-item',
  ENCRYPT_BLOB: 'crypto:encrypt-blob',
  DECRYPT_BLOB: 'crypto:decrypt-blob',

  // Signatures
  SIGN_DATA: 'crypto:sign-data',
  VERIFY_SIGNATURE: 'crypto:verify-signature',

  // Key Rotation
  START_KEY_ROTATION: 'crypto:start-key-rotation',
  GET_ROTATION_PROGRESS: 'crypto:get-rotation-progress',
  CANCEL_KEY_ROTATION: 'crypto:cancel-key-rotation',

  // Keychain
  HAS_MASTER_KEY: 'crypto:has-master-key',
  CLEAR_KEYCHAIN: 'crypto:clear-keychain'
} as const

/**
 * IPC events sent from main to renderer
 */
export const SYNC_EVENTS = {
  // Status changes
  STATUS_CHANGED: 'sync:status-changed',
  ITEM_SYNCED: 'sync:item-synced',
  SYNC_ERROR: 'sync:sync-error',

  // Device linking
  LINKING_REQUEST: 'sync:linking-request',
  LINKING_APPROVED: 'sync:linking-approved',
  LINKING_REJECTED: 'sync:linking-rejected',
  LINKING_EXPIRED: 'sync:linking-expired',

  // Session events
  SESSION_EXPIRED: 'sync:session-expired',
  DEVICE_REMOVED: 'sync:device-removed',

  // Auth events (for loopback OAuth)
  AUTH_SUCCESS: 'sync:auth-success',
  AUTH_ERROR: 'sync:auth-error',

  // Progress events
  INITIAL_SYNC_PROGRESS: 'sync:initial-sync-progress',
  KEY_ROTATION_PROGRESS: 'crypto:rotation-progress'
} as const

// =============================================================================
// Request/Response Types for IPC Handlers
// =============================================================================

// --- Setup ---

export interface SetupFirstDeviceInput {
  kdfSalt: string // Base64
  keyVerifier: string // Base64
}

export const SetupFirstDeviceInputSchema = z.object({
  kdfSalt: z.string(),
  keyVerifier: z.string()
})

export interface SetupStatus {
  isSetup: boolean
  hasUser: boolean
  hasDevice: boolean
  hasMasterKey: boolean
  hasTokens: boolean
}

// --- Auth (Email) ---

export interface EmailSignupInput {
  email: string
  password: string
  deviceName: string
}

export const EmailSignupInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(128),
  deviceName: z.string().min(1).max(100)
})

export interface EmailLoginInput {
  email: string
  password: string
  deviceName: string
}

export const EmailLoginInputSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  deviceName: z.string().min(1).max(100)
})

export interface EmailVerifyInput {
  token: string
}

export const EmailVerifyInputSchema = z.object({
  token: z.string()
})

export interface ForgotPasswordInput {
  email: string
}

export const ForgotPasswordInputSchema = z.object({
  email: z.email()
})

export interface ResetPasswordInput {
  token: string
  newPassword: string
}

export const ResetPasswordInputSchema = z.object({
  token: z.string(),
  newPassword: z.string().min(12).max(128)
})

export interface ChangePasswordInput {
  currentPassword: string
  newPassword: string
}

export const ChangePasswordInputSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(12).max(128)
})

// --- Auth (OAuth) ---

export interface OAuthStartInput {
  provider: 'google' | 'apple' | 'github'
  deviceName: string
}

export const OAuthStartInputSchema = z.object({
  provider: z.enum(['google', 'apple', 'github']),
  deviceName: z.string().min(1).max(100)
})

export interface OAuthCallbackInput {
  code: string
  state: string
}

export const OAuthCallbackInputSchema = z.object({
  code: z.string(),
  state: z.string()
})

// --- Sync Status ---

export interface TriggerSyncInput {
  force?: boolean
}

export const TriggerSyncInputSchema = z.object({
  force: z.boolean().optional()
})

// --- Sync History ---

export interface GetHistoryInput {
  limit?: number
  offset?: number
  type?: 'push' | 'pull' | 'error'
}

export const GetHistoryInputSchema = z.object({
  limit: z.number().optional(),
  offset: z.number().optional(),
  type: z.enum(['push', 'pull', 'error']).optional()
})

export interface GetHistoryOutput {
  entries: SyncHistoryEntry[]
  total: number
  hasMore: boolean
}

// --- Devices ---

export interface RemoveDeviceInput {
  deviceId: string
}

export const RemoveDeviceInputSchema = z.object({
  deviceId: z.string()
})

export interface RenameDeviceInput {
  deviceId: string
  name: string
}

export const RenameDeviceInputSchema = z.object({
  deviceId: z.string(),
  name: z.string().min(1).max(100)
})

// --- Device Linking (QR) ---

export interface GenerateLinkingQROutput {
  qrData: string // JSON string of LinkingQRPayload
  expiresAt: number
}

export interface LinkViaQRInput {
  qrData: string // Scanned QR data
  deviceName: string
}

export const LinkViaQRInputSchema = z.object({
  qrData: z.string(),
  deviceName: z.string().min(1).max(100)
})

export interface ApproveLinkingInput {
  sessionId: string
  approve: boolean
}

export const ApproveLinkingInputSchema = z.object({
  sessionId: z.string(),
  approve: z.boolean()
})

// --- Device Linking (Recovery Phrase) ---

export interface LinkViaRecoveryInput {
  recoveryPhrase: string
  email: string
  deviceName: string
}

export const LinkViaRecoveryInputSchema = z.object({
  recoveryPhrase: z.string(),
  email: z.string().email(),
  deviceName: z.string().min(1).max(100)
})

// --- Settings ---

export interface UpdateSyncedSettingsInput {
  settings: Partial<SyncedSettings>
}

// --- Crypto: Recovery Phrase ---

export interface GenerateRecoveryPhraseOutput {
  phrase: string
  wordCount: number
}

export interface ValidateRecoveryPhraseInput {
  phrase: string
}

export const ValidateRecoveryPhraseInputSchema = z.object({
  phrase: z.string()
})

export interface ConfirmRecoveryPhraseInput {
  phrase: string
  confirmationWords: { index: number; word: string }[]
}

export const ConfirmRecoveryPhraseInputSchema = z.object({
  phrase: z.string(),
  confirmationWords: z.array(
    z.object({
      index: z.number(),
      word: z.string()
    })
  )
})

// --- Crypto: Encryption/Decryption ---

export interface EncryptItemInput {
  data: string // JSON string of item data
  type: 'note' | 'task' | 'project' | 'settings'
}

export const EncryptItemInputSchema = z.object({
  data: z.string(),
  type: z.enum(['note', 'task', 'project', 'settings'])
})

export interface EncryptItemOutput {
  encryptedData: string // Base64
  nonce: string // Base64
  encryptedKey: string // Base64
  keyNonce: string // Base64
  signature: string // Base64
}

export interface DecryptItemInput {
  encryptedData: string // Base64
  nonce: string // Base64
  encryptedKey: string // Base64
  keyNonce: string // Base64
  signature: string // Base64
}

export const DecryptItemInputSchema = z.object({
  encryptedData: z.string(),
  nonce: z.string(),
  encryptedKey: z.string(),
  keyNonce: z.string(),
  signature: z.string()
})

export interface DecryptItemOutput {
  data: string // JSON string of decrypted item
  verified: boolean
}

// --- Crypto: Signatures ---

export interface SignDataInput {
  data: string // Data to sign (will be CBOR encoded)
}

export const SignDataInputSchema = z.object({
  data: z.string()
})

export interface SignDataOutput {
  signature: string // Base64
}

export interface VerifySignatureInput {
  data: string
  signature: string // Base64
  publicKey?: string // Base64 (optional, uses user's key if not provided)
}

export const VerifySignatureInputSchema = z.object({
  data: z.string(),
  signature: z.string(),
  publicKey: z.string().optional()
})

export interface VerifySignatureOutput {
  valid: boolean
  error?: string
}

// =============================================================================
// Event Payloads
// =============================================================================

export interface StatusChangedEvent {
  status: SyncStatus
}

export interface ItemSyncedEvent {
  itemId: string
  type: 'note' | 'task' | 'project' | 'settings' | 'attachment'
  operation: 'create' | 'update' | 'delete'
}

export interface SyncErrorEvent {
  error: string
  itemId?: string
  recoverable: boolean
}

export interface LinkingRequestEvent {
  session: LinkingSession
  deviceName: string
  devicePlatform: DevicePlatform
}

export interface LinkingApprovedEvent {
  sessionId: string
  deviceId: string
}

export interface LinkingRejectedEvent {
  sessionId: string
  reason: string
}

export interface SessionExpiredEvent {
  reason: 'token_expired' | 'device_removed' | 'key_rotated'
}

export interface InitialSyncProgressEvent {
  phase: 'downloading' | 'decrypting' | 'applying'
  current: number
  total: number
  currentItem?: string
}

// =============================================================================
// Type Exports for Handler Registration
// =============================================================================

/**
 * All sync channel names
 */
export type SyncChannel = (typeof SYNC_CHANNELS)[keyof typeof SYNC_CHANNELS]

/**
 * All crypto channel names
 */
export type CryptoChannel = (typeof CRYPTO_CHANNELS)[keyof typeof CRYPTO_CHANNELS]

/**
 * All sync event names
 */
export type SyncEvent = (typeof SYNC_EVENTS)[keyof typeof SYNC_EVENTS]
