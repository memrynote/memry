import { ipcMain, dialog } from 'electron'
import { z } from 'zod'
import {
  ImportChannels,
  ImportStartSchema,
  ImportCancelSchema,
  ImportPickFilesSchema,
  ImportPreviewSchema
} from '@memry/contracts/import-channels'
import { registerCommand } from './lib/register-command'
import { registerBuiltinImporters } from '../import/register-builtins'
import { listImporterMeta } from '../import/registry'
import { runImport, previewImport, cancelImport } from '../import/runner'

/**
 * Generic import IPC: start a run (resolves with the final summary) and cancel
 * an in-flight run. Progress streams over `ImportChannels.events.PROGRESS` from
 * the import context. Importer-specific logic lives in `src/main/import`.
 */
export function registerImportHandlers(): void {
  registerBuiltinImporters()

  registerCommand(
    ImportChannels.invoke.PICK_FILES,
    ImportPickFilesSchema,
    async (input) => {
      // A directory pick grants recursive read of the chosen folder (macOS
      // user-consent), letting us read the protected Apple Notes container —
      // database + attachments — without Full Disk Access.
      const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = input.directory
        ? ['openDirectory']
        : input.allowMultiple
          ? ['openFile', 'multiSelections']
          : ['openFile']
      const result = await dialog.showOpenDialog({
        properties,
        defaultPath: input.defaultPath,
        message: input.message,
        ...(input.directory
          ? {}
          : { filters: [{ name: input.label, extensions: input.extensions }] })
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const, filePaths: [] }
      }
      return { canceled: false as const, filePaths: result.filePaths }
    },
    'errors:importer.fileSelectionFailed'
  )

  registerCommand(
    ImportChannels.invoke.START,
    ImportStartSchema,
    async (input) => {
      const summary = await runImport(input)
      return { success: true as const, summary }
    },
    'errors:importer.importFailed'
  )

  registerCommand(
    ImportChannels.invoke.CANCEL,
    ImportCancelSchema,
    (input) => {
      cancelImport(input.importId)
      return { success: true as const }
    },
    'errors:importer.cancelFailed'
  )

  registerCommand(
    ImportChannels.invoke.PREVIEW,
    ImportPreviewSchema,
    async (input) => {
      const preview = await previewImport(input)
      return { success: true as const, preview }
    },
    'errors:importer.previewFailed'
  )

  registerCommand(
    ImportChannels.invoke.LIST,
    z.unknown(),
    () => listImporterMeta(),
    'errors:importer.listFailed'
  )
}

export function unregisterImportHandlers(): void {
  ipcMain.removeHandler(ImportChannels.invoke.PICK_FILES)
  ipcMain.removeHandler(ImportChannels.invoke.START)
  ipcMain.removeHandler(ImportChannels.invoke.CANCEL)
  ipcMain.removeHandler(ImportChannels.invoke.PREVIEW)
  ipcMain.removeHandler(ImportChannels.invoke.LIST)
}
