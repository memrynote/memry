/**
 * On-disk storage for user-uploaded custom icons.
 *
 * Files live at `<vault>/.memry/icons/<id>.<ext>` — inside `.memry`, so the
 * indexer's exclude patterns already keep them out of the note tree and out of
 * search. The DB row carries the same bytes base64-encoded, which is what makes
 * these files rebuildable on a device that only pulled the row.
 *
 * @module vault/custom-icons
 */

import path from 'path'
import fs from 'fs/promises'
import { getStatus } from './index'
import { getMemryDir } from './init'
import { VaultError, VaultErrorCode } from '../lib/errors'

const ICONS_DIR = 'icons'

function getVaultPath(): string {
  const status = getStatus()
  if (!status.path) {
    throw new VaultError('No vault is currently open', VaultErrorCode.NOT_INITIALIZED)
  }
  return status.path
}

/** Absolute path of the vault's custom-icon directory. */
export function getCustomIconsDir(): string {
  return path.join(getMemryDir(getVaultPath()), ICONS_DIR)
}

/**
 * Absolute path of one icon's file.
 *
 * `id` is minted by us (hex) and `ext` is normalized to `png`/`svg` before it
 * ever reaches here, but both are still rejected if they contain a separator —
 * a synced row is remote input, and this path is handed straight to `fs`.
 */
export function getCustomIconFilePath(id: string, ext: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !/^[a-zA-Z0-9]+$/.test(ext)) {
    throw new VaultError(`Invalid custom icon file name: ${id}.${ext}`, VaultErrorCode.INVALID_PATH)
  }
  return path.join(getCustomIconsDir(), `${id}.${ext}`)
}

/** Write (or overwrite) an icon's bytes. */
export async function writeCustomIconFile(id: string, ext: string, data: Buffer): Promise<string> {
  const filePath = getCustomIconFilePath(id, ext)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, data)
  return filePath
}

/** Remove an icon's bytes. Missing files are not an error. */
export async function deleteCustomIconFile(id: string, ext: string): Promise<void> {
  await fs.rm(getCustomIconFilePath(id, ext), { force: true })
}

/** True when the icon's file is present on this device. */
export async function customIconFileExists(id: string, ext: string): Promise<boolean> {
  try {
    await fs.access(getCustomIconFilePath(id, ext))
    return true
  } catch {
    return false
  }
}
