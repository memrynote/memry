import type { RotationPhase } from './ipc-crypto'
import type { SyncStatusValue } from './ipc-sync-ops'

// ============================================================================
// Event Channel Constants
// ============================================================================

export const EVENT_CHANNELS = {
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
  SESSION_EXPIRED: 'auth:session-expired',
  OTP_DETECTED: 'auth:otp-detected',
  OAUTH_CALLBACK: 'auth:oauth-callback'
} as const

// ============================================================================
// Event Payloads (Main -> Renderer)
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

export interface OtpDetectedEvent {
  code: string
}

export interface OAuthCallbackEvent {
  code: string
  state: string
}
