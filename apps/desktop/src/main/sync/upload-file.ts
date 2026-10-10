import type { FileHandle } from 'node:fs/promises'
import { OutsideVaultError } from '../lib/errors'
import { getRelativePath, openVaultFile } from '../lib/paths'

/**
 * Opens a file queued for upload. The queue holds a path checked when it was
 * queued, and the file can be swapped for a link outside the vault before the
 * upload runs, so the upload stats and reads only through this handle, which
 * `openVaultFile` checked after opening (#3098).
 */
export async function openUploadFile(vaultPath: string, filePath: string): Promise<FileHandle> {
  const relativePath = getRelativePath(vaultPath, filePath)
  if (relativePath === null) throw new OutsideVaultError(filePath)
  const handle = await openVaultFile(vaultPath, relativePath)
  if (handle === null) {
    throw Object.assign(new Error(`ENOENT: no such file, open '${filePath}'`), { code: 'ENOENT' })
  }
  return handle
}
