import { mnemonicToSeed, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { deriveKey, deriveMasterKey, fromBase64 } from '../crypto/libsodium'
import { fetchKeyVerifier } from '../sync/auth-client'
import { closeEditorSession } from '@/editor/session'
import { getVaultKey, setVaultKey, clearVaultKey } from './secure-store'

/**
 * Vault unlock (T044). The product's key chain is phrase-based: there is NO
 * separate vault password (recorded during G0 — the 24-word BIP39 phrase is
 * the credential; seed = mnemonicToSeed(phrase) with empty passphrase, then
 * Argon2id(seed, kdfSalt), verifier check, then the vault key by KDF context).
 * The spec's "password path" resolves to this same derivation — the phrase IS
 * the password surface on a fresh device. An optional biometric gate now sits
 * in front of an already-unlocked vault (`lib/device-unlock.ts`); it is an app
 * lock and does not change how this key is stored or derived.
 *
 * Failure rule (spec): on a wrong phrase NOTHING is left half-unlocked — the
 * vault key reaches secure-store only after the verifier matches.
 */

export class WrongPhraseError extends Error {
  constructor() {
    super('Wrong recovery phrase')
    this.name = 'WrongPhraseError'
  }
}

export class InvalidPhraseError extends Error {
  constructor() {
    super('Not a valid 24-word recovery phrase')
    this.name = 'InvalidPhraseError'
  }
}

export async function unlockVaultWithPhrase(
  vaultId: string,
  accessToken: string,
  recoveryPhrase: string
): Promise<void> {
  const phrase = recoveryPhrase.trim().toLowerCase().split(/\s+/).join(' ')
  if (!validateMnemonic(phrase, wordlist)) {
    throw new InvalidPhraseError()
  }

  const info = await fetchKeyVerifier(accessToken)
  if (!info.kdfSalt) {
    throw new Error('Account has no vault key material — set the vault up from desktop first')
  }

  const seed = await mnemonicToSeed(phrase)
  // Argon2id 64 MiB / ops 3 on-device (R1-proven on the reference device).
  const material = await deriveMasterKey(seed, fromBase64(info.kdfSalt))
  try {
    if (info.keyVerifier && material.keyVerifier !== info.keyVerifier) {
      throw new WrongPhraseError()
    }
    const vaultKey = await deriveKey(material.masterKey, 'memry-vault-key-v1', 32)
    await setVaultKey(vaultId, vaultKey)
    vaultKey.fill(0)
  } finally {
    material.masterKey.fill(0)
  }
}

export async function isVaultUnlocked(vaultId: string): Promise<boolean> {
  const key = await getVaultKey(vaultId)
  if (!key) return false
  key.fill(0)
  return true
}

export async function lockVault(vaultId: string): Promise<void> {
  await clearVaultKey(vaultId)
  // The editor session holds the vault key and every open Y.Doc; leaving it
  // alive would keep usable key material in memory after a lock, and the next
  // unlock would reuse a session whose cached secrets are stale.
  closeEditorSession(vaultId)
}
