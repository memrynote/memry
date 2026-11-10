/**
 * Which notes and folders the owner locked, held once for the whole renderer.
 *
 * A plain module store read through `useSyncExternalStore`, like the custom
 * icon store: sidebar rows read it by the hundred. The first subscriber loads
 * the state and wires `VaultLocksChangedEvent`, which Rust sends after every
 * lock change and at every vault open.
 */

import { useSyncExternalStore } from 'react'
import type { VaultLockState, VaultLockTargetKind } from '@memry/contracts/vault-locks-api'
import { commands, events } from '../../../generated/bindings'
import { subscribeToEvent } from '@/services/tauri-event'
import { commandErrorCode } from './ipc-error'
import { createLogger } from './logger'

const log = createLogger('VaultLocksStore')

const EMPTY: VaultLockState = { notes: [], folders: [] }

let state: VaultLockState = EMPTY
let noteIds = new Set<string>()
// Lock changes Rust is still running (`kind:target`): a folder of 10k notes takes seconds.
let pending: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
let started = false

function notify(): void {
  for (const listener of listeners) listener()
}

function publish(next: VaultLockState): void {
  state = next
  noteIds = new Set(next.notes)
  notify()
}

function setPending(key: string, running: boolean): void {
  const next = new Set(pending)
  if (running) next.add(key)
  else next.delete(key)
  pending = next
  notify()
}

function start(): void {
  if (started) return
  started = true
  // App-lifetime: the locks follow the open vault, whose open sends them again.
  subscribeToEvent(events.vaultLocksChangedEvent, publish)
  commands
    .vaultLocksList()
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

/** True while a lock change of this note or folder runs. */
export function useIsVaultLockPending(kind: VaultLockTargetKind, target: string): boolean {
  const key = `${kind}:${target}`
  return useSyncExternalStore(subscribe, () => pending.has(key))
}

/**
 * Locks or unlocks, and publishes the locks Rust answers. A second change of the same target
 * while the first runs is dropped. An unlock of a folder no longer locked (another window
 * unlocked it, or the list is stale) is `folder_not_found`: the list is read again instead.
 */
export async function setVaultLock(
  kind: VaultLockTargetKind,
  target: string,
  locked: boolean
): Promise<void> {
  const key = `${kind}:${target}`
  if (pending.has(key)) return
  setPending(key, true)
  try {
    publish(await commands.vaultLocksSet({ kind, target, locked }))
  } catch (error) {
    if (locked || kind !== 'folder' || commandErrorCode(error) !== 'folder_not_found') throw error
    log.info('Folder lock already gone; reading the locks again', target)
    publish(await commands.vaultLocksList())
  } finally {
    setPending(key, false)
  }
}
