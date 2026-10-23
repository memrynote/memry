import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { syncPendingDeletes } from '@memry/db-schema/data-schema'
import { customIcons, type CustomIconRow } from '@memry/db-schema/schema/custom-icons'
import {
  CUSTOM_ICON_MAX_EDGE_PX,
  CUSTOM_ICON_MAX_INPUT_BYTES,
  CUSTOM_ICON_NAME_MAX_LENGTH,
  isCustomIconStoredExtension,
  type CustomIcon,
  type CustomIconStoredExtension
} from '@memry/contracts/custom-icons-api'
import { createId } from '@memry/app-core/ids'
import { utcNow } from '@memry/shared/utc'
import { sanitizeSvgBytes } from '@memry/shared/sanitize-svg'
import type { DataDb } from './database.ts'
import { getMemryDir } from './paths.ts'

// Mirrors desktop's custom icon library (apps/desktop/src/main/ipc/
// custom-icon-handlers.ts, icons/store.ts, vault/custom-icons.ts). Desktop
// re-encodes raster uploads to a <=128px PNG through Electron's nativeImage;
// the CLI has no image codec, so it stores SVG (sanitized with the shared
// sanitizer) and PNGs that already fit, and refuses the rest with a message.

export interface CustomIconsService {
  list(): Promise<CustomIcon[]>
  add(sourcePath: string, name?: string): Promise<CustomIcon>
  rename(id: string, name: string): Promise<CustomIcon>
  delete(id: string): Promise<{ success: boolean; syncPending: boolean }>
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function normalizeName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Icon name cannot be empty')
  if (trimmed.length > CUSTOM_ICON_NAME_MAX_LENGTH) {
    throw new Error(`Icon name is longer than ${CUSTOM_ICON_NAME_MAX_LENGTH} characters`)
  }
  return trimmed
}

/** Stored bytes for an input file, or throws with what to do instead. */
function normalizeIcon(
  bytes: Buffer,
  ext: string
): { data: Buffer; ext: CustomIconStoredExtension } {
  if (bytes.length === 0 || bytes.length > CUSTOM_ICON_MAX_INPUT_BYTES) {
    throw new Error(`Icon must be between 1 byte and ${CUSTOM_ICON_MAX_INPUT_BYTES} bytes`)
  }
  if (ext === 'svg') {
    const sanitized = sanitizeSvgBytes(bytes)
    if (!sanitized) throw new Error('The file is not a usable SVG image')
    return { data: sanitized, ext: 'svg' }
  }
  if (ext === 'png') {
    const size = pngSize(bytes)
    // The CLI cannot decode pixels; a header plus a closing IEND chunk is the check it can make.
    if (!size || !bytes.subarray(-12).includes(Buffer.from('IEND'))) {
      throw new Error('The file is not a valid PNG image')
    }
    if (Math.max(size.width, size.height) > CUSTOM_ICON_MAX_EDGE_PX) {
      throw new Error(
        `PNG icons are limited to ${CUSTOM_ICON_MAX_EDGE_PX}px on the longest edge; this one is ${size.width}x${size.height}. Resize it first, or add it from the desktop app, which downscales automatically.`
      )
    }
    return { data: bytes, ext: 'png' }
  }
  throw new Error(
    `The CLI adds svg and png icons. Convert .${ext} to PNG first, or add it from the desktop app, which re-encodes raster images.`
  )
}

function toCustomIcon(row: CustomIconRow, ext: CustomIconStoredExtension, filePath: string) {
  return { id: row.id, name: row.name, ext, path: filePath, createdAt: row.createdAt }
}

export function createCustomIconsService({
  dataDb,
  vaultPath
}: {
  dataDb: DataDb
  vaultPath: string
}): CustomIconsService {
  const iconsDir = path.join(getMemryDir(vaultPath), 'icons')

  function iconPath(id: string, ext: string): string {
    // `id` and `ext` can come from a synced row, and the result goes straight to fs.
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !/^[a-zA-Z0-9]+$/.test(ext)) {
      throw new Error(`Invalid custom icon file name: ${id}.${ext}`)
    }
    return path.join(iconsDir, `${id}.${ext}`)
  }

  function requireRow(id: string): CustomIconRow & { ext: CustomIconStoredExtension } {
    const row = dataDb.select().from(customIcons).where(eq(customIcons.id, id)).get()
    if (!row) throw new Error(`Custom icon ${id} not found`)
    if (!isCustomIconStoredExtension(row.ext)) {
      throw new Error(`Custom icon ${id} has an unsupported extension: ${row.ext}`)
    }
    return { ...row, ext: row.ext }
  }

  return {
    async list() {
      const icons: CustomIcon[] = []
      for (const row of dataDb
        .select()
        .from(customIcons)
        .orderBy(asc(customIcons.createdAt))
        .all()) {
        // A row from a peer can carry an extension this build does not know: skip it, keep the row.
        if (!isCustomIconStoredExtension(row.ext)) continue
        const filePath = iconPath(row.id, row.ext)
        // A row pulled while the vault was closed has no file yet; the row holds the bytes.
        if (!existsSync(filePath)) {
          const data = Buffer.from(row.data, 'base64')
          const bytes = row.ext === 'svg' ? sanitizeSvgBytes(data) : data
          if (bytes) {
            mkdirSync(iconsDir, { recursive: true })
            writeFileSync(filePath, bytes)
          }
        }
        icons.push(toCustomIcon(row, row.ext, filePath))
      }
      return icons
    },

    async add(sourcePath, name) {
      const bytes = readFileSync(sourcePath)
      const sourceExt = path.extname(sourcePath).slice(1).toLowerCase()
      const label = normalizeName(name ?? path.basename(sourcePath, path.extname(sourcePath)))
      const normalized = normalizeIcon(bytes, sourceExt)

      const id = createId('icon')
      const filePath = iconPath(id, normalized.ext)
      mkdirSync(iconsDir, { recursive: true })
      writeFileSync(filePath, normalized.data)

      const now = utcNow()
      // `clock` stays null: desktop's sync seeds clock-less icons on its next start.
      const row = dataDb
        .insert(customIcons)
        .values({
          id,
          name: label,
          ext: normalized.ext,
          data: normalized.data.toString('base64'),
          createdAt: now,
          updatedAt: now
        })
        .returning()
        .get()
      return toCustomIcon(row, normalized.ext, filePath)
    },

    async rename(id, name) {
      const existing = requireRow(id)
      const row = dataDb
        .update(customIcons)
        .set({ name: normalizeName(name), updatedAt: utcNow() })
        .where(eq(customIcons.id, existing.id))
        .returning()
        .get()
      return toCustomIcon(row, existing.ext, iconPath(row.id, existing.ext))
    },

    async delete(id) {
      const snapshot = dataDb.select().from(customIcons).where(eq(customIcons.id, id)).get()
      if (!snapshot) return { success: false, syncPending: false }

      // An icon that synced needs its tombstone handed to the sync engine, or the
      // next pull brings it back. Desktop records the same row snapshot in
      // `sync_pending_deletes` and replays it at the next runtime start.
      const syncPending = snapshot.clock !== null
      dataDb.transaction((tx) => {
        tx.delete(customIcons).where(eq(customIcons.id, id)).run()
        if (syncPending) {
          tx.insert(syncPendingDeletes)
            .values({
              type: 'custom_icon',
              itemId: id,
              payload: JSON.stringify(snapshot),
              createdAt: new Date()
            })
            .onConflictDoUpdate({
              target: [syncPendingDeletes.type, syncPendingDeletes.itemId],
              set: { payload: JSON.stringify(snapshot), createdAt: new Date() }
            })
            .run()
        }
      })
      if (isCustomIconStoredExtension(snapshot.ext)) {
        rmSync(iconPath(snapshot.id, snapshot.ext), { force: true })
      }
      return { success: true, syncPending }
    }
  }
}
