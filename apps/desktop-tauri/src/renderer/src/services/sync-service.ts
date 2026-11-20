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
  type SyncedItem,
  type SyncStatus,
  type Value
} from '../../../generated/bindings'
import { subscribeToEvent, subscribeToEvents } from './tauri-event'

/** How long a subscriber gathers pulled pages before it hears them, from the first one. */
const COALESCE_MS = 150

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
 * `window.api.syncOps` names. The account side (sign-out, vault binding, device key repair) is
 * `sync-account-service`; the storage breakdown (Step 18) is not ported yet.
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

  getUnsentNotes: () => commands.syncGetUnsentNotes()
}

/** `onListening` runs once the listener is live; a status sent before then reached nobody (#4270). */
export const onSyncStatusChanged = (
  callback: (event: SyncStatusChangedEvent) => void,
  onListening?: () => void
): (() => void) =>
  subscribeToEvent(
    events.syncStatusChangedEvent,
    (status) => callback(toStatus(status)),
    onListening
  )

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

/**
 * The records sync pulled, of `types` or of every type: one call per 150 ms of pages, each
 * record once with its last operation. Main sends one event per committed page, and a pull of
 * many pages would otherwise refetch once per page. Notes and journals never arrive here: their
 * events come from the vault (`onNoteUpdated`, the journal events).
 *
 * `onListening` runs once the events reach this page. A page main sends before then reaches
 * nobody and names no record, so a subscriber that reads what the records change reads it all
 * again there (`subscribeToEvents`).
 */
export function onSyncedRecords(
  types: readonly string[] | 'all',
  callback: (items: SyncedItem[]) => void,
  onListening?: () => void
): () => void {
  let pending = new Map<string, SyncedItem>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    timer = null
    const items = [...pending.values()]
    pending = new Map()
    callback(items)
  }
  const stop = subscribeToEvent(
    events.syncItemSyncedEvent,
    ({ items }) => {
      for (const item of items) {
        if (types !== 'all' && !types.includes(item.type)) continue
        const key = `${item.type}\u0000${item.itemId}`
        pending.delete(key)
        pending.set(key, item)
      }
      if (pending.size > 0 && timer === null) timer = setTimeout(flush, COALESCE_MS)
    },
    onListening
  )
  return () => {
    stop()
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * A domain's own event and the records of `types` sync pulled, as one subscription. Electron's
 * item handlers sent the domain's events when they applied a pulled record; here main sends
 * only the pulled page, so the domain's subscription hears it through `onSynced`.
 * `onListening` runs once both reach this page.
 */
export function withSyncedRecords(
  subscribeLocal: (onListening: () => void) => () => void,
  types: readonly string[],
  onSynced: (items: SyncedItem[]) => void,
  onListening?: () => void
): () => void {
  return subscribeToEvents([subscribeLocal, (live) => onSyncedRecords(types, onSynced, live)], () =>
    onListening?.()
  )
}
