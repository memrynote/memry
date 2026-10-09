import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { noteMetadata, tasks } from '@memry/db-schema/data-schema'
import { taskNotes } from '@memry/db-schema/schema/task-relations'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import {
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  seedInboxProject,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { ApplyContext } from '@memry/sync-client/item-handlers/types'

// The drain through its real adapters (#2939): the data and index databases,
// the vault's day files, the journal handler, `createJournalEntry` and the
// tasks domain. The CRDT provider is an in-memory stand-in with the same
// contract; its own fold is tested in crdt-provider.test.ts.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-day-merge-'))
const vaultPath = path.join(root, 'vault')
const userDataDir = path.join(root, 'user-data')
fs.mkdirSync(userDataDir, { recursive: true })

const { dbs, provider, journalSync, logger } = vi.hoisted(() => {
  const docs = new Map<string, import('yjs').Doc>()
  return {
    dbs: { data: null as unknown, index: null as unknown },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    journalSync: { enqueueRecoveredDelete: vi.fn() },
    provider: {
      docs,
      absorbed: [] as Array<{ targetId: string; foreignId: string; fallback: string | null }>,
      purgeFails: false,
      /** Ids an editor window has open. */
      openInWindow: new Set<string>(),
      /** Runs inside `hasDocState`: a write landing during the drain's await. */
      duringHasBody: null as (() => void) | null
    }
  }
})

const textOf = (id: string): string => provider.docs.get(id)?.getText('t').toString() ?? ''

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir) },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../lib/logger', () => ({ createLogger: () => logger }))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('./crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))
vi.mock('../projections', () => ({
  flushProjectionEvents: vi.fn(async () => {}),
  publishProjectionEvent: vi.fn()
}))
vi.mock('../database', () => ({
  getDatabase: () => dbs.data,
  getIndexDatabase: () => dbs.index
}))
vi.mock('../database/client', () => ({
  getDatabase: () => dbs.data,
  getIndexDatabase: () => dbs.index,
  isIndexDatabaseInitialized: () => true,
  getRawIndexDatabase: () => null
}))
vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  initializeJournalCrdt: vi.fn(async () => {})
}))
vi.mock('../tasks/publisher', () => ({ createTasksPublisher: () => ({}) }))
vi.mock('./journal-sync', () => ({ getJournalSyncService: () => journalSync }))
vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({
    hasDocState: async (id: string) => {
      const has = (provider.docs.get(id)?.getText('t').length ?? 0) > 0
      provider.duringHasBody?.()
      return has
    },
    getDoc: (id: string) => provider.docs.get(id),
    getOpenNoteIds: () => [...provider.openInWindow],
    absorbForeignDoc: async (
      targetId: string,
      foreignId: string,
      fallback: string | null
    ): Promise<boolean> => {
      provider.absorbed.push({ targetId, foreignId, fallback })
      const foreign = provider.docs.get(foreignId) ?? new Y.Doc()
      provider.docs.set(foreignId, foreign)
      if (foreign.getText('t').length === 0 && fallback?.trim()) {
        foreign.getText('t').insert(0, fallback)
      }
      if (foreign.getText('t').length === 0) return false
      const target = provider.docs.get(targetId) ?? new Y.Doc()
      provider.docs.set(targetId, target)
      Y.applyUpdate(target, Y.encodeStateAsUpdate(foreign))
      return true
    },
    purge: async (id: string) => {
      if (provider.purgeFails) throw new Error('crashed before the purge')
      provider.docs.delete(id)
    }
  })
}))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => vaultPath,
  toRelativePath: (p: string) => path.relative(vaultPath, p),
  toAbsolutePath: (p: string) => path.join(vaultPath, p)
}))
vi.mock('../vault/index', () => ({
  getStatus: () => ({ path: vaultPath, isOpen: true }),
  getConfig: () => ({ journalFolder: 'journal', defaultNoteFolder: 'notes' })
}))

import { deleteNoteMetadata } from '@memry/storage-data'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { getNoteCacheByPath } from '../database/queries/notes'
import { resolveJournalEntryId } from '../journal/create-entry'
import { recordTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import { _resetBulkApplyForTests } from './bulk-apply'
import { journalHandler } from './item-handlers/journal-handler'
import {
  listOwedJournalDayMerges,
  oweJournalDayMerge,
  runJournalDayMerges
} from './journal-day-merge'
import { listPendingDeletes } from './pending-deletes'

const DATE = '2026-06-09'
const DAY = `j${DATE}`
const FOREIGN = 'vcpzueguep8y'
const DAY_PATH = `journal/${DATE}.md`

describe('runJournalDayMerges', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let ctx: ApplyContext
  let pullBody: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>

  const dayFile = (): string => fs.readFileSync(path.join(vaultPath, DAY_PATH), 'utf-8')
  const rows = () =>
    data.db.select({ id: noteMetadata.id, path: noteMetadata.path }).from(noteMetadata).all()
  const drain = () => runJournalDayMerges(ctx.db, pullBody)
  const typed = (id: string, text: string): void => {
    const doc = new Y.Doc()
    doc.getText('t').insert(0, text)
    provider.docs.set(id, doc)
  }
  /** What a pre-fix build left: a foreign row holding the day, and its file. */
  const foreignRow = (
    clock: Record<string, number> | null,
    { body = 'minted here\n', indexed = false } = {}
  ): void => {
    fs.writeFileSync(path.join(vaultPath, DAY_PATH), body)
    const row = {
      id: FOREIGN,
      path: DAY_PATH,
      title: DATE,
      fileType: 'markdown' as const,
      createdAt: '2026-06-09T08:00:00.000Z',
      modifiedAt: '2026-06-09T08:00:00.000Z'
    }
    data.db
      .insert(noteMetadata)
      .values({ ...row, journalDate: DATE, clock })
      .run()
    if (indexed)
      index.db
        .insert(noteCache)
        .values({ ...row, date: DATE })
        .run()
  }
  const indexedAtDay = (): string | undefined => getNoteCacheByPath(index.db, DAY_PATH)?.id

  beforeEach(() => {
    vi.clearAllMocks()
    _resetBulkApplyForTests()
    provider.docs.clear()
    provider.absorbed.length = 0
    provider.purgeFails = false
    provider.openInWindow.clear()
    provider.duringHasBody = null
    fs.rmSync(vaultPath, { recursive: true, force: true })
    fs.mkdirSync(path.join(vaultPath, 'journal'), { recursive: true })
    data = createTestDataDb()
    index = createTestIndexDb()
    dbs.data = data.db
    dbs.index = index.db
    data.db
      .insert(syncDevices)
      .values({
        id: 'me',
        name: 'This Mac',
        platform: 'macos',
        appVersion: '1',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'key'
      })
      .run()
    ctx = { db: asSyncDb(data.db), emit: vi.fn() }
    pullBody = vi.fn(async () => true)
  })

  afterEach(() => {
    _resetBulkApplyForTests()
    data.close()
    index.close()
  })

  it('creates the day, relinks tasks, folds the body and tombstones the foreign id', async () => {
    const projectId = seedInboxProject(data.db)
    data.db
      .insert(tasks)
      .values({
        id: 'task-1',
        projectId,
        title: 'Follow up',
        position: 0,
        createdAt: '2026-06-09T08:00:00.000Z',
        modifiedAt: '2026-06-09T08:00:00.000Z'
      })
      .run()
    data.db
      .insert(taskNotes)
      .values([
        { taskId: 'task-1', noteId: FOREIGN },
        { taskId: 'task-1', noteId: 'note-kept' }
      ])
      .run()
    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { b: 1 })
    typed(FOREIGN, 'written elsewhere')

    await drain()

    expect(rows()).toEqual([{ id: DAY, path: DAY_PATH }])
    expect(textOf(DAY)).toBe('written elsewhere')
    const linked = data.db
      .select({ noteId: taskNotes.noteId })
      .from(taskNotes)
      .where(eq(taskNotes.taskId, 'task-1'))
      .all()
      .map((row) => row.noteId)
    expect(linked.sort()).toEqual([DAY, 'note-kept'])
    const tombstone = JSON.stringify({ clock: { b: 1, me: 1 } })
    expect(listPendingDeletes(ctx.db)).toEqual([
      { type: 'journal', itemId: FOREIGN, payload: tombstone }
    ])
    expect(journalSync.enqueueRecoveredDelete).toHaveBeenCalledWith(FOREIGN, tombstone)
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
    expect(provider.docs.has(FOREIGN)).toBe(false)
  })

  it('builds the body of a live foreign id with no Yjs history from its record text', async () => {
    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { b: 1 })

    await drain()

    expect(rows()).toEqual([{ id: DAY, path: DAY_PATH }])
    expect(provider.absorbed).toEqual([{ targetId: DAY, foreignId: FOREIGN, fallback: 'theirs\n' }])
    expect(textOf(DAY)).toBe('theirs\n')
    expect(journalSync.enqueueRecoveredDelete).toHaveBeenCalledWith(
      FOREIGN,
      JSON.stringify({ clock: { b: 1, me: 1 } })
    )
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  it('leaves a live foreign id with neither body nor text live, creating no day', async () => {
    // An update record carries `content: null`: the text may live only in an
    // old build's day file, which a tombstone would make it delete.
    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: null }, { b: 2 })

    await drain()

    expect(rows()).toEqual([])
    expect(fs.existsSync(path.join(vaultPath, DAY_PATH))).toBe(false)
    expect(listPendingDeletes(ctx.db)).toEqual([])
    expect(journalSync.enqueueRecoveredDelete).not.toHaveBeenCalled()
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  it('never writes over a day file no row holds', async () => {
    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { b: 1 })
    typed(FOREIGN, 'written elsewhere')
    fs.writeFileSync(path.join(vaultPath, DAY_PATH), 'only copy\n')

    await drain()

    expect(dayFile()).toContain('only copy')
    expect(listOwedJournalDayMerges(ctx.db)).toHaveLength(1)
  })

  it('keeps a foreign row that holds the day itself until the drain folds its file text', async () => {
    foreignRow({ minter: 2 })

    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { minter: 3 })
    // A restart here finds the day still held: no file without a row (#2985).
    expect(rows()).toEqual([{ id: FOREIGN, path: DAY_PATH }])

    await drain()

    expect(rows()).toEqual([{ id: DAY, path: DAY_PATH }])
    expect(provider.absorbed).toEqual([
      { targetId: DAY, foreignId: FOREIGN, fallback: 'minted here' }
    ])
    expect(textOf(DAY)).toBe('minted here')
    expect(listPendingDeletes(ctx.db)).toEqual([
      { type: 'journal', itemId: FOREIGN, payload: JSON.stringify({ clock: { minter: 3, me: 1 } }) }
    ])
  })

  it('folds a foreign row deleted elsewhere, with its unpushed edits, instead of purging it', async () => {
    foreignRow({ minter: 2 })
    typed(FOREIGN, 'typed here, never pushed')

    expect(journalHandler.applyDelete(ctx, FOREIGN, { minter: 2, other: 1 })).toBe('applied')
    expect(provider.docs.has(FOREIGN)).toBe(true)
    expect(dayFile()).toContain('minted here')

    await drain()

    expect(rows()).toEqual([{ id: DAY, path: DAY_PATH }])
    expect(textOf(DAY)).toBe('typed here, never pushed')
    expect(pullBody).not.toHaveBeenCalled()
    expect(journalSync.enqueueRecoveredDelete).not.toHaveBeenCalled()
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  it('forgets a blank foreign holder deleted elsewhere: its rows go and the day opens as the day id', async () => {
    foreignRow({ minter: 2 }, { body: '', indexed: true })

    expect(journalHandler.applyDelete(ctx, FOREIGN, { minter: 2, other: 1 })).toBe('applied')
    await drain()

    expect(rows()).toEqual([])
    expect(indexedAtDay()).toBeUndefined()
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
    expect(journalSync.enqueueRecoveredDelete).not.toHaveBeenCalled()
    // What opening the day to type resolves: not the forgotten id.
    expect(resolveJournalEntryId(DATE)).toBe(DAY)
  })

  it('does not forget a blank holder the user types into during the drain; the next drain merges it', async () => {
    foreignRow({ minter: 2 }, { body: '', indexed: true })
    expect(journalHandler.applyDelete(ctx, FOREIGN, { minter: 2, other: 1 })).toBe('applied')
    // Typing into the open blank day, still only in its live doc (#3008).
    provider.duringHasBody = () => typed(FOREIGN, 'typed mid-drain')

    await drain()

    expect(rows()).toEqual([{ id: FOREIGN, path: DAY_PATH }])
    expect(textOf(FOREIGN)).toBe('typed mid-drain')
    expect(listOwedJournalDayMerges(ctx.db)).toHaveLength(1)

    provider.duringHasBody = null
    await drain()

    expect(rows()).toEqual([{ id: DAY, path: DAY_PATH }])
    expect(textOf(DAY)).toBe('typed mid-drain')
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  it('does not forget a blank holder open in an editor window; it forgets once the window closes', async () => {
    foreignRow({ minter: 2 }, { body: '', indexed: true })
    expect(journalHandler.applyDelete(ctx, FOREIGN, { minter: 2, other: 1 })).toBe('applied')
    // Keystrokes the editor sent may not be applied in main yet (#3019).
    provider.openInWindow.add(FOREIGN)

    await drain()

    expect(rows()).toEqual([{ id: FOREIGN, path: DAY_PATH }])
    expect(listOwedJournalDayMerges(ctx.db)).toHaveLength(1)

    provider.openInWindow.clear()
    await drain()

    expect(rows()).toEqual([])
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  it('forgets a holder whose text was typed and deleted again before the fold', async () => {
    foreignRow({ minter: 2 }, { body: '', indexed: true })
    expect(journalHandler.applyDelete(ctx, FOREIGN, { minter: 2, other: 1 })).toBe('applied')
    typed(FOREIGN, 'typed')
    // Deleted after the drain saw a body: the fold finds nothing (#3019).
    provider.duringHasBody = () => provider.docs.delete(FOREIGN)

    await drain()

    expect(rows()).toEqual([{ id: DAY, path: DAY_PATH }])
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
    expect(journalSync.enqueueRecoveredDelete).not.toHaveBeenCalled()
  })

  it('does not forget a blank holder whose day file gains text during the drain', async () => {
    foreignRow({ minter: 2 }, { body: '', indexed: true })
    expect(journalHandler.applyDelete(ctx, FOREIGN, { minter: 2, other: 1 })).toBe('applied')
    provider.duringHasBody = () =>
      fs.writeFileSync(path.join(vaultPath, DAY_PATH), 'saved mid-drain\n')

    await drain()

    expect(rows()).toEqual([{ id: FOREIGN, path: DAY_PATH }])
    expect(listOwedJournalDayMerges(ctx.db)).toHaveLength(1)

    provider.duringHasBody = null
    await drain()

    expect(rows()).toEqual([{ id: DAY, path: DAY_PATH }])
    expect(textOf(DAY)).toBe('saved mid-drain')
  })

  it('converges from a holder removed from the data DB but not yet from the index DB', async () => {
    foreignRow({ minter: 2 }, { indexed: true })
    // A kill inside the removal: the text is owed, the data row is gone, the
    // index row still names the foreign id at the day's path.
    oweJournalDayMerge(ctx.db, {
      foreignId: FOREIGN,
      date: DATE,
      clock: { minter: 2 },
      fallbackMarkdown: 'minted here'
    })
    deleteNoteMetadata(ctx.db, FOREIGN)

    await drain()

    expect(rows()).toEqual([{ id: DAY, path: DAY_PATH }])
    expect(indexedAtDay()).toBeUndefined()
    expect(textOf(DAY)).toBe('minted here')
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  it('tombstones nothing for a foreign id with an empty clock', async () => {
    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, {})
    typed(FOREIGN, 'written elsewhere')

    await drain()

    expect(textOf(DAY)).toBe('written elsewhere')
    expect(listPendingDeletes(ctx.db)).toEqual([])
    expect(journalSync.enqueueRecoveredDelete).not.toHaveBeenCalled()
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  it('does not re-create a day deleted here; the foreign id stays live with its body', async () => {
    journalHandler.applyUpsert(ctx, DAY, { date: DATE, content: 'canonical\n' }, { c: 1 })
    // What the applier does with the day's tombstone: the row goes, its clock stays.
    deleteNoteMetadata(ctx.db, DAY)
    recordTombstoneClock(ctx.db, 'journal', DAY, { c: 2 })
    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { b: 1 })
    typed(FOREIGN, 'written elsewhere')

    await drain()

    expect(rows()).toEqual([])
    expect(provider.absorbed).toEqual([])
    expect(listPendingDeletes(ctx.db)).toEqual([])
    expect(journalSync.enqueueRecoveredDelete).not.toHaveBeenCalled()
    expect(textOf(FOREIGN)).toBe('written elsewhere')
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  it('never builds a foreign id deleted elsewhere from its record text', async () => {
    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { b: 1 })
    // The deleting device already merged this text into the day.
    journalHandler.applyDelete(ctx, FOREIGN, { b: 1, other: 1 })

    await drain()

    expect(provider.absorbed).toEqual([])
    expect(rows()).toEqual([])
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  it('still folds the day file text of a foreign holder deleted elsewhere', async () => {
    foreignRow({ minter: 2 })
    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { minter: 2 })
    journalHandler.applyDelete(ctx, FOREIGN, { minter: 2, other: 1 })

    await drain()

    expect(rows()).toEqual([{ id: DAY, path: DAY_PATH }])
    expect(provider.absorbed).toEqual([
      { targetId: DAY, foreignId: FOREIGN, fallback: 'minted here' }
    ])
    expect(textOf(DAY)).toBe('minted here')
    expect(journalSync.enqueueRecoveredDelete).not.toHaveBeenCalled()
  })

  it('drops the owed merge with the tombstone, so a crash before the purge leaves nothing owed', async () => {
    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { b: 1 })
    typed(FOREIGN, 'written elsewhere')
    provider.purgeFails = true

    await drain()

    expect(listPendingDeletes(ctx.db)).toHaveLength(1)
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  it('owes nothing again when its own tombstoned foreign id is redelivered', async () => {
    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { b: 1 })
    typed(FOREIGN, 'written elsewhere')
    await drain()

    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { b: 1 })

    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })
})
