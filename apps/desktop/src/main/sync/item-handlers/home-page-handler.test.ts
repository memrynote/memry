import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { homePages } from '@memry/db-schema/schema/home-pages'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { homePageHandler } from './home-page-handler'
import { SyncQueueManager } from '../queue'

let db: TestDataDb
const emit = vi.fn()
const ctx = () => ({ db, emit })
const rowOf = (id: string) => db.select().from(homePages).where(eq(homePages.id, id)).get()

const WIDGETS = JSON.stringify([
  { id: 'w1', type: 'bookmarks', x: 0, y: 0, w: 4, h: 4, config: {} }
])

beforeEach(() => {
  db = createTestDataDb()
  emit.mockClear()
})

describe('homePageHandler', () => {
  it('inserts a remote board that does not exist locally and emits home-pages:created', () => {
    const result = homePageHandler.applyUpsert(
      ctx(),
      'board-1',
      { name: 'Work', icon: '🎯', position: 2, widgets: WIDGETS },
      { deviceA: 1 }
    )

    expect(result).toBe('applied')
    const row = rowOf('board-1')
    expect(row).toMatchObject({
      id: 'board-1',
      name: 'Work',
      icon: '🎯',
      position: 2,
      widgets: WIDGETS,
      clock: { deviceA: 1 }
    })
    expect(row?.syncedAt).toBeTruthy()
    expect(emit).toHaveBeenCalledWith('home-pages:created', { id: 'board-1' })
  })

  it('refuses a name-less insert (ghost guard) and emits nothing', () => {
    // pull-coordinator enqueues '{}' on conflict, and every payload field is
    // optional — without the guard this would mint a permanent ghost board.
    expect(homePageHandler.applyUpsert(ctx(), 'board-1', {}, { deviceA: 1 })).toBe('skipped')

    expect(rowOf('board-1')).toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it('skips a stale remote update, leaves the local row untouched, and emits nothing', () => {
    homePageHandler.applyUpsert(ctx(), 'board-1', { name: 'Local' }, { deviceA: 5 })
    emit.mockClear()
    const before = rowOf('board-1')

    const result = homePageHandler.applyUpsert(
      ctx(),
      'board-1',
      { name: 'Stale remote', position: 9 },
      { deviceA: 2 }
    )

    expect(result).toBe('skipped')
    expect(rowOf('board-1')).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('reports a conflict on concurrent clocks, keeps the remote value, and merges the clock', () => {
    homePageHandler.applyUpsert(ctx(), 'board-1', { name: 'Local', position: 1 }, { deviceA: 3 })
    emit.mockClear()

    const result = homePageHandler.applyUpsert(
      ctx(),
      'board-1',
      { name: 'Remote', position: 4 },
      { deviceB: 4 }
    )

    expect(result).toBe('conflict')
    expect(rowOf('board-1')).toMatchObject({
      name: 'Remote',
      position: 4,
      clock: { deviceA: 3, deviceB: 4 }
    })
    expect(emit).toHaveBeenCalledWith('home-pages:updated', { id: 'board-1' })
  })

  it('applies and emits home-pages:updated when the remote clock cleanly dominates', () => {
    homePageHandler.applyUpsert(ctx(), 'board-1', { name: 'Local' }, { deviceA: 3 })
    emit.mockClear()

    const result = homePageHandler.applyUpsert(
      ctx(),
      'board-1',
      { name: 'Newer', position: 7, widgets: WIDGETS },
      { deviceA: 7 }
    )

    expect(result).toBe('applied')
    expect(rowOf('board-1')).toMatchObject({
      name: 'Newer',
      position: 7,
      widgets: WIDGETS,
      clock: { deviceA: 7 }
    })
    expect(emit).toHaveBeenCalledWith('home-pages:updated', { id: 'board-1' })
  })

  it('falls back to the payload clock when the transport clock is empty', () => {
    expect(
      homePageHandler.applyUpsert(
        ctx(),
        'board-1',
        { name: 'From payload', clock: { deviceA: 2 } },
        {}
      )
    ).toBe('applied')

    expect(rowOf('board-1')).toMatchObject({ clock: { deviceA: 2 } })
  })

  it('keeps the local widgets blob when the remote payload omits the field', () => {
    homePageHandler.applyUpsert(
      ctx(),
      'board-1',
      { name: 'Kept', position: 3, widgets: WIDGETS },
      { deviceA: 1 }
    )

    // Absent `widgets` means "the sender does not know this field", not "clear".
    expect(homePageHandler.applyUpsert(ctx(), 'board-1', { name: 'Kept' }, { deviceA: 2 })).toBe(
      'applied'
    )

    expect(rowOf('board-1')).toMatchObject({ widgets: WIDGETS, position: 3, clock: { deviceA: 2 } })
  })

  it('refuses a widgets blob that is present but not a JSON array, leaving the clock un-advanced', () => {
    homePageHandler.applyUpsert(
      ctx(),
      'board-1',
      { name: 'Local', widgets: WIDGETS },
      { deviceA: 1 }
    )
    emit.mockClear()

    for (const bad of ['not json at all', '{"id":"w1"}', 'null']) {
      expect(
        homePageHandler.applyUpsert(ctx(), 'board-1', { name: 'Bad', widgets: bad }, { deviceA: 9 })
      ).toBe('skipped')
    }

    // Un-advanced clock is the point: a later readable version still wins.
    expect(rowOf('board-1')).toMatchObject({ widgets: WIDGETS, clock: { deviceA: 1 } })
    expect(emit).not.toHaveBeenCalled()

    expect(
      homePageHandler.applyUpsert(
        ctx(),
        'board-1',
        { name: 'Readable', widgets: '[]' },
        { deviceA: 9 }
      )
    ).toBe('applied')
  })

  it('round-trips a legacy {size} widget blob byte-for-byte', () => {
    const legacy = JSON.stringify([{ id: 'w1', type: 'bookmarks', size: 'M', config: {} }])

    homePageHandler.applyUpsert(
      ctx(),
      'board-1',
      { name: 'Legacy', widgets: legacy },
      { deviceA: 1 }
    )

    expect(rowOf('board-1')?.widgets).toBe(legacy)
    expect(
      JSON.parse(homePageHandler.buildPushPayload(db, 'board-1', 'deviceA', 'update')!)
    ).toMatchObject({ widgets: legacy })
  })

  it('round-trips unknown widget keys and types written by a newer build, unstripped', () => {
    const futuristic = JSON.stringify([
      {
        id: 'w1',
        type: 'weather-from-the-future',
        x: 0,
        y: 0,
        w: 2,
        h: 2,
        config: {},
        opacity: 0.5
      }
    ])

    homePageHandler.applyUpsert(
      ctx(),
      'board-1',
      { name: 'Future', widgets: futuristic },
      { deviceA: 1 }
    )

    expect(rowOf('board-1')?.widgets).toBe(futuristic)
  })

  it('clears the icon on an explicit null and keeps it when the key is absent', () => {
    homePageHandler.applyUpsert(ctx(), 'board-1', { name: 'Work', icon: '🎯' }, { deviceA: 1 })

    homePageHandler.applyUpsert(ctx(), 'board-1', { name: 'Work' }, { deviceA: 2 })
    expect(rowOf('board-1')?.icon).toBe('🎯')

    homePageHandler.applyUpsert(ctx(), 'board-1', { name: 'Work', icon: null }, { deviceA: 3 })
    expect(rowOf('board-1')?.icon).toBeNull()
  })

  it('deletes the row and emits home-pages:deleted when the remote delete clock dominates', () => {
    homePageHandler.applyUpsert(ctx(), 'board-1', { name: 'Local' }, { deviceA: 1 })
    emit.mockClear()

    const result = homePageHandler.applyDelete(ctx(), 'board-1', { deviceA: 2 })

    expect(result).toBe('applied')
    expect(rowOf('board-1')).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('home-pages:deleted', { id: 'board-1' })
  })

  it('skips a delete for an unknown board and emits nothing', () => {
    expect(homePageHandler.applyDelete(ctx(), 'missing', { deviceA: 1 })).toBe('skipped')
    expect(emit).not.toHaveBeenCalled()
  })

  it('skips a delete when the local clock is newer or concurrent', () => {
    homePageHandler.applyUpsert(ctx(), 'board-1', { name: 'Local' }, { deviceA: 5 })
    emit.mockClear()

    expect(homePageHandler.applyDelete(ctx(), 'board-1', { deviceA: 2 })).toBe('skipped')
    expect(homePageHandler.applyDelete(ctx(), 'board-1', { deviceB: 1 })).toBe('skipped')
    expect(rowOf('board-1')).toBeDefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it('fetches the local row and reports undefined for an unknown id', () => {
    homePageHandler.applyUpsert(ctx(), 'board-1', { name: 'Local' }, { deviceA: 1 })

    expect(homePageHandler.fetchLocal(db, 'board-1')).toMatchObject({ name: 'Local' })
    expect(homePageHandler.fetchLocal(db, 'missing')).toBeUndefined()
  })

  it('builds a push payload that round-trips and returns null for a missing board', () => {
    homePageHandler.applyUpsert(
      ctx(),
      'board-1',
      { name: 'Local', icon: '🎯', position: 2, widgets: WIDGETS },
      { deviceA: 1 }
    )

    const json = homePageHandler.buildPushPayload(db, 'board-1', 'deviceA', 'update')
    expect(JSON.parse(json!)).toMatchObject({
      id: 'board-1',
      name: 'Local',
      icon: '🎯',
      position: 2,
      widgets: WIDGETS,
      clock: { deviceA: 1 }
    })
    expect(homePageHandler.buildPushPayload(db, 'missing', 'deviceA', 'update')).toBeNull()
  })

  it('stamps syncedAt on markPushSynced', () => {
    db.insert(homePages).values({ id: 'board-1', name: 'Local' }).run()
    expect(rowOf('board-1')?.syncedAt).toBeNull()

    homePageHandler.markPushSynced(db, 'board-1')

    expect(rowOf('board-1')?.syncedAt).toBeTruthy()
  })

  it('seeds unclocked boards into the queue and persists the stamp', () => {
    db.insert(homePages)
      .values([
        { id: 'board-unclocked', name: 'Unclocked', widgets: WIDGETS },
        { id: 'board-clocked', name: 'Clocked', clock: { deviceA: 1 } }
      ])
      .run()

    const queue = new SyncQueueManager(db)
    expect(homePageHandler.seedUnclocked(db, 'deviceA', queue)).toBe(1)

    // Persisted, not just enqueued — otherwise the next run re-seeds it forever.
    expect(rowOf('board-unclocked')).toMatchObject({ clock: { deviceA: 1 } })

    const [queued] = queue.dequeue(5)
    expect(queued).toMatchObject({
      type: 'home_page',
      itemId: 'board-unclocked',
      operation: 'create'
    })
    expect(JSON.parse(queued.payload)).toMatchObject({
      id: 'board-unclocked',
      widgets: WIDGETS,
      clock: { deviceA: 1 }
    })
  })
})
