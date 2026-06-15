/**
 * Todoist import IPC handlers.
 *
 * @module ipc/todoist-import-handlers
 */

import { ipcMain, dialog } from 'electron'
import { TodoistImportChannels } from '@memry/contracts/ipc-channels'
import { TodoistImportRunSchema } from '@memry/contracts/todoist-import-api'
import { createHandler, createValidatedHandler } from './validate'
import { previewTodoistImport, runTodoistImport } from '../import/todoist/todoist-import-service'
import { createLogger } from '../lib/logger'

const logger = createLogger('IPC:TodoistImport')

export function registerTodoistImportHandlers(): void {
  // todoist-import:preview — open a file dialog, parse selected CSVs, report counts (no writes)
  ipcMain.handle(
    TodoistImportChannels.invoke.PREVIEW,
    createHandler(async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Todoist CSV', extensions: ['csv'] }]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const }
      }
      const files = await previewTodoistImport(result.filePaths)
      return { canceled: false as const, filePaths: result.filePaths, files }
    })
  )

  // todoist-import:run — apply the parsed plan for the given files
  ipcMain.handle(
    TodoistImportChannels.invoke.RUN,
    createValidatedHandler(TodoistImportRunSchema, async (input) => {
      logger.info('Importing Todoist files', input.filePaths.length)
      return runTodoistImport(input.filePaths)
    })
  )
}

export function unregisterTodoistImportHandlers(): void {
  Object.values(TodoistImportChannels.invoke).forEach((channel) => ipcMain.removeHandler(channel))
}
