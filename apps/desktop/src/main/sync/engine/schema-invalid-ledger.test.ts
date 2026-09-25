import { afterEach, describe, expect, it, vi } from 'vitest'
import { SchemaInvalidLedger } from './schema-invalid-ledger'
import { CORRUPT_ITEM_COOLDOWN_MS, SYNC_STATE_KEYS } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

function harness(initialVersion: string) {
  const state = new Map<string, string>()
  const stateManager = {
    getStateValue: (key: string) => state.get(key),
    setStateValue: (key: string, value: string) => state.set(key, value)
  } as unknown as SyncStateManager
  const version = { current: initialVersion }
  return { ledger: new SchemaInvalidLedger(stateManager, () => version.current), version, state }
}

const task = (id: string) => ({ id, type: 'task' })

// #2285
describe('SchemaInvalidLedger', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers nothing for a retry on the build that refused it', () => {
    const h = harness('1.0.0')
    h.ledger.record([task('a')], 'payload')

    expect(h.ledger.retryable()).toEqual([])
    expect(h.ledger.has('task', 'a')).toBe(true)
  })

  it('offers every entry once another app version runs', () => {
    const h = harness('1.0.0')
    h.ledger.record([task('a'), task('b')], 'payload')
    h.version.current = '1.1.0'

    expect(h.ledger.retryable()).toEqual([task('a'), task('b')])
  })

  it('offers an envelope failure again after the cooldown, on the same build', () => {
    vi.useFakeTimers()
    const h = harness('1.0.0')
    h.ledger.record([task('payload')], 'payload')
    h.ledger.record([task('envelope')], 'envelope')

    vi.advanceTimersByTime(CORRUPT_ITEM_COOLDOWN_MS + 1)

    expect(h.ledger.retryable()).toEqual([task('envelope')])
  })

  it('forgets an item once it resolves, and re-records the new refusing version', () => {
    const h = harness('1.0.0')
    h.ledger.record([task('a'), task('b')], 'payload')
    h.version.current = '1.1.0'

    h.ledger.resolve([task('a')])
    h.ledger.record([task('b')], 'payload')

    expect(h.ledger.has('task', 'a')).toBe(false)
    expect(h.ledger.retryable()).toEqual([])
    expect(h.ledger.quarantinedItems()).toEqual([
      expect.objectContaining({ itemId: 'b', lastError: 'schema_invalid:payload (app 1.1.0)' })
    ])
  })

  it('keeps readable entries when one stored entry is malformed', () => {
    const h = harness('1.0.0')
    h.state.set(
      SYNC_STATE_KEYS.SCHEMA_INVALID_ITEMS,
      JSON.stringify({
        'task:a': { id: 'a', type: 'task', lastRefusedByVersion: '0.9.0', failedAt: 1 },
        'task:b': { id: 42 }
      })
    )

    expect(h.ledger.retryable()).toEqual([task('a')])
  })

  // #2302: a lost blob is quarantined (so the manifest does not count it
  // server-only) and retried on the corrupt-item cooldown, never deleted.
  it('holds a blob_missing entry and offers it again only after the cooldown', () => {
    vi.useFakeTimers()
    const h = harness('1.0.0')
    h.ledger.record([task('lost')], 'blob_missing')

    expect(h.ledger.has('task', 'lost')).toBe(true)
    expect(h.ledger.retryable()).toEqual([])
    expect(h.ledger.quarantinedItems()).toEqual([
      expect.objectContaining({
        itemId: 'lost',
        lastError: 'schema_invalid:blob_missing (app 1.0.0)'
      })
    ])

    vi.advanceTimersByTime(CORRUPT_ITEM_COOLDOWN_MS + 1)

    expect(h.ledger.retryable()).toEqual([task('lost')])
  })

  // #2302 downgrade: a kind this build does not know reads as 'payload', never a throw.
  it('reads an unknown stored kind as payload', () => {
    const h = harness('1.0.0')
    h.state.set(
      SYNC_STATE_KEYS.SCHEMA_INVALID_ITEMS,
      JSON.stringify({
        'task:a': {
          id: 'a',
          type: 'task',
          kind: 'from_the_future',
          lastRefusedByVersion: '1.0.0',
          failedAt: 1
        }
      })
    )

    expect(h.ledger.has('task', 'a')).toBe(true)
    expect(h.ledger.quarantinedItems()[0].lastError).toBe('schema_invalid:payload (app 1.0.0)')
  })

  // #2301 review r2 A-L2/B-2: an item deferred behind a local sync intent is
  // re-fetched at every pull start, on the same build and with no cooldown,
  // and held here so the manifest does not count it server-only. It is not a
  // quarantined item: nothing is wrong with it.
  it('offers a pending-intent entry at every pull and keeps it out of the quarantine list', () => {
    const h = harness('1.0.0')
    h.ledger.record([task('a')], 'pending_intent')

    expect(h.ledger.retryable()).toEqual([task('a')])
    expect(h.ledger.has('task', 'a')).toBe(true)
    expect(h.ledger.quarantinedItems()).toEqual([])
  })

  it('starts empty on an unreadable row instead of throwing into the pull', () => {
    const h = harness('1.0.0')
    h.state.set(SYNC_STATE_KEYS.SCHEMA_INVALID_ITEMS, '{not json')

    expect(h.ledger.retryable()).toEqual([])
  })

  // #2297 with #2302 and #2301: a refused body and the note record's own
  // entry (a lost blob, an edit waiting on its intent) are separate entries.
  // Round 2 (B-M2): a refused body heals itself and asks nothing of the user,
  // so it is not a quarantined item.
  it('keeps a note_body entry apart from the record kinds and out of the quarantine list', () => {
    const h = harness('1.0.0')
    h.ledger.record([{ id: 'note-1', type: 'note' }], 'blob_missing')
    h.ledger.record([{ id: 'note-2', type: 'note' }], 'pending_intent')
    h.ledger.record(
      [
        { id: 'note-1', type: 'note_body' },
        { id: 'note-2', type: 'note_body' }
      ],
      'envelope'
    )

    // The manifest asks `has(type, id)` of records: a body entry never answers for one.
    expect(h.ledger.has('note', 'note-1')).toBe(true)
    expect(h.ledger.has('note', 'note-3')).toBe(false)
    expect(h.ledger.has('note_body', 'note-1')).toBe(true)
    // Same build, inside the cooldown: only the pending intent is retried.
    expect(h.ledger.retryable()).toEqual([{ id: 'note-2', type: 'note' }])
    expect(h.ledger.quarantinedItems().map((item) => `${item.itemType}:${item.itemId}`)).toEqual([
      'note:note-1'
    ])
  })
})
