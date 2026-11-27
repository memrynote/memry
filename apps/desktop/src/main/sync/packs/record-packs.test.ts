import { describe, expect, it, vi } from 'vitest'

import type { PackSummary, RecordSyncManifest } from '@memry/contracts/sync-api'
import type { PackIndexEntry } from '@memry/contracts/pack-format'

import type { PackFileHandle } from './pack-file-reader'
import {
  planRecordPacks,
  recordCoverageEnd,
  reconcileRecords,
  type PackedRecord
} from './record-packs'

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

const blob = { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' }
const meta = { operation: 'update', signature: 'sig', signerDeviceId: 'dev-b', clock: { b: 1 } }

const packed = (id: string, sortKey: number, over: Partial<PackedRecord['item']> = {}) => ({
  item: { id, type: 'task' as const, ...meta, operation: 'update' as const, blob, ...over },
  sortKey
})

const row = (id: string, serverCursor?: number): RecordSyncManifest['items'][number] => ({
  id,
  type: 'task',
  version: 1,
  modifiedAt: 1,
  size: 1,
  ...(serverCursor === undefined ? {} : { serverCursor })
})

const recordPack = (over: Partial<PackSummary> & { id: string }): PackSummary => ({
  itemKind: 'record',
  packKey: `packs/${over.id}`,
  minCursor: 1,
  maxCursor: 100,
  itemCount: 1,
  byteSize: 1,
  createdAt: 1,
  ...over
})

interface FakeEntry {
  id: string
  sortKey: number
  meta?: Record<string, unknown>
  payload?: unknown
}

const handleOf = (entries: FakeEntry[]): PackFileHandle => {
  const indexEntries = entries.map((entry): PackIndexEntry => ({
    kind: 'record',
    id: entry.id,
    sourceKey: '',
    sortKey: entry.sortKey,
    offset: 0,
    length: 0,
    sha256: new Uint8Array(32),
    ...(entry.meta ? { meta: entry.meta } : {})
  }))
  return {
    entries: indexEntries,
    readEntry: async (entry) => {
      const source = entries.find((candidate) => candidate.id === entry.id)!
      return new TextEncoder().encode(
        typeof source.payload === 'string' ? source.payload : JSON.stringify(source.payload ?? blob)
      )
    },
    close: async () => {}
  }
}

describe('recordCoverageEnd (protocol 08 §8.10, Where the tail starts)', () => {
  it('is 0 without a record coverage statement', () => {
    expect(
      recordCoverageEnd([recordPack({ id: 'a', coverFrom: 0, coverThrough: 50 })], undefined)
    ).toBe(0)
  })

  it('walks an unbroken run from 0 and takes coveredThrough once it reaches packedThrough', () => {
    const packs = [
      recordPack({ id: 'b', coverFrom: 50, coverThrough: 90 }),
      recordPack({ id: 'a', coverFrom: 0, coverThrough: 50 })
    ]
    expect(
      recordCoverageEnd(packs, { itemKind: 'record', packedThrough: 90, coveredThrough: 95 })
    ).toBe(95)
  })

  it('stops at a gap: a pack it could not use lowers the start', () => {
    const packs = [
      recordPack({ id: 'a', coverFrom: 0, coverThrough: 50 }),
      recordPack({ id: 'c', coverFrom: 90, coverThrough: 120 })
    ]
    expect(
      recordCoverageEnd(packs, { itemKind: 'record', packedThrough: 120, coveredThrough: 120 })
    ).toBe(50)
  })
})

describe('reconcileRecords (protocol 08 §8.10, Closing checks)', () => {
  it('applies a live entry only at the manifest cursor and pulls a stale one by id', () => {
    const { apply, pullById } = reconcileRecords(
      [packed('current', 10), packed('stale', 20)],
      [row('current', 10), row('stale', 30)],
      100
    )
    expect(apply.map(({ item }) => item.id)).toEqual(['current'])
    expect(pullById).toEqual([{ id: 'stale', type: 'task', serverCursor: 30 }])
  })

  it('does not apply a live entry the manifest no longer lists', () => {
    const { apply, pullById } = reconcileRecords([packed('gone', 10)], [], 100)
    expect(apply).toEqual([])
    expect(pullById).toEqual([])
  })

  it('pulls by id a manifest item no entry holds, and every item with no serverCursor', () => {
    const { apply, pullById } = reconcileRecords(
      [packed('old-server', 10)],
      [row('omitted', 40), row('old-server')],
      100
    )
    expect(apply).toEqual([])
    expect(pullById).toEqual([
      { id: 'omitted', type: 'task', serverCursor: 40 },
      { id: 'old-server', type: 'task' }
    ])
  })

  it('leaves an item listed above the tail start to the tail', () => {
    const { pullById } = reconcileRecords([], [row('new', 101), row('old', 100)], 100)
    expect(pullById).toEqual([{ id: 'old', type: 'task', serverCursor: 100 }])
  })

  it('applies a tombstone, and drops it for a re-created item that is pulled instead', () => {
    const deleted = { operation: 'delete' as const, deletedAt: 5 }
    const { apply, pullById } = reconcileRecords(
      [packed('dead', 10, deleted), packed('reborn', 11, deleted)],
      [row('reborn', 40)],
      100
    )
    expect(apply.map(({ item }) => item.id)).toEqual(['dead'])
    expect(pullById).toEqual([{ id: 'reborn', type: 'task', serverCursor: 40 }])
  })

  it('takes only the newest entry of an item when two packs hold it', () => {
    const { apply } = reconcileRecords(
      [packed('task-1', 30), packed('task-1', 10)],
      [row('task-1', 30)],
      100
    )
    expect(apply.map(({ sortKey }) => sortKey)).toEqual([30])
  })
})

describe('planRecordPacks', () => {
  const coverage = { itemKind: 'record' as const, packedThrough: 100, coveredThrough: 100 }
  const pack = recordPack({ id: 'r1', coverFrom: 0, coverThrough: 100 })

  it('rebuilds entries, splitting the identity at the first colon', async () => {
    const held = [{ pack, handle: handleOf([{ id: 'folder_config:a:b', sortKey: 7, meta }]) }]
    const plan = await planRecordPacks(held, coverage, async () => ({
      items: [{ ...row('a:b', 7), type: 'folder_config' }],
      complete: true
    }))
    expect(plan?.apply.map(({ item }) => [item.type, item.id])).toEqual([['folder_config', 'a:b']])
    expect(plan?.tailStart).toBe(100)
  })

  it('starts the tail below every unusable entry, but not below an undeclared type', async () => {
    const held = [
      {
        pack,
        handle: handleOf([
          { id: 'task:ok', sortKey: 10, meta },
          { id: 'task:no-meta', sortKey: 40 },
          { id: 'task:bad-blob', sortKey: 60, meta, payload: 'not json' },
          { id: 'future_type:x', sortKey: 5, meta }
        ])
      }
    ]
    const plan = await planRecordPacks(held, coverage, async () => ({
      items: [row('ok', 10), row('no-meta', 40), row('bad-blob', 60)],
      complete: true
    }))
    expect(plan?.tailStart).toBe(39)
    expect(plan?.apply.map(({ item }) => item.id)).toEqual(['ok'])
    // Above the tail start: the tail serves bad-blob.
    expect(plan?.pullById).toEqual([])
  })

  it('does not trust the packs when the manifest stopped short or failed', async () => {
    const held = [{ pack, handle: handleOf([{ id: 'task:ok', sortKey: 10, meta }]) }]
    const short = await planRecordPacks(held, coverage, async () => ({
      items: [],
      complete: false
    }))
    const failed = await planRecordPacks(held, coverage, async () => null)
    expect(short).toBeNull()
    expect(failed).toBeNull()
  })

  it('reads no manifest when coverage reaches nothing', async () => {
    const readManifest = vi.fn()
    const plan = await planRecordPacks([{ pack, handle: handleOf([]) }], undefined, readManifest)
    expect(plan).toBeNull()
    expect(readManifest).not.toHaveBeenCalled()
  })
})
