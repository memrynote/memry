import sodium from 'libsodium-wrappers-sumo'

import { createLogger } from '../../lib/logger'
import { decryptCrdtUpdate } from '../crdt-encrypt'
import type { BodyWatermark, DocumentPlan } from './body-plan'

const log = createLogger('PackBodyApply')

/**
 * A Y.Doc holding nothing encodes its state vector as a single varint 0. Two
 * bytes is the same "still empty" threshold `applyCrdtBatch` uses before it
 * falls back to a markdown seed.
 */
const EMPTY_STATE_VECTOR_BYTES = 2

export interface BodySeedStore {
  getSnapshotWatermark(noteId: string): Promise<BodyWatermark | null>
  putSnapshotWatermark(noteId: string, watermark: BodyWatermark): Promise<void>
  /**
   * Bring the note's Y.Doc into the provider's live map, WITHOUT the markdown
   * seed. Mandatory before `applyRemoteUpdate`: the provider routes updates
   * through that map and silently drops (`log.warn` + `return`) anything for a
   * doc it does not hold. Throwing here means the note stays item-granular.
   */
  openDoc(noteId: string): Promise<void>
  /** False when the provider dropped the update (no open doc, a closing doc). */
  applyRemoteUpdate(noteId: string, update: Uint8Array, editedAtMs?: number): boolean
  /** Live state vector, or null when the provider is not holding this doc. */
  getStateVector(noteId: string): Uint8Array | null
  /** The doc holds structs or deletes whose dependencies it never received. */
  holdsPendingStructs(noteId: string): boolean
  /** Release the doc again unless an editor window is holding it. */
  closeDoc(noteId: string): Promise<void>
}

/** Every signing key this account registered, by device id. */
export type SignerKeys = ReadonlyMap<string, Uint8Array>

export interface PackBodyApplierDeps {
  store: BodySeedStore | null
  getVaultKey: () => Promise<Uint8Array | null>
  getSignerPublicKeys: () => Promise<SignerKeys>
  decrypt?: typeof decryptCrdtUpdate
}

export interface PackBodyApplier {
  localWatermark(noteId: string): Promise<BodyWatermark | null>
  /**
   * Open the doc once, apply the plan's snapshot and then its updates in
   * order, record the watermark reached and close. Returns that watermark, or
   * null when nothing applied: the document then stays on the item routes.
   * An update that fails to read or verify ends the walk there, so the
   * watermark never claims a sequence the doc does not hold.
   */
  applyDocument(noteId: string, plan: DocumentPlan): Promise<BodyWatermark | null>
}

/**
 * Seeds Y.Docs from `crdt_snapshot` and `crdt_update` pack entries (#1840,
 * #5390).
 *
 * SIGNER IDENTITY. A snapshot entry's index carries no signer device id, so
 * the blob is verified against EVERY signing key this account has registered,
 * and the first key whose Ed25519 signature verifies is the signer. Both paths
 * prove "signed by a key this account registered". An update entry names its
 * `signerDeviceId` (protocol 08 §8.4.3) and is verified against that device's
 * key only, as an update the route returned (chapter 07 §7.14).
 */
export const createPackBodyApplier = (deps: PackBodyApplierDeps): PackBodyApplier => {
  const decrypt = deps.decrypt ?? decryptCrdtUpdate
  let signerKeys: SignerKeys | null = null
  // Most snapshots come from the few devices that last compacted, and an
  // account keeps a key per device it ever linked: trying every key per
  // snapshot cost 126 s of a 270 s pack phase on 17k notes (#5390). The key
  // that verified last is tried first; which key verifies does not depend on
  // the order.
  let lastSigner: Uint8Array | null = null

  const keys = async (): Promise<SignerKeys> => {
    if (!signerKeys) signerKeys = await deps.getSignerPublicKeys()
    return signerKeys
  }

  const openSnapshot = (
    bytes: Uint8Array,
    vaultKey: Uint8Array,
    noteId: string,
    candidates: SignerKeys
  ): Uint8Array | null => {
    const ordered = lastSigner ? [lastSigner, ...candidates.values()] : candidates.values()
    for (const publicKey of ordered) {
      try {
        const plain = decrypt(bytes, vaultKey, noteId, publicKey)
        lastSigner = publicKey
        return plain
      } catch {
        // Not this key (or not decryptable under it); try the next.
      }
    }
    return null
  }

  return {
    localWatermark: async (noteId) => (await deps.store?.getSnapshotWatermark(noteId)) ?? null,

    applyDocument: async (noteId, plan) => {
      const store = deps.store
      if (!store) return null
      const vaultKey = await deps.getVaultKey()
      if (!vaultKey) return null
      const candidates = await keys()
      if (candidates.size === 0) return null

      let snapshotPlain: Uint8Array | null = null
      if (plan.snapshot) {
        snapshotPlain = openSnapshot(await plan.snapshot.read(), vaultKey, noteId, candidates)
        if (!snapshotPlain) {
          log.debug('Packed snapshot verified under no registered device key — item GET instead', {
            noteId
          })
          return null
        }
      }

      try {
        await store.openDoc(noteId)
      } catch (error) {
        log.debug('Could not open the doc for packed bodies — item routes instead', {
          noteId,
          error: error instanceof Error ? error.message : String(error)
        })
        return null
      }

      try {
        let reached: BodyWatermark | null = null
        if (snapshotPlain && plan.snapshot) {
          if (!store.applyRemoteUpdate(noteId, snapshotPlain)) return null
          reached = {
            appliedSequence: plan.snapshot.meta.sequenceNum,
            snapshotRevision: plan.snapshot.meta.revision
          }
        }
        for (const update of plan.updates) {
          const publicKey = candidates.get(update.signerDeviceId)
          let plain: Uint8Array
          try {
            if (!publicKey) throw new Error('unknown signer')
            plain = decrypt(await update.read(), vaultKey, noteId, publicKey)
          } catch (error) {
            log.debug('Packed update unusable — the rest of the document stays on the routes', {
              noteId,
              sequenceNum: update.sequenceNum,
              error: error instanceof Error ? error.message : String(error)
            })
            break
          }
          if (
            !store.applyRemoteUpdate(
              noteId,
              plain,
              update.createdAt > 0 ? update.createdAt * 1000 : undefined
            )
          )
            break
          reached = {
            appliedSequence: update.sequenceNum,
            ...(plan.watermark.snapshotRevision
              ? { snapshotRevision: plan.watermark.snapshotRevision }
              : {})
          }
        }
        if (!reached) return null
        // A gap the pack hid: the doc is missing a dependency, so no watermark
        // may vouch for it. The state stays and the item routes fill it in.
        if (store.holdsPendingStructs(noteId)) return null
        const vector = store.getStateVector(noteId)
        if (!vector || vector.length <= EMPTY_STATE_VECTOR_BYTES) {
          log.warn('Packed bodies did not reach the doc — leaving it item-granular', { noteId })
          return null
        }
        await store.putSnapshotWatermark(noteId, reached)
        return reached
      } finally {
        await store.closeDoc(noteId).catch(() => {
          /* the doc is flushed either way; a stuck close is not a failed seed */
        })
      }
    }
  }
}

/** Decode the account's cached device signing keys into raw Ed25519 keys, by device id. */
export const decodeSignerPublicKeys = (
  rows: ReadonlyArray<{ deviceId: string; key: string }>
): Map<string, Uint8Array> => {
  const out = new Map<string, Uint8Array>()
  for (const { deviceId, key } of rows) {
    try {
      /* oxlint-disable import/no-named-as-default-member -- sibling tests vi.mock this module with only a `default` export */
      const raw = sodium.from_base64(key, sodium.base64_variants.ORIGINAL)
      /* oxlint-enable import/no-named-as-default-member */
      out.set(deviceId, raw)
    } catch {
      // A malformed cached key verifies nothing; skip it.
    }
  }
  return out
}
