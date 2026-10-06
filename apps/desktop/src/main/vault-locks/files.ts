/**
 * The file side of read-only locks: the operating system's read-only attribute
 * on every locked file, and the guard every vault write primitive consults.
 *
 * The attribute is what stops a tool outside the app (an editor, a CLI agent)
 * from saving over a locked file without asking. The app clears it for its own
 * allowed writes (remote edits, restoring the locked text) and sets it again
 * right after. Node maps the owner write bit to the Windows read-only
 * attribute, so one chmod covers every platform.
 *
 * @module vault-locks/files
 */

import fs from 'fs'
import path from 'path'
import { getNoteCacheById, getNoteCacheByPath } from '@main/database/queries/notes'
import {
  getDatabase,
  getIndexDatabase,
  isDatabaseInitialized,
  isIndexDatabaseInitialized
} from '../database'
import { createLogger } from '../lib/logger'
import { normalizeRelativePath } from '../lib/paths'
import { setVaultFileWriteGuard } from '../vault/file-ops'
import { generateContentHash } from '../vault/frontmatter'
import { getStatus } from '../vault/index'
import {
  folderLockedError,
  hasAnyVaultLock,
  installVaultLockSource,
  isLockedWriteAllowed,
  isNoteLocked,
  isVaultLockTrackingActive,
  isVaultPathLocked,
  noteLockedError,
  vaultLockSource
} from './registry'
import { deleteBaseline, getBaseline, writeBaseline } from './store'

const log = createLogger('VaultLockFiles')

const FOLDER_CONFIG_FILE = '.folder.md'

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}

function modeFor(current: number, readOnly: boolean): number {
  return readOnly ? current & ~0o222 : current | 0o200
}

export async function setFileReadOnly(absolutePath: string, readOnly: boolean): Promise<void> {
  try {
    const { mode } = await fs.promises.stat(absolutePath)
    const next = modeFor(mode, readOnly)
    if ((next & 0o777) !== (mode & 0o777)) await fs.promises.chmod(absolutePath, next & 0o7777)
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return
    log.warn('Could not change the read-only attribute', { readOnly, error: err })
  }
}

export function setFileReadOnlySync(absolutePath: string, readOnly: boolean): void {
  try {
    const { mode } = fs.statSync(absolutePath)
    const next = modeFor(mode, readOnly)
    if ((next & 0o777) !== (mode & 0o777)) fs.chmodSync(absolutePath, next & 0o7777)
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return
    log.warn('Could not change the read-only attribute', { readOnly, error: err })
  }
}

/** The vault-relative path of a file the locks can cover, or null (outside the vault, folder config). */
export function lockableRelativePath(absolutePath: string): string | null {
  const vaultPath = getStatus().path
  if (!vaultPath) return null
  const relative = path.relative(vaultPath, absolutePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  if (path.basename(relative) === FOLDER_CONFIG_FILE) return null
  return normalizeRelativePath(relative)
}

function isLockedFile(absolutePath: string): string | null {
  if (!hasAnyVaultLock()) return null
  const relative = lockableRelativePath(absolutePath)
  return relative !== null && isVaultPathLocked(relative) ? relative : null
}

function refusal(relative: string): Error {
  const noteId = vaultLockSource()?.noteIdAtPath(relative)
  return noteId ? noteLockedError(noteId) : folderLockedError()
}

/**
 * Record the bytes the app just put in a locked note's file, for a later
 * restore. Never throws: the file is already written.
 */
export function recordLockedBytes(relative: string, content: string): void {
  if (!relative.endsWith('.md')) return
  try {
    const noteId = vaultLockSource()?.noteIdAtPath(relative)
    if (!noteId) return
    writeBaseline(getDatabase(), noteId, content, generateContentHash(content))
  } catch (err) {
    log.warn('Could not record the locked text of a note', { error: err })
  }
}

/**
 * Before the app writes, renames over or deletes a vault file. A locked file is
 * refused unless the write runs in an allowed scope; an allowed one has its
 * read-only attribute cleared so Windows lets the write through.
 *
 * @returns the file's vault-relative path when it is locked, else null
 */
export async function beforeVaultFileWrite(absolutePath: string): Promise<string | null> {
  const relative = isLockedFile(absolutePath)
  if (relative === null) return null
  if (!isLockedWriteAllowed()) throw refusal(relative)
  await setFileReadOnly(absolutePath, false)
  return relative
}

/**
 * For writers that only ever apply another device's change (the sync file
 * writes): no refusal, just clear the read-only attribute of a locked file so
 * Windows lets the write, rename over or delete through.
 *
 * @returns the file's vault-relative path when it is locked, else null
 */
export function unprotectForRemoteWriteSync(absolutePath: string): string | null {
  const relative = isLockedFile(absolutePath)
  if (relative !== null) setFileReadOnlySync(absolutePath, false)
  return relative
}

export async function unprotectForRemoteWrite(absolutePath: string): Promise<string | null> {
  const relative = isLockedFile(absolutePath)
  if (relative !== null) await setFileReadOnly(absolutePath, false)
  return relative
}

/** After an allowed write to a locked file: read-only again, and its bytes become the baseline. */
export async function afterLockedFileWrite(
  absolutePath: string,
  relative: string,
  content: string | null
): Promise<void> {
  await setFileReadOnly(absolutePath, true)
  if (content !== null) recordLockedBytes(relative, content)
}

export function afterLockedFileWriteSync(
  absolutePath: string,
  relative: string,
  content: string | null
): void {
  setFileReadOnlySync(absolutePath, true)
  if (content !== null) recordLockedBytes(relative, content)
}

/**
 * After a remote apply wrote, moved or renamed a note's file: read-only when
 * the note is still locked (with the written bytes as its baseline), writable
 * again when the move took it out of a locked folder. Never throws.
 */
export function settleRemoteNoteFileSync(
  noteId: string,
  absolutePath: string,
  relativePath: string,
  content: string | null
): void {
  try {
    if (!isVaultLockTrackingActive()) return
    if (!hasAnyVaultLock() && !hasBaseline(noteId)) return
    if (isNoteLocked(noteId, relativePath)) {
      setFileReadOnlySync(absolutePath, true)
      if (content !== null) {
        writeBaseline(getDatabase(), noteId, content, generateContentHash(content))
      }
      return
    }
    if (hasBaseline(noteId)) {
      setFileReadOnlySync(absolutePath, false)
      deleteBaseline(getDatabase(), noteId)
    }
  } catch (err) {
    log.warn('Could not settle the lock state of a synced note file', { error: err })
  }
}

function hasBaseline(noteId: string): boolean {
  return getBaseline(getDatabase(), noteId) !== undefined
}

/** Turn locks on for the vaults this process opens: lock lookups and the file write guard. */
export function installVaultLockFileGuard(): void {
  installVaultLockSource({
    dataDb: () => (isDatabaseInitialized() ? getDatabase() : null),
    notePathOf: (noteId) =>
      isIndexDatabaseInitialized()
        ? (getNoteCacheById(getIndexDatabase(), noteId)?.path ?? null)
        : null,
    noteIdAtPath: (relativePath) =>
      isIndexDatabaseInitialized()
        ? (getNoteCacheByPath(getIndexDatabase(), relativePath)?.id ?? null)
        : null
  })
  setVaultFileWriteGuard({
    beforeWrite: beforeVaultFileWrite,
    afterWrite: afterLockedFileWrite
  })
}
