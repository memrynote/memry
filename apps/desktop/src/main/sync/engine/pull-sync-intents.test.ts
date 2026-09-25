import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { syncIntents } from '@memry/db-schema/schema/sync-intents'
import { initTaskSyncService, resetTaskSyncService } from '@memry/sync-client/task-sync'
import { asClientDb } from '@tests/utils/test-db'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'
import { SyncEngine } from '../engine'
import { SYNC_STATE_KEYS } from './sync-context'
import type { SchemaInvalidLedger } from './schema-invalid-ledger'
import { TASK_SYNCABLE_FIELDS } from '@memry/sync-client/field-merge'

let activeDb: unknown = null

vi.mock('../../database', () => ({
  getDatabase: () => activeDb
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/memry-pull-sync-intents-test' }
}))

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

const DEVICE_ID = 'device-A'

function remoteTask(title: string) {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    title,
    description: null,
    priority: 0,
    position: 0,
    statusId: null,
    parentId: null,
    dueDate: null,
    dueTime: null,
    startDate: null,
    repeatConfig: null,
    repeatFrom: null,
    sourceNoteId: null,
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-03T00:00:00.000Z'
  }
}

/** One page carrying a remote edit of task-1 that ties its pre-edit title clock. */
async function mockRemoteTaskPage(): Promise<void> {
  const http = await import('../http-client')
  const clock = { [DEVICE_ID]: 2, 'device-B': 1 }
  vi.spyOn(http, 'getFromServer').mockResolvedValue({
    items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1, size: 10 }],
    deleted: [],
    hasMore: false,
    nextCursor: 1
  })
  vi.spyOn(http, 'postToServer').mockResolvedValue({
    items: [
      {
        id: 'task-1',
        type: 'task',
        operation: 'update',
        cryptoVersion: 1,
        blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
        signature: 'sig',
        signerDeviceId: 'device-B',
        clock
      }
    ]
  })
  vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockImplementation(() => ({
    content: new TextEncoder().encode(JSON.stringify({ ...remoteTask('Remote'), clock })),
    verified: true
  }))
}

describe('pull and pending sync intents (#2301 review A-2/B-2)', () => {
  const { getDb } = setupTestDb()

  beforeEach(() => {
    const db = asClientDb(getDb().db)
    activeDb = db
    db.insert(projects).values({ id: 'proj-1', name: 'Project', color: '#000' }).run()
    db.insert(tasks)
      .values({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Local',
        priority: 0,
        position: 0,
        clock: { [DEVICE_ID]: 3 }
      })
      .run()
    db.insert(syncIntents)
      .values({
        type: 'task',
        itemId: 'task-1',
        op: 'update',
        args: '[["title"]]',
        createdAt: new Date()
      })
      .run()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetTaskSyncService()
    activeDb = null
  })

  function localTask() {
    return asClientDb(getDb().db).select().from(tasks).where(eq(tasks.id, 'task-1')).get()
  }

  it('drains pending intents at the start of a pull, before any page applies', async () => {
    const deps = createMockDeps(getDb())
    initTaskSyncService({
      queue: deps.queue,
      db: asClientDb(getDb().db),
      getDeviceId: () => DEVICE_ID
    })
    const engine = new SyncEngine(deps)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await mockRemoteTaskPage()

    await engine.pull()

    expect(asClientDb(getDb().db).select().from(syncIntents).all()).toEqual([])
    // Drained first, the local title clock {A:4} outweighs the remote
    // {A:2,B:1}; against the pre-edit {A:3} the tie went to the remote.
    expect(localTask()).toMatchObject({ title: 'Local' })
    expect(localTask()?.clock).toMatchObject({ [DEVICE_ID]: 4, 'device-B': 1 })
  })

  // #2301 review r2 A-L2/B-2: an item whose intent cannot drain through a
  // whole pull is not dropped. It waits in the ledger, is re-fetched right
  // after the next pull-start drain, and merges field by field: A's title
  // (the local edit) and B's priority (the remote one) both survive.
  it('defers the remote item to the ledger while the intent cannot drain, then merges both edits', async () => {
    const deps = createMockDeps(getDb())
    initTaskSyncService({
      queue: deps.queue,
      db: asClientDb(getDb().db),
      getDeviceId: () => DEVICE_ID
    })
    const fault = vi.spyOn(deps.queue, 'enqueue').mockImplementation(() => {
      throw new Error('queue broke')
    })
    const engine = new SyncEngine(deps)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    const http = await import('../http-client')
    const clock = { [DEVICE_ID]: 3, 'device-B': 1 }
    const fieldClocks = Object.fromEntries(
      TASK_SYNCABLE_FIELDS.map((field) => [field, { [DEVICE_ID]: 3 }])
    )
    fieldClocks.priority = clock
    vi.spyOn(http, 'getFromServer')
      .mockResolvedValueOnce({
        items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1, size: 10 }],
        deleted: [],
        hasMore: false,
        nextCursor: 1
      })
      .mockResolvedValue({ items: [], deleted: [], hasMore: false, nextCursor: 1 })
    vi.spyOn(http, 'postToServer').mockResolvedValue({
      items: [
        {
          id: 'task-1',
          type: 'task',
          operation: 'update',
          cryptoVersion: 1,
          blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
          signature: 'sig',
          signerDeviceId: 'device-B',
          clock
        }
      ]
    })
    vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockImplementation(() => ({
      content: new TextEncoder().encode(
        JSON.stringify({ ...remoteTask('Before'), priority: 2, clock, fieldClocks })
      ),
      verified: true
    }))
    const ledger = (
      engine as unknown as { pullCoordinator: { schemaInvalid: SchemaInvalidLedger } }
    ).pullCoordinator.schemaInvalid

    await engine.pull()

    expect(localTask()).toMatchObject({ title: 'Local', priority: 0, clock: { [DEVICE_ID]: 3 } })
    // Pull-start, page and deferred-retry drains retry without spending the budget.
    expect(asClientDb(getDb().db).select().from(syncIntents).all()).toMatchObject([
      { itemId: 'task-1', attempts: 0, lastError: 'queue broke' }
    ])
    expect(ledger.has('task', 'task-1')).toBe(true)

    fault.mockRestore()
    await engine.pull()

    expect(asClientDb(getDb().db).select().from(syncIntents).all()).toEqual([])
    expect(localTask()).toMatchObject({ title: 'Local', priority: 2 })
    expect(localTask()?.clock).toMatchObject({ [DEVICE_ID]: 4, 'device-B': 1 })
    expect(ledger.has('task', 'task-1')).toBe(false)
  })
})
