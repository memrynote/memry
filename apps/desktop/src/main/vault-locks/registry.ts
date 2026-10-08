/**
 * Which notes and folders are locked, and the checks every local write runs.
 *
 * A lock stops edits made on this device: body, title, tags, properties,
 * rename, move and delete, by hand or by an agent. Edits that arrive from
 * another device still apply, so every remote apply runs inside
 * `runWithLockedWritesAllowed`, as does the app writing a locked file's own
 * text back after an outside change.
 *
 * @module vault-locks/registry
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { VAULT_LOCKED_NOTE_MESSAGE, type VaultLockState } from '@memry/contracts/vault-locks-api'
import type { DataDb } from '../database/types'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { listLockedRows } from './store'

interface LockSnapshot {
  db: DataDb
  noteIds: Set<string>
  folders: string[]
}

/**
 * Where the locks and note paths of the open vault are read from. Installed at
 * vault open; until then nothing is locked, which keeps this module free of
 * database imports for the many writers that consult it.
 */
export interface VaultLockSource {
  /** The open vault's data DB, or null while no vault is open. */
  dataDb(): DataDb | null
  /** The vault-relative path of an indexed note, or null. */
  notePathOf(noteId: string): string | null
  /** The id of the indexed note at a vault-relative path, or null. */
  noteIdAtPath(relativePath: string): string | null
}

let source: VaultLockSource | null = null
let snapshot: LockSnapshot | null = null

export function installVaultLockSource(next: VaultLockSource): void {
  source = next
  snapshot = null
}

/** True once a vault has installed its lock source. */
export function isVaultLockTrackingActive(): boolean {
  return source !== null
}

export function vaultLockSource(): VaultLockSource | null {
  return source
}

const lockedWriteScope = new AsyncLocalStorage<true>()

/** Trim slashes so `a/b/`, `/a/b` and `a\\b` all name the folder `a/b`. */
export function normalizeLockFolderPath(folderPath: string): string {
  return folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function isUnder(path: string, folder: string): boolean {
  return folder === '' || path === folder || path.startsWith(`${folder}/`)
}

/**
 * The lock rows of the open vault, read once per data DB connection and
 * re-read after `invalidateVaultLocks`. Keyed on the connection so a vault
 * switch can never answer with the previous vault's locks.
 */
function current(): LockSnapshot | null {
  const db = source?.dataDb() ?? null
  if (!db) return null
  if (snapshot?.db === db) return snapshot
  const noteIds = new Set<string>()
  const folders: string[] = []
  for (const row of listLockedRows(db)) {
    if (row.targetKind === 'note') noteIds.add(row.target)
    else if (row.targetKind === 'folder') folders.push(normalizeLockFolderPath(row.target))
  }
  snapshot = { db, noteIds, folders }
  return snapshot
}

export function invalidateVaultLocks(): void {
  snapshot = null
}

export function getVaultLockState(): VaultLockState {
  const locks = current()
  return { notes: [...(locks?.noteIds ?? [])], folders: [...(locks?.folders ?? [])] }
}

export function hasAnyVaultLock(): boolean {
  const locks = current()
  return !!locks && (locks.noteIds.size > 0 || locks.folders.length > 0)
}

/** The locked folder that covers this vault-relative path (itself or an ancestor). */
export function lockedFolderCovering(relativePath: string): string | null {
  const locks = current()
  if (!locks) return null
  const normalized = normalizeLockFolderPath(relativePath)
  return locks.folders.find((folder) => isUnder(normalized, folder)) ?? null
}

function notePathOf(noteId: string): string | null {
  return source?.notePathOf(noteId) ?? null
}

/** A note is locked by its own lock or by a lock on any folder above it. */
export function isNoteLocked(noteId: string, notePath?: string | null): boolean {
  const locks = current()
  if (!locks) return false
  if (locks.noteIds.has(noteId)) return true
  if (locks.folders.length === 0) return false
  const path = notePath ?? notePathOf(noteId)
  return path !== null && lockedFolderCovering(path) !== null
}

/** The note that owns a file in its attachments folder (`attachments/<noteId>/<file>`), or null. */
function attachmentOwnerOf(relativePath: string): string | null {
  const segments = relativePath.split('/')
  return segments.length === 3 && segments[0] === 'attachments' ? segments[1] : null
}

/**
 * The file sits in a locked folder, is a locked note's file, or is in a locked
 * note's attachments folder.
 */
export function isVaultPathLocked(relativePath: string): boolean {
  const locks = current()
  if (!locks) return false
  const normalized = normalizeLockFolderPath(relativePath)
  if (lockedFolderCovering(normalized) !== null) return true
  const owner = attachmentOwnerOf(normalized)
  if (owner !== null && isNoteLocked(owner)) return true
  if (locks.noteIds.size === 0) return false
  const noteId = source?.noteIdAtPath(normalized) ?? null
  return noteId !== null && locks.noteIds.has(noteId)
}

/** True when a locked folder or the file of a locked note sits under `folder`. */
function locksInside(folder: string): boolean {
  const locks = current()
  if (!locks) return false
  if (locks.folders.some((locked) => isUnder(locked, folder))) return true
  for (const noteId of locks.noteIds) {
    const path = notePathOf(noteId)
    if (path !== null && isUnder(path, folder)) return true
  }
  return false
}

export function isLockedWriteAllowed(): boolean {
  return lockedWriteScope.getStore() === true
}

/**
 * Run `fn` with lock checks lifted: remote applies, and the app restoring a
 * locked file's own text. Async work started inside keeps the scope.
 */
export function runWithLockedWritesAllowed<T>(fn: () => T): T {
  return lockedWriteScope.run(true, fn)
}

export function noteLockedError(noteId?: string): NoteError {
  return new NoteError(VAULT_LOCKED_NOTE_MESSAGE, NoteErrorCode.READ_ONLY, noteId)
}

export function folderLockedError(): NoteError {
  return new NoteError(VAULT_LOCKED_NOTE_MESSAGE, NoteErrorCode.READ_ONLY)
}

/** Refuse a local body, title, tag, property, rename, move or delete of a locked note. */
export function assertNoteWritable(noteId: string, notePath?: string | null): void {
  if (isLockedWriteAllowed()) return
  if (isNoteLocked(noteId, notePath)) throw noteLockedError(noteId)
}

/** Refuse creating or moving anything into a locked folder. */
export function assertFolderWritable(folderPath: string | null | undefined): void {
  if (isLockedWriteAllowed()) return
  if (lockedFolderCovering(normalizeLockFolderPath(folderPath ?? '')) !== null) {
    throw folderLockedError()
  }
}

/** Refuse creating a folder, or moving one, to a path inside a locked folder. */
export function assertParentFolderWritable(folderPath: string): void {
  const normalized = normalizeLockFolderPath(folderPath)
  const slash = normalized.lastIndexOf('/')
  assertFolderWritable(slash === -1 ? '' : normalized.slice(0, slash))
}

/**
 * Refuse a rename, move or delete of a folder that is locked, sits in a locked
 * folder, or holds a locked note or folder: each would move or remove a locked
 * item with it.
 */
export function assertFolderTreeWritable(folderPath: string): void {
  if (isLockedWriteAllowed()) return
  const folder = normalizeLockFolderPath(folderPath)
  if (lockedFolderCovering(folder) !== null || locksInside(folder)) throw folderLockedError()
}
