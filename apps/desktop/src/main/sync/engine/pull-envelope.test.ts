import { describe, expect, it, vi } from 'vitest'
import type { DrizzleDb } from '../item-handlers'
import { parsePullItems, purgedTombstoneApplyItems } from './pull-envelope'
import { localTombstoneRefusal } from './purged-tombstone-guard'

vi.mock('./purged-tombstone-guard', () => ({
  readKnownDeviceIds: vi.fn(() => null),
  localTombstoneRefusal: vi.fn(() => null)
}))
vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

const db = {} as DrizzleDb

const item = (id: string) => ({
  id,
  type: 'task',
  operation: 'update',
  signature: 'sig',
  signerDeviceId: 'device-2',
  blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' }
})

describe('parsePullItems', () => {
  // #2292
  it('parses inline items per item, ahead of the pulled ones', () => {
    const parsed = parsePullItems({ items: [item('pulled')] }, [
      item('inline'),
      { id: 'inline-bad', type: 'task' },
      'no id'
    ])

    expect(parsed).toEqual({
      kind: 'envelope',
      items: [expect.objectContaining({ id: 'inline' }), expect.objectContaining({ id: 'pulled' })],
      invalid: [{ id: 'inline-bad', type: 'task' }],
      unnamed: 1,
      purgedTombstones: [],
      refusedTombstones: [],
      blobMissing: []
    })
  })

  // #2292 with #2285: a body that is not an envelope refuses the slice, inline or not.
  it('stays not_envelope when inline items come with a broken pull body', () => {
    expect(parsePullItems({ error: 'x' }, [item('inline')])).toEqual({ kind: 'not_envelope' })
  })

  // #2302 compat: a pre-#2302 body has no sibling lists; a post-#2302 body's items
  // parse exactly as a pre-#2302 client parsed them.
  it('parses items identically with and without the #2302 sibling lists', () => {
    const legacy = parsePullItems({ items: [item('a'), { id: 'bad', type: 'task' }] }, [], ['a'])
    const current = parsePullItems(
      {
        items: [item('a'), { id: 'bad', type: 'task' }],
        purgedTombstones: [
          { id: 'b', type: 'task', deletedAt: 1, clock: { d: 1 }, serverCursor: 2 }
        ],
        blobMissing: [{ id: 'c', type: 'task', serverCursor: 3 }]
      },
      [],
      ['a', 'b', 'c']
    )

    expect(legacy).toMatchObject({ purgedTombstones: [], blobMissing: [] })
    if (legacy.kind !== 'envelope' || current.kind !== 'envelope') throw new Error('envelope')
    expect(current.items).toEqual(legacy.items)
    expect(current.invalid).toEqual(legacy.invalid)
    expect(current.unnamed).toEqual(legacy.unnamed)
  })
})

describe('parsePullItems purged tombstones (#2302)', () => {
  const tombstone = (overrides: Record<string, unknown> = {}) => ({
    id: 'task-t',
    type: 'task',
    deletedAt: 1_700_000_000,
    clock: { 'device-a': 2 },
    serverCursor: 9,
    ...overrides
  })
  const parse = (entries: unknown[], requested = ['task-t']) => {
    const parsed = parsePullItems({ items: [], purgedTombstones: entries }, [], requested)
    if (parsed.kind !== 'envelope') throw new Error('expected an envelope')
    return parsed
  }

  // #2302
  it('admits a requested, clock-required tombstone with a non-empty clock', () => {
    expect(parse([tombstone()]).purgedTombstones).toEqual([
      { id: 'task-t', type: 'task', deletedAt: 1_700_000_000, clock: { 'device-a': 2 } }
    ])
  })

  // #2302: an unsigned delete without a clock would apply unconditionally.
  it('refuses a tombstone with no clock or an empty clock', () => {
    const parsed = parse(
      [tombstone({ clock: undefined }), tombstone({ id: 'task-u', clock: {} })],
      ['task-t', 'task-u']
    )

    expect(parsed.purgedTombstones).toEqual([])
    expect(parsed.refusedTombstones).toEqual([
      { id: 'task-t', type: 'task', reason: 'clockless' },
      { id: 'task-u', type: 'task', reason: 'clockless' }
    ])
  })

  // #2302
  it('refuses a tombstone for a type outside RECORD_CLOCK_REQUIRED_ITEM_TYPES', () => {
    const parsed = parse([tombstone({ id: 'general', type: 'settings' })], ['general'])

    expect(parsed.purgedTombstones).toEqual([])
    expect(parsed.refusedTombstones).toEqual([
      { id: 'general', type: 'settings', reason: 'type_not_clocked' }
    ])
  })

  // #2302: the server may only delete what this request asked for.
  it('refuses a tombstone for an id the request did not name', () => {
    const parsed = parse([tombstone({ id: 'task-other' })])

    expect(parsed.purgedTombstones).toEqual([])
    expect(parsed.refusedTombstones).toEqual([
      { id: 'task-other', type: 'task', reason: 'not_requested' }
    ])
  })

  // #2302: per entry, never per page.
  it('keeps the valid siblings of a malformed entry', () => {
    const parsed = parse([{ id: 'task-t' }, 'junk', tombstone()])

    expect(parsed.purgedTombstones).toHaveLength(1)
    expect(parsed.refusedTombstones.map((entry) => entry.reason)).toEqual(['shape', 'shape'])
  })

  // #2302: the apply input is exactly what the signed path hands the applier for a delete.
  it('maps an admitted tombstone to a delete apply item and skips what the caller names', () => {
    const parsed = parse([tombstone(), tombstone({ id: 'task-done' })], ['task-t', 'task-done'])

    expect(purgedTombstoneApplyItems(parsed, (ref) => ref.id === 'task-done', db)).toEqual([
      {
        id: 'task-t',
        type: 'task',
        operation: 'delete',
        content: '',
        clock: { 'device-a': 2 },
        deletedAt: 1_700_000_000,
        signerDeviceId: ''
      }
    ])
  })

  // #2302 review: a local refusal (purged-tombstone-guard) is never applied.
  it('drops a tombstone the local guard refuses', () => {
    vi.mocked(localTombstoneRefusal).mockReturnValueOnce('local_clockless')
    const parsed = parse([tombstone()])

    expect(purgedTombstoneApplyItems(parsed, () => false, db)).toEqual([])
  })
})

describe('parsePullItems blobMissing (#2302)', () => {
  // #2302
  it('keeps requested, well-formed entries as item refs', () => {
    const parsed = parsePullItems(
      {
        items: [],
        blobMissing: [
          { id: 'task-b', type: 'task', serverCursor: 3 },
          { id: 'task-x', type: 'task', serverCursor: 4 },
          { type: 'task' }
        ]
      },
      [],
      ['task-b']
    )

    expect(parsed).toMatchObject({ blobMissing: [{ id: 'task-b', type: 'task' }] })
  })
})
