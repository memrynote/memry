import sodium from 'libsodium-wrappers-sumo'

import { createLogger } from '../../lib/logger'
import { decryptCrdtUpdate } from '../crdt-encrypt'
import type { PackSnapshotApplier, PackSnapshotMeta } from './pack-bootstrap'

const log = createLogger('PackSnapshotApply')

/**
 * Seeds Y.Docs from `crdt_snapshot` pack entries (#1840).
 *
 * SIGNER IDENTITY. The pack index carries a snapshot's freshness token
 * (`sequenceNum`, `revision`) but not its signer device id — that column never
 * made it into the index block. So the blob is verified against EVERY signing
 * key this account has registered, and the first key whose Ed25519 signature
 * verifies is the signer. This is not weaker than the item path: there the
 * server names the signer and the client verifies that one claim, so both
 * paths prove exactly "signed by a key this account registered", and forging
 * either still requires a device secret key the server never sees. A blob that
 * verifies under no known key is refused, and that note falls back to
 * `GET /sync/crdt/snapshot/:noteId`, which does carry the signer id and can
 * refresh the device-key cache.
 */

export interface SnapshotSeedStore {
  getSnapshotWatermark(
    noteId: string
  ): Promise<{ appliedSequence: number; snapshotRevision?: string } | null>
  putSnapshotWatermark(
    noteId: string,
    watermark: { appliedSequence: number; snapshotRevision?: string }
  ): Promise<void>
  applyRemoteUpdate(noteId: string, update: Uint8Array): void
}

export interface CrdtSnapshotApplierDeps {
  store: SnapshotSeedStore | null
  getVaultKey: () => Promise<Uint8Array | null>
  /** Every signing key registered to this account, newest cache first. */
  getSignerPublicKeys: () => Promise<Uint8Array[]>
  decrypt?: typeof decryptCrdtUpdate
}

export const createCrdtSnapshotApplier = (deps: CrdtSnapshotApplierDeps): PackSnapshotApplier => {
  const decrypt = deps.decrypt ?? decryptCrdtUpdate
  let signerKeys: Uint8Array[] | null = null

  const keys = async (): Promise<Uint8Array[]> => {
    if (!signerKeys) signerKeys = await deps.getSignerPublicKeys()
    return signerKeys
  }

  return {
    shouldApply: async (noteId, meta) => {
      const store = deps.store
      if (!store) return false
      const watermark = await store.getSnapshotWatermark(noteId)
      // No record at all — never merged, store rebuilt, fresh device. Unknown
      // means "we hold nothing", which is exactly what a pack is for.
      if (!watermark) return true
      // The doc already absorbed everything at or below this snapshot's prune
      // watermark, so the packed bytes are stale relative to local state.
      if (watermark.appliedSequence >= meta.sequenceNum) return false
      // Same blob, already merged.
      if (watermark.snapshotRevision === meta.revision) return false
      return true
    },

    apply: async (noteId, bytes, meta: PackSnapshotMeta) => {
      const store = deps.store
      if (!store) return false
      const vaultKey = await deps.getVaultKey()
      if (!vaultKey) return false

      const candidates = await keys()
      if (candidates.length === 0) return false

      let plaintext: Uint8Array | null = null
      for (const publicKey of candidates) {
        try {
          plaintext = decrypt(bytes, vaultKey, noteId, publicKey)
          break
        } catch {
          // Wrong signer for this blob, or genuinely bad bytes. Try the next
          // key; exhausting them means item-granular for this note.
        }
      }
      if (!plaintext) {
        log.debug('Packed snapshot verified under no registered device key — item GET instead', {
          noteId
        })
        return false
      }

      store.applyRemoteUpdate(noteId, plaintext)
      // Written only after the bytes reached the doc: a watermark for a
      // baseline that was never applied is a permanent skip of the download
      // that would have fixed it.
      await store.putSnapshotWatermark(noteId, {
        appliedSequence: meta.sequenceNum,
        snapshotRevision: meta.revision
      })
      return true
    }
  }
}

/** Decode the account's cached device signing keys into raw Ed25519 keys. */
export const decodeSignerPublicKeys = (encoded: string[]): Uint8Array[] => {
  const out: Uint8Array[] = []
  for (const value of encoded) {
    try {
      out.push(sodium.from_base64(value, sodium.base64_variants.ORIGINAL))
    } catch {
      // A malformed cached key is one fewer candidate, never a failure.
    }
  }
  return out
}
