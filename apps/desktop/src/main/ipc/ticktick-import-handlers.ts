/**
 * TickTick import IPC handlers.
 *
 * @module ipc/ticktick-import-handlers
 */

import { ipcMain, dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { TickTickImportChannels } from '@memry/contracts/ipc-channels'
import type { TickTickImportSummary } from '@memry/contracts/ticktick-import-api'
import { requireDatabase } from '../database'
import { createHandler } from './validate'
import { importTickTickCsv } from '../import/ticktick/ticktick-import-service'
import { createLogger } from '../lib/logger'

const log = createLogger('IPC:TickTickImport')

const EMPTY_SUMMARY: TickTickImportSummary = {
  canceled: true,
  stats: { rows: 0, projects: 0, tasks: 0, subtasks: 0, reminders: 0 },
  warnings: []
}

export function registerTickTickImportHandlers(): void {
  ipcMain.handle(
    TickTickImportChannels.invoke.RUN,
    createHandler(async (): Promise<TickTickImportSummary> => {
      const db = requireDatabase()
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'CSV', extensions: ['csv'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) return EMPTY_SUMMARY
      const csvText = await readFile(result.filePaths[0], 'utf8')
      try {
        return await importTickTickCsv(db, csvText)
      } catch (err) {
        log.error('TickTick import failed', err)
        throw err instanceof Error ? err : new Error('TickTick import failed')
      }
    })
  )
}

export function unregisterTickTickImportHandlers(): void {
  ipcMain.removeHandler(TickTickImportChannels.invoke.RUN)
}
