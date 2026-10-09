import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { asSyncDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { ApplyContext } from '@memry/sync-client/item-handlers/types'

// Staging holds `vcpzueguep8y`, a journal for a day this vault already holds as
// `j<date>`. Applying it hit `UNIQUE constraint failed: note_metadata.path` on
// every pull (#2939).

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-journal-cross-type-'))
const vaultPath = path.join(root, 'vault')
const userDataDir = path.join(root, 'user-data')
fs.mkdirSync(userDataDir, { recursive: true })

const { currentDb, purge, logger } = vi.hoisted(() => ({
  currentDb: { value: null as unknown },
  purge: vi.fn(() => Promise.resolve()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => userDataDir) } }))
vi.mock('../../lib/logger', () => ({ createLogger: () => logger }))
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
  ...(await importOriginal<typeof import('@main/database/queries/notes')>()),
  noteCacheExists: vi.fn(() => true),
  getNoteCacheByPath: vi.fn(() => undefined),
  updateNoteCache: vi.fn(),
  setNoteTags: vi.fn(),
  setNoteProperties: vi.fn()
}))
vi.mock('../../notes/runtime-effects', () => ({
  cleanupProjectLinksForDeletedNote: vi.fn(() => Promise.resolve())
}))
vi.mock('../../vault/notes', () => ({
  getVaultRoot: () => vaultPath,
  toRelativePath: (p: string) => path.relative(vaultPath, p),
  toAbsolutePath: (p: string) => path.join(vaultPath, p)
}))
vi.mock('../../vault/index', () => ({
  getStatus: () => ({ path: vaultPath, isOpen: true }),
  getConfig: () => ({ journalFolder: 'journal', defaultNoteFolder: 'notes' })
}))

import { _resetBulkApplyForTests } from '../bulk-apply'
import { journalHandler } from './journal-handler'
import { listOwedJournalDayMerges } from '../journal-day-merge'
import { listDeclinedRefs } from '@memry/sync-client/declined-refs'

const DATE = '2026-06-09'

const DAY = `j${DATE}`
const FOREIGN = 'vcpzueguep8y'

describe("a journal id that is not its day's j<date>", () => {
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

  const rows = () =>
    testDb.db.select({ id: noteMetadata.id, path: noteMetadata.path }).from(noteMetadata).all()
  const dayFile = () => fs.readFileSync(path.join(vaultPath, 'journal', `${DATE}.md`), 'utf-8')

  it('is owed to the day instead of colliding with it', () => {
    journalHandler.applyUpsert(ctx, DAY, { date: DATE, content: 'mine\n' }, { a: 1 })

    const result = journalHandler.applyUpsert(
      ctx,
      FOREIGN,
      { date: DATE, content: 'theirs\n' },
      { b: 1 }
    )

    expect(result).toBe('skipped')
    expect(rows()).toEqual([{ id: DAY, path: `journal/${DATE}.md` }])
    expect(dayFile()).toContain('mine')
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([
      { foreignId: FOREIGN, date: DATE, clock: { b: 1 } }
    ])
    expect(listDeclinedRefs(ctx.db)).toEqual([{ type: 'journal', id: FOREIGN }])
  })

  it('takes the day from a foreign local row when j<date> arrives, keeping its file text', () => {
    fs.writeFileSync(path.join(vaultPath, 'journal', `${DATE}.md`), 'minted here\n')
    testDb.db
      .insert(noteMetadata)
      .values({
        id: FOREIGN,
        path: `journal/${DATE}.md`,
        title: DATE,
        fileType: 'markdown',
        journalDate: DATE,
        clock: { minter: 2 },
        createdAt: '2026-06-09T08:00:00.000Z',
        modifiedAt: '2026-06-09T08:00:00.000Z'
      })
      .run()

    const result = journalHandler.applyUpsert(ctx, DAY, { date: DATE, content: 'mine\n' }, { a: 1 })

    expect(result).toBe('applied')
    expect(rows()).toEqual([{ id: DAY, path: `journal/${DATE}.md` }])
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([
      { foreignId: FOREIGN, date: DATE, clock: { minter: 2 }, fallbackMarkdown: 'minted here' }
    ])
  })
})
