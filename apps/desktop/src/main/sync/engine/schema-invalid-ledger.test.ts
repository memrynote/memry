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

  it('starts empty on an unreadable row instead of throwing into the pull', () => {
    const h = harness('1.0.0')
    h.state.set(SYNC_STATE_KEYS.SCHEMA_INVALID_ITEMS, '{not json')

    expect(h.ledger.retryable()).toEqual([])
  })
})
