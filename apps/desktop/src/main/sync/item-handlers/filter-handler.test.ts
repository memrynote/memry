import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { savedFilters } from '@memry/db-schema/schema/settings'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { filterHandler } from './filter-handler'
import { SyncQueueManager } from '../queue'

let db: TestDataDb
const emit = vi.fn()
const ctx = () => ({ db, emit })
const rowOf = (id: string) => db.select().from(savedFilters).where(eq(savedFilters.id, id)).get()

beforeEach(() => {
  db = createTestDataDb()
  emit.mockClear()
})

describe('filterHandler', () => {
  it('inserts a remote filter that does not exist locally and emits saved-filters:created', () => {
    const result = filterHandler.applyUpsert(
      ctx(),
      'filter-1',
      { name: 'Due today', config: { due: 'today' }, position: 2 },
      { deviceA: 1 }
    )

    expect(result).toBe('applied')
    const row = rowOf('filter-1')
    expect(row).toMatchObject({
      id: 'filter-1',
      name: 'Due today',
      config: { due: 'today' },
      position: 2,
      clock: { deviceA: 1 }
    })
    expect(row?.syncedAt).toBeTruthy()
    expect(emit).toHaveBeenCalledWith('saved-filters:created', { id: 'filter-1' })
  })

  it('defaults a missing name to Untitled Filter on insert', () => {
    expect(filterHandler.applyUpsert(ctx(), 'filter-1', {}, { deviceA: 1 })).toBe('applied')

    expect(rowOf('filter-1')).toMatchObject({
      name: 'Untitled Filter',
      config: {},
      position: 0
    })
  })

  it('skips a stale remote update, leaves the local row untouched, and emits nothing', () => {
    filterHandler.applyUpsert(
      ctx(),
      'filter-1',
      { name: 'Local', config: { a: 1 }, position: 1 },
      { deviceA: 5 }
    )
    emit.mockClear()
    const before = rowOf('filter-1')

    const result = filterHandler.applyUpsert(
      ctx(),
      'filter-1',
      { name: 'Stale remote', config: { a: 9 }, position: 9 },
      { deviceA: 2 }
    )

    expect(result).toBe('skipped')
    expect(rowOf('filter-1')).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('reports a conflict on concurrent clocks, keeps the remote value, and merges the clock', () => {
    filterHandler.applyUpsert(ctx(), 'filter-1', { name: 'Local', position: 1 }, { deviceA: 3 })
    emit.mockClear()

    const result = filterHandler.applyUpsert(
      ctx(),
      'filter-1',
      { name: 'Remote', position: 4 },
      { deviceB: 4 }
    )

    expect(result).toBe('conflict')
    expect(rowOf('filter-1')).toMatchObject({
      name: 'Remote',
      position: 4,
      clock: { deviceA: 3, deviceB: 4 }
    })
    expect(emit).toHaveBeenCalledWith('saved-filters:updated', { id: 'filter-1' })
  })

  it('applies and emits saved-filters:updated when the remote clock cleanly dominates', () => {
    filterHandler.applyUpsert(ctx(), 'filter-1', { name: 'Local' }, { deviceA: 3 })
    emit.mockClear()

    const result = filterHandler.applyUpsert(
      ctx(),
      'filter-1',
      { name: 'Newer', config: { due: 'week' }, position: 7 },
      { deviceA: 7 }
    )

    expect(result).toBe('applied')
    expect(rowOf('filter-1')).toMatchObject({
      name: 'Newer',
      config: { due: 'week' },
      position: 7,
      clock: { deviceA: 7 }
    })
    expect(emit).toHaveBeenCalledWith('saved-filters:updated', { id: 'filter-1' })
  })

  it('falls back to the payload clock when the transport clock is empty', () => {
    expect(
      filterHandler.applyUpsert(
        ctx(),
        'filter-1',
        { name: 'From payload', clock: { deviceA: 2 } },
        {}
      )
    ).toBe('applied')

    expect(rowOf('filter-1')).toMatchObject({ clock: { deviceA: 2 } })
  })

  it('keeps name, config and position when the remote payload omits them', () => {
    filterHandler.applyUpsert(
      ctx(),
      'filter-1',
      { name: 'Kept', config: { due: 'today' }, position: 3 },
      { deviceA: 1 }
    )

    expect(filterHandler.applyUpsert(ctx(), 'filter-1', {}, { deviceA: 2 })).toBe('applied')

    expect(rowOf('filter-1')).toMatchObject({
      name: 'Kept',
      config: { due: 'today' },
      position: 3,
      clock: { deviceA: 2 }
    })
  })

  it('never overwrites an existing name with the Untitled Filter insert default', () => {
    filterHandler.applyUpsert(ctx(), 'filter-1', { name: 'Kept' }, { deviceA: 1 })

    // Update with no name at all, then update with a concurrent clock: neither
    // path may fall back to the insert-only 'Untitled Filter' default.
    filterHandler.applyUpsert(ctx(), 'filter-1', { position: 5 }, { deviceA: 2 })
    expect(rowOf('filter-1')?.name).toBe('Kept')

    filterHandler.applyUpsert(ctx(), 'filter-1', { position: 6 }, { deviceB: 1 })
    expect(rowOf('filter-1')?.name).toBe('Kept')
  })

  it('deletes the row and emits saved-filters:deleted when the remote delete clock dominates', () => {
    filterHandler.applyUpsert(ctx(), 'filter-1', { name: 'Local' }, { deviceA: 1 })
    emit.mockClear()

    const result = filterHandler.applyDelete(ctx(), 'filter-1', { deviceA: 2 })

    expect(result).toBe('applied')
    expect(rowOf('filter-1')).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('saved-filters:deleted', { id: 'filter-1' })
  })

  it('skips a delete for an unknown filter and emits nothing', () => {
    expect(filterHandler.applyDelete(ctx(), 'missing', { deviceA: 1 })).toBe('skipped')
    expect(emit).not.toHaveBeenCalled()
  })

  it('skips a delete when the local clock is newer or concurrent', () => {
    filterHandler.applyUpsert(ctx(), 'filter-1', { name: 'Local' }, { deviceA: 5 })
    emit.mockClear()

    expect(filterHandler.applyDelete(ctx(), 'filter-1', { deviceA: 2 })).toBe('skipped')
    expect(filterHandler.applyDelete(ctx(), 'filter-1', { deviceB: 1 })).toBe('skipped')
    expect(rowOf('filter-1')).toBeDefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it('deletes unconditionally when the local row has never been clocked', () => {
    db.insert(savedFilters).values({ id: 'filter-1', name: 'Unclocked', config: {} }).run()

    expect(filterHandler.applyDelete(ctx(), 'filter-1', { deviceA: 1 })).toBe('applied')
    expect(rowOf('filter-1')).toBeUndefined()
  })

  it('fetches the local row and reports undefined for an unknown id', () => {
    filterHandler.applyUpsert(ctx(), 'filter-1', { name: 'Local' }, { deviceA: 1 })

    expect(filterHandler.fetchLocal(db, 'filter-1')).toMatchObject({ name: 'Local' })
    expect(filterHandler.fetchLocal(db, 'missing')).toBeUndefined()
  })

  it('builds a push payload that round-trips and returns null for a missing filter', () => {
    filterHandler.applyUpsert(
      ctx(),
      'filter-1',
      { name: 'Local', config: { due: 'today' }, position: 2 },
      { deviceA: 1 }
    )

    const json = filterHandler.buildPushPayload(db, 'filter-1', 'deviceA', 'update')
    expect(JSON.parse(json!)).toMatchObject({
      id: 'filter-1',
      name: 'Local',
      config: { due: 'today' },
      position: 2,
      clock: { deviceA: 1 }
    })
    expect(filterHandler.buildPushPayload(db, 'missing', 'deviceA', 'update')).toBeNull()
  })

  it('stamps syncedAt on markPushSynced', () => {
    db.insert(savedFilters).values({ id: 'filter-1', name: 'Local', config: {} }).run()
    expect(rowOf('filter-1')?.syncedAt).toBeNull()

    filterHandler.markPushSynced(db, 'filter-1')

    expect(rowOf('filter-1')?.syncedAt).toBeTruthy()
  })

  it('seeds unclocked filters into the queue', () => {
    db.insert(savedFilters)
      .values([
        { id: 'filter-unclocked', name: 'Unclocked', config: {} },
        { id: 'filter-clocked', name: 'Clocked', config: {}, clock: { deviceA: 1 } }
      ])
      .run()

    const queue = new SyncQueueManager(db)
    expect(filterHandler.seedUnclocked(db, 'deviceA', queue)).toBe(1)

    expect(rowOf('filter-unclocked')).toMatchObject({ clock: { deviceA: 1 } })

    const [queued] = queue.dequeue(5)
    expect(queued).toMatchObject({
      type: 'filter',
      itemId: 'filter-unclocked',
      operation: 'create'
    })
    expect(JSON.parse(queued.payload)).toMatchObject({
      id: 'filter-unclocked',
      clock: { deviceA: 1 }
    })
  })
})
