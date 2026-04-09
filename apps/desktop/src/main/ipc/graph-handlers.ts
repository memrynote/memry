import { ipcMain } from 'electron'
import { GraphChannels } from '@memry/contracts/ipc-channels'
import { createLogger } from '../lib/logger'
import { getDatabase, getIndexDatabase } from '../database/client'
import { getGraphData, getLocalGraph } from '../graph/store'

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

  logger.info('Graph handlers registered')
}

export function unregisterGraphHandlers(): void {
  ipcMain.removeHandler(GraphChannels.invoke.GET_GRAPH_DATA)
  ipcMain.removeHandler(GraphChannels.invoke.GET_LOCAL_GRAPH)

  logger.info('Graph handlers unregistered')
}
