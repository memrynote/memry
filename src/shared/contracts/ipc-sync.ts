import { z } from 'zod'
import {
  ENCRYPTABLE_ITEM_TYPES,
  SYNC_OPERATIONS,
  type EncryptableItemType,
  type SyncOperation
} from './sync-api'

// ============================================================================
// Channel Name Constants
// ============================================================================

export const SYNC_CHANNELS = {
  AUTH_REQUEST_OTP: 'auth:request-otp',
  AUTH_VERIFY_OTP: 'auth:verify-otp',
  AUTH_RESEND_OTP: 'auth:resend-otp',

  SETUP_FIRST_DEVICE: 'sync:setup-first-device',
  CONFIRM_RECOVERY_PHRASE: 'sync:confirm-recovery-phrase',
  GENERATE_LINKING_QR: 'sync:generate-linking-qr',
  LINK_VIA_QR: 'sync:link-via-qr',
  LINK_VIA_RECOVERY: 'sync:link-via-recovery',
  APPROVE_LINKING: 'sync:approve-linking',
  GET_DEVICES: 'sync:get-devices',
  REMOVE_DEVICE: 'sync:remove-device',
  RENAME_DEVICE: 'sync:rename-device',

  GET_STATUS: 'sync:get-status',
  TRIGGER_SYNC: 'sync:trigger-sync',
  GET_HISTORY: 'sync:get-history',
  GET_QUEUE_SIZE: 'sync:get-queue-size',
  PAUSE: 'sync:pause',
  RESUME: 'sync:resume',

  ENCRYPT_ITEM: 'crypto:encrypt-item',
  DECRYPT_ITEM: 'crypto:decrypt-item',
  VERIFY_SIGNATURE: 'crypto:verify-signature',
  ROTATE_KEYS: 'crypto:rotate-keys',
  GET_ROTATION_PROGRESS: 'crypto:get-rotation-progress',

  UPLOAD_ATTACHMENT: 'sync:upload-attachment',
  GET_UPLOAD_PROGRESS: 'sync:get-upload-progress',
  DOWNLOAD_ATTACHMENT: 'sync:download-attachment',
  GET_DOWNLOAD_PROGRESS: 'sync:get-download-progress'
} as const

export const SYNC_EVENTS = {
  STATUS_CHANGED: 'sync:status-changed',
  ITEM_SYNCED: 'sync:item-synced',
  CONFLICT_DETECTED: 'sync:conflict-detected',
  LINKING_REQUEST: 'sync:linking-request',
  LINKING_APPROVED: 'sync:linking-approved',
  UPLOAD_PROGRESS: 'sync:upload-progress',
  DOWNLOAD_PROGRESS: 'sync:download-progress',
  INITIAL_SYNC_PROGRESS: 'sync:initial-sync-progress',
  QUEUE_CLEARED: 'sync:queue-cleared',
  PAUSED: 'sync:paused',
  RESUMED: 'sync:resumed',
  KEY_ROTATION_PROGRESS: 'crypto:key-rotation-progress',
  SESSION_EXPIRED: 'auth:session-expired'
} as const

// ============================================================================
// Types — Auth
// ============================================================================

export interface RequestOtpInput {
  email: string
}

export interface RequestOtpResult {
  success: boolean
  expiresIn?: number
  message?: string
  error?: string
}

export interface VerifyOtpInput {
  email: string
  code: string
}

export interface VerifyOtpResult {
  success: boolean
  isNewUser?: boolean
  needsRecoverySetup?: boolean
  recoveryPhrase?: string
  deviceId?: string
  error?: string
}

export interface ResendOtpInput {
  email: string
}

export interface ResendOtpResult {
  success: boolean
  expiresIn?: number
  message?: string
  error?: string
}

// ============================================================================
// Types — Setup & Devices
// ============================================================================

export interface SetupFirstDeviceInput {
  oauthToken: string
  provider: 'google'
}

export interface SetupFirstDeviceResult {
  success: boolean
  recoveryPhrase?: string
  deviceId?: string
  error?: string
}

export interface ConfirmRecoveryPhraseInput {
  confirmed: boolean
}

export interface ConfirmRecoveryPhraseResult {
  success: boolean
}

export interface GenerateLinkingQrResult {
  qrData?: string
  sessionId?: string
  expiresAt?: number
}

export interface LinkViaQrInput {
  qrData: string
  oauthToken: string
  provider: string
}

export interface LinkViaQrResult {
  success: boolean
  status?: 'waiting_approval' | 'approved' | 'error'
  error?: string
}

export interface LinkViaRecoveryInput {
  recoveryPhrase: string
  oauthToken: string
  provider: string
}

export interface LinkViaRecoveryResult {
  success: boolean
  error?: string
}

export interface ApproveLinkingInput {
  sessionId: string
}

export interface ApproveLinkingResult {
  success: boolean
  error?: string
}

export interface SyncDevice {
  id: string
  name: string
  platform: 'macos' | 'windows' | 'linux' | 'ios' | 'android'
  linkedAt: number
  lastSyncAt?: number
  isCurrentDevice: boolean
}

export interface GetDevicesResult {
  devices: SyncDevice[]
}

export interface RemoveDeviceInput {
  deviceId: string
}

export interface RemoveDeviceResult {
  success: boolean
  error?: string
}

export interface RenameDeviceInput {
  deviceId: string
  newName: string
}

export interface RenameDeviceResult {
  success: boolean
  error?: string
}

// ============================================================================
// Types — Sync Operations
// ============================================================================

export type SyncStatusValue = 'idle' | 'syncing' | 'offline' | 'error'

export interface GetSyncStatusResult {
  status: SyncStatusValue
  lastSyncAt?: number
  pendingCount: number
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

// ============================================================================
// Types — Crypto Operations
// ============================================================================

export interface EncryptItemInput {
  itemId: string
  type: EncryptableItemType
  content: Record<string, unknown>
  operation?: SyncOperation
  metadata?: Record<string, unknown>
}

export interface EncryptItemResult {
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
}

export interface DecryptItemInput {
  itemId: string
  type: EncryptableItemType
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  operation?: SyncOperation
  metadata?: Record<string, unknown>
}

export interface DecryptItemResult {
  success: boolean
  content?: Record<string, unknown>
  error?: string
}

export interface VerifySignatureInput {
  itemId: string
  type: EncryptableItemType
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  operation?: SyncOperation
  metadata?: Record<string, unknown>
}

export interface VerifySignatureResult {
  valid: boolean
}

export interface RotateKeysInput {
  confirm: boolean
}

export interface RotateKeysResult {
  success: boolean
  newRecoveryPhrase?: string
  error?: string
}

export type RotationPhase = 'preparing' | 're-encrypting' | 'finalizing' | 'complete'

export interface GetRotationProgressResult {
  inProgress: boolean
  totalItems?: number
  processedItems?: number
  phase?: RotationPhase
}

// ============================================================================
// Types — Attachments
// ============================================================================

export interface UploadAttachmentInput {
  noteId: string
  filePath: string
}

export interface UploadAttachmentResult {
  success: boolean
  attachmentId?: string
  sessionId?: string
  error?: string
}

export interface GetUploadProgressInput {
  sessionId: string
}

export interface GetUploadProgressResult {
  progress: number
  uploadedChunks: number
  totalChunks: number
  status: 'uploading' | 'paused' | 'completed' | 'failed'
}

export interface DownloadAttachmentInput {
  attachmentId: string
  targetPath?: string
}

export interface DownloadAttachmentResult {
  success: boolean
  filePath?: string
  error?: string
}

export interface GetDownloadProgressInput {
  attachmentId: string
}

export type DownloadStatus = 'downloading' | 'paused' | 'completed' | 'failed'

export interface GetDownloadProgressResult {
  progress: number
  downloadedChunks: number
  totalChunks: number
  status: DownloadStatus
}

// ============================================================================
// Event Payloads (Main → Renderer)
// ============================================================================

export interface SyncStatusChangedEvent {
  status: SyncStatusValue
  lastSyncAt?: number
  pendingCount: number
  error?: string
}

export interface ItemSyncedEvent {
  itemId: string
  type: string
  operation: 'push' | 'pull'
}

export interface ConflictDetectedEvent {
  itemId: string
  type: string
  localVersion: Record<string, unknown>
  remoteVersion: Record<string, unknown>
}

export interface LinkingRequestEvent {
  sessionId: string
  newDeviceName: string
  newDevicePlatform: string
}

export interface LinkingApprovedEvent {
  sessionId: string
}

export interface UploadProgressEvent {
  attachmentId: string
  sessionId: string
  progress: number
  status: string
}

export interface DownloadProgressEvent {
  attachmentId: string
  progress: number
  status: string
}

export type InitialSyncPhase = 'manifest' | 'notes' | 'tasks' | 'attachments' | 'complete'

export interface InitialSyncProgressEvent {
  phase: InitialSyncPhase
  totalItems: number
  processedItems: number
  currentItemType?: string
}

export interface QueueClearedEvent {
  itemCount: number
  duration: number
}

export interface SyncPausedEvent {
  pendingCount: number
}

export interface SyncResumedEvent {
  pendingCount: number
}

export interface KeyRotationProgressEvent {
  phase: RotationPhase
  totalItems: number
  processedItems: number
  error?: string
}

export type SessionExpiredReason = 'token_expired' | 'device_revoked' | 'server_error'

export interface SessionExpiredEvent {
  reason: SessionExpiredReason
}

// ============================================================================
// Zod Schemas — Auth
// ============================================================================

export const RequestOtpSchema = z.object({
  email: z.string().email()
})

export const VerifyOtpSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/)
})

export const ResendOtpSchema = z.object({
  email: z.string().email()
})

// ============================================================================
// Zod Schemas — Setup & Devices
// ============================================================================

export const SetupFirstDeviceSchema = z.object({
  oauthToken: z.string().min(1),
  provider: z.literal('google')
})

export const ConfirmRecoveryPhraseSchema = z.object({
  confirmed: z.boolean()
})

export const LinkViaQrSchema = z.object({
  qrData: z.string().min(1),
  oauthToken: z.string().min(1),
  provider: z.string().min(1)
})

export const LinkViaRecoverySchema = z.object({
  recoveryPhrase: z.string().min(1),
  oauthToken: z.string().min(1),
  provider: z.string().min(1)
})

export const ApproveLinkingSchema = z.object({
  sessionId: z.string().min(1)
})

export const RemoveDeviceSchema = z.object({
  deviceId: z.string().min(1)
})

export const RenameDeviceSchema = z.object({
  deviceId: z.string().min(1),
  newName: z.string().min(1).max(100)
})

// ============================================================================
// Zod Schemas — Sync Operations
// ============================================================================

export const GetHistorySchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional()
})

// ============================================================================
// Zod Schemas — Crypto Operations
// ============================================================================

const ItemTypeEnum = z.enum(ENCRYPTABLE_ITEM_TYPES)
const OperationEnum = z.enum(SYNC_OPERATIONS)

export const EncryptItemSchema = z.object({
  itemId: z.string().min(1),
  type: ItemTypeEnum,
  content: z.record(z.string(), z.unknown()),
  operation: OperationEnum.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export const DecryptItemSchema = z.object({
  itemId: z.string().min(1),
  type: ItemTypeEnum,
  encryptedKey: z.string().min(1),
  keyNonce: z.string().min(1),
  encryptedData: z.string().min(1),
  dataNonce: z.string().min(1),
  signature: z.string().min(1),
  operation: OperationEnum.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export const VerifySignatureSchema = z.object({
  itemId: z.string().min(1),
  type: ItemTypeEnum,
  encryptedKey: z.string().min(1),
  keyNonce: z.string().min(1),
  encryptedData: z.string().min(1),
  dataNonce: z.string().min(1),
  signature: z.string().min(1),
  operation: OperationEnum.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export const RotateKeysSchema = z.object({
  confirm: z.boolean()
})

// ============================================================================
// Zod Schemas — Attachments
// ============================================================================

export const UploadAttachmentSchema = z.object({
  noteId: z.string().min(1),
  filePath: z.string().min(1)
})

export const GetUploadProgressSchema = z.object({
  sessionId: z.string().min(1)
})

export const DownloadAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  targetPath: z.string().min(1).optional()
})

export const GetDownloadProgressSchema = z.object({
  attachmentId: z.string().min(1)
})

// ============================================================================
// Type Inference
// ============================================================================

export type RequestOtpSchemaInput = z.infer<typeof RequestOtpSchema>
export type VerifyOtpSchemaInput = z.infer<typeof VerifyOtpSchema>
export type ResendOtpSchemaInput = z.infer<typeof ResendOtpSchema>
export type SetupFirstDeviceSchemaInput = z.infer<typeof SetupFirstDeviceSchema>
export type ConfirmRecoveryPhraseSchemaInput = z.infer<typeof ConfirmRecoveryPhraseSchema>
export type LinkViaQrSchemaInput = z.infer<typeof LinkViaQrSchema>
export type LinkViaRecoverySchemaInput = z.infer<typeof LinkViaRecoverySchema>
export type ApproveLinkingSchemaInput = z.infer<typeof ApproveLinkingSchema>
export type RemoveDeviceSchemaInput = z.infer<typeof RemoveDeviceSchema>
export type RenameDeviceSchemaInput = z.infer<typeof RenameDeviceSchema>
export type GetHistorySchemaInput = z.infer<typeof GetHistorySchema>
export type EncryptItemSchemaInput = z.infer<typeof EncryptItemSchema>
export type DecryptItemSchemaInput = z.infer<typeof DecryptItemSchema>
export type VerifySignatureSchemaInput = z.infer<typeof VerifySignatureSchema>
export type RotateKeysSchemaInput = z.infer<typeof RotateKeysSchema>
export type UploadAttachmentSchemaInput = z.infer<typeof UploadAttachmentSchema>
export type GetUploadProgressSchemaInput = z.infer<typeof GetUploadProgressSchema>
export type DownloadAttachmentSchemaInput = z.infer<typeof DownloadAttachmentSchema>
export type GetDownloadProgressSchemaInput = z.infer<typeof GetDownloadProgressSchema>
