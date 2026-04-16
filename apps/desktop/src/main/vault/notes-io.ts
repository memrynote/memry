/**
 * Vault path utilities — vault-relative ↔ absolute conversions and notes
 * directory resolution. Pulled from notes.ts during the Phase 3.1 split
 * (.claude/plans/tech-debt-remediation.md).
 *
 * @module vault/notes-io
 */

import path from 'path'
import { BrowserWindow } from 'electron'
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

export function getNotesDir(): string {
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
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, payload)
  })
}
