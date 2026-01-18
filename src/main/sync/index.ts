/**
 * Sync Module
 *
 * Central export point for sync-related functionality.
 *
 * @module main/sync
 */

// =============================================================================
// Vector Clock
// =============================================================================

export {
  // Types
  ClockComparison,
  // Basic operations
  createClock,
  incrementClock,
  getTime,
  getDevices,
  // Merge operations
  mergeClock,
  updateClockFromRemote,
  // Comparison operations
  compareClock,
  isAncestor,
  isConcurrent,
  dominates,
  // Serialization
  serializeClock,
  deserializeClock,
  // Utilities
  clockSum,
  clockMax,
  isEmptyClock,
  copyClock,
  removeDevice
} from './vector-clock'

// =============================================================================
// API Client
// =============================================================================

export { SyncApiClient, SyncApiError, syncApi } from './api-client'
export type {
  ApiError,
  AuthResult,
  DevicePublic,
  RecoveryData,
  SignupResponse,
  MessageResponse,
  RefreshResponse
} from './api-client'

// =============================================================================
// Sync Queue
// =============================================================================

export { SyncQueueManager, getSyncQueue, resetSyncQueue, SyncPriority } from './queue'
export type { QueueItemInput, QueueStats, SyncPriorityLevel } from './queue'

// =============================================================================
// Retry Logic
// =============================================================================

export {
  calculateNextRetry,
  categorizeError,
  isRetryableError,
  isPermanentError,
  shouldRetry,
  withRetry,
  getRetryDescription,
  ErrorCategory,
  MAX_RETRY_ATTEMPTS,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  JITTER_FACTOR
} from './retry'
export type { RetryOptions } from './retry'

// =============================================================================
// Network Monitor
// =============================================================================

export { NetworkMonitor, getNetworkMonitor, resetNetworkMonitor } from './network'
export type { NetworkStatus, NetworkStatusEvent, NetworkMonitorEvents } from './network'

// =============================================================================
// WebSocket Manager
// =============================================================================

export { WebSocketManager, getWebSocketManager, resetWebSocketManager } from './websocket'
export type {
  WebSocketState,
  ServerMessageType,
  ClientMessageType,
  ServerMessage,
  ClientMessage,
  ItemSyncedPayload,
  LinkingRequestPayload,
  DeviceRemovedPayload,
  WebSocketEvents
} from './websocket'

// =============================================================================
// Sync Engine
// =============================================================================

export { SyncEngine, getSyncEngine, resetSyncEngine } from './engine'
export type { SyncEngineConfig, SyncEngineEvents } from './engine'

// =============================================================================
// Sync Triggers
// =============================================================================

export {
  isSyncEnabled,
  queueTaskSync,
  queueProjectSync,
  queueInboxItemSync,
  queueSavedFilterSync,
  queueSettingsSync,
  queueNoteSync,
  queueAttachmentSync,
  queueBulkSync
} from './triggers'
export type { SyncTriggerOptions } from './triggers'

// =============================================================================
// Bootstrap
// =============================================================================

export { performBootstrap, hasBootstrapped, markBootstrapped } from './bootstrap'
export type { BootstrapResult } from './bootstrap'
