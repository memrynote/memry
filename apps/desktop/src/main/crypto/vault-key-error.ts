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
 *   an undecryptable ciphertext, or an OS keychain that timed out). Do NOT
 *   prompt recovery — the read may
 *   succeed on the next healthy run. See secrets/secret-storage.ts getSecret.
 * - `other`: anything else; treat as a generic sync failure.
 *
 * Matches on the thrown Error messages from crypto/vault-key-state.ts and
 * secrets/secret-storage.ts. Kept as a pure string classifier so it can be unit
 * tested without the keychain, database, or native modules.
 */
export type VaultKeyErrorKind = 'recovery-needed' | 'transient' | 'other'

export function classifyVaultKeyError(error: unknown): VaultKeyErrorKind {
  if (isKeychainUnreadableError(error)) {
    return 'transient'
  }

  const message = error instanceof Error ? error.message : String(error)

  if (
    message.includes('does not match this vault') ||
    message.includes('verifier exists but master key is missing') ||
    // The account holds the real key and the recovery phrase re-derives it —
    // the most recoverable state there is, and it used to classify as `other`,
    // so no prompt ever appeared.
    message.includes('cannot create a local vault key while sync credentials exist')
  ) {
    return 'recovery-needed'
  }

  return 'other'
}

/**
 * True when a secret could not be read from this machine's secret storage this
 * run: the stored copy exists but is unreadable, or the OS keychain timed out
 * or is still latched from an earlier timeout (secrets/secret-storage.ts). The
 * secret is not gone, so a later attempt can succeed; nothing may treat it as
 * absent. keychain.ts re-wraps these as plain Errors, so this matches messages.
 */
export function isKeychainUnreadableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('could not be read this run') ||
    message.includes('OS keychain did not answer within') ||
    message.includes('OS keychain is unavailable')
  )
}

export function vaultRecoveryReason(error: unknown): VaultRecoveryNeededEvent['reason'] {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('master key is missing') || message.includes('Master key not found')
    ? 'master-key-missing'
    : 'vault-key-mismatch'
}
