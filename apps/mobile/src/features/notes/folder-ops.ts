import type { VaultDb } from '@/db/index'
import { withVaultTransaction } from '@/db/tx'
import { createLogger } from '@/lib/logger'
import { dropFolderBookmarks, rewriteFolderBookmarks } from '@/features/notes/bookmarks'
import {
  createNote,
  deleteNote,
  duplicateNote,
  moveNote,
  type NoteOpsContext,
  type NotePayload
} from '@/features/notes/note-ops'
import { bumpClock } from '@/sync/outbox'

const log = createLogger('FolderOps')

/**
 * Folder operations for the row long-press menu (board 26B).
 *
 * Two things carry a folder across devices and they answer different
 * questions:
 *
 *  - Every note's `folderPath` is where the notes actually live. A rename, a
 *    move and a delete are therefore batches of note writes, which is what
 *    makes them converge with desktop without a folder-specific merge rule.
 *  - A `folder_config` row is what makes an EMPTY folder exist. Desktop's
 *    handler mirrors the row to `.folder.md` and `writeFolderConfig` mkdirs
 *    the directory on the way, so a config row for a brand-new path creates
 *    the folder over there even though it carries only `icon: null`.
 *
 * Without the second one, `New folder` would be a button that does nothing
 * until a note is put inside it — the reason the notes screen shipped without
 * the affordance at all.
 */

interface FolderConfigPayload {
  icon?: string | null
  clock?: Record<string, number>
  createdAt?: string
  modifiedAt?: string
  [unknownFieldsFromNewerClients: string]: unknown
}

interface NoteRow {
  id: string
  payload: NotePayload
}

// --- reads -----------------------------------------------------------------

/**
 * The folder paths that exist because somebody made them, not because a note
 * is sitting in one. The tree unions these with the paths it derives from
 * `folderPath`, so an empty folder still draws a row.
 */
export async function readFolderPaths(db: VaultDb): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM sync_items WHERE type = 'folder_config' AND deleted_at IS NULL`
  )
  const paths = new Set<string>()
  for (const row of rows) if (row.id.length > 0) paths.add(row.id)
  return paths
}

/** Every note under `path`, itself included, with its parsed payload. */
async function notesUnder(db: VaultDb, path: string): Promise<NoteRow[]> {
  const rows = await db.getAllAsync<{ id: string; payload: string }>(
    `SELECT id, payload FROM sync_items
     WHERE type = 'note' AND deleted_at IS NULL AND payload IS NOT NULL`
  )
  const out: NoteRow[] = []
  for (const row of rows) {
    let payload: NotePayload
    try {
      payload = JSON.parse(row.payload) as NotePayload
    } catch {
      continue
    }
    if (isUnder(payload.folderPath ?? '', path)) out.push({ id: row.id, payload })
  }
  return out
}

/** `path` itself or anything below it. `''` (the root) contains everything. */
export function isUnder(candidate: string, path: string): boolean {
  if (path === '') return true
  return candidate === path || candidate.startsWith(`${path}/`)
}

async function configPathsUnder(db: VaultDb, path: string): Promise<string[]> {
  const paths = await readFolderPaths(db)
  return [...paths].filter((candidate) => isUnder(candidate, path))
}

// --- folder_config writes --------------------------------------------------

async function readFolderConfig(db: VaultDb, path: string): Promise<FolderConfigPayload | null> {
  const row = await db.getFirstAsync<{ payload: string | null }>(
    'SELECT payload FROM sync_items WHERE id = ? AND type = ?',
    [path, 'folder_config']
  )
  if (!row?.payload) return null
  try {
    return JSON.parse(row.payload) as FolderConfigPayload
  } catch {
    return null
  }
}

/**
 * Write (or revive) the config row for a folder path and queue it.
 *
 * An existing row's payload is reused verbatim so a desktop-written icon and
 * whatever else a newer client stored survive, and so the clock keeps climbing
 * across a delete/recreate cycle — a fresh clock on a revived path reads as
 * older on every peer and the folder would simply not come back.
 */
export async function writeFolderConfigRow(
  ctx: NoteOpsContext,
  path: string,
  mutate?: (payload: FolderConfigPayload) => void
): Promise<void> {
  if (path === '') return
  const now = Date.now()
  const payload: FolderConfigPayload = (await readFolderConfig(ctx.db, path)) ?? {
    icon: null,
    createdAt: new Date(now).toISOString()
  }
  mutate?.(payload)
  payload.icon = payload.icon ?? null
  payload.modifiedAt = new Date(now).toISOString()
  bumpClock(payload as Record<string, unknown>, ctx.deviceId)
  const serialized = JSON.stringify(payload)

  await withVaultTransaction(ctx.db, async () => {
    await ctx.db.runAsync(
      `INSERT INTO sync_items (id, type, vault_id, updated_at, deleted_at, payload_state, payload)
       VALUES (?, 'folder_config', ?, ?, NULL, 'full', ?)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at,
         deleted_at = NULL,
         payload_state = 'full',
         payload = excluded.payload`,
      [path, ctx.vaultId, now, serialized]
    )
    await ctx.outbox.enqueueRecord('folder_config', path, 'update', serialized)
  })
}

async function deleteFolderConfigRow(ctx: NoteOpsContext, path: string): Promise<void> {
  const stored = await readFolderConfig(ctx.db, path)
  if (!stored) return
  const now = Date.now()
  bumpClock(stored as Record<string, unknown>, ctx.deviceId)
  const serialized = JSON.stringify(stored)
  await withVaultTransaction(ctx.db, async () => {
    await ctx.db.runAsync(
      'UPDATE sync_items SET deleted_at = ?, updated_at = ?, payload = ? WHERE id = ?',
      [now, now, serialized, path]
    )
    await ctx.outbox.enqueueRecord('folder_config', path, 'delete', serialized)
  })
}

// --- naming ----------------------------------------------------------------

export function folderName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

export function parentPath(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export function joinPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

/**
 * `Interviews copy`, then `Interviews copy 2`, `copy 3`… — the first free one.
 *
 * `taken` is every sibling name the caller already knows about. Duplicating
 * twice in a row must not produce two folders with the same path: on mobile a
 * path IS the identity, so the second one would merge into the first.
 */
export function uniqueName(taken: ReadonlySet<string>, base: string, suffix = 'copy'): string {
  const first = `${base} ${suffix}`
  if (!taken.has(first)) return first
  for (let n = 2; ; n += 1) {
    const candidate = `${first} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Sibling folder names directly under `parent`, from every known folder path. */
export function siblingNames(paths: Iterable<string>, parent: string): Set<string> {
  const names = new Set<string>()
  const prefix = parent === '' ? '' : `${parent}/`
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    if (rest.length === 0 || rest.includes('/')) continue
    names.add(rest)
  }
  return names
}

// --- operations ------------------------------------------------------------

export async function createFolder(ctx: NoteOpsContext, path: string): Promise<void> {
  await writeFolderConfigRow(ctx, path)
}

/**
 * Move every note out of `fromPath` into `toPath`, taking the folder's config
 * rows and bookmarks with it. A rename and a move are the same operation with
 * a different destination, so there is one implementation.
 */
export async function renameFolder(
  ctx: NoteOpsContext,
  fromPath: string,
  toPath: string
): Promise<number> {
  if (fromPath === '' || toPath === '' || fromPath === toPath) return 0
  if (isUnder(toPath, fromPath)) {
    // Moving a folder inside itself would detach the subtree from every path
    // the notes still name. The picker already refuses to offer it; this is
    // the guard for every other caller.
    log.warn('Refusing to move a folder into its own subtree', { fromPath, toPath })
    return 0
  }

  const configPaths = await configPathsUnder(ctx.db, fromPath)
  const notes = await notesUnder(ctx.db, fromPath)

  for (const note of notes) {
    const current = note.payload.folderPath ?? ''
    await moveNote(ctx, note.id, toPath + current.slice(fromPath.length))
  }

  // The config rows AFTER the notes: a peer that applies the new config first
  // sees an empty folder for a moment, which is harmless, whereas the reverse
  // order can leave notes pointing at a path whose folder was already removed.
  for (const configPath of configPaths) {
    await writeFolderConfigRow(ctx, toPath + configPath.slice(fromPath.length), (payload) => {
      void payload
    })
    await deleteFolderConfigRow(ctx, configPath)
  }
  await rewriteFolderBookmarks(ctx, fromPath, toPath)

  return notes.length
}

/** `Move folder to…`: the folder keeps its name and changes parents. */
export async function moveFolder(
  ctx: NoteOpsContext,
  path: string,
  newParent: string
): Promise<number> {
  const destination = joinPath(newParent, folderName(path))
  if (destination === path) return 0
  return renameFolder(ctx, path, destination)
}

export interface FolderDeleteResult {
  notes: number
  folders: number
}

/**
 * Delete a folder and everything under it.
 *
 * Notes first, config rows second. A device that applies the config tombstone
 * before the note tombstones would show an empty folder briefly; the reverse
 * would show orphan notes in a folder that is already gone, which reads as
 * data loss.
 */
export async function deleteFolder(ctx: NoteOpsContext, path: string): Promise<FolderDeleteResult> {
  if (path === '') return { notes: 0, folders: 0 }
  const configPaths = await configPathsUnder(ctx.db, path)
  const notes = await notesUnder(ctx.db, path)

  for (const note of notes) await deleteNote(ctx, note.id)
  for (const configPath of configPaths) await deleteFolderConfigRow(ctx, configPath)
  await dropFolderBookmarks(ctx, path)

  return { notes: notes.length, folders: configPaths.length }
}

/**
 * Copy a folder and its whole subtree beside itself.
 *
 * Every note is duplicated with a NEW id — a copy that shared ids would be the
 * same note in two places on the next pull — and the config rows are recreated
 * so an empty subfolder survives the copy.
 */
export async function duplicateFolder(ctx: NoteOpsContext, path: string): Promise<string> {
  const known = await readFolderPaths(ctx.db)
  for (const note of await notesUnder(ctx.db, '')) {
    const folder = note.payload.folderPath ?? ''
    if (folder !== '') known.add(folder)
  }
  const parent = parentPath(path)
  const destination = joinPath(parent, uniqueName(siblingNames(known, parent), folderName(path)))

  const configPaths = await configPathsUnder(ctx.db, path)
  for (const configPath of configPaths) {
    await writeFolderConfigRow(ctx, destination + configPath.slice(path.length))
  }
  // The folder itself always gets a row, even when the original had none: the
  // copy has to exist as a folder before its first note lands, or an empty
  // source folder would duplicate into nothing at all.
  await writeFolderConfigRow(ctx, destination)

  for (const note of await notesUnder(ctx.db, path)) {
    const folder = note.payload.folderPath ?? ''
    await duplicateNote(ctx, note.id, {
      folderPath: destination + folder.slice(path.length),
      // Inside a copied folder the titles are already unique among themselves,
      // so the notes keep their names; only the folder is renamed.
      keepTitle: true
    })
  }

  return destination
}

/**
 * `New note` inside a folder. The folder is materialised first so the note
 * lands somewhere that already exists on every device.
 */
export async function createNoteInFolder(ctx: NoteOpsContext, folderPath: string): Promise<string> {
  if (folderPath !== '') await writeFolderConfigRow(ctx, folderPath)
  return createNote(ctx, { title: 'Untitled', folderPath })
}
