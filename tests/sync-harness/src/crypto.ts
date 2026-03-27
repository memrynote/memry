import sodium from 'libsodium-wrappers-sumo'
import { encode } from 'cborg'
import pako from 'pako'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { XCHACHA20_PARAMS } from '@memry/contracts/crypto'
import type { PushItem, SyncItemType, SyncOperation, VectorClock } from '@memry/contracts/sync-api'

export async function initCrypto(): Promise<void> {
  await sodium.ready
}

const toB64 = (bytes: Uint8Array): string =>
  sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)

const fromB64 = (str: string): Uint8Array =>
  sodium.from_base64(str, sodium.base64_variants.ORIGINAL)

function encodeCbor(data: Record<string, unknown>, fieldOrder: readonly string[]): Uint8Array {
  const ordered: [string, unknown][] = []
  for (const field of fieldOrder) {
    if (field in data && data[field] !== undefined) {
      ordered.push([field, data[field]])
    }
  }
  return encode(new Map(ordered))
}

const FLAG_RAW = 0x00
const FLAG_DEFLATE = 0x01

function compressPayload(data: Uint8Array): Uint8Array {
  if (data.byteLength < 64) return prependFlag(FLAG_RAW, data)
  const compressed = pako.deflate(data)
  return compressed.byteLength >= data.byteLength
    ? prependFlag(FLAG_RAW, data)
    : prependFlag(FLAG_DEFLATE, compressed)
}

function decompressPayload(data: Uint8Array): Uint8Array {
  if (data.byteLength === 0) return data
  const flag = data[0]
  if (flag === FLAG_DEFLATE) return pako.inflate(data.subarray(1))
  if (flag === FLAG_RAW) return data.subarray(1)
  throw new Error(`Unknown compression flag: 0x${flag.toString(16)}`)
}

function prependFlag(flag: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(1 + payload.byteLength)
  result[0] = flag
  result.set(payload, 1)
  return result
}

export function generateSigningKeypair(): {
  publicKey: Uint8Array
  secretKey: Uint8Array
} {
  const kp = sodium.crypto_sign_keypair()
  return { publicKey: kp.publicKey, secretKey: kp.privateKey }
}

export function generateVaultKey(): Uint8Array {
  return sodium.randombytes_buf(XCHACHA20_PARAMS.KEY_LENGTH)
}

export interface EncryptForPushInput {
  id: string
  type: SyncItemType
  operation: SyncOperation
  content: Uint8Array
  vaultKey: Uint8Array
  signingSecretKey: Uint8Array
  signerDeviceId: string
  clock?: VectorClock
  stateVector?: string
  deletedAt?: number
}

export function encryptItemForPush(input: EncryptForPushInput): {
  pushItem: PushItem
  sizeBytes: number
} {
  const fileKey = sodium.randombytes_buf(XCHACHA20_PARAMS.KEY_LENGTH)

  try {
    const compressed = compressPayload(input.content)

    const dataNonce = sodium.randombytes_buf(XCHACHA20_PARAMS.NONCE_LENGTH)
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      compressed,
      null,
      null,
      dataNonce,
      fileKey
    )

    const keyNonce = sodium.randombytes_buf(XCHACHA20_PARAMS.NONCE_LENGTH)
    const wrappedKey = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      fileKey,
      null,
      null,
      keyNonce,
      input.vaultKey
    )

    const encryptedKeyB64 = toB64(wrappedKey)
    const keyNonceB64 = toB64(keyNonce)
    const encryptedDataB64 = toB64(ciphertext)
    const dataNonceB64 = toB64(dataNonce)

    const signaturePayload: Record<string, unknown> = {
      id: input.id,
      type: input.type,
      operation: input.operation,
      cryptoVersion: 1,
      encryptedKey: encryptedKeyB64,
      keyNonce: keyNonceB64,
      encryptedData: encryptedDataB64,
      dataNonce: dataNonceB64
    }

    if (input.deletedAt !== undefined) {
      signaturePayload.deletedAt = input.deletedAt
    }

    if (input.clock || input.stateVector) {
      const metadata: Record<string, unknown> = {}
      if (input.clock) metadata.clock = input.clock
      if (input.stateVector) metadata.stateVector = input.stateVector
      signaturePayload.metadata = metadata
    }

    const message = encodeCbor(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM)
    const signature = sodium.crypto_sign_detached(message, input.signingSecretKey)

    return {
      pushItem: {
        id: input.id,
        type: input.type,
        operation: input.operation,
        encryptedKey: encryptedKeyB64,
        keyNonce: keyNonceB64,
        encryptedData: encryptedDataB64,
        dataNonce: dataNonceB64,
        signature: toB64(signature),
        signerDeviceId: input.signerDeviceId,
        ...(input.clock && { clock: input.clock }),
        ...(input.stateVector && { stateVector: input.stateVector }),
        ...(input.deletedAt !== undefined && { deletedAt: input.deletedAt })
      },
      sizeBytes: ciphertext.length
    }
  } finally {
    sodium.memzero(fileKey)
  }
}

export interface DecryptFromPullInput {
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
  metadata?: { clock?: VectorClock; stateVector?: string }
  vaultKey: Uint8Array
  signerPublicKey: Uint8Array
}

export function decryptItemFromPull(input: DecryptFromPullInput): {
  content: Uint8Array
  verified: true
} {
  if (input.cryptoVersion !== 1) {
    throw new Error(
      `Unsupported crypto version: ${input.cryptoVersion}. Only version 1 is supported.`
    )
  }
  const signaturePayload: Record<string, unknown> = {
    id: input.id,
    type: input.type,
    operation: input.operation ?? 'update',
    cryptoVersion: input.cryptoVersion,
    encryptedKey: input.encryptedKey,
    keyNonce: input.keyNonce,
    encryptedData: input.encryptedData,
    dataNonce: input.dataNonce
  }
  if (input.deletedAt !== undefined) signaturePayload.deletedAt = input.deletedAt
  if (input.metadata) signaturePayload.metadata = input.metadata

  const signatureBytes = fromB64(input.signature)
  const message = encodeCbor(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM)
  const verified = sodium.crypto_sign_verify_detached(
    signatureBytes,
    message,
    input.signerPublicKey
  )

  if (!verified) {
    throw new Error(
      `Signature verification failed for item ${input.id} from device ${input.signerDeviceId}`
    )
  }

  const wrappedKey = fromB64(input.encryptedKey)
  const keyNonce = fromB64(input.keyNonce)
  const encryptedData = fromB64(input.encryptedData)
  const dataNonce = fromB64(input.dataNonce)

  const fileKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    wrappedKey,
    null,
    keyNonce,
    input.vaultKey
  )

  try {
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      encryptedData,
      null,
      dataNonce,
      fileKey
    )
    const content = decompressPayload(plaintext)
    return { content, verified: true }
  } finally {
    sodium.memzero(fileKey)
  }
}
