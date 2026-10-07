/**
 * Which notes and folders the owner locked, held once for the whole renderer.
 *
 * A plain module store read through `useSyncExternalStore`, like the custom
 * icon store: sidebar rows read it by the hundred. The first subscriber loads
 * the state and wires `vault-locks:changed`, which main broadcasts after every
 * local or remote lock change and at vault open.
 */

import { useSyncExternalStore } from 'react'
import type { VaultLockState, VaultLockTargetKind } from '@memry/contracts/vault-locks-api'
import { createLogger } from './logger'

const log = createLogger('VaultLocksStore')

const EMPTY: VaultLockState = { notes: [], folders: [] }

let state: VaultLockState = EMPTY
let noteIds = new Set<string>()
const listeners = new Set<() => void>()
let started = false

function publish(next: VaultLockState): void {
  state = next
  noteIds = new Set(next.notes)
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  started = true
  const api = window.api
  if (!api?.vaultLocks) return
  api.onVaultLocksChanged(publish)
  void api.vaultLocks
    .list()
    .then(publish)
    .catch((error: unknown) => log.warn('Failed to load vault locks', error))
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`)
}

/** The locked folder covering this vault-relative path, or null. */
export function lockedFolderFor(path: string, locks: VaultLockState = state): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return locks.folders.find((folder) => isUnder(normalized, folder)) ?? null
}

export function isNoteLockedIn(
  locks: VaultLockState,
  ids: ReadonlySet<string>,
  noteId: string,
  notePath: string | null | undefined
): boolean {
  if (ids.has(noteId)) return true
  return !!notePath && lockedFolderFor(notePath, locks) !== null
}

export function useVaultLockState(): VaultLockState {
  return useSyncExternalStore(subscribe, () => state)
}

/**
 * Locked by its own lock or by a lock on a folder above it. With no id yet
 * (a journal day with no file), only a folder lock covering the path counts:
 * main refuses to create a file there.
 */
export function useIsNoteLocked(
  noteId: string | null | undefined,
  notePath?: string | null
): boolean {
  const locks = useVaultLockState()
  if (!noteId) return !!notePath && lockedFolderFor(notePath, locks) !== null
  return isNoteLockedIn(locks, noteIds, noteId, notePath)
}

/** True for a note's own lock only (what the unlock toggle can undo). */
export function useHasOwnNoteLock(noteId: string | null | undefined): boolean {
  const locks = useVaultLockState()
  return !!noteId && locks.notes.includes(noteId)
}

export async function setVaultLock(
  kind: VaultLockTargetKind,
  target: string,
  locked: boolean
): Promise<void> {
  publish(await window.api.vaultLocks.set({ kind, target, locked }))
}
