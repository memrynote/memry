import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import { invoke, subscribe } from '../lib/ipc'

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
  verifySignature: (input: DecryptInput) => invoke(SYNC_CHANNELS.VERIFY_SIGNATURE, input),
  rotateKeys: (input: { confirm: boolean }) => invoke(SYNC_CHANNELS.ROTATE_KEYS, input),
  getRotationProgress: () => invoke(SYNC_CHANNELS.GET_ROTATION_PROGRESS)
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
  applyUpdate: (input: { noteId: string; update: number[] }) =>
    invoke(SYNC_CHANNELS.APPLY_UPDATE, input),
  syncStep1: (input: { noteId: string; stateVector: number[] }) =>
    invoke(SYNC_CHANNELS.SYNC_STEP_1, input),
  syncStep2: (input: { noteId: string; diff: number[] }) => invoke(SYNC_CHANNELS.SYNC_STEP_2, input)
}

export const onCrdtStateChanged = (
  callback: (data: { noteId: string; update: number[]; origin: string }) => void
): (() => void) =>
  subscribe<{ noteId: string; update: number[]; origin: string }>(
    SYNC_EVENTS.STATE_CHANGED,
    callback
  )
