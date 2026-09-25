import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { syncTombstoneClocks } from '@memry/db-schema/schema/sync-tombstone-clocks'
import { syncPendingDeletes } from '@memry/db-schema/schema/sync-pending-deletes'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { incrementClock } from '@memry/sync-core'
import {
  nextLocalClock,
  recordLocalDeleteClock,
  recordTombstoneClock
} from '@memry/sync-client/tombstone-clocks'
import type { DataDb } from '../database/client'

// #2409: the store of delete clocks a re-create is seeded from.
const DEVICE = 'device-A'
const PEER = 'device-B'

describe('tombstone clocks (#2409)', () => {
  let testDb: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    testDb = createTestDataDb()
    db = asClientDb(testDb.db)
  })

  afterEach(() => {
    testDb.close()
  })

  const stored = (): Array<{ type: string; itemId: string; clock: unknown }> =>
    db
      .select({
        type: syncTombstoneClocks.type,
        itemId: syncTombstoneClocks.itemId,
        clock: syncTombstoneClocks.clock
      })
      .from(syncTombstoneClocks)
      .all()

  const registerDevice = (): void => {
    db.insert(syncDevices)
      .values({
        id: DEVICE,
        name: 'Test device',
        platform: 'darwin',
        appVersion: '2026.9.24',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'pk'
      })
      .run()
  }

  it('merge-upserts and never shrinks', () => {
    recordTombstoneClock(db, 'tag_definition', 'work', { [DEVICE]: 3, [PEER]: 1 })
    recordTombstoneClock(db, 'tag_definition', 'work', { [DEVICE]: 1, [PEER]: 4 })
    recordTombstoneClock(db, 'tag_definition', 'work', { [DEVICE]: 1, [PEER]: 4 })

    expect(stored()).toEqual([
      { type: 'tag_definition', itemId: 'work', clock: { [DEVICE]: 3, [PEER]: 4 } }
    ])
  })

  it('files notes and journals in one family', () => {
    recordTombstoneClock(db, 'journal', 'j2026-04-16', { [PEER]: 2 })

    expect(stored()).toEqual([{ type: 'note', itemId: 'j2026-04-16', clock: { [PEER]: 2 } }])
    expect(nextLocalClock(db, 'note', 'j2026-04-16', null, DEVICE, 'create')).toEqual({
      [PEER]: 2,
      [DEVICE]: 1
    })
  })

  it('ignores non-recreatable types and empty clocks', () => {
    recordTombstoneClock(db, 'task', 'task-1', { [PEER]: 2 })
    recordTombstoneClock(db, 'tag_definition', 'work', {})
    recordTombstoneClock(db, 'tag_definition', 'work', undefined)
    recordLocalDeleteClock(db, 'project', 'p1', JSON.stringify({ clock: { [PEER]: 2 } }), 'final')

    expect(stored()).toEqual([])
  })

  it("records a 'final' payload clock as is and ticks a 'snapshot' once", () => {
    registerDevice()
    recordLocalDeleteClock(db, 'note', 'n1', JSON.stringify({ clock: { [DEVICE]: 4 } }), 'final')
    recordLocalDeleteClock(
      db,
      'tag_definition',
      'work',
      JSON.stringify({ name: 'work', clock: { [DEVICE]: 4 } }),
      'snapshot'
    )

    expect(stored()).toEqual(
      expect.arrayContaining([
        { type: 'note', itemId: 'n1', clock: { [DEVICE]: 4 } },
        { type: 'tag_definition', itemId: 'work', clock: { [DEVICE]: 5 } }
      ])
    )
  })

  it('records nothing for a snapshot with no registered device, or an unreadable payload', () => {
    recordLocalDeleteClock(db, 'tag_definition', 'work', JSON.stringify({ clock: {} }), 'snapshot')
    recordLocalDeleteClock(db, 'tag_definition', 'work', '{not json', 'final')

    expect(stored()).toEqual([])
  })

  it('with no recorded tombstone mints exactly incrementClock(current)', () => {
    expect(nextLocalClock(db, 'bookmark', 'bmk_1', null, DEVICE, 'create')).toEqual(
      incrementClock({}, DEVICE)
    )
    expect(nextLocalClock(db, 'bookmark', 'bmk_1', { [DEVICE]: 7 }, DEVICE, 'update')).toEqual(
      incrementClock({ [DEVICE]: 7 }, DEVICE)
    )
  })

  it('a seeded create retires the family pending deletes; an unseeded write keeps them', () => {
    const pending = (type: string, itemId: string) => ({
      type,
      itemId,
      payload: '{}',
      createdAt: new Date()
    })
    db.insert(syncPendingDeletes)
      .values([
        pending('note', 'j2026-04-16'),
        pending('journal', 'j2026-04-16'),
        pending('tag_definition', 'work')
      ])
      .run()
    recordTombstoneClock(db, 'tag_definition', 'work', { [PEER]: 2 })

    nextLocalClock(db, 'tag_definition', 'work', { [DEVICE]: 5 }, DEVICE, 'update')
    nextLocalClock(db, 'bookmark', 'bmk_1', null, DEVICE, 'create')
    expect(db.select().from(syncPendingDeletes).all()).toHaveLength(3)

    recordTombstoneClock(db, 'note', 'j2026-04-16', { [PEER]: 2 })
    nextLocalClock(db, 'journal', 'j2026-04-16', null, DEVICE, 'create')
    nextLocalClock(db, 'tag_definition', 'work', null, DEVICE, 'create')

    expect(db.select().from(syncPendingDeletes).all()).toEqual([])
  })
})
