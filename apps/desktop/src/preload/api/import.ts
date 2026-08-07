import {
  ImportChannels,
  OneNoteImportChannels,
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
  type OneNoteNotebooksResult
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
  onenote: {
    status: (): Promise<OneNoteAuthStatusResult> =>
      invoke<OneNoteAuthStatusResult>(OneNoteImportChannels.invoke.STATUS),
    connect: (): Promise<OneNoteAuthStatusResult> =>
      invoke<OneNoteAuthStatusResult>(OneNoteImportChannels.invoke.CONNECT),
    disconnect: (): Promise<{ success: true }> =>
      invoke<{ success: true }>(OneNoteImportChannels.invoke.DISCONNECT),
    notebooks: (): Promise<OneNoteNotebooksResult> =>
      invoke<OneNoteNotebooksResult>(OneNoteImportChannels.invoke.NOTEBOOKS)
  }
}

export const importEvents = {
  onImportProgress: (callback: (event: ImportProgressEvent) => void): (() => void) =>
    subscribe<ImportProgressEvent>(ImportChannels.events.PROGRESS, callback)
}
