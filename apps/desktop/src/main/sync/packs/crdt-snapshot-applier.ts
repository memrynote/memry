import sodium from 'libsodium-wrappers-sumo'

import { createLogger } from '../../lib/logger'
import { decryptCrdtUpdate } from '../crdt-encrypt'
import type { PackSnapshotApplier, PackSnapshotMeta } from './pack-bootstrap'

const log = createLogger('PackSnapshotApply')

/**
 * A Y.Doc holding nothing encodes its state vector as a single varint 0. Two
 * bytes is the same "still empty" threshold `applyCrdtBatch` uses before it
 * falls back to a markdown seed.
 */
const EMPTY_STATE_VECTOR_BYTES = 2

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
  /**
   * Bring the note's Y.Doc into the provider's live map, WITHOUT the markdown
   * seed. Mandatory before `applyRemoteUpdate`: the provider routes updates
   * through that map and silently drops (`log.warn` + `return`) anything for a
   * doc it does not hold. Throwing here means the note stays item-granular.
   */
  openDoc(noteId: string): Promise<void>
  applyRemoteUpdate(noteId: string, update: Uint8Array): void
  /** Live state vector, or null when the provider is not holding this doc. */
  getStateVector(noteId: string): Uint8Array | null
  /** Release the doc again unless an editor window is holding it. */
  closeDoc(noteId: string): Promise<void>
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

      // Pack bootstrap runs before the first pull, so nothing has opened any of
      // these docs — no editor window, no note row, no CRDT sweep yet. Seeding
      // an unopened doc is a silent no-op in the provider, so the open is what
      // makes the whole feature real.
      try {
        await store.openDoc(noteId)
      } catch (error) {
        log.debug('Could not open the doc for a packed snapshot — item GET instead', {
          noteId,
          error: error instanceof Error ? error.message : String(error)
        })
        return false
      }

      try {
        store.applyRemoteUpdate(noteId, plaintext)
        // Proof the bytes actually landed, not an assumption that they did.
        // `applyRemoteUpdate` returns void and drops the update for a doc the
        // provider is not holding (or one mid-close), and a watermark for a
        // baseline that was never applied is a PERMANENT skip of the
        // `GET /sync/crdt/snapshot/:noteId` that would have fixed it — the
        // sweep reads that watermark as "this doc already holds its baseline".
        // Same emptiness test the coordinator uses after a baseline apply.
        const vector = store.getStateVector(noteId)
        if (!vector || vector.length <= EMPTY_STATE_VECTOR_BYTES) {
          log.warn('Packed snapshot did not reach the doc — leaving it item-granular', { noteId })
          return false
        }
        await store.putSnapshotWatermark(noteId, {
          appliedSequence: meta.sequenceNum,
          snapshotRevision: meta.revision
        })
        return true
      } finally {
        // Hundreds of packed notes must not pin hundreds of Y.Docs in the main
        // process; the provider's own LRU only sheds what it is told to.
        await store.closeDoc(noteId).catch(() => {
          /* the doc is flushed either way; a stuck close is not a failed seed */
        })
      }
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
