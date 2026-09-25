import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { projects } from '@memry/db-schema/schema/projects'
import { tasks } from '@memry/db-schema/schema/tasks'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { localTombstoneRefusal, readKnownDeviceIds } from './purged-tombstone-guard'
import type { PurgedTombstone } from './pull-envelope'

// The note handler reads its row through the app's data DB handle.
const current: { db: TestDatabaseResult | null } = { db: null }
vi.mock('../../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: () => current.db!.db
}))

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

/** A delete that happened on 2023-11-14 (epoch seconds). */
const DELETED_AT = 1_700_000_000
const OLD = '2020-01-01T00:00:00.000Z'
const NEW = '2024-06-01T00:00:00.000Z'

const tombstone = (
  type: PurgedTombstone['type'],
  id: string,
  clock: Record<string, number> = { 'device-a': 2 }
): PurgedTombstone => ({ id, type, deletedAt: DELETED_AT, clock })

// #2302 review: the local reasons a purged tombstone is never applied.
describe('localTombstoneRefusal (#2302)', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
    current.db = testDb
    testDb.db.insert(projects).values({ id: 'proj', name: 'P', color: '#000', position: 0 }).run()
  })

  afterEach(() => {
    testDb.close()
  })

  const guard = (t: PurgedTombstone) =>
    localTombstoneRefusal(asSyncDb(testDb.db), t, readKnownDeviceIds(asSyncDb(testDb.db)))

  const seedTask = (id: string, clock: Record<string, number> | null) =>
    testDb.db
      .insert(tasks)
      .values({ id, projectId: 'proj', title: id, priority: 0, position: 0, clock })
      .run()

  const seedTag = (name: string, clock: Record<string, number> | null, createdAt = OLD) =>
    testDb.db.insert(tagDefinitions).values({ name, color: 'blue', clock, createdAt }).run()

  it('applies when there is no local row (the delete is a no-op)', () => {
    expect(guard(tombstone('task', 'absent'))).toBeNull()
  })

  it('applies to a clocked, older, known-device local row', () => {
    seedTask('task-1', { 'device-a': 1 })
    expect(guard(tombstone('task', 'task-1'))).toBeNull()
  })

  // A-F2 / B-4: the handler guard is skipped for a clockless row, so the delete would be unconditional.
  it('refuses a clockless or empty-clock local row', () => {
    seedTask('task-null', null)
    seedTask('task-empty', {})
    expect(guard(tombstone('task', 'task-null'))).toBe('local_clockless')
    expect(guard(tombstone('task', 'task-empty'))).toBe('local_clockless')
  })

  // Restored vault folder: the indexer wrote the note row with no clock.
  it('refuses a clockless note, so a restored note file is never unlinked', () => {
    testDb.db
      .insert(noteMetadata)
      .values({
        id: 'note-restored',
        path: 'restored.md',
        title: 'R',
        createdAt: OLD,
        modifiedAt: OLD
      })
      .run()
    expect(guard(tombstone('note', 'note-restored'))).toBe('local_clockless')
  })

  it('refuses a recreatable item with a queued create or update, not with a queued delete', () => {
    seedTag('work', { 'device-b': 1 })
    seedTag('home', { 'device-b': 1 })
    const queue = new SyncQueueManager(asClientDb(testDb.db))
    queue.enqueue({ type: 'tag_definition', itemId: 'work', operation: 'create', payload: '{}' })
    queue.enqueue({ type: 'tag_definition', itemId: 'home', operation: 'delete', payload: '{}' })

    expect(guard(tombstone('tag_definition', 'work'))).toBe('local_pending_write')
    expect(guard(tombstone('tag_definition', 'home'))).toBeNull()
  })

  it('refuses a recreatable item created or modified after the delete happened', () => {
    seedTag('recreated', { 'device-b': 1 }, NEW)
    testDb.db
      .insert(noteMetadata)
      .values({
        id: 'note-edited',
        path: 'e.md',
        title: 'E',
        clock: { 'device-b': 1 },
        createdAt: OLD,
        modifiedAt: NEW
      })
      .run()

    expect(guard(tombstone('tag_definition', 'recreated'))).toBe('local_newer')
    expect(guard(tombstone('note', 'note-edited'))).toBe('local_newer')
  })

  it('does not apply the recreate rules to a random-id type', () => {
    testDb.db
      .insert(tasks)
      .values({
        id: 'task-new',
        projectId: 'proj',
        title: 't',
        priority: 0,
        position: 0,
        clock: { 'device-a': 1 },
        createdAt: NEW,
        modifiedAt: NEW
      })
      .run()
    expect(guard(tombstone('task', 'task-new'))).toBeNull()
  })

  it('refuses a clock naming a device absent from the local clock and the known devices', () => {
    testDb.db
      .insert(syncDevices)
      .values({
        id: 'device-known',
        name: 'K',
        platform: 'macos',
        appVersion: '1',
        linkedAt: new Date(),
        signingPublicKey: 'k'
      })
      .run()
    seedTask('task-1', { 'device-a': 1 })

    expect(guard(tombstone('task', 'task-1', { 'device-z': 9 }))).toBe('unknown_device')
    expect(guard(tombstone('task', 'task-1', { 'device-a': 2 }))).toBeNull()
    expect(guard(tombstone('task', 'task-1', { 'device-known': 2, _offline: 1 }))).toBeNull()
  })

  it('skips the device check when no device is cached locally', () => {
    seedTask('task-1', { 'device-a': 1 })
    expect(readKnownDeviceIds(asSyncDb(testDb.db))).toBeNull()
    expect(guard(tombstone('task', 'task-1', { 'device-z': 9 }))).toBeNull()
  })
})
