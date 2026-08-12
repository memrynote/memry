/**
 * #1326 — the app-root task fetch (`use-task-queries.ts`) pulls the whole
 * workspace and re-runs on every task mutation and every incoming task sync
 * event. Every row it returned used to carry the sync bookkeeping columns
 * (`clock`, `fieldClocks`, `syncedAt`), which are not part of the declared
 * `Task` shape and which no `tasks:list` consumer reads.
 *
 * Real data DB + the real production wiring from `domain.ts` (real
 * `taskQueries`, real `createTasksRepository`, real `createTasksQueries`), so
 * this measures the actual `tasks:list` response rather than a mocked one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTasksQueries } from '@memry/domain-tasks'
import { createTasksRepository } from '@memry/storage-data'
import type { VectorClock, FieldClocks } from '@memry/contracts/sync-api'
import { asClientDb, createTestDataDb, sql } from '@tests/utils/test-db'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import * as taskQueries from '@main/database/queries/tasks'
import * as projectQueries from '@main/database/queries/projects'
import type { DataDb } from '../database'

// Two real-shaped device ids, as a vault synced across a desktop and a laptop.
const DEVICE_A = '7f3c1e8a-4d21-4b6f-9c05-2ea18d7b4f60'
const DEVICE_B = 'b91d40c7-6a58-4e33-8f12-5c7d9ab30e41'

// The exact list `initAllFieldClocks(clock, TASK_SYNCABLE_FIELDS)` seeds on a
// task the moment it first syncs (apps/desktop/src/main/sync/field-merge.ts).
const TASK_SYNCABLE_FIELDS = [
  'title',
  'description',
  'projectId',
  'statusId',
  'parentId',
  'priority',
  'position',
  'dueDate',
  'dueTime',
  'startDate',
  'repeatConfig',
  'repeatFrom',
  'sourceNoteId',
  'completedAt',
  'archivedAt'
]

// Every field the renderer's `dbTaskToUiTask` reads off a `tasks:list` row
// (apps/desktop/src/renderer/src/features/tasks/use-task-queries.ts). If the
// strip ever takes one of these, the task UI loses data.
const RENDERER_READ_FIELDS = [
  'id',
  'title',
  'description',
  'projectId',
  'statusId',
  'priority',
  'dueDate',
  'dueTime',
  'repeatConfig',
  'linkedNoteIds',
  'sourceNoteId',
  'tags',
  'parentId',
  'createdAt',
  'completedAt',
  'archivedAt'
] as const

const SYNC_BOOKKEEPING_FIELDS = ['clock', 'fieldClocks', 'syncedAt'] as const

function syncedClock(): VectorClock {
  return { [DEVICE_A]: 12, [DEVICE_B]: 5 }
}

function syncedFieldClocks(): FieldClocks {
  const clock = syncedClock()
  return Object.fromEntries(TASK_SYNCABLE_FIELDS.map((field) => [field, { ...clock }]))
}

describe('#1326 tasks:list row shape', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb
  let clientDb: DataDb
  let repo: ReturnType<typeof createTasksRepository<DataDb>>
  let queries: ReturnType<typeof createTasksQueries>

  const seedTask = (id: string, index: number) =>
    taskQueries.insertTask(clientDb, {
      id,
      projectId: 'project-1',
      statusId: 'status-todo',
      title: `Ship the ${id} milestone`,
      description: index % 3 === 0 ? `Follow up with the team about ${id}.` : null,
      priority: index % 5,
      position: index,
      dueDate: '2026-09-01',
      createdAt: '2026-08-01T09:00:00.000Z',
      modifiedAt: '2026-08-11T09:00:00.000Z',
      clock: syncedClock(),
      fieldClocks: syncedFieldClocks(),
      syncedAt: '2026-08-11T09:00:05.000Z'
    })

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
    clientDb = asClientDb(db)

    db.run(sql`
      INSERT INTO projects (id, name, color, position, is_inbox)
      VALUES ('project-1', 'Project 1', '#6366f1', 0, 0)
    `)
    db.run(sql`
      INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done)
      VALUES ('status-todo', 'project-1', 'To Do', '#6b7280', 0, 1, 0)
    `)

    repo = createTasksRepository({ db: clientDb, taskQueries, projectQueries })
    queries = createTasksQueries(repo)
  })

  afterEach(() => {
    dbResult.close()
  })

  it('drops sync bookkeeping the renderer never reads', () => {
    seedTask('task-1', 0)

    const [row] = queries.listTasks({ includeCompleted: true, includeArchived: true }).tasks

    for (const field of SYNC_BOOKKEEPING_FIELDS) {
      expect(Object.hasOwn(row, field)).toBe(false)
    }
  })

  it('keeps every field the task UI renders', () => {
    seedTask('task-1', 0)
    taskQueries.setTaskTags(clientDb, 'task-1', ['urgent', 'q3'])
    taskQueries.setTaskNotes(clientDb, 'task-1', [])

    const [row] = queries.listTasks({ includeCompleted: true, includeArchived: true }).tasks
    const raw = taskQueries.getTaskById(clientDb, 'task-1')

    for (const field of RENDERER_READ_FIELDS) {
      expect(Object.hasOwn(row, field)).toBe(true)
    }

    // Same values, not just same keys — the strip must not perturb anything.
    expect(row.id).toBe(raw?.id)
    expect(row.title).toBe(raw?.title)
    expect(row.description).toBe(raw?.description)
    expect(row.projectId).toBe(raw?.projectId)
    expect(row.statusId).toBe(raw?.statusId)
    expect(row.priority).toBe(raw?.priority)
    expect(row.dueDate).toBe(raw?.dueDate)
    expect(row.parentId).toBe(raw?.parentId)
    expect(row.createdAt).toBe(raw?.createdAt)
    expect(row.completedAt).toBe(raw?.completedAt)
    expect(row.archivedAt).toBe(raw?.archivedAt)
    expect(row.tags).toEqual(['q3', 'urgent'])
    expect(row.linkedNoteIds).toEqual([])
  })

  it('still carries the clock on getTask, which feeds the delete tombstone', () => {
    // task-sync.ts `buildDeletePayload` runs `withIncrementedClock` over the
    // JSON of this snapshot and reads `clock` back off it. Stripping the list
    // rows must not reach this path or every task tombstone would push a fresh
    // clock and lose ordering against a concurrent remote update.
    seedTask('task-1', 0)

    const snapshot = repo.getTask('task-1') as Record<string, unknown> | undefined

    expect(snapshot?.clock).toEqual(syncedClock())
  })

  it('cuts the app-root workspace payload for a large task list', () => {
    for (let index = 0; index < 500; index += 1) {
      seedTask(`task-${index}`, index)
    }

    // Exactly the app-root fetch from use-task-queries.ts.
    const response = queries.listTasks({
      includeCompleted: true,
      includeArchived: true,
      limit: 1000
    })

    expect(response.tasks).toHaveLength(500)

    const bytes = JSON.stringify(response).length
    // Before the strip this response measured 620,032 bytes for these 500 rows.
    // eslint-disable-next-line no-console
    console.log(`#1326 tasks:list payload for ${response.tasks.length} rows: ${bytes} bytes`)
    expect(bytes).toBeLessThan(310_016)
  })
})
