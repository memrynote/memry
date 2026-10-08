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
import { eq } from 'drizzle-orm'
import { vaultLockBaselines } from '@memry/db-schema/schema/vault-locks'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
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
  lockedFolderCovering,
  noteLockedError,
  vaultLockSource
} from './registry'
import {
  deleteBaseline,
  forgetFileMode,
  getBaseline,
  getFileMode,
  recordFileMode,
  writeBaseline
} from './store'

const log = createLogger('VaultLockFiles')

const FOLDER_CONFIG_FILE = '.folder.md'

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}

/**
 * The mode a lock change leaves the file in, or null when it already has it.
 * Locking records the file's permission bits once, then clears every write
 * bit; lifting the lock gives the recorded bits back. A file with no record
 * (no data DB yet, or locked by an older build) only gets the owner write bit.
 */
function nextMode(absolutePath: string, current: number, readOnly: boolean): number | null {
  const relative = isDatabaseInitialized() ? lockableRelativePath(absolutePath) : null
  let recorded = relative === null ? undefined : getFileMode(getDatabase(), relative)
  if (readOnly && recorded === undefined && relative !== null && current & 0o222) {
    recorded = current & 0o777
    recordFileMode(getDatabase(), relative, recorded)
  }
  const next = readOnly
    ? (recorded ?? current & 0o777) & ~0o222
    : (recorded ?? (current | 0o200) & 0o777)
  return next === (current & 0o777) ? null : (current & 0o7000) | next
}

export async function setFileReadOnly(absolutePath: string, readOnly: boolean): Promise<void> {
  try {
    const { mode } = await fs.promises.stat(absolutePath)
    const next = nextMode(absolutePath, mode, readOnly)
    if (next !== null) await fs.promises.chmod(absolutePath, next)
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return
    log.warn('Could not change the read-only attribute', { readOnly, error: err })
  }
}

export function setFileReadOnlySync(absolutePath: string, readOnly: boolean): void {
  try {
    const { mode } = fs.statSync(absolutePath)
    const next = nextMode(absolutePath, mode, readOnly)
    if (next !== null) fs.chmodSync(absolutePath, next)
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return
    log.warn('Could not change the read-only attribute', { readOnly, error: err })
  }
}

/** A lock no longer covers the file: its recorded bits back, and the record dropped. */
export async function releaseLockedFile(absolutePath: string): Promise<void> {
  await setFileReadOnly(absolutePath, false)
  forgetRecordedMode(absolutePath)
}

function releaseLockedFileSync(absolutePath: string): void {
  setFileReadOnlySync(absolutePath, false)
  forgetRecordedMode(absolutePath)
}

function forgetRecordedMode(absolutePath: string): void {
  const relative = lockableRelativePath(absolutePath)
  if (relative === null || !isDatabaseInitialized()) return
  try {
    forgetFileMode(getDatabase(), relative)
  } catch (err) {
    log.warn('Could not drop the recorded mode of an unlocked file', { error: err })
  }
}

/**
 * After the watcher saw a file added, moved in, renamed or replaced from
 * outside: read-only again when a lock covers it. Never throws.
 */
export async function protectLockedFile(absolutePath: string): Promise<void> {
  try {
    if (isLockedFile(absolutePath) !== null) await setFileReadOnly(absolutePath, true)
  } catch (err) {
    log.warn('Could not protect a locked file changed outside the app', { error: err })
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

/** A locked note's file or attachment says "note"; any other file in a locked folder says "folder". */
function refusal(relative: string): Error {
  const noteId = vaultLockSource()?.noteIdAtPath(relative) ?? undefined
  return noteId || lockedFolderCovering(relative) === null
    ? noteLockedError(noteId)
    : folderLockedError()
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

/** After an allowed write to a locked file: read-only again, and its bytes become the baseline. */
export async function afterLockedFileWrite(
  absolutePath: string,
  relative: string,
  content: string | null
): Promise<void> {
  await setFileReadOnly(absolutePath, true)
  if (content !== null) recordLockedBytes(relative, content)
}

/**
 * For writers that only ever apply another device's change (the sync file
 * writes): no refusal. A locked file's read-only attribute is cleared so
 * Windows lets the write, rename over or delete through, and set again after,
 * whether `write` landed or threw. `write` returns the bytes it put in the
 * file, which become the locked baseline, or null.
 */
export function writeThroughLockSync(absolutePath: string, write: () => string | null): void {
  const relative = isLockedFile(absolutePath)
  if (relative !== null) setFileReadOnlySync(absolutePath, false)
  let written: string | null = null
  try {
    written = write()
  } finally {
    if (relative !== null) {
      setFileReadOnlySync(absolutePath, true)
      if (written !== null) recordLockedBytes(relative, written)
    }
  }
}

export async function writeThroughLock(
  absolutePath: string,
  write: () => Promise<string | null>
): Promise<void> {
  const relative = isLockedFile(absolutePath)
  if (relative !== null) await setFileReadOnly(absolutePath, false)
  let written: string | null = null
  try {
    written = await write()
  } finally {
    if (relative !== null) await afterLockedFileWrite(absolutePath, relative, written)
  }
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
      releaseLockedFileSync(absolutePath)
      deleteBaseline(getDatabase(), noteId)
    }
  } catch (err) {
    log.warn('Could not settle the lock state of a synced note file', { error: err })
  }
}

/**
 * A note or journal deleted on another device: the locked text kept for its
 * restores has nothing left to restore. Never throws; a leftover row is
 * harmless.
 */
export function forgetBaselineOfRemotelyDeletedNote(db: DrizzleDb, noteId: string): void {
  try {
    db.delete(vaultLockBaselines).where(eq(vaultLockBaselines.noteId, noteId)).run()
  } catch (err) {
    log.warn('Could not drop the locked text of a deleted note', { error: err })
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
