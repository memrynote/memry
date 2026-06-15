import {
  ImportChannels,
  type ImportStartInput,
  type ImportStartResult,
  type ImportCancelInput,
  type ImportPickFilesInput,
  type ImportPickFilesResult,
  type ImportProgressEvent
} from '@memry/contracts/import-channels'
import { invoke, subscribe } from '../lib/ipc'

export const importApi = {
  pickFiles: (input: ImportPickFilesInput): Promise<ImportPickFilesResult> =>
    invoke<ImportPickFilesResult>(ImportChannels.invoke.PICK_FILES, input),
  start: (input: ImportStartInput): Promise<ImportStartResult> =>
    invoke<ImportStartResult>(ImportChannels.invoke.START, input),
  cancel: (input: ImportCancelInput): Promise<{ success: true }> =>
    invoke<{ success: true }>(ImportChannels.invoke.CANCEL, input)
}

export const importEvents = {
  onImportProgress: (callback: (event: ImportProgressEvent) => void): (() => void) =>
    subscribe<ImportProgressEvent>(ImportChannels.events.PROGRESS, callback)
}
