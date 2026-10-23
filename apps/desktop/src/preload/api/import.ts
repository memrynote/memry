import {
  AppleNotesImportChannels,
  ImportChannels,
  OneNoteImportChannels,
  ReadwiseImportChannels,
  type AppleNotesFoldersInput,
  type AppleNotesFoldersResult,
  type AppleNotesCheckUnlockInput,
  type AppleNotesCheckUnlockResult,
  type ImportStartInput,
  type ImportStartResponse,
  type ImportCancelInput,
  type ImportPickFilesInput,
  type ImportPickFilesResult,
  type ImportProgressEvent,
  type ImportPreviewInput,
  type ImportPreviewResponse,
  type ImporterMeta,
  type OneNoteAuthStatusResult,
  type OneNoteNotebooksResult,
  type ReadwiseConnectInput,
  type ReadwiseBookCommandInput,
  type ReadwiseDeletedBook,
  type ReadwiseRestoreBookInput,
  type ReadwiseSetOptionsInput,
  type ReadwiseStatusResult
} from '@memry/contracts/import-channels'
import { invoke, subscribe } from '../lib/ipc'

export const importApi = {
  pickFiles: (input: ImportPickFilesInput): Promise<ImportPickFilesResult> =>
    invoke<ImportPickFilesResult>(ImportChannels.invoke.PICK_FILES, input),
  start: (input: ImportStartInput): Promise<ImportStartResponse> =>
    invoke<ImportStartResponse>(ImportChannels.invoke.START, input),
  cancel: (input: ImportCancelInput): Promise<{ success: true }> =>
    invoke<{ success: true }>(ImportChannels.invoke.CANCEL, input),
  preview: (input: ImportPreviewInput): Promise<ImportPreviewResponse> =>
    invoke<ImportPreviewResponse>(ImportChannels.invoke.PREVIEW, input),
  list: (): Promise<ImporterMeta[]> => invoke<ImporterMeta[]>(ImportChannels.invoke.LIST),
  appleNotes: {
    folders: (input: AppleNotesFoldersInput): Promise<AppleNotesFoldersResult> =>
      invoke<AppleNotesFoldersResult>(AppleNotesImportChannels.invoke.FOLDERS, input),
    checkUnlock: (input: AppleNotesCheckUnlockInput): Promise<AppleNotesCheckUnlockResult> =>
      invoke<AppleNotesCheckUnlockResult>(AppleNotesImportChannels.invoke.CHECK_UNLOCK, input)
  },
  onenote: {
    status: (): Promise<OneNoteAuthStatusResult> =>
      invoke<OneNoteAuthStatusResult>(OneNoteImportChannels.invoke.STATUS),
    connect: (): Promise<OneNoteAuthStatusResult> =>
      invoke<OneNoteAuthStatusResult>(OneNoteImportChannels.invoke.CONNECT),
    disconnect: (): Promise<{ success: true }> =>
      invoke<{ success: true }>(OneNoteImportChannels.invoke.DISCONNECT),
    notebooks: (): Promise<OneNoteNotebooksResult> =>
      invoke<OneNoteNotebooksResult>(OneNoteImportChannels.invoke.NOTEBOOKS)
  },
  readwise: {
    status: (): Promise<ReadwiseStatusResult> =>
      invoke<ReadwiseStatusResult>(ReadwiseImportChannels.invoke.STATUS),
    connect: (input: ReadwiseConnectInput): Promise<ReadwiseStatusResult> =>
      invoke<ReadwiseStatusResult>(ReadwiseImportChannels.invoke.CONNECT, input),
    disconnect: (): Promise<{ success: true }> =>
      invoke<{ success: true }>(ReadwiseImportChannels.invoke.DISCONNECT),
    syncNow: (): Promise<{ success: true }> =>
      invoke<{ success: true }>(ReadwiseImportChannels.invoke.SYNC_NOW),
    setOptions: (input: ReadwiseSetOptionsInput): Promise<ReadwiseStatusResult> =>
      invoke<ReadwiseStatusResult>(ReadwiseImportChannels.invoke.SET_OPTIONS, input),
    reimportBook: (input: ReadwiseBookCommandInput): Promise<{ success: true }> =>
      invoke<{ success: true }>(ReadwiseImportChannels.invoke.REIMPORT_BOOK, input),
    refreshBook: (input: ReadwiseBookCommandInput): Promise<{ success: true }> =>
      invoke<{ success: true }>(ReadwiseImportChannels.invoke.REFRESH_BOOK, input),
    listDeleted: (): Promise<{ books: ReadwiseDeletedBook[] }> =>
      invoke<{ books: ReadwiseDeletedBook[] }>(ReadwiseImportChannels.invoke.LIST_DELETED),
    restoreBook: (input: ReadwiseRestoreBookInput): Promise<{ success: true }> =>
      invoke<{ success: true }>(ReadwiseImportChannels.invoke.RESTORE_BOOK, input)
  }
}

export const importEvents = {
  onImportProgress: (callback: (event: ImportProgressEvent) => void): (() => void) =>
    subscribe<ImportProgressEvent>(ImportChannels.events.PROGRESS, callback)
}
