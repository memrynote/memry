import sodium from 'libsodium-wrappers-sumo'

import { decrypt, encrypt } from '../crypto/encryption'

export const CANVAS_AT_REST_VERSION = 1 as const

export interface CanvasEnvelope {
  version: typeof CANVAS_AT_REST_VERSION
  nonce: string
  ciphertext: string
}

const BASE64 = sodium.base64_variants.ORIGINAL
const PURPOSE_AD = `memry/${CANVAS_AT_REST_VERSION}/canvas_snapshot`
/**
 * Distinct AD from the scene purpose so a library-item ciphertext can never be
 * swapped into a canvases row (or vice versa) and still authenticate.
 */
const LIBRARY_ITEM_PURPOSE_AD = `memry/${CANVAS_AT_REST_VERSION}/canvas_library_item`

function purposeAd(): Uint8Array {
  return new TextEncoder().encode(PURPOSE_AD)
}

function libraryItemPurposeAd(): Uint8Array {
  return new TextEncoder().encode(LIBRARY_ITEM_PURPOSE_AD)
}

function seal(plaintext: string, vaultKey: Uint8Array, ad: Uint8Array): string {
  const result = encrypt(new TextEncoder().encode(plaintext), vaultKey, ad)
  const envelope: CanvasEnvelope = {
    version: CANVAS_AT_REST_VERSION,
    nonce: sodium.to_base64(result.nonce, BASE64),
    ciphertext: sodium.to_base64(result.ciphertext, BASE64)
  }
  return JSON.stringify(envelope)
}

function open(serializedEnvelope: string, vaultKey: Uint8Array, ad: Uint8Array): string {
  const envelope = JSON.parse(serializedEnvelope) as CanvasEnvelope
  if (envelope.version !== CANVAS_AT_REST_VERSION) {
    throw new Error(`Unsupported canvas envelope version: ${envelope.version}`)
  }

  const plaintext = decrypt(
    sodium.from_base64(envelope.ciphertext, BASE64),
    sodium.from_base64(envelope.nonce, BASE64),
    vaultKey,
    ad
  )
  return new TextDecoder().decode(plaintext)
}

/**
 * Encrypts one serialized Excalidraw LibraryItem for storage in
 * canvas_library_items.item_ciphertext.
 */
export function encryptCanvasLibraryItemForVault(item: string, vaultKey: Uint8Array): string {
  return seal(item, vaultKey, libraryItemPurposeAd())
}

export function decryptCanvasLibraryItemForVault(
  itemCiphertext: string,
  vaultKey: Uint8Array
): string {
  return open(itemCiphertext, vaultKey, libraryItemPurposeAd())
}

/**
 * Encrypts a serialized Excalidraw scene under the vault key for at-rest
 * storage in canvases.snapshot_ciphertext. Mirrors the agent-chat at-rest
 * envelope (main/agent/storage/encryption.ts) with a canvas-specific purpose.
 */
export function encryptCanvasSceneForVault(scene: string, vaultKey: Uint8Array): string {
  return seal(scene, vaultKey, purposeAd())
}

export function decryptCanvasSceneForVault(
  snapshotCiphertext: string,
  vaultKey: Uint8Array
): string {
  return open(snapshotCiphertext, vaultKey, purposeAd())
}
