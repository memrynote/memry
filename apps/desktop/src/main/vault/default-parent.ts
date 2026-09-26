import path from 'path'
import { app } from 'electron'

import { getCurrentVaultPath } from '../store'

/**
 * Folder new vaults are created in by default: next to the current vault when
 * one is open, otherwise `~/Documents/Memry`. Kept free of vault/sync imports so
 * both the create-vault flow and the account vault directory can share it.
 */
export function defaultVaultParentDir(): string {
  const current = getCurrentVaultPath()
  if (current) return path.dirname(current)
  return path.join(app.getPath('documents'), 'Memry')
}
