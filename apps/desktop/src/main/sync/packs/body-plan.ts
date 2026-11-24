import type { CrdtManifestDocument } from '@memry/contracts/sync-api'
import type { PackIndexEntry } from '@memry/contracts/pack-format'

import type { BodyManifest } from './body-manifest'

/** Freshness token a packed snapshot carries (protocol 08 §8.4). */
export interface PackSnapshotMeta {
  sequenceNum: number
  revision: string
}

export interface BodyWatermark {
  appliedSequence: number
  snapshotRevision?: string
}

export interface PackedSnapshot {
  entry: PackIndexEntry
  meta: PackSnapshotMeta
  read: () => Promise<Uint8Array>
}

export interface PackedUpdate {
  entry: PackIndexEntry
  sequenceNum: number
  signerDeviceId: string
  /** Server time, epoch seconds: the edit time the write-back stamps. */
  createdAt: number
  read: () => Promise<Uint8Array>
}

/** What one document takes from the packs: applied in order, then `watermark` recorded. */
export interface DocumentPlan {
  snapshot: PackedSnapshot | null
  updates: PackedUpdate[]
  /** The watermark once the snapshot and every update applied. */
  watermark: BodyWatermark
}

const sameDigest = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/**
 * The packed updates of one document that apply above `cursor`: ascending
 * `sequenceNum`, each one above `floor` and exactly the cursor plus one,
 * stopping at the first gap (protocol 08 §8.4.3). Two entries for one
 * `(document, sequenceNum)` with different digests make every packed update of
 * the document unusable.
 */
export const contiguousUpdates = (
  updates: readonly PackedUpdate[],
  cursor: number,
  floor: number
): PackedUpdate[] => {
  const bySequence = new Map<number, PackedUpdate>()
  for (const update of updates) {
    const held = bySequence.get(update.sequenceNum)
    if (held && !sameDigest(held.entry.sha256, update.entry.sha256)) return []
    bySequence.set(update.sequenceNum, update)
  }
  const out: PackedUpdate[] = []
  let next = cursor + 1
  for (let update = bySequence.get(next); update; update = bySequence.get(next)) {
    if (update.sequenceNum <= floor) break
    out.push(update)
    next++
  }
  return out
}

/**
 * Decides what a document takes from the packs.
 *
 * With no body manifest (a server before #5232 answers it 404, or the read
 * stopped short) only a snapshot newer than the local state applies, as before
 * #5390: the sweep that follows confirms its revision with the batch route.
 * Packed updates need a manifest's `floor` and are never applied without one.
 *
 * With a manifest, a snapshot applies only when its revision is the one the
 * manifest names, and the walk starts at its `sequenceNum`. A document absent
 * from the manifest has no body row, so nothing of it applies. A local
 * watermark whose revision is the manifest's continues from its own sequence;
 * any other local state, or a server snapshot no pack confirms, leaves the
 * document to the item routes.
 */
export const planDocument = (
  noteId: string,
  local: BodyWatermark | null,
  snapshot: PackedSnapshot | null,
  updates: readonly PackedUpdate[],
  manifest: BodyManifest | null
): DocumentPlan | null => {
  if (manifest === null) {
    if (!snapshot) return null
    if (local) {
      if (local.appliedSequence >= snapshot.meta.sequenceNum) return null
      if (local.snapshotRevision === snapshot.meta.revision) return null
    }
    return {
      snapshot,
      updates: [],
      watermark: {
        appliedSequence: snapshot.meta.sequenceNum,
        snapshotRevision: snapshot.meta.revision
      }
    }
  }

  const document: CrdtManifestDocument | undefined = manifest.get(noteId)
  if (!document) return null
  const revision = document.snapshot?.revision

  let base: { snapshot: PackedSnapshot | null; cursor: number }
  if (snapshot && revision === snapshot.meta.revision && local?.snapshotRevision !== revision) {
    base = { snapshot, cursor: snapshot.meta.sequenceNum }
  } else if (local) {
    if (local.snapshotRevision !== revision) return null
    base = { snapshot: null, cursor: local.appliedSequence }
  } else if (revision === undefined) {
    base = { snapshot: null, cursor: 0 }
  } else {
    return null
  }

  const taken = contiguousUpdates(updates, base.cursor, document.floor)
  if (!base.snapshot && taken.length === 0) return null
  const appliedSequence = taken.at(-1)?.sequenceNum ?? base.cursor
  return {
    snapshot: base.snapshot,
    updates: taken,
    watermark: { appliedSequence, ...(revision ? { snapshotRevision: revision } : {}) }
  }
}
