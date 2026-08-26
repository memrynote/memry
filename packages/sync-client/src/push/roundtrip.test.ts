import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { decryptCrdtUpdatePacked, decryptRecordItem } from '../pull/record-decrypt.ts'
import type { SyncPushCryptoProvider } from './crypto-provider.ts'
import { encryptCrdtUpdatePacked } from './crdt-encrypt.ts'
import {
  decryptAttachmentManifest,
  encryptAttachmentManifest,
  ManifestSignatureError,
  type AttachmentManifest
} from './attachment-manifest.ts'
import { encryptRecordForPush } from './record-encrypt.ts'

/**
 * The push encryptors are the inverse of the pull decryptors, and both are
 * byte-compatible twins of desktop's. Nothing else in the codebase asserts
 * that pairing, so this suite is what keeps a "harmless" refactor of either
 * half from producing items every other device silently rejects.
 */

const provider = (): SyncPushCryptoProvider => ({
  generateFileKey: () => sodium.randombytes_buf(32),
  encrypt: (plaintext, key, associatedData) => {
    const nonce = sodium.randombytes_buf(24)
    return {
      ciphertext: sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        associatedData ?? '',
        null,
        nonce,
        key
      ),
      nonce
    }
  },
  decrypt: (ciphertext, nonce, key, associatedData) =>
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      associatedData ?? '',
      nonce,
      key
    ),
  wrapFileKey: (fileKey, vaultKey) => {
    const nonce = sodium.randombytes_buf(24)
    return {
      wrappedKey: sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        fileKey,
        '',
        null,
        nonce,
        vaultKey
      ),
      nonce
    }
  },
  unwrapFileKey: (wrappedKey, nonce, vaultKey) =>
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, wrappedKey, '', nonce, vaultKey),
  signDetached: (message, secretKey) => sodium.crypto_sign_detached(message, secretKey),
  verifyDetached: (signature, message, publicKey) =>
    sodium.crypto_sign_verify_detached(signature, message, publicKey),
  fromBase64: (value) => sodium.from_base64(value, sodium.base64_variants.ORIGINAL),
  toBase64: (bytes) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
})

let crypto: SyncPushCryptoProvider
let vaultKey: Uint8Array
let signing: { publicKey: Uint8Array; privateKey: Uint8Array }

beforeAll(async () => {
  await sodium.ready
  crypto = provider()
  vaultKey = sodium.randombytes_buf(32)
  signing = sodium.crypto_sign_keypair()
})

describe('encryptRecordForPush', () => {
  it('round-trips through the pull decryptor', async () => {
    const content = new TextEncoder().encode(JSON.stringify({ title: 'Note', content: 'hello' }))
    const { pushItem } = await encryptRecordForPush(crypto, {
      id: 'note-1',
      type: 'note',
      operation: 'create',
      content,
      vaultKey,
      signingSecretKey: signing.privateKey,
      signerDeviceId: 'device-a'
    })

    const decrypted = await decryptRecordItem(
      crypto,
      { ...pushItem, cryptoVersion: 1 },
      vaultKey,
      signing.publicKey
    )
    expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(content))
  })

  it('carries clock and stateVector into the signed payload', async () => {
    const { pushItem } = await encryptRecordForPush(crypto, {
      id: 'task-1',
      type: 'task',
      operation: 'update',
      content: new TextEncoder().encode('{}'),
      vaultKey,
      signingSecretKey: signing.privateKey,
      signerDeviceId: 'device-a',
      clock: { 'device-a': 4 },
      stateVector: 'AQID'
    })

    expect(pushItem.clock).toEqual({ 'device-a': 4 })
    await expect(
      decryptRecordItem(crypto, { ...pushItem, cryptoVersion: 1 }, vaultKey, signing.publicKey)
    ).resolves.toBeInstanceOf(Uint8Array)
  })

  it('rejects verification when the clock is stripped after signing', async () => {
    const { pushItem } = await encryptRecordForPush(crypto, {
      id: 'task-2',
      type: 'task',
      operation: 'update',
      content: new TextEncoder().encode('{}'),
      vaultKey,
      signingSecretKey: signing.privateKey,
      signerDeviceId: 'device-a',
      clock: { 'device-a': 1 }
    })

    const tampered = { ...pushItem, cryptoVersion: 1, clock: undefined }
    await expect(decryptRecordItem(crypto, tampered, vaultKey, signing.publicKey)).rejects.toThrow(
      /Signature verification failed/
    )
  })

  it('signs a delete with its deletedAt', async () => {
    const deletedAt = 1_700_000_000_000
    const { pushItem } = await encryptRecordForPush(crypto, {
      id: 'note-2',
      type: 'note',
      operation: 'delete',
      content: new TextEncoder().encode('{}'),
      vaultKey,
      signingSecretKey: signing.privateKey,
      signerDeviceId: 'device-a',
      deletedAt
    })

    expect(pushItem.deletedAt).toBe(deletedAt)
    await expect(
      decryptRecordItem(crypto, { ...pushItem, cryptoVersion: 1 }, vaultKey, signing.publicKey)
    ).resolves.toBeInstanceOf(Uint8Array)
  })
})

describe('encryptCrdtUpdatePacked', () => {
  it('round-trips through the pull decryptor', async () => {
    // Long enough that compressPayload actually deflates, which is the branch
    // a short fixture would never reach.
    const update = new Uint8Array(512).map((_, i) => i % 7)
    const packed = encryptCrdtUpdatePacked(crypto, update, vaultKey, 'note-1', signing.privateKey)

    const decrypted = await decryptCrdtUpdatePacked(
      crypto,
      packed,
      vaultKey,
      'note-1',
      signing.publicKey
    )
    expect(Array.from(decrypted)).toEqual(Array.from(update))
  })

  it('binds the ciphertext to its noteId', async () => {
    const packed = encryptCrdtUpdatePacked(
      crypto,
      new Uint8Array([1, 2, 3]),
      vaultKey,
      'note-a',
      signing.privateKey
    )

    // A different noteId changes the signed payload before it ever reaches the
    // AEAD, so this fails as a signature error — the note id is authenticated,
    // not merely associated.
    await expect(
      decryptCrdtUpdatePacked(crypto, packed, vaultKey, 'note-b', signing.publicKey)
    ).rejects.toThrow(/Signature verification failed/)
  })

  it('rejects a flipped ciphertext byte', async () => {
    const packed = encryptCrdtUpdatePacked(
      crypto,
      new Uint8Array(200).fill(9),
      vaultKey,
      'note-1',
      signing.privateKey
    )
    packed[packed.length - 1] ^= 0xff

    await expect(
      decryptCrdtUpdatePacked(crypto, packed, vaultKey, 'note-1', signing.publicKey)
    ).rejects.toThrow()
  })
})

describe('attachment manifest', () => {
  const manifest = (): AttachmentManifest => ({
    id: 'att-1',
    filename: 'diagram.png',
    mimeType: 'image/png',
    size: 2048,
    checksum: 'a'.repeat(64),
    chunks: [{ index: 0, hash: 'b'.repeat(64), encryptedHash: 'c'.repeat(64), size: 2048 }],
    chunkSize: 8 * 1024 * 1024,
    createdAt: 1_700_000_000_000
  })

  it('round-trips and hands back the file key', async () => {
    const fileKey = crypto.generateFileKey()
    const encrypted = encryptAttachmentManifest(crypto, manifest(), fileKey, vaultKey, {
      secretKey: signing.privateKey,
      deviceId: 'device-a'
    })

    const result = await decryptAttachmentManifest(crypto, encrypted, vaultKey, signing.publicKey)
    expect(result.manifest).toEqual(manifest())
    expect(Array.from(result.fileKey)).toEqual(Array.from(fileKey))
  })

  it('refuses a manifest whose ciphertext was swapped after signing', async () => {
    const first = encryptAttachmentManifest(
      crypto,
      manifest(),
      crypto.generateFileKey(),
      vaultKey,
      {
        secretKey: signing.privateKey,
        deviceId: 'device-a'
      }
    )
    const second = encryptAttachmentManifest(
      crypto,
      { ...manifest(), filename: 'evil.png' },
      crypto.generateFileKey(),
      vaultKey,
      { secretKey: signing.privateKey, deviceId: 'device-a' }
    )

    // The server holds the manifest blob; substituting one signed body's
    // ciphertext under another's signature is exactly the swap the signature
    // exists to catch.
    await expect(
      decryptAttachmentManifest(
        crypto,
        { ...first, encryptedManifest: second.encryptedManifest },
        vaultKey,
        signing.publicKey
      )
    ).rejects.toBeInstanceOf(ManifestSignatureError)
  })
})
