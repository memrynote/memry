import { getMeta, setMeta, type VaultDb } from '@/db/index'
import { NOTES_EXPANDED_KEY, NOTES_SORT_KEY } from '@/db/keys'
import {
  fileTypeFromTitle,
  isMobileSortMode,
  isNoteFileType,
  MOBILE_SORT_DEFAULT,
  type MobileSortMode,
  type NoteEntry,
  type NoteFileType
} from '@/features/notes/tree'
import { createLogger } from '@/lib/logger'

const log = createLogger('NotesRepo')

/**
 * Everything the notes screens read from SQLite, so the tree module stays a
 * pure function of rows and the screens stay a render of what it returns.
 */

export interface NotesSnapshot {
  entries: NoteEntry[]
  icons: Map<string, string>
  pendingCount: number
}

/**
 * `createdAt` arrives in two shapes and both are live in the same table.
 * Desktop's `buildSnapshotPayload` pushes the ISO string from
 * `NoteMetadata.createdAt`, and this app's `createNote` writes `Date.now()`.
 * Accepting only numbers would collapse every desktop-synced note onto its
 * `updated_at` and make the two `created-*` sort modes wrong for most of a
 * real vault.
 */
function toEpochMs(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

/**
 * Folder emoji by path. A `folder_config` row's id IS the folder path:
 * `folderConfigs.path` is its primary key and the record sync controller
 * passes that same value as the sync item id.
 *
 * Mobile ships no `folder_config` sync handler, so on most devices this map
 * comes back empty and every folder falls back to the plain glyph. That is the
 * correct outcome, not a fault worth reporting.
 */
async function readFolderIcons(db: VaultDb): Promise<Map<string, string>> {
  const rows = await db.getAllAsync<{ id: string; payload: string | null }>(
    `SELECT id, payload FROM sync_items WHERE type = 'folder_config' AND deleted_at IS NULL`
  )
  const icons = new Map<string, string>()
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const icon = (JSON.parse(row.payload) as { icon?: string | null }).icon
      if (icon) icons.set(row.id, icon)
    } catch {
      log.warn('Folder config payload is not JSON; skipping', { path: row.id })
    }
  }
  return icons
}

export async function readNotesSnapshot(db: VaultDb): Promise<NotesSnapshot> {
  const rows = await db.getAllAsync<{
    id: string
    payload: string | null
    updated_at: number
    body: number | null
  }>(
    `SELECT s.id, s.payload, s.updated_at, (SELECT 1 FROM note_bodies b WHERE b.item_id = s.id) AS body
     FROM sync_items s
     WHERE s.type = 'note' AND s.deleted_at IS NULL AND s.payload_state = 'full'
     ORDER BY s.updated_at DESC`
  )

  const entries: NoteEntry[] = []
  for (const row of rows) {
    let title = 'Untitled'
    let folderPath = ''
    let createdAt = row.updated_at
    let fileType: NoteFileType | null = null
    try {
      const payload = row.payload
        ? (JSON.parse(row.payload) as {
            title?: string
            folderPath?: string | null
            createdAt?: unknown
            fileType?: unknown
          })
        : {}
      title = payload.title ?? 'Untitled'
      folderPath = payload.folderPath ?? ''
      createdAt = toEpochMs(payload.createdAt, row.updated_at)
      // The payload's own enum wins. Desktop writes it for every binary note,
      // so falling straight to the extension would relabel a note whose title
      // desktop already classified.
      if (isNoteFileType(payload.fileType)) fileType = payload.fileType
    } catch {
      // unparseable payload: keep defaults
    }
    entries.push({
      id: row.id,
      title,
      folderPath,
      fileType: fileType ?? fileTypeFromTitle(title),
      updatedAt: row.updated_at,
      createdAt,
      hasBody: row.body === 1
    })
  }

  const pending = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sync_items WHERE type = 'note' AND deleted_at IS NULL AND payload_state = 'metadata-only'`
  )

  return { entries, icons: await readFolderIcons(db), pendingCount: pending?.n ?? 0 }
}

export async function readSortMode(db: VaultDb): Promise<MobileSortMode> {
  const stored = await getMeta(db, NOTES_SORT_KEY)
  return isMobileSortMode(stored) ? stored : MOBILE_SORT_DEFAULT
}

export async function writeSortMode(db: VaultDb, mode: MobileSortMode): Promise<void> {
  await setMeta(db, NOTES_SORT_KEY, mode)
}

export async function readExpandedFolders(db: VaultDb): Promise<Set<string>> {
  const stored = await getMeta(db, NOTES_EXPANDED_KEY)
  if (stored === null) return new Set()
  try {
    const parsed: unknown = JSON.parse(stored)
    if (Array.isArray(parsed)) {
      const paths = new Set<string>()
      for (const item of parsed) {
        if (typeof item !== 'string') return new Set()
        paths.add(item)
      }
      return paths
    }
  } catch {
    log.warn('Stored expanded folders is not JSON; opening the tree collapsed')
  }
  return new Set()
}

export async function writeExpandedFolders(db: VaultDb, paths: ReadonlySet<string>): Promise<void> {
  await setMeta(db, NOTES_EXPANDED_KEY, JSON.stringify([...paths]))
}
