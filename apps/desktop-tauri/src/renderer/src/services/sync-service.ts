import type {
  CertificatePinFailedEvent,
  ClockSkewWarningEvent,
  InitialSyncProgressEvent,
  QueueClearedEvent,
  SecurityWarningEvent,
  SyncStatusChangedEvent
} from '@memry/contracts/ipc-events'
import type { SyncControlSurface, TriggerSyncResult } from '@memry/contracts/ipc-sync-ops'

import {
  commands,
  events,
  type SyncItemSyncedEvent,
  type SyncStatus,
  type Value
} from '../../../generated/bindings'
import { subscribeToEvent } from './tauri-event'

/** Rust leaves an absent field off the wire; the contract types spell it optional. */
function toStatus(status: SyncStatus): SyncStatusChangedEvent {
  return {
    status: status.status,
    pendingCount: status.pendingCount,
    lastSyncAt: status.lastSyncAt ?? undefined,
    error: status.error ?? undefined,
    errorCategory: status.errorCategory ?? undefined,
    offlineSince: status.offlineSince ?? undefined
  }
}

/**
 * The open vault's sync over its Rust commands (`commands/sync.rs`), under the Electron
 * `window.api.syncOps` names. The account side (sign-out, vault binding) is
 * `sync-account-service`; the storage breakdown (Step 18) and device key repair (Step 19) are
 * not ported yet.
 */
export const syncService = {
  getStatus: (): Promise<SyncStatusChangedEvent> => commands.syncGetStatus().then(toStatus),

  triggerSync: (): Promise<TriggerSyncResult> =>
    commands
      .syncTrigger()
      .then(({ success, reason, error }) =>
        success ? { success } : { success, reason: reason ?? 'failed', ...(error ? { error } : {}) }
      ),

  getHistory: (input: { limit?: number; offset?: number }) =>
    commands.syncGetHistory({ limit: input.limit ?? null, offset: input.offset ?? null }),

  getQueueSize: () => commands.syncGetQueueSize(),

  pause: (surface: SyncControlSurface) => commands.syncPause({ surface }),

  resume: (surface: SyncControlSurface) => commands.syncResume({ surface }),

  updateSyncedSetting: (fieldPath: string, value: Value) =>
    commands.syncUpdateSyncedSetting({ fieldPath, value }),

  getSyncedSettings: () => commands.syncGetSyncedSettings(),

  getLargeNotes: () => commands.syncGetLargeNotes(),

  getNoteSyncState: (noteId: string) => commands.syncGetNoteSyncState({ noteId }),

  getUnsentNotes: () => commands.syncGetUnsentNotes(),

  getQuarantinedItems: () => commands.syncGetQuarantinedItems()
}

export const onSyncStatusChanged = (
  callback: (event: SyncStatusChangedEvent) => void
): (() => void) =>
  subscribeToEvent(events.syncStatusChangedEvent, (status) => callback(toStatus(status)))

export const onItemSynced = (callback: (event: SyncItemSyncedEvent) => void): (() => void) =>
  subscribeToEvent(events.syncItemSyncedEvent, callback)

export const onQueueCleared = (callback: (event: QueueClearedEvent) => void): (() => void) =>
  subscribeToEvent(events.syncQueueClearedEvent, callback)

export const onClockSkewWarning = (
  callback: (event: ClockSkewWarningEvent) => void
): (() => void) => subscribeToEvent(events.syncClockSkewWarningEvent, callback)

export const onInitialSyncProgress = (
  callback: (event: InitialSyncProgressEvent) => void
): (() => void) =>
  subscribeToEvent(events.syncInitialSyncProgressEvent, ({ currentItemType, ...progress }) =>
    callback({ ...progress, ...(currentItemType ? { currentItemType } : {}) })
  )

export const onSecurityWarning = (callback: (event: SecurityWarningEvent) => void): (() => void) =>
  subscribeToEvent(events.syncSecurityWarningEvent, callback)

export const onCertificatePinFailed = (
  callback: (event: CertificatePinFailedEvent) => void
): (() => void) => subscribeToEvent(events.syncCertificatePinFailedEvent, callback)
