import { z } from 'zod'

import { VaultLocksChannels } from './ipc-channels'
export { VaultLocksChannels }

/**
 * A read-only lock on one note, or on a folder and everything under it.
 *
 * A note lock is keyed by the note id, so it follows the note through a rename
 * or move made on another device. A folder lock is keyed by the folder's
 * vault-relative path and covers its subfolders and every note created in it.
 */
export const VAULT_LOCK_TARGET_KINDS = ['note', 'folder'] as const
export type VaultLockTargetKind = (typeof VAULT_LOCK_TARGET_KINDS)[number]

export function isVaultLockTargetKind(kind: string): kind is VaultLockTargetKind {
  return (VAULT_LOCK_TARGET_KINDS as readonly string[]).includes(kind)
}

/** The sync item id of a lock. Two devices locking the same target share one record. */
export function vaultLockId(kind: VaultLockTargetKind, target: string): string {
  return `${kind}:${target}`
}

/**
 * What every refused write says, for a locked note and a locked folder alike
 * (#2606 fixes this one agent text). Agents relay it verbatim.
 */
export const VAULT_LOCKED_NOTE_MESSAGE = 'The owner made this note read-only.'

export const VaultLockSetSchema = z.object({
  kind: z.enum(VAULT_LOCK_TARGET_KINDS),
  target: z.string().min(1),
  locked: z.boolean()
})
export type VaultLockSetInput = z.infer<typeof VaultLockSetSchema>

/** Every target locked on this device: note ids and folder paths. */
export interface VaultLockState {
  notes: string[]
  folders: string[]
}

/** A locked file changed outside the app; the app wrote the locked text back. */
export interface VaultLockExternalEditRestoredEvent {
  noteId: string
  path: string
  title: string
}
