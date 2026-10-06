/**
 * Locking and unlocking, keeping locked files read-only on disk, and writing a
 * locked note's text back when its file changes outside the app.
 *
 * @module vault-locks/service
 */

import fs from 'fs'
import path from 'path'
import {
  VaultLocksChannels,
  type VaultLockSetInput,
  type VaultLockState
} from '@memry/contracts/vault-locks-api'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { getNoteCacheById, getNoteCacheByPath } from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase, isDatabaseInitialized } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { atomicWrite, safeRead } from '../vault/file-ops'
import { folderExists } from '../vault/folders'
import { generateContentHash } from '../vault/frontmatter'
import { getStatus } from '../vault/index'
import { createSnapshot } from '../vault/notes-versions'
import { setFileReadOnly } from './files'
import {
  getVaultLockState,
  invalidateVaultLocks,
  isNoteLocked,
  lockedFolderCovering,
  normalizeLockFolderPath,
  runWithLockedWritesAllowed
} from './registry'
import { enqueueVaultLockCreate, enqueueVaultLockUpdate } from './runtime-effects'
import {
  deleteBaseline,
  getBaseline,
  listBaselineNoteIds,
  writeBaseline,
  writeLockRow
} from './store'

const log = createLogger('VaultLocks')

function vaultPath(): string | null {
  return getStatus().path
}

/** Every file under a folder, skipping hidden entries and folder config, as absolute paths. */
async function listFilesUnder(absoluteFolder: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  await walk(absoluteFolder)
  return files
}

function notePath(noteId: string): string | null {
  return getNoteCacheById(getIndexDatabase(), noteId)?.path ?? null
}

function getNoteIdByPath(relativePath: string): string | null {
  return getNoteCacheByPath(getIndexDatabase(), relativePath)?.id ?? null
}

/** Read-only on disk, with its current bytes as the baseline when it is a markdown note. */
async function protectNoteFile(noteId: string, relativePath: string, root: string): Promise<void> {
  const absolutePath = path.join(root, relativePath)
  if (relativePath.endsWith('.md') && !getBaseline(getDatabase(), noteId)) {
    const content = await safeRead(absolutePath)
    if (content !== null) {
      writeBaseline(getDatabase(), noteId, content, generateContentHash(content))
    }
  }
  await setFileReadOnly(absolutePath, true)
}

async function releaseNoteFile(
  noteId: string,
  relativePath: string | null,
  root: string
): Promise<void> {
  if (relativePath !== null) await setFileReadOnly(path.join(root, relativePath), false)
  deleteBaseline(getDatabase(), noteId)
}

/**
 * Bring the disk in line with the locks: every locked file read-only, every
 * locked markdown note with a baseline, and every note that lost its lock
 * writable again with its baseline dropped. A folder that was just unlocked is
 * passed in so its other files (PDFs, images) are made writable too.
 */
export async function reconcileLockedFiles(unlockedFolder?: string): Promise<void> {
  const root = vaultPath()
  if (!root || !isDatabaseInitialized()) return
  const db = getDatabase()
  const state = getVaultLockState()

  for (const noteId of state.notes) {
    const relative = notePath(noteId)
    if (relative !== null) await protectNoteFile(noteId, relative, root)
  }

  for (const folder of state.folders) {
    for (const absolutePath of await listFilesUnder(path.join(root, folder))) {
      const relative = path.relative(root, absolutePath).replace(/\\/g, '/')
      const noteId = getNoteIdByPath(relative)
      if (noteId) await protectNoteFile(noteId, relative, root)
      else await setFileReadOnly(absolutePath, true)
    }
  }

  for (const noteId of listBaselineNoteIds(db)) {
    if (isNoteLocked(noteId)) continue
    await releaseNoteFile(noteId, notePath(noteId), root)
  }

  if (unlockedFolder !== undefined) {
    for (const absolutePath of await listFilesUnder(path.join(root, unlockedFolder))) {
      const relative = path.relative(root, absolutePath).replace(/\\/g, '/')
      if (lockedFolderCovering(relative) !== null) continue
      const noteId = getNoteIdByPath(relative)
      if (noteId && isNoteLocked(noteId, relative)) continue
      await setFileReadOnly(absolutePath, false)
    }
  }
}

let reconcileTimer: ReturnType<typeof setTimeout> | null = null

/** Reconcile soon, once: remote applies move and create files a lock may cover. */
export function scheduleLockedFileReconcile(): void {
  if (reconcileTimer) return
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null
    void reconcileLockedFiles().catch((err) =>
      log.warn('Reconciling locked files failed', { error: err })
    )
  }, 1000)
}

function broadcastLockState(): VaultLockState {
  const state = getVaultLockState()
  broadcastToAllWindows(VaultLocksChannels.events.CHANGED, state)
  return state
}

/** Lock or unlock a note or folder on this device, and sync the change. */
export async function setVaultLock(input: VaultLockSetInput): Promise<VaultLockState> {
  const target = input.kind === 'folder' ? normalizeLockFolderPath(input.target) : input.target
  if (input.kind === 'note' && !getNoteCacheById(getIndexDatabase(), target)) {
    throw new NoteError(`Note not found: ${target}`, NoteErrorCode.NOT_FOUND, target)
  }
  if (input.kind === 'folder' && (target === '' || !folderExists(target))) {
    throw new NoteError(`Folder not found: ${target}`, NoteErrorCode.INVALID_PATH)
  }

  const written = writeLockRow(getDatabase(), input.kind, target, input.locked)
  if (!written) return getVaultLockState()
  if (written.created) enqueueVaultLockCreate(written.row.id)
  else enqueueVaultLockUpdate(written.row.id)

  invalidateVaultLocks()
  await reconcileLockedFiles(input.kind === 'folder' && !input.locked ? target : undefined)
  return broadcastLockState()
}

/** A lock record from another device landed: refresh, re-protect, tell the windows. */
export function onRemoteVaultLockApplied(folderUnlocked?: string): void {
  invalidateVaultLocks()
  void reconcileLockedFiles(folderUnlocked)
    .catch((err) => log.warn('Reconciling locked files after a remote lock failed', { error: err }))
    .finally(() => broadcastLockState())
}

/**
 * A locked note's file changed outside the app (or is gone). Keep the changed
 * bytes as a version, write the locked text back, and tell the windows.
 *
 * @param changed the bytes now on disk, or null when the file was removed
 * @returns true when the locked text was written back
 */
export async function restoreLockedNoteFile(
  noteId: string,
  changed: string | null
): Promise<boolean> {
  const root = vaultPath()
  const relative = notePath(noteId)
  if (!root || relative === null || !isNoteLocked(noteId, relative)) return false

  const baseline = getBaseline(getDatabase(), noteId)
  if (!baseline) {
    if (changed !== null) {
      writeBaseline(getDatabase(), noteId, changed, generateContentHash(changed))
    }
    return false
  }
  if (changed !== null && generateContentHash(changed) === baseline.contentHash) return false

  const title = getNoteCacheById(getIndexDatabase(), noteId)?.title ?? relative
  if (changed !== null) {
    try {
      createSnapshot(noteId, changed, title, SnapshotReasons.SIGNIFICANT)
    } catch (err) {
      // Without the version the outside change would be lost; leave the file.
      log.error('Could not keep the outside change to a locked note as a version', {
        noteId,
        error: err
      })
      return false
    }
  }

  await runWithLockedWritesAllowed(() => atomicWrite(path.join(root, relative), baseline.content))
  log.warn('Wrote the locked text back over an outside change', {
    noteId,
    removed: changed === null
  })
  broadcastToAllWindows(VaultLocksChannels.events.EXTERNAL_EDIT_RESTORED, {
    noteId,
    path: relative,
    title
  })
  return true
}

/**
 * At vault open: locked files edited or removed while the app was closed get
 * their locked text back, then every lock is re-applied on disk.
 */
export async function checkLockedFilesAtOpen(): Promise<void> {
  const root = vaultPath()
  if (!root || !isDatabaseInitialized()) return
  for (const noteId of listBaselineNoteIds(getDatabase())) {
    const relative = notePath(noteId)
    if (relative === null || !isNoteLocked(noteId, relative)) continue
    const onDisk = await safeRead(path.join(root, relative))
    await restoreLockedNoteFile(noteId, onDisk)
  }
  await reconcileLockedFiles()
  broadcastLockState()
}
