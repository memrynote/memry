import { ipcMain, nativeImage } from 'electron'
import { nanoid } from 'nanoid'
import { CustomIconsChannels } from '@memry/contracts/ipc-channels'
import {
  CustomIconAddFromUrlSchema,
  CustomIconAddSchema,
  CustomIconRenameSchema,
  CUSTOM_ICON_MAX_EDGE_PX,
  CUSTOM_ICON_MAX_INPUT_BYTES,
  type CustomIcon
} from '@memry/contracts/custom-icons-api'
import type { CustomIconRow } from '@memry/db-schema/schema/custom-icons'
import {
  deleteCustomIcon,
  getCustomIcon,
  insertCustomIcon,
  listCustomIcons,
  renameCustomIcon
} from '../icons/store'
import { downloadRemoteIcon } from '../icons/remote-icon'
import {
  enqueueCustomIconCreate,
  enqueueCustomIconDelete,
  enqueueCustomIconUpdate
} from '../icons/runtime-effects'
import {
  customIconFileExists,
  deleteCustomIconFile,
  getCustomIconFilePath,
  writeCustomIconFile
} from '../vault/custom-icons'
import type { DataDb } from '../database/types'
import { requireDatabase } from '../database'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { createLogger } from '../lib/logger'
import { getMainI18n } from '../lib/main-i18n'

const log = createLogger('CustomIconHandlers')

function rowToCustomIcon(row: CustomIconRow): CustomIcon {
  return {
    id: row.id,
    name: row.name,
    ext: row.ext,
    path: getCustomIconFilePath(row.id, row.ext),
    createdAt: row.createdAt
  }
}

/**
 * Normalize an uploaded image to what we store.
 *
 * Raster formats are decoded and re-encoded to PNG, downscaled so the longest
 * edge is at most `CUSTOM_ICON_MAX_EDGE_PX`. That keeps every icon a few KB,
 * which is what makes carrying the bytes inside the sync record affordable, and
 * it strips whatever metadata the source file carried. SVG has no raster to
 * resize and is stored verbatim; it is only ever rendered through `<img src>`,
 * which does not execute script.
 */
function normalizeIcon(bytes: Buffer, ext: string): { data: Buffer; ext: string } {
  if (ext === 'svg') return { data: bytes, ext: 'svg' }

  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) {
    throw new Error(getMainI18n().t('errors:customIcon.unreadableImage'))
  }

  const { width, height } = image.getSize()
  const longestEdge = Math.max(width, height)
  const resized =
    longestEdge > CUSTOM_ICON_MAX_EDGE_PX
      ? image.resize(
          width >= height
            ? { width: CUSTOM_ICON_MAX_EDGE_PX, quality: 'best' }
            : { height: CUSTOM_ICON_MAX_EDGE_PX, quality: 'best' }
        )
      : image

  return { data: resized.toPNG(), ext: 'png' }
}

export function makeCustomIconHandlers(db: DataDb) {
  /** Normalize, write and record one icon, whatever the bytes arrived through. */
  async function store(bytes: Buffer, ext: string, name: string): Promise<CustomIcon> {
    if (bytes.length === 0 || bytes.length > CUSTOM_ICON_MAX_INPUT_BYTES) {
      throw new Error(getMainI18n().t('errors:customIcon.tooLarge'))
    }

    const normalized = normalizeIcon(bytes, ext)
    const id = nanoid()

    await writeCustomIconFile(id, normalized.ext, normalized.data)
    const row = insertCustomIcon(db, {
      id,
      name,
      ext: normalized.ext,
      data: normalized.data.toString('base64')
    })

    enqueueCustomIconCreate(row.id)
    broadcastToAllWindows(CustomIconsChannels.events.UPDATED, { id: row.id })
    return rowToCustomIcon(row)
  }

  return {
    /**
     * Also repairs the vault: a row pulled from a peer while the vault was
     * closed has no file yet, and this is the one call every icon consumer
     * makes before rendering.
     */
    list: async (): Promise<CustomIcon[]> => {
      const rows = listCustomIcons(db)
      for (const row of rows) {
        try {
          if (await customIconFileExists(row.id, row.ext)) continue
          await writeCustomIconFile(row.id, row.ext, Buffer.from(row.data, 'base64'))
        } catch (error) {
          log.warn('Failed to rehydrate custom icon file', { id: row.id, error })
        }
      }
      return rows.map(rowToCustomIcon)
    },

    add: async (input: unknown): Promise<CustomIcon> => {
      const data = CustomIconAddSchema.parse(input)
      return store(Buffer.from(data.dataBase64, 'base64'), data.ext, data.name)
    },

    /**
     * Add an icon from a link.
     *
     * The download happens here and once: past this point a linked icon is
     * indistinguishable from an uploaded one, so nothing renders from the
     * network and the remote host cannot swap the image later.
     */
    addFromUrl: async (input: unknown): Promise<CustomIcon> => {
      const { url, name } = CustomIconAddFromUrlSchema.parse(input)
      const remote = await downloadRemoteIcon(url)
      return store(remote.bytes, remote.ext, name ?? remote.name)
    },

    rename: async (input: unknown): Promise<CustomIcon> => {
      const { id, name } = CustomIconRenameSchema.parse(input)
      const row = renameCustomIcon(db, id, name)
      if (!row) throw new Error(`Custom icon ${id} not found`)

      enqueueCustomIconUpdate(row.id)
      broadcastToAllWindows(CustomIconsChannels.events.UPDATED, { id: row.id })
      return rowToCustomIcon(row)
    },

    delete: async (id: string): Promise<{ success: boolean }> => {
      // Snapshot BEFORE deleting: RecordSyncController.enqueueDelete returns
      // early on a null payload, so without it the tombstone is silently dropped
      // and the icon resurrects from peers on the next pull.
      const snapshot = getCustomIcon(db, id)
      const success = deleteCustomIcon(db, id)
      if (!success) return { success }

      if (snapshot) {
        await deleteCustomIconFile(snapshot.id, snapshot.ext).catch((error: unknown) => {
          log.warn('Failed to remove custom icon file', { id, error })
        })
      }
      enqueueCustomIconDelete(id, snapshot)
      broadcastToAllWindows(CustomIconsChannels.events.UPDATED, { id })
      return { success }
    }
  }
}

export function registerCustomIconHandlers(): void {
  ipcMain.handle(CustomIconsChannels.invoke.LIST, () =>
    makeCustomIconHandlers(requireDatabase()).list()
  )
  ipcMain.handle(CustomIconsChannels.invoke.ADD, (_e, input) =>
    makeCustomIconHandlers(requireDatabase()).add(input)
  )
  ipcMain.handle(CustomIconsChannels.invoke.ADD_FROM_URL, (_e, input) =>
    makeCustomIconHandlers(requireDatabase()).addFromUrl(input)
  )
  ipcMain.handle(CustomIconsChannels.invoke.RENAME, (_e, input) =>
    makeCustomIconHandlers(requireDatabase()).rename(input)
  )
  ipcMain.handle(CustomIconsChannels.invoke.DELETE, (_e, id: string) =>
    makeCustomIconHandlers(requireDatabase()).delete(id)
  )
}

export function unregisterCustomIconHandlers(): void {
  ipcMain.removeHandler(CustomIconsChannels.invoke.LIST)
  ipcMain.removeHandler(CustomIconsChannels.invoke.ADD)
  ipcMain.removeHandler(CustomIconsChannels.invoke.ADD_FROM_URL)
  ipcMain.removeHandler(CustomIconsChannels.invoke.RENAME)
  ipcMain.removeHandler(CustomIconsChannels.invoke.DELETE)
}
