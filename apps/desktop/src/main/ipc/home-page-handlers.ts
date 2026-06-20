import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { HomePagesChannels } from '@memry/contracts/ipc-channels'
import {
  HomePageCreateSchema,
  HomePageUpdateSchema,
  HomePageReorderSchema,
  type HomePage,
  type WidgetInstance
} from '@memry/contracts/home-page-api'
import {
  listHomePages,
  getHomePage,
  insertHomePage,
  updateHomePage,
  deleteHomePage,
  reorderHomePages
} from '../database/queries/home-pages'
import type { DataDb } from '../database/types'
import type { HomePageRow } from '@memry/db-schema/schema/home-pages'
import { requireDatabase } from '../database'

function rowToHomePage(row: HomePageRow): HomePage {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon ?? undefined,
    position: row.position,
    widgets: JSON.parse(row.widgets) as WidgetInstance[]
  }
}

export function makeHomePageHandlers(db: DataDb) {
  return {
    list: async (): Promise<HomePage[]> => listHomePages(db).map(rowToHomePage),
    get: async (id: string): Promise<HomePage | null> => {
      const row = getHomePage(db, id)
      return row ? rowToHomePage(row) : null
    },
    create: async (input: unknown): Promise<HomePage> => {
      const data = HomePageCreateSchema.parse(input)
      const row = insertHomePage(db, {
        id: nanoid(),
        name: data.name,
        icon: data.icon ?? null,
        position: data.position,
        widgets: JSON.stringify(data.widgets)
      })
      return rowToHomePage(row)
    },
    update: async (input: unknown): Promise<HomePage> => {
      const data = HomePageUpdateSchema.parse(input)
      const row = updateHomePage(db, data.id, {
        name: data.name,
        icon: data.icon,
        position: data.position,
        widgets: data.widgets !== undefined ? JSON.stringify(data.widgets) : undefined
      })
      if (!row) throw new Error(`Home page ${data.id} not found`)
      return rowToHomePage(row)
    },
    delete: async (id: string): Promise<{ success: boolean }> => ({
      success: deleteHomePage(db, id)
    }),
    reorder: async (input: unknown): Promise<{ success: boolean }> => {
      const { ids } = HomePageReorderSchema.parse(input)
      reorderHomePages(db, ids)
      return { success: true }
    }
  }
}

export function registerHomePageHandlers(): void {
  ipcMain.handle(HomePagesChannels.LIST, () => makeHomePageHandlers(requireDatabase()).list())
  ipcMain.handle(HomePagesChannels.GET, (_e, id: string) =>
    makeHomePageHandlers(requireDatabase()).get(id)
  )
  ipcMain.handle(HomePagesChannels.CREATE, (_e, input) =>
    makeHomePageHandlers(requireDatabase()).create(input)
  )
  ipcMain.handle(HomePagesChannels.UPDATE, (_e, input) =>
    makeHomePageHandlers(requireDatabase()).update(input)
  )
  ipcMain.handle(HomePagesChannels.DELETE, (_e, id: string) =>
    makeHomePageHandlers(requireDatabase()).delete(id)
  )
  ipcMain.handle(HomePagesChannels.REORDER, (_e, input) =>
    makeHomePageHandlers(requireDatabase()).reorder(input)
  )
}

export function unregisterHomePageHandlers(): void {
  ipcMain.removeHandler(HomePagesChannels.LIST)
  ipcMain.removeHandler(HomePagesChannels.GET)
  ipcMain.removeHandler(HomePagesChannels.CREATE)
  ipcMain.removeHandler(HomePagesChannels.UPDATE)
  ipcMain.removeHandler(HomePagesChannels.DELETE)
  ipcMain.removeHandler(HomePagesChannels.REORDER)
}
