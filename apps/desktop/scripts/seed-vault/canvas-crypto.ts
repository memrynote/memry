/**
 * Node-safe vault-key derivation + canvas scene encryption for the seed script.
 *
 * Mirrors the app's crypto exactly (protocol constants are frozen at v1):
 *   - master key lookup: src/main/crypto/keychain.ts (keytar account
 *     `master-key-<device>`; plain `pnpm dev` collapses to device `dev`, see
 *     keychain-account.ts)
 *   - vault key KDF: src/main/crypto/keys.ts KDF_CONTEXT_MAP
 *     ('memry-vault-key-v1' → subkey id 1, ctx 'memryvlt')
 *   - verifier: src/main/crypto/vault-key-state.ts computeVaultKeyVerifier
 *   - scene envelope: src/main/canvas/encryption.ts
 *
 * The app modules themselves import electron/safeStorage, so the seed keeps a
 * small keytar+libsodium mirror instead of importing them under plain Node.
 */

import keytar from 'keytar'
import sodium from 'libsodium-wrappers-sumo'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'

export const VAULT_KEY_VERIFIER_SETTING = 'vault.crypto.verifier.v1'

const VERIFIER_CONTEXT = 'memry/vault-key-verifier/v1'
const CANVAS_PURPOSE_AD = 'memry/1/canvas_snapshot'

/**
 * Derives the vault key the app will use for the given dev device suffix,
 * creating (and storing) a master key when the keychain has none — the same
 * first-run behaviour as getOrInitializeLocalVaultKey.
 */
export async function resolveVaultKey(device: string): Promise<Uint8Array> {
  await sodium.ready

  const { service, account } = KEYCHAIN_ENTRIES.MASTER_KEY
  const deviceAccount = `${account}-${device}`
  const stored = await keytar.getPassword(service, deviceAccount)

  let masterKey: Uint8Array
  if (stored) {
    masterKey = sodium.from_base64(stored, sodium.base64_variants.ORIGINAL)
  } else {
    masterKey = sodium.randombytes_buf(32)
    await keytar.setPassword(
      service,
      deviceAccount,
      sodium.to_base64(masterKey, sodium.base64_variants.ORIGINAL)
    )
  }

  try {
    return sodium.crypto_kdf_derive_from_key(32, 1, 'memryvlt', masterKey)
  } finally {
    sodium.memzero(masterKey)
  }
}

export function computeVaultKeyVerifier(vaultKey: Uint8Array, vaultId: string): string {
  const input = new TextEncoder().encode(`${VERIFIER_CONTEXT}/${vaultId}`)
  const verifier = sodium.crypto_generichash(32, input, vaultKey)
  try {
    return sodium.to_base64(verifier, sodium.base64_variants.ORIGINAL)
  } finally {
    sodium.memzero(verifier)
  }
}

/** XChaCha20-Poly1305 envelope matching encryptCanvasSceneForVault. */
export function encryptCanvasScene(sceneJson: string, vaultKey: Uint8Array): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(sceneJson),
    new TextEncoder().encode(CANVAS_PURPOSE_AD),
    null,
    nonce,
    vaultKey
  )
  return JSON.stringify({
    version: 1,
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL)
  })
}
