import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { reminders } from '@memry/db-schema/schema/reminders'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { asSyncDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { ApplyContext } from '@memry/sync-client/item-handlers/types'
import { ReminderChannels } from '@memry/contracts/ipc-channels'
import type * as NotesModule from '@main/database/queries/notes'

// Notes and journals share `note_metadata`, keyed by id alone, while the server
// keeps one row per (type, id). Staging holds `legacyagent0609` as a journal
// tombstone and a live note, and every pull returned both.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-journal-cross-type-'))
const vaultPath = path.join(root, 'vault')
const userDataDir = path.join(root, 'user-data')
fs.mkdirSync(userDataDir, { recursive: true })

const { ingested } = vi.hoisted(() => ({ ingested: new Map<string, string>() }))
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
vi.mock('../crdt-writeback', () => ({}))
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
  reindexNoteNames: vi.fn(() => []),
  reresolveLinks: vi.fn(() => ({ sourceIds: [], targetIds: [] })),
  pathLinkKeys: vi.fn(() => []),
  noteCacheExists: vi.fn(() => true),
  getNoteCacheByPath: vi.fn(() => undefined),
  updateNoteCache: vi.fn(),
  setNoteTags: vi.fn(),
  setNoteProperties: vi.fn(),
  // The note's file holds the bytes this device ingested (#5797).
  getNoteCacheById: vi.fn((_db: unknown, id: string) =>
    ingested.has(id) ? { contentHash: ingested.get(id) } : undefined
  )
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

import { attachmentEvents } from '@memry/sync-client/attachment-events'
import type { AttachmentDownloadNeededEvent } from '@memry/sync-client/attachment-events'
import { _resetBulkApplyForTests } from '../bulk-apply'
import { journalHandler } from './journal-handler'
import { noteHandler } from './note-handler'
import { generateContentHash } from '../../vault/frontmatter'
import { generateJournalId } from '@memry/contracts/journal-api'

const ID = 'legacyagent0609'
const DATE = '2026-06-09'
const DAY_ID = generateJournalId(DATE)

describe('note and journal rows that share an id', () => {
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

  const rowOf = (id = ID) =>
    testDb.db
      .select({
        path: noteMetadata.path,
        title: noteMetadata.title,
        journalDate: noteMetadata.journalDate,
        clock: noteMetadata.clock
      })
      .from(noteMetadata)
      .where(eq(noteMetadata.id, id))
      .get()

  const vaultFiles = () =>
    fs
      .readdirSync(vaultPath, { recursive: true, encoding: 'utf-8' })
      .filter((f) => f.endsWith('.md'))
      .toSorted()

  const seedLiveNote = (id = ID) => {
    testDb.db
      .insert(noteMetadata)
      .values({
        id,
        path: 'Untitled.md',
        title: 'Untitled',
        fileType: 'markdown',
        clock: { 'device-9821': 1 },
        createdAt: '2026-09-26T15:09:05.000Z',
        modifiedAt: '2026-09-26T15:09:05.000Z'
      })
      .run()
    fs.writeFileSync(path.join(vaultPath, 'Untitled.md'), 'legacy body\n', 'utf-8')
  }

  const seedLiveJournal = (id = ID) => {
    testDb.db
      .insert(noteMetadata)
      .values({
        id,
        path: `journal/${DATE}.md`,
        title: DATE,
        fileType: 'markdown',
        journalDate: DATE,
        clock: { 'device-c239': 1 },
        createdAt: '2026-06-09T08:00:00.000Z',
        modifiedAt: '2026-06-09T08:00:00.000Z'
      })
      .run()
    fs.writeFileSync(path.join(vaultPath, 'journal', `${DATE}.md`), 'journal body\n', 'utf-8')
  }

  it('a journal tombstone leaves the live note with the same id alone', () => {
    seedLiveNote()

    const deleted = journalHandler.applyDelete(ctx, ID, { 'device-c239': 1, 'device-5057': 1 })
    const upserted = noteHandler.applyUpsert(
      ctx,
      ID,
      { title: 'Untitled', content: 'legacy body\n' },
      { 'device-9821': 1 }
    )

    expect({ row: rowOf(), files: vaultFiles() }).toEqual({
      row: {
        path: 'Untitled.md',
        title: 'Untitled',
        journalDate: null,
        clock: { 'device-9821': 1 }
      },
      files: ['Untitled.md']
    })
    expect({ deleted, upserted }).toEqual({ deleted: 'skipped', upserted: 'applied' })
    expect(purge).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping remote item whose id belongs to a local item of another type',
      { itemId: ID, incomingType: 'journal', localType: 'note' }
    )
  })

  it('warns once per id and type across repeated pulls', () => {
    seedLiveNote('legacyagent0610')

    journalHandler.applyDelete(ctx, 'legacyagent0610', { 'device-c239': 1 })
    journalHandler.applyDelete(ctx, 'legacyagent0610', { 'device-c239': 1 })

    expect(logger.warn.mock.calls).toEqual([
      [
        'Skipping remote item whose id belongs to a local item of another type',
        { itemId: 'legacyagent0610', incomingType: 'journal', localType: 'note' }
      ]
    ])
  })

  it('a note tombstone leaves the live journal with the same id alone', () => {
    seedLiveJournal()

    const result = noteHandler.applyDelete(ctx, ID, { 'device-9821': 2 })

    expect({ row: rowOf(), files: vaultFiles() }).toEqual({
      row: {
        path: `journal/${DATE}.md`,
        title: DATE,
        journalDate: DATE,
        clock: { 'device-c239': 1 }
      },
      files: [`journal/${DATE}.md`]
    })
    expect(result).toBe('skipped')
    expect(purge).not.toHaveBeenCalled()
  })

  it('a journal upsert does not turn a live note into a journal', () => {
    seedLiveNote()

    const result = journalHandler.applyUpsert(
      ctx,
      ID,
      { date: DATE, content: 'journal body', tags: [] },
      { 'device-c239': 2 }
    )

    expect({ row: rowOf(), files: vaultFiles() }).toEqual({
      row: {
        path: 'Untitled.md',
        title: 'Untitled',
        journalDate: null,
        clock: { 'device-9821': 1 }
      },
      files: ['Untitled.md']
    })
    expect(result).toBe('skipped')
  })

  it('a note upsert does not rename or retitle a live journal', () => {
    seedLiveJournal()

    const result = noteHandler.applyUpsert(
      ctx,
      ID,
      { title: 'Hijacked' },
      { 'device-c239': 1, 'device-9821': 1 }
    )

    expect({ row: rowOf(), files: vaultFiles() }).toEqual({
      row: {
        path: `journal/${DATE}.md`,
        title: DATE,
        journalDate: DATE,
        clock: { 'device-c239': 1 }
      },
      files: [`journal/${DATE}.md`]
    })
    expect(result).toBe('skipped')
  })

  // A journal day's pictures ride a `note` record under the day's id: the
  // journal payload has no `attachmentReferences` (#5731).
  // The legacy id owes a day merge; the canonical `j<date>` is the day itself.
  // Neither is pushed back as a note (#5730).
  it.each([
    ['a legacy', ID],
    ['the canonical', DAY_ID]
  ])("a note upsert on %s live journal merges the day's pictures and asks for them", (_, id) => {
    seedLiveJournal(id)
    testDb.db
      .update(noteMetadata)
      .set({ attachmentReferences: ['att-local'] })
      .where(eq(noteMetadata.id, id))
      .run()
    const asked: Array<
      Pick<AttachmentDownloadNeededEvent, 'noteId' | 'attachmentId' | 'diskPath'>
    > = []
    const listener = (event: AttachmentDownloadNeededEvent) =>
      asked.push({
        noteId: event.noteId,
        attachmentId: event.attachmentId,
        diskPath: event.diskPath
      })
    attachmentEvents.onDownloadNeeded(listener)
    try {
      const result = noteHandler.applyUpsert(
        ctx,
        id,
        { title: 'Hijacked', attachmentReferences: ['att-local', 'att-peer'] },
        { 'device-c239': 1, 'device-9821': 1 }
      )

      const stored = testDb.db
        .select({ refs: noteMetadata.attachmentReferences })
        .from(noteMetadata)
        .where(eq(noteMetadata.id, id))
        .get()
      expect({
        result,
        row: rowOf(id),
        refs: stored?.refs,
        files: vaultFiles(),
        queued: testDb.db.select().from(syncQueue).all().length
      }).toEqual({
        result: 'skipped',
        row: {
          path: `journal/${DATE}.md`,
          title: DATE,
          journalDate: DATE,
          clock: { 'device-c239': 1 }
        },
        refs: ['att-local', 'att-peer'],
        files: [`journal/${DATE}.md`],
        queued: 0
      })
      const dir = path.join(vaultPath, 'attachments', id)
      expect(asked).toEqual([
        { noteId: id, attachmentId: 'att-local', diskPath: dir },
        { noteId: id, attachmentId: 'att-peer', diskPath: dir }
      ])
    } finally {
      attachmentEvents.offDownloadNeeded(listener)
    }
  })
})

describe('remote note delete and its note_date reminders', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    vi.clearAllMocks()
    _resetBulkApplyForTests()
    fs.rmSync(vaultPath, { recursive: true, force: true })
    fs.mkdirSync(vaultPath, { recursive: true })
    testDb = createTestDataDb()
    currentDb.value = testDb.db
    ctx = { db: asSyncDb(testDb.db), emit: vi.fn() }
  })

  afterEach(() => {
    _resetBulkApplyForTests()
    testDb.close()
  })

  const reminder = (id: string, targetType: string, targetId: string) => ({
    id,
    targetType,
    targetId,
    remindAt: '2026-10-16T09:00:00.000Z',
    status: 'pending',
    clock: { 'device-ea91': 1 },
    createdAt: '2026-09-26T14:21:38.000Z',
    modifiedAt: '2026-09-26T14:21:38.000Z'
  })

  it('clears the deleted note_date reminders and enqueues nothing', () => {
    testDb.db
      .insert(noteMetadata)
      .values({
        id: '7225bkun6riy',
        path: 'Launch.md',
        title: 'Launch',
        fileType: 'markdown',
        clock: { 'device-64ae': 1 },
        createdAt: '2026-09-23T10:00:00.000Z',
        modifiedAt: '2026-09-23T10:00:00.000Z'
      })
      .run()
    fs.writeFileSync(path.join(vaultPath, 'Launch.md'), 'launch body\n', 'utf-8')
    ingested.set('7225bkun6riy', generateContentHash('launch body\n'))
    testDb.db
      .insert(reminders)
      .values([
        reminder('rem_nd_7225bkun6riy_parity-d2', 'note_date', '7225bkun6riy'),
        reminder('rem_nd_othernote_a1', 'note_date', 'othernote')
      ])
      .run()

    expect(noteHandler.applyDelete(ctx, '7225bkun6riy', { 'device-64ae': 2 })).toBe('applied')

    expect(
      testDb.db
        .select({ id: reminders.id })
        .from(reminders)
        .all()
        .map((r) => r.id)
    ).toEqual(['rem_nd_othernote_a1'])
    expect(testDb.db.select().from(syncQueue).all()).toEqual([])
    expect(ctx.emit).toHaveBeenCalledWith(ReminderChannels.events.DELETED, {
      id: 'rem_nd_7225bkun6riy_parity-d2'
    })
  })
})
