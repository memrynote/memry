import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { RecordChangesResponse, VectorClock } from '@memry/contracts/sync-api'
import { projects } from '@memry/db-schema/schema/projects'
import { tasks } from '@memry/db-schema/schema/tasks'
import { createMockDeps, setupTestDb, type TestDatabaseResult } from '@tests/utils/engine-mocks'
import { SyncEngine } from '../engine'
import { ItemApplier } from '../apply-item'
import { SYNC_STATE_KEYS } from './sync-context'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/memry-run-applied-cursors-test' }
}))

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

/**
 * #2429: one pull run applies task X on page 1; a newer version of X commits
 * before page 2 is read, and page 2 lists it. The run must apply that version,
 * not skip X because it already applied an older one.
 */

const PROJECT = 'proj-1'
const DELETED_AT = 1_700_000_000

interface Version {
  title: string
  clock: VectorClock
  deletedAt?: number
}

/** A /sync/pull item whose `encryptedData` names the version the mocked decrypt returns. */
const pullItem = (id: string, version: Version) => ({
  id,
  type: 'task',
  operation: version.deletedAt ? 'delete' : 'update',
  cryptoVersion: 1,
  blob: {
    encryptedKey: 'ek',
    keyNonce: 'kn',
    encryptedData: JSON.stringify(version),
    dataNonce: 'dn'
  },
  signature: 'sig',
  signerDeviceId: 'device-2',
  clock: version.clock,
  ...(version.deletedAt ? { deletedAt: version.deletedAt } : {})
})

const ref = (id: string, serverCursor?: number) => ({
  id,
  type: 'task' as const,
  version: 1,
  modifiedAt: 1000,
  size: 10,
  ...(serverCursor === undefined ? {} : { serverCursor })
})

interface ServedPage {
  changes: RecordChangesResponse
  pull: Record<string, ReturnType<typeof pullItem>>
}

/**
 * Serves the pages in order. Each /sync/pull answers from the next page with a
 * non-empty `pull` map; a fully inline page issues none.
 */
const servePages = async (pages: ServedPage[]): Promise<void> => {
  const http = await import('../http-client')
  const get = vi.spyOn(http, 'getFromServer')
  for (const page of pages) get.mockResolvedValueOnce(page.changes)
  const pulls = pages.filter((page) => Object.keys(page.pull).length > 0)
  vi.spyOn(http, 'postToServer').mockImplementation(async (_path, body) => {
    const page = pulls.shift()!
    const itemIds = (body as { itemIds: string[] }).itemIds
    return { items: itemIds.flatMap((id) => (page.pull[id] ? [page.pull[id]] : [])) }
  })
  vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockImplementation((input) => {
    const version = JSON.parse(input.encryptedData) as Version
    return {
      content: new TextEncoder().encode(
        JSON.stringify({ title: version.title, projectId: PROJECT, clock: version.clock })
      ),
      verified: true
    }
  })
}

const seedProject = (db: TestDatabaseResult): void => {
  db.db.insert(projects).values({ id: PROJECT, name: 'Project', color: '#000', position: 0 }).run()
}

const taskRow = (db: TestDatabaseResult, id: string) =>
  db.db.select().from(tasks).where(eq(tasks.id, id)).get()

const V1: Version = { title: 'v1', clock: { 'device-2': 1 } }
const V2: Version = { title: 'v2', clock: { 'device-2': 2 } }
const DELETE: Version = { title: 'v1', clock: { 'device-2': 2 }, deletedAt: DELETED_AT }

const page = (
  items: ReturnType<typeof ref>[],
  nextCursor: number,
  extra: Partial<RecordChangesResponse> = {}
): RecordChangesResponse => ({
  items,
  deleted: [],
  hasMore: false,
  nextCursor,
  ...extra
})

const syncedEngine = (db: TestDatabaseResult): SyncEngine => {
  const engine = new SyncEngine(createMockDeps(db))
  engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '10')
  return engine
}

describe('a pull run re-applies a newer version of an item it applied earlier (#2429)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // #2429
  it('applies a delete of X that committed between page 1 and page 2', async () => {
    const db = getDb()
    seedProject(db)
    const engine = syncedEngine(db)
    await servePages([
      {
        changes: page([ref('task-x', 50)], 60, { hasMore: true }),
        pull: { 'task-x': pullItem('task-x', V1) }
      },
      {
        changes: page([], 100, { deleted: ['task-x'] }),
        pull: { 'task-x': pullItem('task-x', DELETE) }
      }
    ])

    await expect(engine.pull()).resolves.toBe(true)

    expect(taskRow(db, 'task-x')).toBeUndefined()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('100')
  })

  // #2429
  it('applies an update of X that committed between page 1 and page 2', async () => {
    const db = getDb()
    seedProject(db)
    const engine = syncedEngine(db)
    await servePages([
      {
        changes: page([ref('task-x', 50)], 60, { hasMore: true }),
        pull: { 'task-x': pullItem('task-x', V1) }
      },
      {
        changes: page([ref('task-x', 100)], 100),
        pull: { 'task-x': pullItem('task-x', V2) }
      }
    ])

    await expect(engine.pull()).resolves.toBe(true)

    expect(taskRow(db, 'task-x')?.title).toBe('v2')
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('100')
  })

  // #2429: a server without ref serverCursor (pre-#2280) falls back to the page's nextCursor.
  it('applies a later-page delete on a server that sends no ref serverCursor', async () => {
    const db = getDb()
    seedProject(db)
    const engine = syncedEngine(db)
    await servePages([
      {
        changes: page([ref('task-x')], 60, { hasMore: true }),
        pull: { 'task-x': pullItem('task-x', V1) }
      },
      {
        changes: page([], 100, { deleted: ['task-x'] }),
        pull: { 'task-x': pullItem('task-x', DELETE) }
      }
    ])

    await expect(engine.pull()).resolves.toBe(true)

    expect(taskRow(db, 'task-x')).toBeUndefined()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('100')
  })

  // #2429: page 1 carried X inline (#2292); page 2 pulls its delete.
  it('applies a later-page delete of X that page 1 carried inline', async () => {
    const db = getDb()
    seedProject(db)
    const engine = syncedEngine(db)
    await servePages([
      {
        changes: page([ref('task-x', 50)], 60, {
          hasMore: true,
          inline: [pullItem('task-x', V1)]
        }),
        pull: {}
      },
      {
        changes: page([], 100, { deleted: ['task-x'] }),
        pull: { 'task-x': pullItem('task-x', DELETE) }
      }
    ])

    await expect(engine.pull()).resolves.toBe(true)

    expect(taskRow(db, 'task-x')).toBeUndefined()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('100')
  })

  // #2429: the same version listed again at the same cursor is still skipped before apply.
  it('skips X on page 2 when it is listed at the cursor already applied', async () => {
    const db = getDb()
    seedProject(db)
    const engine = syncedEngine(db)
    await servePages([
      {
        changes: page([ref('task-x', 50)], 60, { hasMore: true }),
        pull: { 'task-x': pullItem('task-x', V1) }
      },
      {
        changes: page([ref('task-x', 50)], 100),
        pull: { 'task-x': pullItem('task-x', V1) }
      }
    ])
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')

    await expect(engine.pull()).resolves.toBe(true)

    expect(applySpy).toHaveBeenCalledTimes(1)
    expect(taskRow(db, 'task-x')?.title).toBe('v1')
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('100')
  })
})
