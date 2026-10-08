import { access } from 'node:fs/promises'
import path from 'node:path'

import { getStatus } from '../../../vault'
import type { CreatedFoldersReply } from './handles'

async function folderExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * The folders, shallowest first, that a write into the vault-relative
 * `folder` creates. Read before the write, since the write creates them.
 */
export async function foldersToCreate(folder: string): Promise<string[]> {
  const vaultPath = getStatus().path
  if (!vaultPath) return []
  const segments = folder.split('/').filter(Boolean)
  const missing: string[] = []
  for (let depth = 1; depth <= segments.length; depth++) {
    const relative = segments.slice(0, depth).join('/')
    if (missing.length > 0 || !(await folderExists(path.join(vaultPath, relative)))) {
      missing.push(relative)
    }
  }
  return missing
}

export function createdFoldersReply(folders: string[]): CreatedFoldersReply {
  return folders.length > 0 ? { created_folders: folders } : {}
}
