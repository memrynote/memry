/**
 * A child that arrives before its FK parent must be deferred, never lost.
 *
 * `tasks.project_id` is NOT NULL and FK-bound, and so is
 * `calendar_external_events.source_id`. The server hands pages back in
 * last-update order, not dependency order, so a task genuinely can land before
 * its project. What the user must never see is the task simply missing.
 *
 * Three mechanisms cooperate, and this suite walks the same sequence the pull
 * coordinator runs, against real SQLite with foreign keys ON:
 *   1. `sortByApplyOrder` puts parents first inside a page, so the ordinary
 *      case never defers at all;
 *   2. an apply that still fails throws instead of returning, which is what
 *      makes the pull coordinator park the item in `pendingApplyRetries`;
 *   3. the replay after the parent lands writes it for real.
 *
 * `orphan-repair.test.ts` covers step 4 — the parent that is gone *everywhere*
 * — so this file deliberately stops at the parent that merely arrives late.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { makeTaskPayload } from '@tests/utils/fixtures/sync-item-handlers'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { ItemApplier, type ApplyItemInput } from './apply-item'
import { MissingSyncParentError } from './item-handlers/types'
import { sortByApplyOrder } from './engine/pull-coordinator'

const LATE_PROJECT = 'proj-late'
const LATE_SOURCE = 'source-late'

let testDb: TestDatabaseResult
let applier: ItemApplier
let emit: ReturnType<typeof vi.fn>

const encode = (payload: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(payload))

/** One decrypted pull item, shaped the way the coordinator hands it to apply. */
function pulled(
  type: ApplyItemInput['type'],
  itemId: string,
  payload: unknown,
  clock: Record<string, number> = { mac: 1 }
): ApplyItemInput {
  return { itemId, type, operation: 'create', content: encode(payload), clock }
}

const taskItem = (): ApplyItemInput =>
  pulled(
    'task',
    'task-late',
    makeTaskPayload({ title: 'Ship the release', projectId: LATE_PROJECT, statusId: null })
  )

const projectItem = (): ApplyItemInput =>
  pulled('project', LATE_PROJECT, { name: 'Release 2.0', color: '#123456', position: 0 })

const externalEventItem = (): ApplyItemInput =>
  pulled('calendar_external_event', 'event-late', {
    sourceId: LATE_SOURCE,
    remoteEventId: 'remote-1',
    title: 'Design review',
    startAt: '2026-08-01T09:00:00.000Z'
  })

const sourceItem = (): ApplyItemInput =>
  pulled('calendar_source', LATE_SOURCE, { title: 'Work', provider: 'google' })

/** Applies and returns whatever escaped, mirroring the coordinator's try/catch. */
function applyCatching(input: ApplyItemInput): unknown {
  try {
    applier.apply(input)
    return undefined
  } catch (err) {
    return err
  }
}

beforeEach(() => {
  testDb = createTestDataDb()
  emit = vi.fn()
  applier = new ItemApplier(asSyncDb(testDb.db), emit)
})

afterEach(() => {
  testDb.close()
})

describe('out-of-order pull: task before its project', () => {
  it('defers rather than writing a half-broken row', () => {
    const err = applyCatching(taskItem())

    expect(err).toBeInstanceOf(MissingSyncParentError)
    // Naming the parent is what lets the coordinator refetch it instead of
    // dropping the child until some future remote update (#837).
    const missing = err as MissingSyncParentError
    expect(missing.parentType).toBe('project')
    expect(missing.parentId).toBe(LATE_PROJECT)
    expect(missing.childId).toBe('task-late')

    expect(testDb.db.select().from(tasks).where(eq(tasks.id, 'task-late')).get()).toBeUndefined()
  })

  it('lands the task intact once the parent arrives and the deferred item replays', () => {
    applyCatching(taskItem())

    // A later page of the same run carries the project.
    expect(applier.apply(projectItem())).toBe('applied')

    // applyDeferredRetries replays everything that threw.
    expect(applier.apply(taskItem())).toBe('applied')

    const row = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-late')).get()
    expect(row?.title).toBe('Ship the release')
    expect(row?.projectId).toBe(LATE_PROJECT)
  })

  it('never defers in the first place when both items are in the same page', () => {
    // Cursor order is last-update order, so the child can lead the page.
    const page = sortByApplyOrder([taskItem(), projectItem()])

    expect(page.map((item) => item.type)).toEqual(['project', 'task'])
    for (const item of page) expect(applier.apply(item)).toBe('applied')
    expect(testDb.db.select().from(tasks).where(eq(tasks.id, 'task-late')).get()).toBeDefined()
  })
})

describe('out-of-order pull: calendar_external_event before its calendar_source', () => {
  it('defers rather than writing an event pointing at a source that is not there', () => {
    const err = applyCatching(externalEventItem())

    expect(err).toBeInstanceOf(Error)
    expect(
      testDb.db
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, 'event-late'))
        .get()
    ).toBeUndefined()
  })

  it('lands the event intact once the source arrives and the deferred item replays', () => {
    applyCatching(externalEventItem())

    expect(applier.apply(sourceItem())).toBe('applied')
    expect(
      testDb.db.select().from(calendarSources).where(eq(calendarSources.id, LATE_SOURCE)).get()
    ).toBeDefined()

    expect(applier.apply(externalEventItem())).toBe('applied')

    const row = testDb.db
      .select()
      .from(calendarExternalEvents)
      .where(eq(calendarExternalEvents.id, 'event-late'))
      .get()
    expect(row?.title).toBe('Design review')
    expect(row?.sourceId).toBe(LATE_SOURCE)
  })

  it('never defers in the first place when both items are in the same page', () => {
    const page = sortByApplyOrder([externalEventItem(), sourceItem()])

    expect(page.map((item) => item.type)).toEqual(['calendar_source', 'calendar_external_event'])
    for (const item of page) expect(applier.apply(item)).toBe('applied')
  })

  // GAP. `taskHandler` translates a dangling FK into MissingSyncParentError, so
  // repairOrphans can refetch the parent and — if it is gone everywhere —
  // tombstone the child, ending the #837 re-pull loop. The external event
  // handler still raises SQLite's anonymous "FOREIGN KEY constraint failed",
  // which names neither the constraint nor the missing id, so the coordinator
  // can only log and drop it. Deleting a calendar_source cascades its events
  // away locally while the server keeps them alive, which is exactly the loop
  // #837 fixed for tasks. Delete `.fails` once the handler names its parent.
  it.fails('should name the missing calendar_source so orphan repair can act', () => {
    const err = applyCatching(externalEventItem())

    expect(err).toBeInstanceOf(MissingSyncParentError)
  })
})

describe('out-of-order pull: a deferred child does not disturb its neighbours', () => {
  it('applies every other item in the page even though one child is unwritable', () => {
    expect(applier.apply(sourceItem())).toBe('applied')
    expect(applyCatching(taskItem())).toBeInstanceOf(MissingSyncParentError)
    expect(applier.apply(projectItem())).toBe('applied')

    expect(
      testDb.db.select().from(calendarSources).where(eq(calendarSources.id, LATE_SOURCE)).get()
    ).toBeDefined()
    expect(
      testDb.db.select().from(projects).where(eq(projects.id, LATE_PROJECT)).get()
    ).toBeDefined()
  })
})
