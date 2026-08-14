import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import { invoke, logListenerError, subscribe } from '../lib/ipc'

export const syncOps = {
  getStatus: () => invoke(SYNC_CHANNELS.GET_STATUS),
  triggerSync: () => invoke(SYNC_CHANNELS.TRIGGER_SYNC),
  getHistory: (input: { limit?: number; offset?: number }) =>
    invoke(SYNC_CHANNELS.GET_HISTORY, input),
  getQueueSize: () => invoke(SYNC_CHANNELS.GET_QUEUE_SIZE),
  pause: () => invoke(SYNC_CHANNELS.PAUSE),
  resume: () => invoke(SYNC_CHANNELS.RESUME),
  updateSyncedSetting: (fieldPath: string, value: unknown) =>
    invoke(SYNC_CHANNELS.UPDATE_SYNCED_SETTING, { fieldPath, value }),
  getSyncedSettings: () => invoke(SYNC_CHANNELS.GET_SYNCED_SETTINGS),
  getStorageBreakdown: () => invoke(SYNC_CHANNELS.GET_STORAGE_BREAKDOWN)
}

type CryptoItemType = 'note' | 'task' | 'project' | 'settings'

type DecryptInput = {
  itemId: string
  type: CryptoItemType
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  operation?: 'create' | 'update' | 'delete'
  deletedAt?: number
  metadata?: Record<string, unknown>
}

export const cryptoApi = {
  encryptItem: (input: {
    itemId: string
    type: CryptoItemType
    content: Record<string, unknown>
    operation?: 'create' | 'update' | 'delete'
    deletedAt?: number
    metadata?: Record<string, unknown>
  }) => invoke(SYNC_CHANNELS.ENCRYPT_ITEM, input),
  decryptItem: (input: DecryptInput) => invoke(SYNC_CHANNELS.DECRYPT_ITEM, input),
  verifySignature: (input: DecryptInput) => invoke(SYNC_CHANNELS.VERIFY_SIGNATURE, input)
}

export const syncAttachments = {
  upload: (input: { noteId: string; filePath: string }) =>
    invoke(SYNC_CHANNELS.UPLOAD_ATTACHMENT, input),
  getUploadProgress: (input: { sessionId: string }) =>
    invoke(SYNC_CHANNELS.GET_UPLOAD_PROGRESS, input),
  download: (input: { attachmentId: string; targetPath: string }) =>
    invoke(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT, input),
  getDownloadProgress: (input: { attachmentId: string }) =>
    invoke(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS, input)
}

// CRDT channels are merged into SYNC_CHANNELS (single flat namespace for the preload bridge)
export const syncCrdt = {
  openDoc: (input: { noteId: string }) => invoke(SYNC_CHANNELS.OPEN_DOC, input),
  closeDoc: (input: { noteId: string }) => invoke(SYNC_CHANNELS.CLOSE_DOC, input),
  applyUpdate: (input: { noteId: string; update: Uint8Array }) =>
    invoke(SYNC_CHANNELS.APPLY_UPDATE, input),
  syncStep1: (input: { noteId: string; stateVector: Uint8Array }) =>
    invoke(SYNC_CHANNELS.SYNC_STEP_1, input),
  syncStep2: (input: { noteId: string; diff: Uint8Array }) =>
    invoke(SYNC_CHANNELS.SYNC_STEP_2, input)
}

type CrdtStateChangedPayload = { noteId: string; update: Uint8Array; origin: string }
type CrdtStateChangedCallback = (data: CrdtStateChangedPayload) => void

/**
 * CRDT updates arrive on one global channel, but each subscriber only ever
 * wants one note. Subscribing every open editor's provider to the raw channel
 * made every keystroke in any note walk all N provider callbacks; this registry
 * keeps a single channel subscription for the window and dispatches by noteId,
 * so the cost per update is one map lookup regardless of how many notes are open.
 */
const crdtNoteSubscribers = new Map<string, Set<CrdtStateChangedCallback>>()
let crdtChannelCleanup: (() => void) | null = null

const dispatchCrdtStateChanged = (data: CrdtStateChangedPayload): void => {
  const subscribers = crdtNoteSubscribers.get(data.noteId)
  if (!subscribers) return
  // Snapshot: a callback may unsubscribe itself (teardown) mid-dispatch. The
  // per-callback guard mirrors `subscribe()` — one throwing provider must not
  // starve the others registered for the same note.
  for (const callback of [...subscribers]) {
    try {
      callback(data)
    } catch (error) {
      logListenerError(SYNC_EVENTS.STATE_CHANGED, error)
    }
  }
}

/**
 * Main dropped the provider that owned every open doc. Unlike the update
 * channel this is not note-scoped: every provider in the window is stranded at
 * once, so each one subscribes for itself and rebinds its own note.
 */
export const onCrdtProviderReset = (callback: () => void): (() => void) =>
  subscribe<void>(SYNC_EVENTS.PROVIDER_RESET, callback)

export const onCrdtStateChanged = (
  noteId: string,
  callback: CrdtStateChangedCallback
): (() => void) => {
  let subscribers = crdtNoteSubscribers.get(noteId)
  if (!subscribers) {
    subscribers = new Set()
    crdtNoteSubscribers.set(noteId, subscribers)
  }
  subscribers.add(callback)

  // Attach the channel listener before returning so the caller is live from the
  // moment it subscribes — no window where a main-process broadcast is dropped.
  crdtChannelCleanup ??= subscribe<CrdtStateChangedPayload>(
    SYNC_EVENTS.STATE_CHANGED,
    dispatchCrdtStateChanged
  )

  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true

    const current = crdtNoteSubscribers.get(noteId)
    if (!current) return
    current.delete(callback)
    if (current.size > 0) return

    // Drop the note's bucket so closed notes cannot accumulate, and release the
    // channel listener entirely once nothing is listening (note close, window
    // reload, vault switch).
    crdtNoteSubscribers.delete(noteId)
    if (crdtNoteSubscribers.size === 0) {
      crdtChannelCleanup?.()
      crdtChannelCleanup = null
    }
  }
}
