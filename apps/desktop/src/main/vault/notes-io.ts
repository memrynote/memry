/**
 * Vault path utilities — vault-relative ↔ absolute conversions and notes
 * directory resolution. Pulled from notes.ts during the Phase 3.1 split
 * (.claude/plans/tech-debt-remediation.md).
 *
 * @module vault/notes-io
 */

import path from 'path'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { getStatus, getConfig } from './index'
import { normalizeRelativePath } from '../lib/paths'
import { VaultError, VaultErrorCode } from '../lib/errors'

// ============================================================================
// Helpers
// ============================================================================

function getVaultPath(): string {
  const status = getStatus()
  if (!status.path) {
    throw new VaultError('No vault is currently open', VaultErrorCode.NOT_INITIALIZED)
  }
  return status.path
}

// ============================================================================
// Path Conversions
// ============================================================================

/**
 * Root every folder path in the app is relative to.
 *
 * The sidebar tree, folder view, `.folder.md` config, moves and the sync wire
 * all speak vault-relative folder paths. `defaultNoteFolder` deliberately does
 * NOT re-root this: setting it must not change what the sidebar shows (#1204).
 */
export function getVaultRoot(): string {
  return getVaultPath()
}

/**
 * Where a new note lands when the caller does not name a folder.
 *
 * This is the only thing `defaultNoteFolder` controls. A caller that does name
 * a folder gets `getVaultRoot()` + that folder, so creating inside a folder
 * never nests it under the default one.
 */
export function getDefaultNoteDir(): string {
  const vaultPath = getVaultPath()
  const config = getConfig()
  return path.join(vaultPath, config.defaultNoteFolder)
}

export function toAbsolutePath(relativePath: string): string {
  const vaultPath = getVaultPath()
  return path.join(vaultPath, relativePath)
}

export function toRelativePath(absolutePath: string): string {
  const vaultPath = getVaultPath()
  return normalizeRelativePath(path.relative(vaultPath, absolutePath))
}

// ============================================================================
// Event Broadcast
// ============================================================================

export function emitNoteEvent(channel: string, payload: unknown): void {
  broadcastToAllWindows(channel, payload)
}
