import { SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import type {
  SyncStatusChangedEvent,
  ItemSyncedEvent,
  ConflictDetectedEvent,
  LinkingRequestEvent,
  LinkingApprovedEvent,
  LinkingFinalizedEvent,
  UploadProgressEvent,
  DownloadProgressEvent,
  InitialSyncProgressEvent,
  QueueClearedEvent,
  SyncPausedEvent,
  SyncResumedEvent,
  KeyRotationProgressEvent,
  SessionExpiredEvent,
  OtpDetectedEvent,
  OAuthCallbackEvent,
  OAuthErrorEvent,
  ClockSkewWarningEvent,
  DeviceRevokedEvent,
  SecurityWarningEvent,
  CertificatePinFailedEvent
} from '@memry/contracts/ipc-sync'
import { subscribe } from '../lib/ipc'

export const syncEvents = {
  onSyncStatusChanged: (callback: (event: SyncStatusChangedEvent) => void): (() => void) =>
    subscribe<SyncStatusChangedEvent>(SYNC_EVENTS.STATUS_CHANGED, callback),

  onItemSynced: (callback: (event: ItemSyncedEvent) => void): (() => void) =>
    subscribe<ItemSyncedEvent>(SYNC_EVENTS.ITEM_SYNCED, callback),

  onConflictDetected: (callback: (event: ConflictDetectedEvent) => void): (() => void) =>
    subscribe<ConflictDetectedEvent>(SYNC_EVENTS.CONFLICT_DETECTED, callback),

  onLinkingRequest: (callback: (event: LinkingRequestEvent) => void): (() => void) =>
    subscribe<LinkingRequestEvent>(SYNC_EVENTS.LINKING_REQUEST, callback),

  onLinkingApproved: (callback: (event: LinkingApprovedEvent) => void): (() => void) =>
    subscribe<LinkingApprovedEvent>(SYNC_EVENTS.LINKING_APPROVED, callback),

  onLinkingFinalized: (callback: (event: LinkingFinalizedEvent) => void): (() => void) =>
    subscribe<LinkingFinalizedEvent>(SYNC_EVENTS.LINKING_FINALIZED, callback),

  onUploadProgress: (callback: (event: UploadProgressEvent) => void): (() => void) =>
    subscribe<UploadProgressEvent>(SYNC_EVENTS.UPLOAD_PROGRESS, callback),

  onDownloadProgress: (callback: (event: DownloadProgressEvent) => void): (() => void) =>
    subscribe<DownloadProgressEvent>(SYNC_EVENTS.DOWNLOAD_PROGRESS, callback),

  onInitialSyncProgress: (callback: (event: InitialSyncProgressEvent) => void): (() => void) =>
    subscribe<InitialSyncProgressEvent>(SYNC_EVENTS.INITIAL_SYNC_PROGRESS, callback),

  onQueueCleared: (callback: (event: QueueClearedEvent) => void): (() => void) =>
    subscribe<QueueClearedEvent>(SYNC_EVENTS.QUEUE_CLEARED, callback),

  onSyncPaused: (callback: (event: SyncPausedEvent) => void): (() => void) =>
    subscribe<SyncPausedEvent>(SYNC_EVENTS.PAUSED, callback),

  onSyncResumed: (callback: (event: SyncResumedEvent) => void): (() => void) =>
    subscribe<SyncResumedEvent>(SYNC_EVENTS.RESUMED, callback),

  onKeyRotationProgress: (callback: (event: KeyRotationProgressEvent) => void): (() => void) =>
    subscribe<KeyRotationProgressEvent>(SYNC_EVENTS.KEY_ROTATION_PROGRESS, callback),

  onSessionExpired: (callback: (event: SessionExpiredEvent) => void): (() => void) =>
    subscribe<SessionExpiredEvent>(SYNC_EVENTS.SESSION_EXPIRED, callback),

  onDeviceRevoked: (callback: (event: DeviceRevokedEvent) => void): (() => void) =>
    subscribe<DeviceRevokedEvent>(SYNC_EVENTS.DEVICE_REMOVED, callback),

  onOtpDetected: (callback: (event: OtpDetectedEvent) => void): (() => void) =>
    subscribe<OtpDetectedEvent>(SYNC_EVENTS.OTP_DETECTED, callback),

  onOAuthCallback: (callback: (event: OAuthCallbackEvent) => void): (() => void) =>
    subscribe<OAuthCallbackEvent>(SYNC_EVENTS.OAUTH_CALLBACK, callback),

  onOAuthError: (callback: (event: OAuthErrorEvent) => void): (() => void) =>
    subscribe<OAuthErrorEvent>(SYNC_EVENTS.OAUTH_ERROR, callback),

  onClockSkewWarning: (callback: (event: ClockSkewWarningEvent) => void): (() => void) =>
    subscribe<ClockSkewWarningEvent>(SYNC_EVENTS.CLOCK_SKEW_WARNING, callback),

  onSecurityWarning: (callback: (event: SecurityWarningEvent) => void): (() => void) =>
    subscribe<SecurityWarningEvent>(SYNC_EVENTS.SECURITY_WARNING, callback),

  onCertificatePinFailed: (callback: (event: CertificatePinFailedEvent) => void): (() => void) =>
    subscribe<CertificatePinFailedEvent>(SYNC_EVENTS.CERTIFICATE_PIN_FAILED, callback)
}
