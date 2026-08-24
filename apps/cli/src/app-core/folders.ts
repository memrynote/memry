import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizePath, type VaultConfig } from './paths.ts'

export interface FolderRecord {
  path: string
}

export interface FoldersService {
  list(): Promise<FolderRecord[]>
  create(folderPath: string): Promise<FolderRecord>
  rename(oldPath: string, newPath: string): Promise<FolderRecord>
  delete(folderPath: string): Promise<boolean>
}

async function walkFolders(
  root: string,
  hiddenTopLevel: Set<string>,
  current = ''
): Promise<FolderRecord[]> {
  const absolute = path.join(root, current)
  const entries = await fs.readdir(absolute, { withFileTypes: true })
  const folders: FolderRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // Skip hidden dirs (.memry, .obsidian, .git) and structural/excluded folders
    // (journal, attachments, excludePatterns) — relevant once the notes root is
    // the vault root (defaultNoteFolder = '').
    if (entry.name.startsWith('.')) continue
    if (current === '' && hiddenTopLevel.has(entry.name)) continue
    const relative = normalizePath(path.join(current, entry.name))
    folders.push({ path: relative })
    folders.push(...(await walkFolders(root, hiddenTopLevel, relative)))
  }
  return folders
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
  const hiddenTopLevel = new Set(
    [config.journalFolder, config.attachmentsFolder, ...config.excludePatterns]
      .filter(Boolean)
      .map((p) => normalizePath(p).split('/')[0])
  )

  return {
    async list() {
      return walkFolders(root, hiddenTopLevel)
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
