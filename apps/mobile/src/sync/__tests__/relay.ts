import sodium from 'libsodium-wrappers-sumo'
import type { SyncPushCryptoProvider } from '@memry/sync-client/push'

/**
 * A stand-in for the sync server that stores exactly what the real one stores:
 * opaque ciphertext, plus the metadata the feed exposes.
 *
 * The point is that NOTHING about the client code paths is faked — the same
 * encryptors, the same decryptors, the same Yjs merge. What is replaced is only
 * the transport and D1/R2, which the seam tests cannot reach from a unit run.
 * Set `MEMRY_SEAM_SERVER` to point the same scenarios at a real local
 * sync-server; the scenario bodies do not change, only the relay behind them.
 */

export interface RelayRecordRow {
  id: string
  type: string
  operation: string
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
  signature: string
  signerDeviceId: string
  clock?: Record<string, number>
  deletedAt?: number
  /** Monotonic, like the server's cursor. */
  cursor: number
}

export interface RelayCrdtRow {
  noteId: string
  seq: number
  packed: Uint8Array
  signerDeviceId: string
}

export class Relay {
  private records = new Map<string, RelayRecordRow>()
  private crdt: RelayCrdtRow[] = []
  private cursor = 0

  pushRecord(item: Omit<RelayRecordRow, 'cursor'>): void {
    // Last write wins on the record feed, which is what the real server does:
    // the merge that matters (field-level, clock-based) happens on the client
    // after decrypt, and the server never sees enough to arbitrate.
    this.records.set(item.id, { ...item, cursor: ++this.cursor })
  }

  pushCrdt(noteId: string, packed: Uint8Array, signerDeviceId: string): number {
    const seq = this.crdt.filter((row) => row.noteId === noteId).length + 1
    this.crdt.push({ noteId, seq, packed, signerDeviceId })
    return seq
  }

  changesSince(cursor: number): RelayRecordRow[] {
    return [...this.records.values()]
      .filter((row) => row.cursor > cursor)
      .sort((a, b) => a.cursor - b.cursor)
  }

  crdtSince(noteId: string, since: number): RelayCrdtRow[] {
    return this.crdt.filter((row) => row.noteId === noteId && row.seq > since)
  }

  latestCursor(): number {
    return this.cursor
  }
}

/** The sodium-backed provider both simulated devices share. */
export function nodeCryptoProvider(): SyncPushCryptoProvider {
  return {
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
  }
}
