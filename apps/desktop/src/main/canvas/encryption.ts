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

function purposeAd(): Uint8Array {
  return new TextEncoder().encode(PURPOSE_AD)
}

/**
 * Encrypts a serialized Excalidraw scene under the vault key for at-rest
 * storage in canvases.snapshot_ciphertext. Mirrors the agent-chat at-rest
 * envelope (main/agent/storage/encryption.ts) with a canvas-specific purpose.
 */
export function encryptCanvasSceneForVault(scene: string, vaultKey: Uint8Array): string {
  const result = encrypt(new TextEncoder().encode(scene), vaultKey, purposeAd())
  const envelope: CanvasEnvelope = {
    version: CANVAS_AT_REST_VERSION,
    nonce: sodium.to_base64(result.nonce, BASE64),
    ciphertext: sodium.to_base64(result.ciphertext, BASE64)
  }
  return JSON.stringify(envelope)
}

export function decryptCanvasSceneForVault(
  snapshotCiphertext: string,
  vaultKey: Uint8Array
): string {
  const envelope = JSON.parse(snapshotCiphertext) as CanvasEnvelope
  if (envelope.version !== CANVAS_AT_REST_VERSION) {
    throw new Error(`Unsupported canvas envelope version: ${envelope.version}`)
  }

  const plaintext = decrypt(
    sodium.from_base64(envelope.ciphertext, BASE64),
    sodium.from_base64(envelope.nonce, BASE64),
    vaultKey,
    purposeAd()
  )
  return new TextDecoder().decode(plaintext)
}
