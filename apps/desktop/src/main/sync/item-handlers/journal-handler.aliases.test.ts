import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { asSyncDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { ApplyContext } from '@memry/sync-client/item-handlers/types'
import type * as NotesModule from '@main/database/queries/notes'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-aliases-'))
const vaultPath = path.join(root, 'vault')
const userDataDir = path.join(root, 'user-data')
fs.mkdirSync(userDataDir, { recursive: true })

const { currentDb, purge, logger } = vi.hoisted(() => {
  const slot: { value: unknown } = { value: null }
  return {
    currentDb: slot,
    purge: vi.fn(() => Promise.resolve()),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  }
})

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => userDataDir) } }))
vi.mock('../../lib/logger', () => ({ createLogger: () => logger }))
vi.mock('../crdt-network-update', async () => await import('../crdt-writeback'))
vi.mock('../crdt-writeback-port', async () => {
  const writeback = await import('../crdt-writeback')
  return { crdtWriteback: () => writeback }
})
vi.mock('../crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))
vi.mock('../crdt-provider', () => ({ getCrdtProvider: () => ({ purge }) }))
vi.mock('../../projections', () => ({
  flushProjectionEvents: vi.fn(),
  publishProjectionEvent: vi.fn()
}))
vi.mock('../../database/client', () => ({
  getIndexDatabase: vi.fn(() => ({})),
  isIndexDatabaseInitialized: vi.fn(() => false),
  getRawIndexDatabase: vi.fn(() => null)
}))
vi.mock('../../database', () => ({ getDatabase: () => currentDb.value }))
vi.mock('@main/database/queries/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof NotesModule>()),
  noteCacheExists: vi.fn(() => true),
  getNoteCacheByPath: vi.fn(() => undefined),
  deleteNoteCache: vi.fn(),
  updateNoteCache: vi.fn(),
  setNoteTags: vi.fn(),
  setNoteProperties: vi.fn()
}))
vi.mock('../../notes/runtime-effects', () => ({
  cleanupProjectLinksForDeletedNote: vi.fn(() => Promise.resolve())
}))
vi.mock('../../vault/note-snapshots', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes-versions', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes-crud', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes-io', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes', () => ({
  getVaultRoot: () => vaultPath,
  toRelativePath: (p: string) => path.relative(vaultPath, p),
  toAbsolutePath: (p: string) => path.join(vaultPath, p)
}))
vi.mock('../../vault/status', async () => await import('../../vault/index'))
vi.mock('../../vault/index', () => ({
  getStatus: () => ({ path: vaultPath, isOpen: true }),
  getConfig: () => ({ journalFolder: 'journal', defaultNoteFolder: 'notes' })
}))

import { _resetBulkApplyForTests } from '../bulk-apply'
import { journalHandler } from './journal-handler'

const DATE = '2026-06-09'
const DAY = `j${DATE}`

describe('journal aliases over sync', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    vi.clearAllMocks()
    _resetBulkApplyForTests()
    fs.rmSync(vaultPath, { recursive: true, force: true })
    fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })
    testDb = createTestDataDb()
    currentDb.value = testDb.db
    ctx = { db: asSyncDb(testDb.db), emit: vi.fn() }
  })

  afterEach(() => {
    _resetBulkApplyForTests()
    testDb.close()
  })

  const dayFile = (): string =>
    fs.readFileSync(path.join(vaultPath, 'journal', `${DATE}.md`), 'utf-8')
  const pushed = (): Record<string, unknown> =>
    JSON.parse(journalHandler.buildPushPayload(ctx.db, DAY, 'device', 'update') ?? 'null')

  it('writes pulled aliases, keeps them for an absent field, clears them for []', () => {
    journalHandler.applyUpsert(
      ctx,
      DAY,
      { date: DATE, content: 'day\n', aliases: ['Kickoff'] },
      { a: 1 }
    )
    expect(dayFile()).toContain('aliases:\n  - Kickoff\n')
    expect(pushed().aliases).toEqual(['Kickoff'])

    journalHandler.applyUpsert(ctx, DAY, { date: DATE, content: 'day two\n' }, { a: 2 })
    expect(dayFile()).toContain('aliases:\n  - Kickoff\n')
    expect(dayFile()).toContain('day two')

    journalHandler.applyUpsert(ctx, DAY, { date: DATE, aliases: [] }, { a: 3 })
    expect(dayFile()).not.toContain('aliases')
    expect(pushed().aliases).toEqual([])
  })
})
