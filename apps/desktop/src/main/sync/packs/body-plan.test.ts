import { describe, expect, it } from 'vitest'

import type { CrdtManifestDocument } from '@memry/contracts/sync-api'
import type { PackIndexEntry } from '@memry/contracts/pack-format'

import type { BodyManifest } from './body-manifest'
import {
  planDocument,
  type BodyWatermark,
  type PackedSnapshot,
  type PackedUpdate
} from './body-plan'

const entry = (kind: PackIndexEntry['kind'], digest = 0): PackIndexEntry => ({
  kind,
  id: 'note-1',
  sourceKey: '',
  sortKey: 0,
  offset: 0,
  length: 0,
  sha256: new Uint8Array(32).fill(digest)
})

const snapshot = (sequenceNum: number, revision: string): PackedSnapshot => ({
  entry: entry('crdt_snapshot'),
  packId: 'p1',
  meta: { sequenceNum, revision },
  read: async () => new Uint8Array()
})

const update = (sequenceNum: number, digest = sequenceNum): PackedUpdate => ({
  entry: entry('crdt_update', digest),
  packId: 'p1',
  sequenceNum,
  signerDeviceId: 'a',
  createdAt: 0,
  read: async () => new Uint8Array()
})

const manifestOf = (document: Omit<CrdtManifestDocument, 'noteId'> | null): BodyManifest =>
  new Map(document ? [['note-1', { noteId: 'note-1', ...document }]] : [])

const doc = (
  revision: string | null,
  floor = 0,
  maxSequenceNum = 9
): Omit<CrdtManifestDocument, 'noteId'> => ({
  floor,
  maxSequenceNum,
  snapshot: revision ? { revision, sequenceNum: 4 } : null
})

interface Case {
  name: string
  local: BodyWatermark | null
  snapshot: PackedSnapshot | null
  updates: PackedUpdate[]
  manifest: BodyManifest | null
  /** null: nothing applies from the packs; the item routes own the document. */
  expected: { snapshot: string | null; updates: number[]; watermark: BodyWatermark } | null
}

const cases: Case[] = [
  // No manifest: an old server (404) or a read that stopped short. The pre-#5390 rule.
  {
    name: 'no manifest, fresh doc: the snapshot only, never a packed update',
    local: null,
    snapshot: snapshot(4, 'r4'),
    updates: [update(5)],
    manifest: null,
    expected: {
      snapshot: 'r4',
      updates: [],
      watermark: { appliedSequence: 4, snapshotRevision: 'r4' }
    }
  },
  {
    name: 'no manifest, local state at the packed sequence: stale',
    local: { appliedSequence: 4, snapshotRevision: 'old' },
    snapshot: snapshot(4, 'r4'),
    updates: [],
    manifest: null,
    expected: null
  },
  {
    name: 'no manifest, same revision already merged: redundant',
    local: { appliedSequence: 2, snapshotRevision: 'r4' },
    snapshot: snapshot(7, 'r4'),
    updates: [],
    manifest: null,
    expected: null
  },
  {
    name: 'no manifest, update-only document: nothing',
    local: null,
    snapshot: null,
    updates: [update(1)],
    manifest: null,
    expected: null
  },
  // With a manifest.
  {
    name: 'document absent from the manifest: it has no body row',
    local: null,
    snapshot: snapshot(4, 'r4'),
    updates: [update(5)],
    manifest: manifestOf(null),
    expected: null
  },
  {
    name: 'confirmed snapshot then the contiguous updates above it',
    local: null,
    snapshot: snapshot(4, 'r4'),
    updates: [update(6), update(5), update(3)],
    manifest: manifestOf(doc('r4')),
    expected: {
      snapshot: 'r4',
      updates: [5, 6],
      watermark: { appliedSequence: 6, snapshotRevision: 'r4' }
    }
  },
  {
    name: 'a gap stops the walk; nothing above it applies',
    local: null,
    snapshot: snapshot(4, 'r4'),
    updates: [update(5), update(7), update(8)],
    manifest: manifestOf(doc('r4')),
    expected: {
      snapshot: 'r4',
      updates: [5],
      watermark: { appliedSequence: 5, snapshotRevision: 'r4' }
    }
  },
  {
    name: 'packed snapshot revision is not the server one: nothing',
    local: null,
    snapshot: snapshot(4, 'r-old'),
    updates: [update(5)],
    manifest: manifestOf(doc('r4')),
    expected: null
  },
  {
    name: 'server holds a snapshot no pack carries: nothing',
    local: null,
    snapshot: null,
    updates: [update(5)],
    manifest: manifestOf(doc('r4')),
    expected: null
  },
  {
    name: 'update-only document walks from 0',
    local: null,
    snapshot: null,
    updates: [update(1), update(2)],
    manifest: manifestOf(doc(null)),
    expected: { snapshot: null, updates: [1, 2], watermark: { appliedSequence: 2 } }
  },
  {
    name: 'updates at or below the floor never apply (a purge the pack predates)',
    local: null,
    snapshot: null,
    updates: [update(1), update(2), update(3)],
    manifest: manifestOf(doc(null, 2)),
    expected: null
  },
  {
    name: 'a claimed snapshot below the floor keeps its baseline but takes no update',
    local: null,
    snapshot: snapshot(4, 'r4'),
    updates: [update(5), update(6)],
    manifest: manifestOf(doc('r4', 5)),
    expected: {
      snapshot: 'r4',
      updates: [],
      watermark: { appliedSequence: 4, snapshotRevision: 'r4' }
    }
  },
  {
    name: 'two digests for one (document, sequenceNum): no packed update',
    local: null,
    snapshot: snapshot(4, 'r4'),
    updates: [update(5), update(5, 99), update(6)],
    manifest: manifestOf(doc('r4')),
    expected: {
      snapshot: 'r4',
      updates: [],
      watermark: { appliedSequence: 4, snapshotRevision: 'r4' }
    }
  },
  {
    name: 'the same entry in two packs is one update',
    local: null,
    snapshot: snapshot(4, 'r4'),
    updates: [update(5), update(5), update(6)],
    manifest: manifestOf(doc('r4')),
    expected: {
      snapshot: 'r4',
      updates: [5, 6],
      watermark: { appliedSequence: 6, snapshotRevision: 'r4' }
    }
  },
  {
    name: 'a resumed doc continues from its own watermark under the same revision',
    local: { appliedSequence: 5, snapshotRevision: 'r4' },
    snapshot: snapshot(4, 'r4'),
    updates: [update(5), update(6), update(7)],
    manifest: manifestOf(doc('r4')),
    expected: {
      snapshot: null,
      updates: [6, 7],
      watermark: { appliedSequence: 7, snapshotRevision: 'r4' }
    }
  },
  {
    name: 'a resumed doc with nothing new above its watermark: nothing',
    local: { appliedSequence: 6, snapshotRevision: 'r4' },
    snapshot: snapshot(4, 'r4'),
    updates: [update(5), update(6)],
    manifest: manifestOf(doc('r4')),
    expected: null
  },
  {
    name: 'local state under another revision takes the confirmed snapshot',
    local: { appliedSequence: 9, snapshotRevision: 'r-old' },
    snapshot: snapshot(4, 'r4'),
    updates: [update(5)],
    manifest: manifestOf(doc('r4')),
    expected: {
      snapshot: 'r4',
      updates: [5],
      watermark: { appliedSequence: 5, snapshotRevision: 'r4' }
    }
  },
  {
    name: 'local state under another revision and no confirmed snapshot: nothing',
    local: { appliedSequence: 3, snapshotRevision: 'r-old' },
    snapshot: null,
    updates: [update(4), update(5)],
    manifest: manifestOf(doc('r4')),
    expected: null
  }
]

describe('planDocument', () => {
  it.each(cases)('$name', ({ local, snapshot: packed, updates, manifest, expected }) => {
    const plan = planDocument('note-1', local, packed, updates, manifest)
    expect(
      plan && {
        snapshot: plan.snapshot?.meta.revision ?? null,
        updates: plan.updates.map((row) => row.sequenceNum),
        watermark: plan.watermark
      }
    ).toEqual(expected)
  })
})
