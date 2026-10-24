import { ipcMain, net } from 'electron'
import { nanoid } from 'nanoid'
import { HomePagesChannels } from '@memry/contracts/ipc-channels'
import {
  HomePageCreateSchema,
  HomePageUpdateSchema,
  HomePageReorderSchema,
  HomePageSetCoverFramingSchema,
  HomePageSetCoverSchema,
  type HomePage,
  type HomePageSetCoverResult,
  type WidgetInstance
} from '@memry/contracts/home-page-api'
import {
  listHomePages,
  getHomePage,
  insertHomePage,
  updateHomePage,
  deleteHomePage,
  reorderHomePages
} from '../home/store'
import type { DataDb } from '../database/types'
import type { HomePageRow } from '@memry/db-schema/schema/home-pages'
import { requireDatabase } from '../database'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import {
  enqueueHomePageCreate,
  enqueueHomePageDelete,
  enqueueHomePageUpdate
} from '../home/runtime-effects'
import {
  deleteHomeCoverFiles,
  reconcileHomeCovers,
  removeHomeCover,
  requireVaultPath,
  setHomeCover,
  setHomeCoverFraming
} from '../home/cover-service'
import { createLogger } from '../lib/logger'

const log = createLogger('HomePageHandlers')

// Legacy span (S/M/L) → grid coords, for boards saved before the resizable-grid migration.
const LEGACY_SPAN: Record<string, { w: number; h: number }> = {
  S: { w: 2, h: 2 },
  M: { w: 4, h: 4 },
  L: { w: 8, h: 4 }
}

/**
 * An unparseable blob used to throw out of `home-pages:list`, which made the
 * renderer's `boards` fall back to `[]` with `isLoading: false` — tripping the
 * first-run seed and minting a brand-new board on every launch. Degrade the one
 * bad row to an empty board instead.
 */
function parseWidgets(row: HomePageRow): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(row.widgets) as unknown
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped external object narrowed to a loose record; members are checked before use
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : []
  } catch {
    log.warn('Home board has an unparseable widgets blob, rendering it empty', { id: row.id })
    return []
  }
}

function rowToHomePage(row: HomePageRow): HomePage {
  const raw = parseWidgets(row)
  let y = 0
  const widgets = raw.map((w): WidgetInstance => {
    if (
      typeof w.x === 'number' &&
      typeof w.y === 'number' &&
      typeof w.w === 'number' &&
      typeof w.h === 'number'
    ) {
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- foreign runtime object with no published type for this member; shape checked at use
      return w as unknown as WidgetInstance
    }
    // ponytail: migrate old {size} widgets on read; the next drag/resize persists real coords and
    // react-grid-layout compacts any overlap. Remove once no legacy boards remain (pre-production).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- value from an untyped boundary (database, parser or runtime); the asserted shape is what its producer writes
    const span = LEGACY_SPAN[w.size as string] ?? LEGACY_SPAN.M
    const migrated: WidgetInstance = {
      id: String(w.id),
      type: String(w.type),
      x: 0,
      y,
      w: span.w,
      h: span.h,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped external object narrowed to a loose record; members are checked before use
      config: (w.config as Record<string, unknown>) ?? {}
    }
    y += span.h
    return migrated
  })
  return {
    id: row.id,
    name: row.name,
    icon: row.icon ?? undefined,
    position: row.position,
    widgets,
    ...(row.cover ? { cover: row.cover } : {})
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
      enqueueHomePageCreate(row.id)
      broadcastToAllWindows(HomePagesChannels.events.CREATED, { id: row.id })
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
      enqueueHomePageUpdate(row.id)
      broadcastToAllWindows(HomePagesChannels.events.UPDATED, { id: row.id })
      return rowToHomePage(row)
    },
    delete: async (id: string): Promise<{ success: boolean }> => {
      // Snapshot BEFORE deleting: RecordSyncController.enqueueDelete returns
      // early on a null payload, so without it the tombstone is silently dropped
      // and the board resurrects from peers on the next pull.
      const snapshot = getHomePage(db, id)
      const success = deleteHomePage(db, id)
      if (!success) return { success }
      enqueueHomePageDelete(id, snapshot)
      broadcastToAllWindows(HomePagesChannels.events.DELETED, { id })
      await deleteHomeCoverFiles(id)
      return { success }
    },
    reorder: async (input: unknown): Promise<{ success: boolean }> => {
      const { ids } = HomePageReorderSchema.parse(input)
      for (const id of reorderHomePages(db, ids)) {
        enqueueHomePageUpdate(id)
        broadcastToAllWindows(HomePagesChannels.events.UPDATED, { id })
      }
      return { success: true }
    },
    setCover: async (input: unknown): Promise<HomePageSetCoverResult> => {
      const { id, source } = HomePageSetCoverSchema.parse(input)
      // `net.fetch` rather than global fetch: it honours the system proxy and
      // the app's session, like every other outbound call in main.
      const result = await setHomeCover(id, source, {
        db,
        vaultPath: requireVaultPath(),
        fetch: (url, init) => net.fetch(url, init)
      })
      return result.ok ? { ok: true, page: rowToHomePage(result.row) } : result
    },
    setCoverFraming: async (input: unknown): Promise<HomePage> => {
      const { id, changes } = HomePageSetCoverFramingSchema.parse(input)
      return rowToHomePage(setHomeCoverFraming(db, id, changes))
    },
    removeCover: async (id: string): Promise<HomePage> =>
      rowToHomePage(await removeHomeCover(db, requireVaultPath(), id)),
    materializeCover: async (id: string): Promise<{ success: boolean }> => {
      await reconcileHomeCovers({ db, vaultPath: requireVaultPath() }, id)
      return { success: true }
    }
  }
}

export function registerHomePageHandlers(): void {
  ipcMain.handle(HomePagesChannels.invoke.LIST, () =>
    makeHomePageHandlers(requireDatabase()).list()
  )
  ipcMain.handle(HomePagesChannels.invoke.GET, (_e, id: string) =>
    makeHomePageHandlers(requireDatabase()).get(id)
  )
  ipcMain.handle(HomePagesChannels.invoke.CREATE, (_e, input) =>
    makeHomePageHandlers(requireDatabase()).create(input)
  )
  ipcMain.handle(HomePagesChannels.invoke.UPDATE, (_e, input) =>
    makeHomePageHandlers(requireDatabase()).update(input)
  )
  ipcMain.handle(HomePagesChannels.invoke.DELETE, (_e, id: string) =>
    makeHomePageHandlers(requireDatabase()).delete(id)
  )
  ipcMain.handle(HomePagesChannels.invoke.REORDER, (_e, input) =>
    makeHomePageHandlers(requireDatabase()).reorder(input)
  )
  ipcMain.handle(HomePagesChannels.invoke.SET_COVER, (_e, input) =>
    makeHomePageHandlers(requireDatabase()).setCover(input)
  )
  ipcMain.handle(HomePagesChannels.invoke.SET_COVER_FRAMING, (_e, input) =>
    makeHomePageHandlers(requireDatabase()).setCoverFraming(input)
  )
  ipcMain.handle(HomePagesChannels.invoke.REMOVE_COVER, (_e, id: string) =>
    makeHomePageHandlers(requireDatabase()).removeCover(id)
  )
  ipcMain.handle(HomePagesChannels.invoke.MATERIALIZE_COVER, (_e, id: string) =>
    makeHomePageHandlers(requireDatabase()).materializeCover(id)
  )
}

export function unregisterHomePageHandlers(): void {
  ipcMain.removeHandler(HomePagesChannels.invoke.LIST)
  ipcMain.removeHandler(HomePagesChannels.invoke.GET)
  ipcMain.removeHandler(HomePagesChannels.invoke.CREATE)
  ipcMain.removeHandler(HomePagesChannels.invoke.UPDATE)
  ipcMain.removeHandler(HomePagesChannels.invoke.DELETE)
  ipcMain.removeHandler(HomePagesChannels.invoke.REORDER)
  ipcMain.removeHandler(HomePagesChannels.invoke.SET_COVER)
  ipcMain.removeHandler(HomePagesChannels.invoke.SET_COVER_FRAMING)
  ipcMain.removeHandler(HomePagesChannels.invoke.REMOVE_COVER)
  ipcMain.removeHandler(HomePagesChannels.invoke.MATERIALIZE_COVER)
}
