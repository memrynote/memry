import fs from 'fs'
import path from 'path'

import type { SelectVaultResponse } from '@memry/contracts/vault-api'

import { createLogger } from '../lib/logger'
import { selectVault } from './index'

const log = createLogger('Vault:Create')

// Path separators, NUL, and the characters Windows rejects in file names.
// Leading dots would hide the vault folder on macOS/Linux.
const INVALID_NAME = /[/\\:*?"<>|\0]/

export function isValidVaultFolderName(name: string): boolean {
  return name.length > 0 && !name.startsWith('.') && !INVALID_NAME.test(name)
}

/**
 * Create `<parentPath>/<name>` and open it as the current vault.
 *
 * Refuses to reuse an existing folder: adopting existing files is what
 * "Open folder as vault" is for, and silently opening a folder the user did
 * not mean to pick is how notes end up mixed into the wrong directory.
 */
export async function createVault(input: {
  parentPath: string
  name: string
}): Promise<SelectVaultResponse> {
  const name = input.name.trim()
  if (!isValidVaultFolderName(name)) {
    return {
      success: false,
      vault: null,
      error: 'Vault name contains characters that cannot be used in a folder name',
      errorCode: 'invalid-name'
    }
  }

  const target = path.join(input.parentPath, name)
  if (fs.existsSync(target)) {
    return {
      success: false,
      vault: null,
      error: 'A folder with this name already exists here',
      errorCode: 'already-exists'
    }
  }

  try {
    fs.mkdirSync(input.parentPath, { recursive: true })
    fs.mkdirSync(target)
  } catch (error) {
    log.warn('Vault folder creation failed', { error })
    const message = error instanceof Error ? error.message : 'Could not create the vault folder'
    return { success: false, vault: null, error: message }
  }

  const result = await selectVault({ path: target })
  if (!result.success) {
    // Leave nothing behind for a vault that never opened. rmdir (not rm -r)
    // only succeeds while the folder is still empty, so it cannot eat files.
    try {
      fs.rmdirSync(target)
    } catch {
      // Already populated by a partial open; keep it for the user to inspect.
    }
  }
  return result
}
