import { ipcMain } from 'electron'
import { RecentsChannels } from '@memry/contracts/ipc-channels'
import {
  ListRecentlyOpenedSchema,
  RecordRecentlyOpenedSchema,
  RECENTLY_OPENED_LIMIT,
  type RecentlyOpenedItem
} from '@memry/contracts/recents-api'
import { createLogger } from '../lib/logger'
import { createValidatedHandler } from './validate'
import { getDatabase, getIndexDatabase } from '../database'
import { generateId } from '../lib/id'
import { recentsQueries } from '../recents/store'

const logger = createLogger('IPC:Recents')

export function registerRecentsHandlers(): void {
  ipcMain.handle(
    RecentsChannels.invoke.RECORD,
    createValidatedHandler(RecordRecentlyOpenedSchema, async (input) => {
      // The trail is a convenience surface, never a blocker: a failed write
      // must not turn opening a note into a visible error.
      try {
        recentsQueries.recordRecentlyOpened(getDatabase(), {
          id: generateId(),
          itemId: input.itemId,
          itemType: input.itemType,
          openedAt: new Date().toISOString()
        })
        return { recorded: true as const }
      } catch (error) {
        logger.error('recents:record failed:', error)
        return { recorded: false as const }
      }
    })
  )

  ipcMain.handle(
    RecentsChannels.invoke.LIST,
    createValidatedHandler(ListRecentlyOpenedSchema, async (input) => {
      try {
        return recentsQueries.listRecentlyOpened(
          getDatabase(),
          getIndexDatabase(),
          input.limit ?? RECENTLY_OPENED_LIMIT
        )
      } catch (error) {
        logger.error('recents:list failed:', error)
        return [] as RecentlyOpenedItem[]
      }
    })
  )
}

export function unregisterRecentsHandlers(): void {
  ipcMain.removeHandler(RecentsChannels.invoke.RECORD)
  ipcMain.removeHandler(RecentsChannels.invoke.LIST)
}
