import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import type { VectorClock } from '@memry/contracts/sync-api'
import { decompressPayload } from '../compress.ts'
import { encodeCbor } from './cbor.ts'
import type { SyncCryptoProvider } from './crypto-provider.ts'

/**
 * Platform-free twin of desktop's `decryptItemFromPull`
 * (`apps/desktop/src/main/sync/decrypt.ts`) — same canonical signature
 * payload, same crypto-version gate, same unwrap → decrypt → decompress chain,
 * with the crypto calls going through the injected provider instead of
 * libsodium-wrappers-sumo. The signature payload construction must stay
 * byte-identical to desktop's or every verification fails.
 */

export class SignatureVerificationError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly signerDeviceId: string
  ) {
    super(`Signature verification failed for item ${itemId} from device ${signerDeviceId}`)
    this.name = 'SignatureVerificationError'
  }
}

export interface RecordDecryptInput {
  id: string
  type: string
  operation?: string
  cryptoVersion: number
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  signerDeviceId: string
  deletedAt?: number
  clock?: VectorClock
  stateVector?: string
}

export async function decryptRecordItem(
  crypto: SyncCryptoProvider,
  input: RecordDecryptInput,
  vaultKey: Uint8Array,
  signerPublicKey: Uint8Array
): Promise<Uint8Array> {
  const version = input.cryptoVersion

  if (version < 1) {
    throw new Error(`Invalid crypto version: ${version}. Version must be >= 1.`)
  }
  if (version !== 1) {
    throw new Error(`Crypto version ${version} is not supported. Please update the app.`)
  }

  const signaturePayload: Record<string, unknown> = {
    id: input.id,
    type: input.type,
    operation: input.operation ?? 'update',
    cryptoVersion: version,
    encryptedKey: input.encryptedKey,
    keyNonce: input.keyNonce,
    encryptedData: input.encryptedData,
    dataNonce: input.dataNonce
  }

  if (input.deletedAt !== undefined) {
    signaturePayload.deletedAt = input.deletedAt
  }

  // Nested object construction matches desktop's decrypt-item.ts exactly:
  // clock first, then stateVector, and the key is absent (not undefined) when
  // neither exists — CBOR encodes the nested object's own key order.
  if (input.clock || input.stateVector) {
    signaturePayload.metadata = {
      ...(input.clock ? { clock: input.clock } : {}),
      ...(input.stateVector ? { stateVector: input.stateVector } : {})
    }
  }

  const message = encodeCbor(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM)
  const signatureBytes = crypto.fromBase64(input.signature)
  const verified = await crypto.verifyDetached(signatureBytes, message, signerPublicKey)
  if (!verified) {
    throw new SignatureVerificationError(input.id, input.signerDeviceId)
  }

  const wrappedKey = crypto.fromBase64(input.encryptedKey)
  const keyNonce = crypto.fromBase64(input.keyNonce)
  const encryptedData = crypto.fromBase64(input.encryptedData)
  const dataNonce = crypto.fromBase64(input.dataNonce)

  const fileKey = await crypto.unwrapFileKey(wrappedKey, keyNonce, vaultKey)
  try {
    const plaintext = await crypto.decrypt(encryptedData, dataNonce, fileKey)
    return decompressPayload(plaintext)
  } finally {
    fileKey.fill(0)
  }
}

const CRDT_NONCE_LEN = 24
const CRDT_WRAPPED_KEY_LEN = 48
const CRDT_SIGNATURE_LEN = 64
const CRDT_HEADER_LEN = CRDT_NONCE_LEN + CRDT_NONCE_LEN + CRDT_WRAPPED_KEY_LEN + CRDT_SIGNATURE_LEN

/**
 * Platform-free twin of desktop's `decryptCrdtUpdate`
 * (`apps/desktop/src/main/sync/crdt-encrypt.ts`): packed layout
 * [dataNonce(24) | keyNonce(24) | wrappedKey(48) | signature(64) | ciphertext],
 * signed over noteId ‖ header-without-signature ‖ ciphertext, AEAD associated
 * data = the noteId bytes.
 */
export async function decryptCrdtUpdatePacked(
  crypto: SyncCryptoProvider,
  packed: Uint8Array,
  vaultKey: Uint8Array,
  noteId: string,
  signerPublicKey: Uint8Array
): Promise<Uint8Array> {
  if (packed.length < CRDT_HEADER_LEN + 1) {
    throw new Error(`CRDT update too short: ${packed.length} bytes`)
  }

  const sigOffset = CRDT_NONCE_LEN + CRDT_NONCE_LEN + CRDT_WRAPPED_KEY_LEN
  const signature = packed.subarray(sigOffset, sigOffset + CRDT_SIGNATURE_LEN)

  const noteIdBytes = new TextEncoder().encode(noteId)
  const beforeSig = packed.subarray(0, sigOffset)
  const afterSig = packed.subarray(sigOffset + CRDT_SIGNATURE_LEN)
  const signedPayload = new Uint8Array(noteIdBytes.length + beforeSig.length + afterSig.length)
  signedPayload.set(noteIdBytes, 0)
  signedPayload.set(beforeSig, noteIdBytes.length)
  signedPayload.set(afterSig, noteIdBytes.length + beforeSig.length)

  const valid = await crypto.verifyDetached(signature, signedPayload, signerPublicKey)
  if (!valid) {
    throw new SignatureVerificationError(noteId, 'crdt-signer')
  }

  const dataNonce = packed.subarray(0, CRDT_NONCE_LEN)
  const keyNonce = packed.subarray(CRDT_NONCE_LEN, CRDT_NONCE_LEN + CRDT_NONCE_LEN)
  const wrappedKey = packed.subarray(CRDT_NONCE_LEN + CRDT_NONCE_LEN, sigOffset)
  const ciphertext = packed.subarray(CRDT_HEADER_LEN)

  const fileKey = await crypto.unwrapFileKey(wrappedKey, keyNonce, vaultKey)
  try {
    const compressed = await crypto.decrypt(ciphertext, dataNonce, fileKey, noteId)
    return decompressPayload(compressed)
  } finally {
    fileKey.fill(0)
  }
}
