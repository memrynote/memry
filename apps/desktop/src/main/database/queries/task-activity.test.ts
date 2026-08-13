import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { taskActivity } from '@memry/db-schema/schema/task-activity'
import { projects } from '@memry/db-schema/schema/projects'
import { listTaskActivity, pruneTaskActivity } from './task-activity'

const DAY_MS = 24 * 60 * 60 * 1000

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

describe('listTaskActivity', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
    testDb.db
      .insert(taskActivity)
      .values([
        {
          id: 'a1',
          taskId: 'task-1',
          action: 'created',
          actor: 'user',
          deviceId: 'device-A',
          createdAt: isoDaysAgo(3)
        },
        {
          id: 'a2',
          taskId: 'task-1',
          action: 'updated',
          field: 'dueDate',
          oldValue: '"2026-08-12"',
          newValue: '"2026-08-20"',
          actor: 'user',
          deviceId: 'device-B',
          createdAt: isoDaysAgo(2)
        },
        {
          id: 'a3',
          taskId: 'task-1',
          action: 'superseded',
          field: 'priority',
          actor: 'sync',
          deviceId: 'device-B',
          createdAt: isoDaysAgo(1)
        },
        {
          id: 'b1',
          taskId: 'task-2',
          action: 'created',
          actor: 'user',
          deviceId: 'device-A',
          createdAt: isoDaysAgo(1)
        }
      ])
      .run()
  })

  afterEach(() => {
    testDb.close()
  })

  it('returns one task newest first, and never another task', () => {
    const result = listTaskActivity(asClientDb(testDb.db), { taskId: 'task-1' }, 'device-A')

    expect(result.entries.map((entry) => entry.id)).toEqual(['a3', 'a2', 'a1'])
    expect(result.total).toBe(3)
    expect(result.hasMore).toBe(false)
  })

  it('resolves isThisDevice instead of leaking the device id', () => {
    const result = listTaskActivity(asClientDb(testDb.db), { taskId: 'task-1' }, 'device-A')

    expect(result.entries.find((entry) => entry.id === 'a1')?.isThisDevice).toBe(true)
    expect(result.entries.find((entry) => entry.id === 'a2')?.isThisDevice).toBe(false)
    expect(JSON.stringify(result.entries)).not.toContain('device-B')
  })

  it('claims the offline-stamped rows when the device is not registered', () => {
    // An unregistered device (signed out, or before the first link) writes its
    // own rows under OFFLINE_CLOCK_DEVICE_ID. Reading them back as someone
    // else's would tell a signed-out user that "another device" made the edit
    // they just made.
    testDb.db
      .insert(taskActivity)
      .values({
        id: 'a4',
        taskId: 'task-1',
        action: 'updated',
        field: 'title',
        actor: 'user',
        deviceId: '_offline',
        createdAt: isoDaysAgo(0)
      })
      .run()

    const result = listTaskActivity(asClientDb(testDb.db), { taskId: 'task-1' }, null)

    expect(result.entries.find((entry) => entry.id === 'a4')?.isThisDevice).toBe(true)
    expect(result.entries.find((entry) => entry.id === 'a2')?.isThisDevice).toBe(false)
  })

  it('pages without repeating or skipping a row', () => {
    const first = listTaskActivity(asClientDb(testDb.db), { taskId: 'task-1', limit: 2 }, null)
    expect(first.entries.map((entry) => entry.id)).toEqual(['a3', 'a2'])
    expect(first.hasMore).toBe(true)

    const second = listTaskActivity(
      asClientDb(testDb.db),
      { taskId: 'task-1', limit: 2, offset: 2 },
      null
    )
    expect(second.entries.map((entry) => entry.id)).toEqual(['a1'])
    expect(second.hasMore).toBe(false)
  })

  it('breaks created_at ties on id so one edit touching three fields pages cleanly', () => {
    const stamp = isoDaysAgo(0)
    testDb.db
      .insert(taskActivity)
      .values(
        ['t1', 't2', 't3'].map((id) => ({
          id,
          taskId: 'task-3',
          action: 'updated',
          actor: 'user',
          deviceId: 'device-A',
          createdAt: stamp
        }))
      )
      .run()

    const page1 = listTaskActivity(asClientDb(testDb.db), { taskId: 'task-3', limit: 2 }, null)
    const page2 = listTaskActivity(
      asClientDb(testDb.db),
      { taskId: 'task-3', limit: 2, offset: 2 },
      null
    )

    const seen = [...page1.entries, ...page2.entries].map((entry) => entry.id)
    expect(new Set(seen).size).toBe(3)
  })

  it('resolves entity ids to names so the feed never shows a raw id', () => {
    testDb.db
      .insert(projects)
      .values([
        { id: 'proj-a', name: 'Work', color: '#fff', icon: null, position: 0 },
        { id: 'proj-b', name: 'Home', color: '#000', icon: null, position: 1 }
      ] as never)
      .run()
    testDb.db
      .insert(taskActivity)
      .values({
        id: 'move-1',
        taskId: 'task-9',
        action: 'moved',
        field: 'projectId',
        oldValue: JSON.stringify('proj-a'),
        newValue: JSON.stringify('proj-b'),
        actor: 'user',
        createdAt: isoDaysAgo(1)
      })
      .run()

    const result = listTaskActivity(asClientDb(testDb.db), { taskId: 'task-9' }, null)

    expect(result.entries[0].oldValue).toBe(JSON.stringify('Work'))
    expect(result.entries[0].newValue).toBe(JSON.stringify('Home'))
  })

  it('falls back to the id when the referenced row is gone — a deleted project still happened', () => {
    testDb.db
      .insert(taskActivity)
      .values({
        id: 'move-2',
        taskId: 'task-9',
        action: 'moved',
        field: 'projectId',
        oldValue: JSON.stringify('proj-vanished'),
        newValue: null,
        actor: 'user',
        createdAt: isoDaysAgo(1)
      })
      .run()

    const result = listTaskActivity(asClientDb(testDb.db), { taskId: 'task-9' }, null)

    expect(result.entries[0].oldValue).toBe(JSON.stringify('proj-vanished'))
  })

  it('filters by action', () => {
    const result = listTaskActivity(
      asClientDb(testDb.db),
      { taskId: 'task-1', actions: ['superseded'] },
      null
    )

    expect(result.entries.map((entry) => entry.id)).toEqual(['a3'])
    expect(result.total).toBe(1)
  })
})

describe('pruneTaskActivity', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
  })

  it('drops only rows older than the cutoff', () => {
    testDb.db
      .insert(taskActivity)
      .values([
        {
          id: 'old',
          taskId: 'task-1',
          action: 'created',
          actor: 'user',
          createdAt: isoDaysAgo(200)
        },
        {
          id: 'new',
          taskId: 'task-1',
          action: 'created',
          actor: 'user',
          createdAt: isoDaysAgo(1)
        }
      ])
      .run()

    const removed = pruneTaskActivity(asClientDb(testDb.db), isoDaysAgo(90))

    expect(removed).toBe(1)
    expect(
      testDb.db
        .select()
        .from(taskActivity)
        .all()
        .map((row) => row.id)
    ).toEqual(['new'])
  })
})
