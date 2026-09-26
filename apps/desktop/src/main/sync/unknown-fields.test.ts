import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createTestDataDb,
  cleanupTestDatabase,
  asClientDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { syncUnknownFields } from '@memry/db-schema/schema/sync-unknown-fields'
import type { DataDb } from '../database/client'
import {
  recordUnknownPayloadFields,
  mergeUnknownPayloadFields,
  clearUnknownPayloadFields
} from './unknown-fields'

/**
 * The seam is "a key this build's schema strips survives the round trip":
 * capture what `schema.parse` dropped, put it back under the freshly built push
 * payload. Real migrated SQLite, no mocks.
 */
describe('unknown payload fields', () => {
  let testDb: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    testDb = createTestDataDb()
    db = asClientDb(testDb.db)
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
  })

  it('round-trips a key a newer client wrote', () => {
    // What a newer client sent vs what this build's z.object left behind.
    const raw = { id: 't1', title: 'A', snoozedUntil: 123 }
    const validated = { id: 't1', title: 'A' }

    recordUnknownPayloadFields(db, 'task', 't1', raw, validated)

    const pushed = mergeUnknownPayloadFields(
      db,
      'task',
      't1',
      JSON.stringify({ id: 't1', title: 'A edited' })
    )
    expect(JSON.parse(pushed)).toEqual({ id: 't1', title: 'A edited', snoozedUntil: 123 })
  })

  it('never lets a stale capture overwrite a locally owned key', () => {
    recordUnknownPayloadFields(db, 'task', 't1', { id: 't1', extra: 'old' }, { id: 't1' })

    const pushed = mergeUnknownPayloadFields(
      db,
      'task',
      't1',
      JSON.stringify({ id: 't1', extra: 'local' })
    )
    expect(JSON.parse(pushed).extra).toBe('local')
  })

  it('keeps no row for the envelope id and device-local syncedAt of a row-dump payload', () => {
    const raw = { id: 't1', syncedAt: '2026-09-01T00:00:00.000Z', title: 'A' }
    recordUnknownPayloadFields(db, 'task', 't1', raw, { title: 'A' })
    recordUnknownPayloadFields(db, 'task', 't2', { ...raw, id: 't2', foo: 1 }, { title: 'A' })

    expect(
      db
        .select({ itemId: syncUnknownFields.itemId, fields: syncUnknownFields.fields })
        .from(syncUnknownFields)
        .all()
    ).toEqual([{ itemId: 't2', fields: '{"foo":1}' }])
  })

  it('clears the row once the payload has no unknown keys left', () => {
    recordUnknownPayloadFields(db, 'task', 't1', { id: 't1', extra: 1 }, { id: 't1' })
    recordUnknownPayloadFields(db, 'task', 't1', { id: 't1', extra: 1 }, { id: 't1', extra: 1 })

    expect(db.select().from(syncUnknownFields).all()).toHaveLength(0)
  })

  it('leaves the payload untouched when nothing was captured', () => {
    const payload = JSON.stringify({ id: 't2' })
    expect(mergeUnknownPayloadFields(db, 'task', 't2', payload)).toBe(payload)

    clearUnknownPayloadFields(db, 'task', 't2')
    expect(mergeUnknownPayloadFields(db, 'task', 't2', payload)).toBe(payload)
  })

  it('ignores non-object payloads instead of throwing', () => {
    recordUnknownPayloadFields(db, 'task', 't3', [1, 2], { id: 't3' })
    expect(db.select().from(syncUnknownFields).all()).toHaveLength(0)

    recordUnknownPayloadFields(db, 'task', 't4', { id: 't4', extra: 1 }, { id: 't4' })
    expect(mergeUnknownPayloadFields(db, 'task', 't4', 'not json')).toBe('not json')
  })
})
