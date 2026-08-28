import { getMeta, setMeta, type VaultDb } from '@/db/index'
import { NOTES_EXPANDED_KEY, NOTES_SORT_KEY } from '@/db/keys'
import { readBookmarkKeys, type BookmarkKey } from '@/features/notes/bookmarks'
import { readFolderPaths } from '@/features/notes/folder-ops'
import { customIconDataUri } from '@/features/notes/icon-value'
import { toEpochMs } from '@/features/notes/note-ops'
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
  /** `custom_icon` id → data URI, for the `custom:<id>` icon values. */
  customIcons: Map<string, string>
  /**
   * Folders that exist without holding a note — the `folder_config` paths
   * `New folder` writes. The tree unions them with the paths it derives from
   * the notes' `folderPath`s.
   */
  folderPaths: Set<string>
  /** `note:<id>` / `folder:<path>` for every live bookmark. */
  bookmarks: Set<BookmarkKey>
  pendingCount: number
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

/**
 * The user-uploaded icons, as data URIs.
 *
 * The bytes ride inside the `custom_icon` payload rather than the attachment
 * pipeline (a normalized icon is a few KB), so the whole library is already on
 * the device and no row here costs a fetch.
 */
async function readCustomIcons(db: VaultDb): Promise<Map<string, string>> {
  const rows = await db.getAllAsync<{ id: string; payload: string | null }>(
    `SELECT id, payload FROM sync_items WHERE type = 'custom_icon' AND deleted_at IS NULL`
  )
  const icons = new Map<string, string>()
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const payload = JSON.parse(row.payload) as { ext?: unknown; data?: unknown }
      if (typeof payload.data === 'string' && payload.data.length > 0) {
        icons.set(row.id, customIconDataUri(payload.ext, payload.data))
      }
    } catch {
      log.warn('Custom icon payload is not JSON; skipping', { id: row.id })
    }
  }
  return icons
}

export async function readNotesSnapshot(db: VaultDb): Promise<NotesSnapshot> {
  // `type = 'note'` and nothing else. The sync table also holds tasks,
  // projects, home boards and the rest, but this screen is the vault's file
  // tree: an item with no file behind it has no row here.
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
    let payload: Record<string, unknown> = {}
    try {
      if (row.payload) payload = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      // unparseable payload: keep defaults
    }
    const rawTitle = payload.title
    const title = typeof rawTitle === 'string' && rawTitle.trim().length > 0 ? rawTitle : 'Untitled'
    // The payload's own enum wins. Desktop writes it for every binary note,
    // so falling straight to the extension would relabel a note whose title
    // desktop already classified.
    const fileType: NoteFileType | null = isNoteFileType(payload.fileType) ? payload.fileType : null
    const folderPath = payload.folderPath
    const emoji = payload.emoji
    entries.push({
      id: row.id,
      title,
      folderPath: typeof folderPath === 'string' ? folderPath : '',
      fileType: fileType ?? fileTypeFromTitle(title),
      icon: typeof emoji === 'string' && emoji.length > 0 ? emoji : null,
      updatedAt: row.updated_at,
      createdAt: toEpochMs(payload.createdAt, row.updated_at),
      hasBody: row.body === 1
    })
  }

  const pending = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sync_items
     WHERE type = 'note' AND deleted_at IS NULL AND payload_state = 'metadata-only'`
  )

  return {
    entries,
    icons: await readFolderIcons(db),
    customIcons: await readCustomIcons(db),
    folderPaths: await readFolderPaths(db),
    bookmarks: await readBookmarkKeys(db),
    pendingCount: pending?.n ?? 0
  }
}

export async function readSortMode(db: VaultDb): Promise<MobileSortMode> {
  const stored = await getMeta(db, NOTES_SORT_KEY)
  return isMobileSortMode(stored) ? stored : MOBILE_SORT_DEFAULT
}

export async function writeSortMode(db: VaultDb, mode: MobileSortMode): Promise<void> {
  await setMeta(db, NOTES_SORT_KEY, mode)
}

async function readStringSet(db: VaultDb, key: string): Promise<Set<string>> {
  const stored = await getMeta(db, key)
  if (stored === null) return new Set()
  try {
    const parsed: unknown = JSON.parse(stored)
    if (Array.isArray(parsed)) {
      const values = new Set<string>()
      for (const item of parsed) {
        if (typeof item !== 'string') return new Set()
        values.add(item)
      }
      return values
    }
  } catch {
    log.warn('Stored tree state is not JSON; opening the tree collapsed', { key })
  }
  return new Set()
}

export async function readExpandedFolders(db: VaultDb): Promise<Set<string>> {
  return readStringSet(db, NOTES_EXPANDED_KEY)
}

export async function writeExpandedFolders(db: VaultDb, paths: ReadonlySet<string>): Promise<void> {
  await setMeta(db, NOTES_EXPANDED_KEY, JSON.stringify([...paths]))
}
