import fs from 'node:fs/promises'
import path from 'node:path'
import { caseTwinUnderFolder } from './case-twins.ts'
import type { DataDb } from './database.ts'
import { errorCode } from './errno.ts'
import {
  ATTACHMENTS_DIR,
  CANVAS_DIR,
  knownExcludePatterns,
  normalizePath,
  vaultFolder,
  type VaultConfig
} from './paths.ts'

export interface FolderRecord {
  path: string
}

export interface FoldersService {
  list(): Promise<FolderRecord[]>
  create(folderPath: string): Promise<FolderRecord>
  rename(oldPath: string, newPath: string): Promise<FolderRecord>
  delete(folderPath: string): Promise<boolean>
}

/**
 * Mirrors desktop's `createTreeFolderFilter` (main/vault/folder-visibility.ts).
 * Structural and excluded folders hide by first segment; the journal folder
 * hides as an exact subtree, and shows when `journalShowInSidebar` is on.
 * `config` comes from `ensureVaultLayout`, already normalized like desktop's.
 */
function createTreeFolderFilter(config: VaultConfig): (folderPath: string) => boolean {
  const hiddenRoots = new Set(
    [ATTACHMENTS_DIR, CANVAS_DIR, ...knownExcludePatterns(config)]
      .filter(Boolean)
      .map((p) => p.replace(/\/+$/, '').split('/')[0])
  )
  const journalFolder = config.journalShowInSidebar ? '' : config.journalFolder

  return (folderPath) =>
    !hiddenRoots.has(folderPath.split('/')[0]) &&
    !(journalFolder && (folderPath === journalFolder || folderPath.startsWith(`${journalFolder}/`)))
}

async function walkFolders(
  root: string,
  isListed: (folderPath: string) => boolean,
  current = ''
): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, current), { withFileTypes: true })
  const folders: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    // Walk the raw name: on POSIX a folder may be named `a\b`, which desktop reports as `a/b`.
    const fsRelative = path.join(current, entry.name)
    const relative = normalizePath(fsRelative)
    // Both hiding rules cover whole subtrees, so a hidden folder's children are skipped too.
    if (!isListed(relative)) continue
    folders.push(relative)
    folders.push(...(await walkFolders(root, isListed, fsRelative)))
  }
  return folders
}

/**
 * Whether each segment is an entry of its parent under exactly that name, as Tauri's
 * `spelled_on_disk` (crates/memry-desktop/src/notes/folder_delete.rs) checks. A case- or
 * Unicode-form-blind disk (macOS, Windows) resolves another spelling to the same folder.
 */
async function spelledOnDisk(root: string, segments: string[]): Promise<boolean> {
  let dir = root
  for (const segment of segments) {
    if (!(await fs.readdir(dir)).includes(segment)) return false
    dir = path.join(dir, segment)
  }
  return true
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

/** Vault-relative folders the desktop notes tree lists. */
export function listTreeFolders(vaultPath: string, config: VaultConfig): Promise<string[]> {
  return walkFolders(vaultPath, createTreeFolderFilter(config))
}

export function createFoldersService({
  vaultPath,
  config,
  dataDb
}: {
  vaultPath: string
  config: VaultConfig
  dataDb: DataDb
}): FoldersService {
  // Folder paths are vault-relative (#1204): `defaultNoteFolder` is where an
  // unplaced note lands, not a notes root to resolve folders under.
  const root = vaultPath
  return {
    async list() {
      return (await listTreeFolders(root, config)).map((folderPath) => ({ path: folderPath }))
    },
    async create(folderPath) {
      const folder = await vaultFolder(root, folderPath, 'create folder')
      await fs.mkdir(path.join(root, folder), { recursive: true })
      return { path: normalizePath(folderPath) }
    },
    async rename(oldPath, newPath) {
      const from = await vaultFolder(root, oldPath, 'rename folder')
      const to = await vaultFolder(root, newPath, 'rename folder')
      // The rename leaves the notes' rows behind, and desktop pairs one row to a moved file (#5650).
      const twin = await caseTwinUnderFolder(dataDb, root, from)
      if (twin) {
        throw new Error(
          `Refusing to rename folder "${oldPath}": note "${twin.path}" shares its file with a case twin on this case-insensitive disk, and the rename would leave one of them without a file.`
        )
      }
      await fs.mkdir(path.dirname(path.join(root, to)), { recursive: true })
      await fs.rename(path.join(root, from), path.join(root, to))
      return { path: normalizePath(newPath) }
    },
    async delete(folderPath) {
      const folder = await vaultFolder(root, folderPath, 'delete folder')
      const target = path.join(root, folder)
      // Unchecked, `supernotes` would delete `SuperNotes` with every note in it (#5648).
      // A missing folder stays a no-op.
      if ((await pathExists(target)) && !(await spelledOnDisk(root, folder.split('/')))) {
        throw new Error(
          `Refusing to delete folder "${folderPath}": the disk spells it differently, so it would delete another folder with all of its notes. Pass the path exactly as "memrynote folders list" prints it.`
        )
      }
      await fs.rm(target, { recursive: true, force: true })
      return true
    }
  }
}
