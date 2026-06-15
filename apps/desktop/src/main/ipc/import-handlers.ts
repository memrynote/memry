import { ipcMain } from 'electron'
import {
  ImportChannels,
  ImportStartSchema,
  ImportCancelSchema
} from '@memry/contracts/import-channels'
import { registerCommand } from './lib/register-command'
import { registerBuiltinImporters } from '../import/register-builtins'
import { runImport, cancelImport } from '../import/runner'

/**
 * Generic import IPC: start a run (resolves with the final summary) and cancel
 * an in-flight run. Progress streams over `ImportChannels.events.PROGRESS` from
 * the import context. Importer-specific logic lives in `src/main/import`.
 */
export function registerImportHandlers(): void {
  registerBuiltinImporters()

  registerCommand(
    ImportChannels.invoke.START,
    ImportStartSchema,
    async (input) => {
      const summary = await runImport(input)
      return { success: true as const, summary }
    },
    'Import failed'
  )

  registerCommand(
    ImportChannels.invoke.CANCEL,
    ImportCancelSchema,
    (input) => {
      cancelImport(input.importId)
      return { success: true as const }
    },
    'Cancel failed'
  )
}

export function unregisterImportHandlers(): void {
  ipcMain.removeHandler(ImportChannels.invoke.START)
  ipcMain.removeHandler(ImportChannels.invoke.CANCEL)
}
