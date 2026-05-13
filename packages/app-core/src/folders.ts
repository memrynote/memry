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

async function walkFolders(root: string, current = ''): Promise<FolderRecord[]> {
  const absolute = path.join(root, current)
  const entries = await fs.readdir(absolute, { withFileTypes: true })
  const folders: FolderRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const relative = normalizePath(path.join(current, entry.name))
    folders.push({ path: relative })
    folders.push(...(await walkFolders(root, relative)))
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
  const root = path.join(vaultPath, config.defaultNoteFolder)

  return {
    async list() {
      return walkFolders(root)
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
