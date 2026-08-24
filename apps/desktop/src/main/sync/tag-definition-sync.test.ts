import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { TagDefinitionSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'

/**
 * Push side of tag-definition sync. Real `RecordSyncController`, real
 * `SyncQueueManager`, real migrated in-memory data DB.
 *
 * The colour is the field users notice: a tag whose colour fails to leave the
 * machine (or leaves stale) shows up as "my tag colours changed on their own".
 */

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  TagDefinitionSyncService,
  getTagDefinitionSyncService,
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'

let db: TestDataDb
let queue: SyncQueueManager

function seedTag(overrides: Record<string, unknown> = {}): void {
  db.insert(tagDefinitions)
    .values({
      name: 'work',
      color: 'terracotta',
      icon: null,
      clock: {},
      categoryId: null,
      sortOrder: 0,
      ...overrides
    } as never)
    .run()
}

function queueRows(): Array<typeof syncQueue.$inferSelect> {
  return db.select().from(syncQueue).all()
}

function payloadOf(row: typeof syncQueue.$inferSelect | undefined): Record<string, unknown> {
  return JSON.parse(row!.payload) as Record<string, unknown>
}

function storedClock(name = 'work'): unknown {
  return db.select().from(tagDefinitions).where(eq(tagDefinitions.name, name)).get()?.clock
}

function makeService(deviceId: string | null = 'device-a'): TagDefinitionSyncService {
  return new TagDefinitionSyncService({ queue, db, getDeviceId: () => deviceId })
}

beforeEach(() => {
  vi.clearAllMocks()
  db = createTestDataDb()
  queue = new SyncQueueManager(db)
  resetTagDefinitionSyncService()
})

describe('TagDefinitionSyncService push', () => {
  it('enqueues exactly one tag_definition create carrying the colour', () => {
    seedTag()

    makeService().enqueueCreate('work')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('tag_definition')
    expect(rows[0].itemId).toBe('work')
    expect(rows[0].operation).toBe('create')

    const payload = payloadOf(rows[0])
    expect(payload).toMatchObject({
      name: 'work',
      color: 'terracotta',
      sortOrder: 0,
      clock: { 'device-a': 1 }
    })
    expect(TagDefinitionSyncPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('pushes the NEW colour after the user recolours a tag', () => {
    seedTag()
    const service = makeService()

    service.enqueueCreate('work')
    db.update(tagDefinitions).set({ color: 'indigo' }).where(eq(tagDefinitions.name, 'work')).run()
    service.enqueueUpdate('work')

    // The pending push is rewritten in place, so the surviving payload must
    // carry the colour the user just chose, not the one it replaced.
    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(payloadOf(rows[0]).color).toBe('indigo')
  })

  it('carries the icon, category and sort order alongside the colour', () => {
    seedTag({ icon: 'briefcase', categoryId: 'cat-1', sortOrder: 3 })

    makeService().enqueueUpdate('work')

    expect(payloadOf(queueRows()[0])).toMatchObject({
      color: 'terracotta',
      icon: 'briefcase',
      categoryId: 'cat-1',
      sortOrder: 3
    })
  })

  it('persists the bumped clock on the tag row', () => {
    seedTag({ clock: { 'device-b': 2 } })

    makeService().enqueueUpdate('work')

    expect(storedClock()).toEqual({ 'device-b': 2, 'device-a': 1 })
    expect(payloadOf(queueRows()[0]).clock).toEqual({ 'device-b': 2, 'device-a': 1 })
  })

  it('skips a tag that has no definition row', () => {
    makeService().enqueueUpdate('ghost')

    expect(queueRows()).toEqual([])
  })

  it('skips every mutation while there is no device id', () => {
    seedTag()
    const service = makeService(null)

    service.enqueueCreate('work')
    service.enqueueUpdate('work')
    service.enqueueDelete('work')

    expect(queueRows()).toEqual([])
    expect(storedClock()).toEqual({})
  })

  it('queues a create payload that satisfies the tag_definition sync schema when views are saved', () => {
    // REGRESSION GUARD: `serialize` used to ship the raw DB row, and
    // `tag_definitions.views` is a TEXT column holding JSON, so the queued
    // payload carried `views` as a *string* while the contract expects an
    // array. The push coordinator normally rebuilds the payload via
    // `tagDefinitionHandler.buildPushPayload` (which calls `readTagViews`),
    // so this only escaped on the frozen-payload fallback — reached when the
    // row disappears locally before the push flushes (e.g. a remote delete
    // hard-deletes the row, which `tagDefinitionHandler.applyDelete` does).
    // The receiver then failed schema validation and dropped the whole tag,
    // colour included.
    seedTag({ views: JSON.stringify([{ id: 'v1', name: 'All', type: 'list' }]) })

    makeService().enqueueCreate('work')

    const payload = payloadOf(queueRows()[0])
    expect(payload.views).toEqual([{ id: 'v1', name: 'All', type: 'list' }])
    expect(TagDefinitionSyncPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('sends null views as an explicit clear and never invents the key', () => {
    seedTag()

    makeService().enqueueCreate('work')

    const payload = payloadOf(queueRows()[0])
    expect(payload.views).toBeNull()
    expect(TagDefinitionSyncPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('drops an unreadable views blob instead of clearing the peer copy', () => {
    // A corrupt blob must not become `views: null` on the wire — the receiver
    // treats an absent key as "sender predates this field, keep local".
    seedTag({ views: '{not json' })

    makeService().enqueueCreate('work')

    const payload = payloadOf(queueRows()[0])
    expect(Object.prototype.hasOwnProperty.call(payload, 'views')).toBe(false)
    expect(TagDefinitionSyncPayloadSchema.safeParse(payload).success).toBe(true)
  })
})

describe('TagDefinitionSyncService deletes', () => {
  it('propagates a delete using the caller snapshot with the clock advanced', () => {
    seedTag()

    makeService().enqueueDelete(
      'work',
      JSON.stringify({ name: 'work', color: 'terracotta', clock: { 'device-a': 4 } })
    )

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('delete')
    expect(payloadOf(rows[0])).toEqual({
      name: 'work',
      color: 'terracotta',
      clock: { 'device-a': 5 }
    })
  })

  it('falls back to a minimal tombstone when the caller has no snapshot', () => {
    makeService().enqueueDelete('work')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('delete')
    // The empty colour is a placeholder that only exists to satisfy the
    // required `color` field; the receiver's delete path ignores it.
    const payload = payloadOf(rows[0])
    expect(payload).toEqual({ name: 'work', color: '', clock: { 'device-a': 1 } })
    expect(TagDefinitionSyncPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('propagates a delete for a tag whose row is already gone', () => {
    makeService().enqueueDelete('already-removed')

    expect(queueRows()).toHaveLength(1)
  })

  it('lets a delete win over a still-pending create instead of being dropped', () => {
    seedTag()
    const service = makeService()

    service.enqueueCreate('work')
    service.enqueueDelete('work')

    const rows = queueRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].operation).toBe('delete')
  })
})

describe('tag definition sync service lifecycle', () => {
  it('tracks the module-level singleton', () => {
    expect(getTagDefinitionSyncService()).toBeNull()

    const service = initTagDefinitionSyncService({ queue, db, getDeviceId: () => 'device-a' })
    expect(getTagDefinitionSyncService()).toBe(service)

    resetTagDefinitionSyncService()
    expect(getTagDefinitionSyncService()).toBeNull()
  })
})
