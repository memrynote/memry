import fs from 'node:fs/promises'
import path from 'node:path'
import { ATTACHMENTS_DIR, CANVAS_DIR, normalizePath, type VaultConfig } from './paths.ts'

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
 */
function createTreeFolderFilter(config: VaultConfig): (folderPath: string) => boolean {
  const hiddenRoots = new Set(
    [ATTACHMENTS_DIR, CANVAS_DIR, ...config.excludePatterns]
      .filter(Boolean)
      .map((p) => normalizePath(p).split('/')[0])
  )
  const journalFolder = config.journalShowInSidebar ? '' : normalizePath(config.journalFolder)

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
    const relative = normalizePath(path.join(current, entry.name))
    // Both hiding rules cover whole subtrees, so a hidden folder's children are skipped too.
    if (!isListed(relative)) continue
    folders.push(relative)
    folders.push(...(await walkFolders(root, isListed, relative)))
  }
  return folders
}

/** Vault-relative folders the desktop notes tree lists. */
export function listTreeFolders(vaultPath: string, config: VaultConfig): Promise<string[]> {
  return walkFolders(vaultPath, createTreeFolderFilter(config))
}

export function createFoldersService({
  vaultPath,
  config
}: {
  vaultPath: string
  config: VaultConfig
}): FoldersService {
  // Folder paths are vault-relative (#1204): `defaultNoteFolder` is where an
  // unplaced note lands, not a notes root to resolve folders under.
  const root = vaultPath
  return {
    async list() {
      return (await listTreeFolders(root, config)).map((folderPath) => ({ path: folderPath }))
    },
    async create(folderPath) {
      const normalized = normalizePath(folderPath)
      await fs.mkdir(path.join(root, normalized), { recursive: true })
      return { path: normalized }
    },
    async rename(oldPath, newPath) {
      const oldNormalized = normalizePath(oldPath)
      const newNormalized = normalizePath(newPath)
      await fs.mkdir(path.dirname(path.join(root, newNormalized)), { recursive: true })
      await fs.rename(path.join(root, oldNormalized), path.join(root, newNormalized))
      return { path: newNormalized }
    },
    async delete(folderPath) {
      const normalized = normalizePath(folderPath)
      await fs.rm(path.join(root, normalized), { recursive: true, force: true })
      return true
    }
  }
}
