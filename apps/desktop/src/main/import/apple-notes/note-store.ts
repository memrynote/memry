/**
 * Shared read access to the Apple Notes NoteStore.sqlite database.
 *
 * Both the importer (which decodes note bodies) and the dialog's folder picker
 * (which only needs the folder tree) open the same snapshot and read the same
 * account/folder rows, so the copy-to-temp, entity-id lookup, row queries and
 * folder-chain walk live here instead of being duplicated per caller.
 *
 * The original NoteStore.sqlite is never mutated — every caller reads a
 * read-only temp copy.
 */

import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import Database from 'better-sqlite3'
import type {
  AppleNotesAccountNode,
  AppleNotesFolderNode,
  AppleNotesFoldersResult
} from '@memry/contracts/import-channels'

const NOTE_CONTAINER_REL = 'Library/Group Containers/group.com.apple.notes'
const NOTE_DB = 'NoteStore.sqlite'

/** Folder type discriminator from ICFolder.ZFOLDERTYPE. */
export const FOLDER_TYPE_TRASH = 1
export const FOLDER_TYPE_SMART = 3

/** Safety cap on the ZPARENT walk; a corrupt DB must not build endless paths. */
export const MAX_FOLDER_DEPTH = 32

export const ACCESS_DENIED_HINT =
  'Memry could not read the Apple Notes data. Click “Select Apple Notes folder” and ' +
  'choose the “group.com.apple.notes” folder when the picker opens — that grants access ' +
  'without Full Disk Access. If it still fails, grant Full Disk Access to Memry (or ' +
  '“Electron” in development) in System Settings → Privacy & Security, then reopen the app.'

export interface PrimaryKeys {
  ICAccount: number
  ICFolder: number
  ICNote: number
  ICMedia: number
}

export interface AccountRow {
  pk: number
  name: string
  identifier: string
}

export interface FolderRow {
  pk: number
  title: string | null
  parent: number | null
  identifier: string | null
  folderType: number | null
  owner: number | null
}

export function defaultContainerDir(): string {
  return path.join(os.homedir(), NOTE_CONTAINER_REL)
}

export function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null | undefined)?.code
}

/** macOS TCC / filesystem permission denial reading the protected Notes data. */
export function isAccessDenied(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'EPERM' || code === 'EACCES' || code === 'SQLITE_CANTOPEN'
}

/**
 * Copy the chosen NoteStore.sqlite (+ WAL/SHM sidecars when present) to a temp
 * file so we read a consistent, never-mutated snapshot.
 */
async function copyToTemp(sourcePath: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-apple-notes-'))
  const dest = path.join(tmpDir, 'NoteStore.sqlite')
  await fs.copyFile(sourcePath, dest)
  for (const suffix of ['-wal', '-shm']) {
    try {
      await fs.copyFile(sourcePath + suffix, dest + suffix)
    } catch {
      // Sidecar absent (DB checkpointed) — fine.
    }
  }
  return dest
}

export interface NoteStore {
  db: Database.Database
  /** Directory the Media/ tree is resolved against (attachments). */
  mediaBase: string
  close(): Promise<void>
}

/**
 * Open a read-only snapshot of the database the user pointed us at: either the
 * `group.com.apple.notes` container folder (preferred — its grant also covers
 * attachments) or a NoteStore.sqlite file directly.
 */
export async function openNoteStore(selected: string): Promise<NoteStore> {
  const source = selected || defaultContainerDir()
  const isDbFile = source.toLowerCase().endsWith('.sqlite')
  const dbPath = isDbFile ? source : path.join(source, NOTE_DB)
  const mediaBase = isDbFile ? path.dirname(source) : source

  let tempPath: string
  let db: Database.Database
  try {
    tempPath = await copyToTemp(dbPath)
    db = new Database(tempPath, { readonly: true, fileMustExist: true })
  } catch (error) {
    if (isAccessDenied(error)) throw new Error(ACCESS_DENIED_HINT)
    if (errorCode(error) === 'ENOENT') {
      throw new Error(
        `Apple Notes database not found at ${dbPath}. Open the Notes app once to ` +
          'create it, or select the “group.com.apple.notes” folder.'
      )
    }
    throw error
  }

  return {
    db,
    mediaBase,
    close: async () => {
      try {
        db.close()
      } catch {
        // ignore close errors
      }
      await fs.rm(path.dirname(tempPath), { recursive: true, force: true }).catch(() => {})
    }
  }
}

export function loadPrimaryKeys(db: Database.Database): PrimaryKeys {
  // better-sqlite3 keys rows by the schema's real column case — the Apple Notes
  // DB declares Z_ENT/Z_NAME uppercase, so an unaliased `z_name` read returns
  // undefined and every entity id falls back to -1 (→ zero rows). Alias to a
  // stable lowercase key. (Every other query already aliases its columns.)
  const rows = db.prepare('SELECT z_ent AS ent, z_name AS name FROM z_primarykey').all() as {
    ent: number
    name: string
  }[]
  const byName = new Map(rows.map((r) => [r.name, r.ent]))
  return {
    ICAccount: byName.get('ICAccount') ?? -1,
    ICFolder: byName.get('ICFolder') ?? -1,
    ICNote: byName.get('ICNote') ?? -1,
    ICMedia: byName.get('ICMedia') ?? -1
  }
}

export function loadAccounts(db: Database.Database, keys: PrimaryKeys): AccountRow[] {
  return db
    .prepare(
      'SELECT z_pk AS pk, zname AS name, zidentifier AS identifier ' +
        'FROM ziccloudsyncingobject WHERE z_ent = ?'
    )
    .all(keys.ICAccount) as AccountRow[]
}

export function loadFolders(db: Database.Database, keys: PrimaryKeys): FolderRow[] {
  return db
    .prepare(
      'SELECT z_pk AS pk, ztitle2 AS title, zparent AS parent, zidentifier AS identifier, ' +
        'zfoldertype AS folderType, zowner AS owner ' +
        'FROM ziccloudsyncingobject WHERE z_ent = ?'
    )
    .all(keys.ICFolder) as FolderRow[]
}

/** Default ("Notes") and account-root folders map to the importer root. */
export function folderDisplayName(folder: FolderRow | undefined): string | null {
  if (!folder || !folder.title) return null
  if (folder.identifier && folder.identifier.startsWith('DefaultFolder')) return null
  return folder.title
}

/**
 * Ordered folder titles from the account root down to `folder` (leaf last), so
 * `Work/Clients/Acme` and `Personal/Acme` stay distinct instead of merging.
 * Stops at the depth cap or on a ZPARENT cycle (corrupt DB), keeping the
 * deepest segments. Default-folder suppression applies to the leaf only.
 * The trash root contributes no segment: a note under a folder nested inside
 * “Recently Deleted” imports under its own name, not a literal trash tree.
 */
export function folderPath(
  folder: FolderRow | undefined,
  folderById: Map<number, FolderRow>,
  cache: Map<number, string[]>
): string[] {
  if (!folder) return []
  const cached = cache.get(folder.pk)
  if (cached) return cached

  const segments: string[] = []
  const seen = new Set<number>()
  let current: FolderRow | undefined = folder
  while (current && segments.length < MAX_FOLDER_DEPTH && !seen.has(current.pk)) {
    seen.add(current.pk)
    const title =
      current.folderType === FOLDER_TYPE_TRASH
        ? null
        : current === folder
          ? folderDisplayName(current)
          : current.title
    if (title) segments.unshift(title)
    current = current.parent != null ? folderById.get(current.parent) : undefined
  }

  cache.set(folder.pk, segments)
  return segments
}

/** Note count per ICFolder pk; `null` key = notes that sit outside any folder. */
function loadNoteCounts(db: Database.Database, keys: PrimaryKeys): Map<number | null, number> {
  // Counts only — the note body (ZDATA) is never read, so the picker stays
  // instant on a large library.
  const rows = db
    .prepare(
      'SELECT zcso.zfolder AS folder, COUNT(*) AS count ' +
        'FROM zicnotedata AS nd ' +
        'JOIN ziccloudsyncingobject AS zcso ON zcso.z_pk = nd.znote ' +
        'WHERE zcso.z_ent = ? AND zcso.ztitle1 IS NOT NULL ' +
        'GROUP BY zcso.zfolder'
    )
    .all(keys.ICNote) as { folder: number | null; count: number }[]
  return new Map(rows.map((r) => [r.folder, r.count]))
}

/**
 * Account → folder → subfolder tree for the import dialog's folder picker.
 *
 * Smart folders (saved queries, not containers) and Trash are left out; folders
 * whose parent is missing or part of a ZPARENT cycle surface at the top level
 * instead of vanishing.
 */
export async function scanAppleNotesFolders(sourcePath: string): Promise<AppleNotesFoldersResult> {
  const store = await openNoteStore(sourcePath)
  try {
    const keys = loadPrimaryKeys(store.db)
    const accounts = loadAccounts(store.db, keys)
    const counts = loadNoteCounts(store.db, keys)
    const folders = loadFolders(store.db, keys).filter(
      (f) => f.folderType !== FOLDER_TYPE_SMART && f.folderType !== FOLDER_TYPE_TRASH
    )

    const byPk = new Map(folders.map((f) => [f.pk, f]))
    const childrenOf = new Map<number, FolderRow[]>()
    for (const folder of folders) {
      if (folder.parent == null || !byPk.has(folder.parent)) continue
      const siblings = childrenOf.get(folder.parent)
      if (siblings) siblings.push(folder)
      else childrenOf.set(folder.parent, [folder])
    }

    const visited = new Set<number>()
    const toNode = (folder: FolderRow): AppleNotesFolderNode => {
      visited.add(folder.pk)
      const children = (childrenOf.get(folder.pk) ?? [])
        .filter((child) => !visited.has(child.pk))
        .map(toNode)
      const noteCount = counts.get(folder.pk) ?? 0
      return {
        // A folder with no identifier cannot be selected by id; fall back to the
        // primary key so the row still renders and stays addressable.
        id: folder.identifier ?? String(folder.pk),
        title: folder.title ?? '',
        noteCount,
        totalNoteCount: noteCount + children.reduce((sum, c) => sum + c.totalNoteCount, 0),
        children
      }
    }

    const roots = folders.filter((f) => f.parent == null || !byPk.has(f.parent))
    const byAccount = new Map<number, AppleNotesFolderNode[]>()
    const push = (folder: FolderRow): void => {
      if (visited.has(folder.pk)) return
      const owner = folder.owner ?? -1
      const nodes = byAccount.get(owner)
      if (nodes) nodes.push(toNode(folder))
      else byAccount.set(owner, [toNode(folder)])
    }
    roots.forEach(push)
    // Anything left is part of a ZPARENT cycle — show it rather than drop it.
    folders.forEach(push)

    const accountNodes: AppleNotesAccountNode[] = [...byAccount.entries()].map(
      ([owner, folderNodes]) => ({
        name: accounts.find((a) => a.pk === owner)?.name ?? '',
        folders: folderNodes
      })
    )

    return { accounts: accountNodes, unfiledNoteCount: counts.get(null) ?? 0 }
  } finally {
    await store.close()
  }
}
