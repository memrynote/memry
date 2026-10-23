import { ipcMain } from 'electron'
import { GraphChannels } from '@memry/contracts/ipc-channels'
import {
  GraphLayoutViewKeySchema,
  SaveGraphLayoutRequestSchema,
  type GraphLayout
} from '@memry/contracts/graph-api'
import { createLogger } from '../lib/logger'
import { getDatabase, getIndexDatabase } from '../database/client'
import {
  clearGraphLayout,
  getGraphData,
  getGraphLayout,
  getLocalGraph,
  saveGraphLayout
} from '../graph/store'
import { createValidatedHandler } from './validate'

const logger = createLogger('IPC:Graph')

export function registerGraphHandlers(): void {
  ipcMain.handle(GraphChannels.invoke.GET_GRAPH_DATA, () => {
    try {
      const indexDb = getIndexDatabase()
      const dataDb = getDatabase()
      return getGraphData(indexDb, dataDb)
    } catch (error) {
      logger.error('Failed to get graph data:', error)
      throw error
    }
  })

  ipcMain.handle(
    GraphChannels.invoke.GET_LOCAL_GRAPH,
    (_event, params: { noteId: string; depth?: number }) => {
      try {
        const indexDb = getIndexDatabase()
        const dataDb = getDatabase()
        return getLocalGraph(indexDb, dataDb, params.noteId, params.depth ?? 2)
      } catch (error) {
        logger.error('Failed to get local graph:', error)
        throw error
      }
    }
  )

  ipcMain.handle(
    GraphChannels.invoke.GET_LAYOUT,
    createValidatedHandler(GraphLayoutViewKeySchema, (viewKey): GraphLayout | null =>
      getGraphLayout(getIndexDatabase(), viewKey)
    )
  )

  ipcMain.handle(
    GraphChannels.invoke.SAVE_LAYOUT,
    createValidatedHandler(SaveGraphLayoutRequestSchema, (input): void =>
      saveGraphLayout(getIndexDatabase(), input.viewKey, input.layout)
    )
  )

  ipcMain.handle(
    GraphChannels.invoke.CLEAR_LAYOUT,
    createValidatedHandler(GraphLayoutViewKeySchema, (viewKey): void =>
      clearGraphLayout(getIndexDatabase(), viewKey)
    )
  )
}

export function unregisterGraphHandlers(): void {
  ipcMain.removeHandler(GraphChannels.invoke.GET_GRAPH_DATA)
  ipcMain.removeHandler(GraphChannels.invoke.GET_LOCAL_GRAPH)
  ipcMain.removeHandler(GraphChannels.invoke.GET_LAYOUT)
  ipcMain.removeHandler(GraphChannels.invoke.SAVE_LAYOUT)
  ipcMain.removeHandler(GraphChannels.invoke.CLEAR_LAYOUT)

  logger.info('Graph handlers unregistered')
}
