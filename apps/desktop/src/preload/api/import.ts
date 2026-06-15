import {
  ImportChannels,
  type ImportStartInput,
  type ImportStartResponse,
  type ImportCancelInput,
  type ImportPickFilesInput,
  type ImportPickFilesResult,
  type ImportProgressEvent,
  type ImportPreviewInput,
  type ImportPreviewResponse,
  type ImporterMeta
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
  list: (): Promise<ImporterMeta[]> => invoke<ImporterMeta[]>(ImportChannels.invoke.LIST)
}

export const importEvents = {
  onImportProgress: (callback: (event: ImportProgressEvent) => void): (() => void) =>
    subscribe<ImportProgressEvent>(ImportChannels.events.PROGRESS, callback)
}
