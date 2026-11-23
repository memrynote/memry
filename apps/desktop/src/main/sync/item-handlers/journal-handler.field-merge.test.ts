import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { updateNoteMetadata } from '@memry/storage-data'
import { asSyncDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { JournalSyncPayload } from '@memry/contracts/sync-payloads'
import type { ApplyContext } from '@memry/sync-client/item-handlers/types'
import type * as NotesModule from '@main/database/queries/notes'

// #5508: concurrent tag and property edits from different devices merge per
// unit (chapter 06 §6.12) instead of the remote payload replacing the day.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-field-merge-'))
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
  getNoteCacheById: vi.fn(() => undefined),
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
import { buildJournalEntryWrite } from '../../vault/journal'
import { journalHandler } from './journal-handler'
import { readJournalFieldsBase } from '../journal-fields'

const DATE = '2026-11-23'
const DAY = `j${DATE}`

describe('concurrent journal tag and property edits (#5508)', () => {
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

  const apply = (payload: JournalSyncPayload) =>
    journalHandler.applyUpsert(ctx, DAY, payload, payload.clock ?? {})

  /** A local edit: the day file rewritten and the row clock advanced, as journal writes do. */
  const editLocally = (
    tags: string[],
    properties: Record<string, unknown>,
    clock: Record<string, number>
  ) => {
    const write = buildJournalEntryWrite(DATE, null, tags, properties)
    fs.writeFileSync(write.absolutePath, write.fileContent)
    updateNoteMetadata(ctx.db, DAY, { clock })
  }

  const pushed = (): JournalSyncPayload =>
    JSON.parse(journalHandler.buildPushPayload(ctx.db, DAY, 'dev-a', 'update') ?? 'null')

  // Every device starts from the day as one legacy payload (no unit clocks).
  const base: JournalSyncPayload = {
    date: DATE,
    content: 'body\n',
    tags: ['lm-jtag'],
    properties: { mood: 'good' },
    clock: { X: 1 }
  }

  it('keeps a local tag add and a concurrent remote property set', () => {
    apply(base)
    editLocally(['lm-jtag', 't-a'], { mood: 'good' }, { X: 1, A: 1 })

    const result = apply({
      date: DATE,
      content: null,
      tags: ['lm-jtag'],
      properties: { mood: 'good', p3c: 'c-val' },
      clock: { X: 1, C: 1 },
      fieldClocks: {
        'tags.lm-jtag': { X: 1 },
        'properties.mood': { X: 1 },
        'properties.p3c': { X: 1, C: 1 }
      },
      fieldClocksAt: { X: 1, C: 1 }
    })

    expect(result).toBe('conflict')
    const payload = pushed()
    expect(payload.tags).toEqual(['lm-jtag', 't-a'])
    expect(payload.properties).toEqual({ mood: 'good', p3c: 'c-val' })
    expect(payload.clock).toEqual({ X: 1, A: 1, C: 1 })
    expect(payload.fieldClocksAt).toEqual(payload.clock)
    expect(payload.fieldClocks?.['tags.t-a']).toEqual({ X: 1, A: 1 })
    // The body is the CRDT's: the merge leaves the file body alone.
    expect(fs.readFileSync(path.join(vaultPath, 'journal', `${DATE}.md`), 'utf-8')).toContain(
      'body'
    )
  })

  it('does not resurrect a local removal from a peer that edited something else', () => {
    apply(base)
    editLocally([], { mood: 'good' }, { X: 1, I: 1 })

    apply({
      date: DATE,
      content: null,
      tags: ['lm-jtag'],
      properties: { mood: 'tired' },
      clock: { X: 1, B: 2 },
      fieldClocks: { 'tags.lm-jtag': { X: 1 }, 'properties.mood': { X: 1, B: 2 } },
      fieldClocksAt: { X: 1, B: 2 }
    })

    const payload = pushed()
    expect(payload.tags).toEqual([])
    expect(payload.properties).toEqual({ mood: 'tired' })
    expect(payload.fieldClocks?.['tags.lm-jtag']).toEqual({ X: 1, I: 1 })
  })

  it('reads an older build’s payload whole at its clock', () => {
    apply(base)
    editLocally(['lm-jtag'], { mood: 'good', mine: 1 }, { X: 1, A: 1 })

    // An older build kept the stamp but ticked the clock and removed `mood`.
    apply({
      date: DATE,
      content: null,
      tags: ['lm-jtag'],
      properties: {},
      clock: { X: 1, O: 3 },
      fieldClocks: { 'tags.lm-jtag': { X: 1 }, 'properties.mood': { X: 1 } },
      fieldClocksAt: { X: 1 }
    })

    expect(pushed().properties).toEqual({ mine: 1 })
  })

  // REVIEW-5529 finding 1: an older build removed a tag and a property while
  // this device made an edit that touched neither.
  it('keeps an older build’s removal of a tag and a property', () => {
    apply({ ...base, tags: ['T'], properties: { p: 1 } })
    editLocally(['T'], { p: 1 }, { X: 1, N: 1 })
    pushed()

    apply({ date: DATE, content: null, tags: [], properties: {}, clock: { X: 1, O: 1 } })

    const payload = pushed()
    expect(payload.tags).toEqual([])
    expect(payload.properties).toEqual({})
  })

  // REVIEW-5529 finding 2: re-pulling the legacy row this device already holds
  // is the identical equal-clock skip of §6.5.2 P4, and writes no base.
  it('skips an equal-clock legacy row identical to the local day', () => {
    apply(base)
    const before = readJournalFieldsBase(ctx.db, DAY)

    expect(apply(base)).toBe('skipped')
    expect(readJournalFieldsBase(ctx.db, DAY)).toEqual(before)
  })
})
