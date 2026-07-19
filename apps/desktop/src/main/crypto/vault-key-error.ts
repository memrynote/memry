import type { VaultRecoveryNeededEvent } from '@memry/contracts/ipc-events'

/**
 * Classifies a vault-key verification failure so the sync runtime can react
 * correctly:
 *
 * - `recovery-needed`: the device holds a master key that cannot decrypt this
 *   vault, or the master key is gone while a verifier still exists. The user
 *   must re-derive the correct master key (recovery phrase / re-link). Surface a
 *   recovery prompt.
 * - `transient`: a secret could not be read this run (safeStorage unavailable,
 *   or an undecryptable ciphertext). Do NOT prompt recovery — the read may
 *   succeed on the next healthy run. See secrets/secret-storage.ts getSecret.
 * - `other`: anything else; treat as a generic sync failure.
 *
 * Matches on the thrown Error messages from crypto/vault-key-state.ts and
 * secrets/secret-storage.ts. Kept as a pure string classifier so it can be unit
 * tested without the keychain, database, or native modules.
 */
export type VaultKeyErrorKind = 'recovery-needed' | 'transient' | 'other'

export function classifyVaultKeyError(error: unknown): VaultKeyErrorKind {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes('could not be read this run')) {
    return 'transient'
  }

  if (
    message.includes('does not match this vault') ||
    message.includes('verifier exists but master key is missing')
  ) {
    return 'recovery-needed'
  }

  return 'other'
}

export function vaultRecoveryReason(error: unknown): VaultRecoveryNeededEvent['reason'] {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('master key is missing') ? 'master-key-missing' : 'vault-key-mismatch'
}
