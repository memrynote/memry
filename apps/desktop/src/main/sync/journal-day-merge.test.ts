import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { noteMetadata, tasks } from '@memry/db-schema/data-schema'
import { taskNotes } from '@memry/db-schema/schema/task-relations'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncState } from '@memry/db-schema/schema/sync-state'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  seedInboxProject,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { ApplyContext } from '@memry/sync-client/item-handlers/types'
import type { Doc } from 'yjs'

// The drain through its real adapters (#2939): the data and index databases,
// the vault's day files, the journal handler, `createJournalEntry` and the
// tasks domain. The CRDT provider is an in-memory stand-in with the same
// contract; its own fold is tested in crdt-provider.test.ts.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-day-merge-'))
const vaultPath = path.join(root, 'vault')
const userDataDir = path.join(root, 'user-data')
fs.mkdirSync(userDataDir, { recursive: true })

const { dbs, provider, journalSync, logger } = vi.hoisted(() => {
  const docs = new Map<string, Doc>()
  return {
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- the annotation widens the literal so later assignments type-check
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

// oxlint-disable-next-line typescript/no-base-to-string -- Y.Text/Y.XmlFragment toString returns the document text; the rule does not see the override
const textOf = (id: string): string => provider.docs.get(id)?.getText('t').toString() ?? ''

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir) },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../lib/logger', () => ({ createLogger: () => logger }))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('./crdt-network-update', async () => await import('./crdt-writeback'))
vi.mock('./crdt-writeback-port', async () => {
  const writeback = await import('./crdt-writeback')
  return { crdtWriteback: () => writeback }
})
vi.mock('./crdt-writeback', () => ({
  takeWritebackTurn: (_id: string, run: () => Promise<unknown>) => run(),
  holdFlushUntil: vi.fn(),
  writebackNow: vi.fn()
}))
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
  isDatabaseInitialized: () => true,
  isIndexDatabaseInitialized: () => true,
  getRawIndexDatabase: () => null
}))
// Sign-out's real teardown runs its `sync_state` wipe; its keychain, runtime
// and calendar collaborators are stand-ins.
vi.mock('../crypto', () => ({ deleteKey: vi.fn(async () => {}) }))
vi.mock('./runtime-state', async () => await import('./runtime'))
vi.mock('./runtime', () => ({ stopSyncRuntime: vi.fn(async () => {}) }))
vi.mock('./token-manager', () => ({
  resetTokenManagerState: vi.fn(),
  getValidAccessToken: vi.fn(async () => null)
}))
vi.mock('./linking-service', () => ({
  clearPendingSession: vi.fn(),
  clearPendingLinkCompletion: vi.fn()
}))
vi.mock('../ipc/in-memory-auth-state', () => ({ clearInMemoryAuthState: vi.fn() }))
vi.mock('../store', () => ({ store: { set: vi.fn() } }))
vi.mock('../calendar/google/oauth', () => ({
  disconnectGoogleCalendar: vi.fn(),
  listGoogleAccountIds: () => []
}))
vi.mock('../calendar/google/google-sync-runner', () => ({
  startGoogleCalendarSyncRunner: vi.fn(async () => {}),
  stopGoogleCalendarSyncRunner: vi.fn()
}))
vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  enqueueJournalUpdate: vi.fn(),
  initializeJournalCrdt: vi.fn(async () => {})
}))
vi.mock('../tasks/publisher', () => ({ createTasksPublisher: () => ({}) }))
vi.mock('./journal-sync', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getJournalSyncService: () => journalSync
}))
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
    initPersistence: async () => {},
    purge: async (id: string) => {
      if (provider.purgeFails) throw new Error('crashed before the purge')
      provider.docs.delete(id)
    }
  })
}))
vi.mock('../vault/note-snapshots', async () => await import('../vault/notes'))
vi.mock('../vault/notes-versions', async () => await import('../vault/notes'))
vi.mock('../vault/notes-crud', async () => await import('../vault/notes'))
vi.mock('../vault/notes-io', async () => await import('../vault/notes'))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => vaultPath,
  toRelativePath: (p: string) => path.relative(vaultPath, p),
  toAbsolutePath: (p: string) => path.join(vaultPath, p)
}))
vi.mock('../vault/status', async () => await import('../vault/index'))
vi.mock('../vault/index', () => ({
  getStatus: () => ({ path: vaultPath, isOpen: true }),
  getConfig: () => ({ journalFolder: 'journal', defaultNoteFolder: 'notes' })
}))

import { deleteNoteMetadata } from '@memry/storage-data'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { getNoteCacheByPath } from '../database/queries/notes'
import { resolveJournalEntryId } from '../journal/create-entry'
import { updateJournalEntry } from '../journal/update-entry'
import { recordTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import { _resetBulkApplyForTests } from './bulk-apply'
import { journalHandler } from './item-handlers/journal-handler'
import { getRemoteSyncAdapter } from './item-handlers'
import {
  listOwedJournalDayMerges,
  oweJournalDayMerge,
  runJournalDayMerges
} from './journal-day-merge'
import { listPendingDeletes } from './pending-deletes'
import { ItemApplier } from './apply-item'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { parseJournalEntry } from '../vault/journal'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { JournalSyncService } from './journal-sync'
import { recoverDirtyItems } from './dirty-recovery'
import { teardownSession } from './session-teardown'

const DATE = '2026-06-09'
const DAY = `j${DATE}`
const FOREIGN = 'vcpzueguep8y'
const DAY_PATH = `journal/${DATE}.md`
const THIS_DEVICE = {
  id: 'me',
  name: 'This Mac',
  platform: 'macos' as const,
  appVersion: '1',
  linkedAt: new Date(),
  isCurrentDevice: true,
  signingPublicKey: 'key'
}

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
    {
      body = 'minted here\n',
      indexed = false,
      syncedAt = null
    }: { body?: string; indexed?: boolean; syncedAt?: string | null } = {}
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
      .values({ ...row, journalDate: DATE, clock, syncedAt })
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
    data.db.insert(syncDevices).values(THIS_DEVICE).run()
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
    expect(linked.toSorted()).toEqual([DAY, 'note-kept'])
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

  // The day file owns its tags (#5476), so the foreign doc's tags array never
  // reaches it: the merge carries the foreign entry's tags into the file.
  it.each([
    [[], ['x']],
    [['a'], ['a', 'x']]
  ])('a day file tagged %j gains the folded foreign tags: %j', async (dayTags, expected) => {
    journalHandler.applyUpsert(
      ctx,
      DAY,
      { date: DATE, content: 'canonical\n', tags: dayTags },
      { c: 1 }
    )
    journalHandler.applyUpsert(
      ctx,
      FOREIGN,
      { date: DATE, content: 'theirs\n', tags: ['x', 'a'].slice(0, dayTags.length + 1) },
      { b: 1 }
    )

    await drain()

    expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toEqual(expected)
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  // Case variants fold to one key; they must not hide the missing tag.
  it('adds a foreign tag to a day file holding case variants of one tag', async () => {
    journalHandler.applyUpsert(
      ctx,
      DAY,
      { date: DATE, content: 'canonical\n', tags: ['Work', 'work'] },
      { c: 1 }
    )
    journalHandler.applyUpsert(
      ctx,
      FOREIGN,
      { date: DATE, content: 'theirs\n', tags: ['x'] },
      { b: 1 }
    )

    await drain()

    expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toContain('x')
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  // Tags compare by tag key on both clients (core `tags::dedupe`).
  it('writes nothing for a foreign tag the day holds in another case', async () => {
    journalHandler.applyUpsert(
      ctx,
      DAY,
      { date: DATE, content: 'canonical\n', tags: ['a'] },
      { c: 1 }
    )
    const before = dayFile()
    journalHandler.applyUpsert(
      ctx,
      FOREIGN,
      { date: DATE, content: 'theirs\n', tags: ['A'] },
      { b: 1 }
    )

    await drain()

    expect(dayFile()).toBe(before)
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  // A tag the foreign record dropped since must not come back.
  it('adds the newest record tags of a foreign id seen twice', async () => {
    journalHandler.applyUpsert(ctx, DAY, { date: DATE, content: 'canonical\n', tags: [] }, { c: 1 })
    pullBody.mockResolvedValue(false)
    journalHandler.applyUpsert(
      ctx,
      FOREIGN,
      { date: DATE, content: 'theirs\n', tags: ['x'] },
      { b: 1 }
    )
    await drain()
    journalHandler.applyUpsert(
      ctx,
      FOREIGN,
      { date: DATE, content: 'theirs\n', tags: ['y'] },
      { b: 2 }
    )
    pullBody.mockResolvedValue(true)

    await drain()

    expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toEqual(['y'])
  })

  it('keeps the tags of a foreign row that held the day when the day record writes over it', async () => {
    foreignRow({ minter: 2 }, { body: '---\ntags:\n  - mine\n---\nminted here\n' })

    journalHandler.applyUpsert(ctx, DAY, { date: DATE, content: 'canonical\n', tags: [] }, { c: 1 })
    await drain()

    expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toEqual(['mine'])
    expect(textOf(DAY)).toBe('minted here')
  })

  // The deleting device merged the record's tags; one removed since must not
  // come back from the record this device kept.
  it('adds no record tags of a foreign id deleted elsewhere while it waited for its body', async () => {
    journalHandler.applyUpsert(
      ctx,
      FOREIGN,
      { date: DATE, content: 'theirs\n', tags: ['x'] },
      { b: 1 }
    )
    typed(FOREIGN, 'typed here, never pushed')
    pullBody.mockResolvedValue(false)
    await drain()
    expect(listOwedJournalDayMerges(ctx.db)).toHaveLength(1)

    journalHandler.applyDelete(ctx, FOREIGN, { b: 1, other: 1 })
    journalHandler.applyUpsert(
      ctx,
      DAY,
      { date: DATE, content: 'canonical\n', tags: [] },
      { other: 1 }
    )
    await drain()

    expect(textOf(DAY)).toBe('typed here, never pushed')
    expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags ?? []).toEqual([])
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  // An owed merge written before `recordTags` kept both kinds in `tags`.
  it('adds the tags of an owed merge written before record tags were kept apart, even deleted', async () => {
    journalHandler.applyUpsert(ctx, DAY, { date: DATE, content: 'canonical\n', tags: [] }, { c: 1 })
    oweJournalDayMerge(ctx.db, { foreignId: FOREIGN, date: DATE, clock: { b: 1 }, tags: ['x'] })
    journalHandler.applyDelete(ctx, FOREIGN, { b: 1, other: 1 })
    typed(FOREIGN, 'typed here, never pushed')

    await drain()

    expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toEqual(['x'])
  })

  // The tag fold keeps whitespace, as core `tags::dedupe` folds the owed
  // holder tags (protocol §13.7.7, the `no-trim-in-fold` vector).
  it('keeps a padded spelling beside the plain one in an owed merge', () => {
    const owed = { foreignId: FOREIGN, date: DATE, clock: { b: 1 } }
    oweJournalDayMerge(ctx.db, { ...owed, tags: ['Work'] })
    oweJournalDayMerge(ctx.db, { ...owed, tags: [' Work ', 'work'] })

    expect(listOwedJournalDayMerges(ctx.db)[0].tags).toEqual(['Work', ' Work '])
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

  // A live blank holder whose only content is a tag added offline: `j<D>`
  // displaces it and no tombstone comes (#5699). A tag the day lacks merges
  // it, tombstone and all; one the day holds leaves nothing to merge.
  it.each([
    ['lacks', ['a'], ['a', 'c'], true],
    ['holds in another case', ['a', 'C'], ['a', 'C'], false]
  ] as const)(
    'keeps an offline tag of a blank live holder the day %s',
    async (_case, dayTags, expected, tombstoned) => {
      foreignRow(
        { me: 2 },
        { body: '---\ntags:\n  - a\n  - c\n---\n', syncedAt: '2026-06-09T07:00:00.000Z' }
      )
      journalHandler.applyUpsert(
        ctx,
        DAY,
        { date: DATE, content: '', tags: [...dayTags] },
        { b: 2 }
      )

      await drain()

      expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toEqual(expected)
      expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
      expect(listPendingDeletes(ctx.db).map((row) => row.itemId)).toEqual(
        tombstoned ? [FOREIGN] : []
      )
    }
  )

  // The owed merge holds the only copy of the displaced blank holder's offline
  // tag while the drain waits for the foreign body. A sign-out in that window
  // keeps it, so the next sign-in's drain still adds the tag to the day.
  it('keeps an owed offline tag of a blank holder through sign-out', async () => {
    foreignRow(
      { me: 2 },
      { body: '---\ntags:\n  - a\n  - c\n---\n', syncedAt: '2026-06-09T07:00:00.000Z' }
    )
    journalHandler.applyUpsert(ctx, DAY, { date: DATE, content: '', tags: ['a'] }, { b: 2 })
    pullBody.mockResolvedValue(false)
    await drain()
    expect(listOwedJournalDayMerges(ctx.db).map((owed) => owed.tags)).toEqual([['a', 'c']])

    await teardownSession('logout')
    data.db.insert(syncDevices).values(THIS_DEVICE).run()
    pullBody.mockResolvedValue(true)
    await drain()

    expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toEqual(['a', 'c'])
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  it('owes nothing again when its own tombstoned foreign id is redelivered', async () => {
    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { b: 1 })
    typed(FOREIGN, 'written elsewhere')
    await drain()

    journalHandler.applyUpsert(ctx, FOREIGN, { date: DATE, content: 'theirs\n' }, { b: 1 })

    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  // The user edits a foreign holder `F`'s tags through the real edit path
  // after its tombstone is held and before the drain takes the day over
  // (#5694). The drain merges the tags `F` holds then, not the ones read
  // when the tombstone arrived.
  it('merges the tags a held day holds when the drain runs, not those read at its tombstone', async () => {
    foreignRow({ me: 1 }, { body: '---\ntags:\n  - a\n  - b\n---\nheld\n' })
    getRemoteSyncAdapter('journal')?.markPushSynced?.(ctx.db, FOREIGN)
    await updateJournalEntry({ date: DATE, tags: ['a', 'b', 'c'] })
    new ItemApplier(ctx.db, vi.fn()).apply({
      itemId: FOREIGN,
      type: 'journal',
      operation: 'delete',
      content: new TextEncoder().encode(JSON.stringify({ clock: { me: 1, b: 1 } })),
      clock: { me: 1, b: 1 },
      deletedAt: Date.now()
    })
    await updateJournalEntry({ date: DATE, tags: ['a', 'b', 'd'] })

    await drain()

    expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toEqual(['a', 'b', 'd'])
    expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
  })

  // Device B merged `F` at `{me: 1}` into the day and pushed the day, then
  // `F`'s tombstone `{me: 1, b: 1}` (#5659). This device held `F`. The same
  // traces as the core's `journal_day_merge_devices.rs`, with the same end
  // state: a tag B never saw is added, one B removed after seeing it is not.
  describe.each(['day first', 'tombstone first'] as const)(
    'a foreign holder merged elsewhere, %s',
    (order) => {
      const record = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

      it.each([
        // trace, F's tags and text here, F's tick here, an edit queued, F's row edited since its sync, B's day tags, redelivered, end state
        [
          'a: a pushed tag the delete overwrote',
          ['a', 'b', 'c'],
          'held',
          2,
          false,
          false,
          ['a', 'b'],
          false,
          ['a', 'b', 'c']
        ],
        [
          'B4: a tag B removed after the merge',
          ['a', 'b'],
          'held',
          1,
          false,
          false,
          ['a'],
          false,
          ['a']
        ],
        [
          'B4r: the same, the tombstone delivered again',
          ['a', 'b'],
          'held',
          1,
          false,
          false,
          ['a'],
          true,
          ['a']
        ],
        [
          'c1: a tag added offline',
          ['a', 'b', 'c'],
          'held',
          2,
          true,
          false,
          ['a', 'b'],
          false,
          ['a', 'b', 'c']
        ],
        [
          'c2: the same, the tombstone delivered again',
          ['a', 'b', 'c'],
          'held',
          2,
          true,
          false,
          ['a', 'b'],
          true,
          ['a', 'b', 'c']
        ],
        [
          'c3: two offline edits',
          ['a', 'b', 'c', 'd'],
          'held',
          3,
          true,
          false,
          ['a', 'b'],
          false,
          ['a', 'b', 'c', 'd']
        ],
        [
          'c4: a tag added offline to a blank day',
          ['c'],
          '',
          2,
          true,
          false,
          ['a'],
          false,
          ['a', 'c']
        ],
        // An edit queued with no tick, as the dirty sweep re-queues one: the
        // tombstone drops it after the first weighing (REVIEW-5691).
        [
          'R0: a recovered edit, queued with no tick',
          ['a', 'b', 'x'],
          'held',
          1,
          true,
          false,
          ['a', 'b'],
          false,
          ['a', 'b', 'x']
        ],
        [
          'R1: a recovered edit, the tombstone delivered again',
          ['a', 'b', 'x'],
          'held',
          1,
          true,
          false,
          ['a', 'b'],
          true,
          ['a', 'b', 'x']
        ],
        // A tag added outside the app: the watcher marks the row edited and
        // neither queues nor ticks it (REVIEW-5691).
        [
          'R2: a tag added outside the app, nothing queued',
          ['a', 'b', 'x'],
          'held',
          1,
          false,
          true,
          ['a', 'b'],
          false,
          ['a', 'b', 'x']
        ]
      ])('%s', async (_trace, held, text, tick, queued, edited, dayTags, redeliver, expected) => {
        // Minted here and never pulled: only the acked push stamps `syncedAt`.
        foreignRow(
          { me: tick },
          { body: `---\ntags:\n${held.map((t) => `  - ${t}\n`).join('')}---\n${text}\n` }
        )
        getRemoteSyncAdapter('journal')?.markPushSynced?.(ctx.db, FOREIGN)
        if (edited) {
          data.db
            .update(noteMetadata)
            .set({ modifiedAt: new Date(Date.now() + 60_000).toISOString() })
            .where(eq(noteMetadata.id, FOREIGN))
            .run()
        }
        if (queued) {
          data.db
            .insert(syncQueue)
            .values({
              id: 'edit',
              type: 'journal',
              itemId: FOREIGN,
              operation: 'update',
              payload: '{}',
              createdAt: new Date()
            })
            .run()
        }
        const applier = new ItemApplier(ctx.db, vi.fn())
        const day = () =>
          applier.apply({
            itemId: DAY,
            type: 'journal',
            operation: 'update',
            content: record({ date: DATE, content: 'canonical\n', tags: dayTags }),
            clock: { b: 2 }
          })
        const tombstone = () =>
          applier.apply({
            itemId: FOREIGN,
            type: 'journal',
            operation: 'delete',
            content: record({ clock: { me: 1, b: 1 } }),
            clock: { me: 1, b: 1 },
            deletedAt: Date.now()
          })

        if (order === 'day first') {
          day()
          tombstone()
        } else {
          tombstone()
          day()
        }
        if (redeliver) tombstone()
        await drain()

        expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toEqual(expected)
        expect(listOwedJournalDayMerges(ctx.db)).toEqual([])
      })
    }
  )
  // A holder `F` at `{me: 1}`, held here with tags a, b, c; device B merged it
  // into the day as a, b and deleted it at `{me: 1, b: 1}`. Each case pushes
  // `F` against a server holding that tombstone. The server refuses the push
  // (apps/sync-server/src/services/sync.ts `detectReplay`): a clock the
  // tombstone covers is a replay and is acked, any other loses to the delete
  // and is not. Either way the queue row goes, as in push-coordinator.
  describe('a holder pushed against a peer tombstone', () => {
    const TOMBSTONE = { me: 1, b: 1 }
    const holderFile = (tags: string[]): string =>
      `---\ntags:\n${tags.map((t) => `  - ${t}\n`).join('')}---\nheld\n`
    let queue: SyncQueueManager
    let service: JournalSyncService
    const sweep = () =>
      recoverDirtyItems(
        data.db as never,
        {
          getLocal: (type: string) => (type === 'journal' ? service : undefined)
        } as unknown as Parameters<typeof recoverDirtyItems>[1]
      )
    const clockOf = () =>
      data.db.select().from(noteMetadata).where(eq(noteMetadata.id, FOREIGN)).get()?.clock
    const build = (): Record<string, number> =>
      (
        JSON.parse(journalHandler.buildPushPayload(ctx.db, FOREIGN, 'me', 'update') ?? '{}') as {
          clock: Record<string, number>
        }
      ).clock
    const answer = (pushed: Record<string, number>): void => {
      const covered = Object.entries(pushed).every(([d, n]) => n <= (TOMBSTONE[d as 'me'] ?? 0))
      if (covered) journalHandler.markPushSynced(ctx.db, FOREIGN)
      for (const row of queue.peek(10)) queue.markSuccess(row.id)
    }
    const peerMerged = async (order: 'day first' | 'tombstone first'): Promise<string[]> => {
      const applier = new ItemApplier(ctx.db, vi.fn())
      const day = () =>
        applier.apply({
          itemId: DAY,
          type: 'journal',
          operation: 'update',
          content: new TextEncoder().encode(
            JSON.stringify({ date: DATE, content: 'canonical\n', tags: ['a', 'b'] })
          ),
          clock: { b: 2 }
        })
      const tombstone = () =>
        applier.apply({
          itemId: FOREIGN,
          type: 'journal',
          operation: 'delete',
          content: new TextEncoder().encode(JSON.stringify({ clock: TOMBSTONE })),
          clock: TOMBSTONE,
          deletedAt: Date.now()
        })
      if (order === 'day first') {
        day()
        tombstone()
      } else {
        tombstone()
        day()
      }
      await drain()
      return parseJournalEntry(dayFile(), DATE).frontmatter.tags ?? []
    }

    // This vault first opened under the stamping build at `iso` (`journalClockEra`).
    const upgradedAt = (iso: string): void => {
      data.db
        .insert(syncState)
        .values({ key: 'journalClockEra', value: iso, updatedAt: new Date() })
        .onConflictDoUpdate({ target: syncState.key, set: { value: iso } })
        .run()
    }

    beforeEach(() => {
      queue = new SyncQueueManager(asClientDb(data.db))
      service = new JournalSyncService({ queue, getDeviceId: () => 'me' })
      upgradedAt('2026-06-09T06:00:00.000Z')
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    // Tag c was added outside the app, which never ticks the clock; the next
    // start's dirty sweep queues it (VERIFY-5691R2).
    it.each(['day first', 'tombstone first'] as const)(
      'keeps a tag added outside the app and recovered at start, %s',
      async (order) => {
        foreignRow(
          { me: 1 },
          { body: holderFile(['a', 'b', 'c']), syncedAt: '2026-06-09T07:00:00.000Z' }
        )
        expect(sweep().journals).toBe(1)
        answer(build())

        expect(await peerMerged(order)).toEqual(['a', 'b', 'c'])
      }
    )

    // Tag c lands outside the app after the push payload was read and before
    // its ack, in the ack's millisecond or before it.
    it.each([
      ['in the ack millisecond, day first', 0, 'day first'],
      ['in the ack millisecond, tombstone first', 0, 'tombstone first'],
      ['before the ack, day first', 5, 'day first'],
      ['before the ack, tombstone first', 5, 'tombstone first']
    ] as const)(
      'keeps a tag added outside the app during its push, %s',
      async (_c, ackLag, order) => {
        vi.useFakeTimers({ toFake: ['Date'] })
        foreignRow({ me: 1 }, { body: holderFile(['a', 'b']) })
        vi.setSystemTime(new Date('2026-06-09T09:00:00.000Z'))
        const pushed = build()
        const edit = new Date('2026-06-09T09:00:00.100Z')
        fs.writeFileSync(path.join(vaultPath, DAY_PATH), holderFile(['a', 'b', 'c']))
        data.db
          .update(noteMetadata)
          .set({ modifiedAt: edit.toISOString() })
          .where(eq(noteMetadata.id, FOREIGN))
          .run()
        vi.setSystemTime(new Date(edit.getTime() + ackLag))
        answer(pushed)

        expect(await peerMerged(order)).toEqual(['a', 'b', 'c'])
      }
    )

    it('does not bump or re-push a holder in step on the next start', () => {
      foreignRow({ me: 1 }, { body: holderFile(['a', 'b']) })
      service.enqueueUpdate(FOREIGN, DATE)
      expect(clockOf()).toEqual({ me: 2 })
      journalHandler.buildPushPayload(ctx.db, FOREIGN, 'me', 'update')
      journalHandler.markPushSynced(ctx.db, FOREIGN)
      for (const row of queue.peek(10)) queue.markSuccess(row.id)

      expect(sweep().journals).toBe(0)
      expect(queue.getPendingCount()).toBe(0)
      expect(clockOf()).toEqual({ me: 2 })
    })

    // A build before #5659 acked journal pushes without stamping `syncedAt`, so
    // every journal it pushed reaches the upgraded build at `syncedAt` null.
    describe('on the first start after an upgrade', () => {
      const queuedClock = (): Record<string, number> =>
        (JSON.parse(queue.peek(1)[0]?.payload ?? '{}') as { clock: Record<string, number> }).clock

      // The fixture rows below are an older build's: written before this one.
      beforeEach(() => {
        upgradedAt('2026-06-09T09:30:00.000Z')
      })

      // The older build pulled the day from B at `{b: 1}`, which stamped it,
      // then took an edit here (`{b: 1, me: 1}`) and pushed it; its ack stamped
      // nothing. B then made a tag edit it has not pushed yet (VERIFY-5691R4).
      it("replays a pulled-then-acked journal, leaving a peer's unpushed tag edit standing", () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-06-09T08:30:00.000Z'))
        journalHandler.applyUpsert(
          ctx,
          DAY,
          { date: DATE, content: 'held\n', tags: ['a'] },
          { b: 1 }
        )
        data.db
          .update(noteMetadata)
          .set({ clock: { b: 1, me: 1 }, modifiedAt: '2026-06-09T09:00:00.000Z' })
          .where(eq(noteMetadata.id, DAY))
          .run()
        vi.useRealTimers()

        expect(sweep().journals).toBe(1)
        const pushed = queuedClock()
        expect(pushed).toEqual({ b: 1, me: 1 })
        for (const row of queue.peek(10)) queue.markSuccess(row.id)

        fs.writeFileSync(
          path.join(vaultPath, DAY_PATH),
          dayFile().replace('  - a\n', '  - a\n  - peer\n')
        )
        data.db
          .update(noteMetadata)
          .set({ clock: { b: 2, me: 1 } })
          .where(eq(noteMetadata.id, DAY))
          .run()
        journalHandler.applyUpsert(ctx, DAY, { date: DATE, content: null, tags: ['a'] }, pushed)

        expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toEqual(['a', 'peer'])
      })

      // The same older-build row, pulled at 07:00 and edited and acked at
      // 08:00, then given tag c outside the app after the upgrade: the watcher
      // moves `modifiedAt` and nothing ticks.
      it.each(['day first', 'tombstone first'] as const)(
        'keeps a tag added outside the app after the upgrade to a pulled-then-acked holder, %s',
        async (order) => {
          foreignRow(
            { me: 1 },
            { body: holderFile(['a', 'b', 'c']), syncedAt: '2026-06-09T07:00:00.000Z' }
          )
          data.db
            .update(noteMetadata)
            .set({ modifiedAt: '2026-06-09T10:00:00.000Z' })
            .where(eq(noteMetadata.id, FOREIGN))
            .run()

          expect(sweep().journals).toBe(1)
          expect(queuedClock()).toEqual({ me: 2 })
          answer(build())

          expect(await peerMerged(order)).toEqual(['a', 'b', 'c'])
        }
      )

      it('replays an acked unstamped journal at its stored clock', () => {
        foreignRow({ me: 1 }, { body: holderFile(['a']) })

        expect(sweep().journals).toBe(1)
        expect(clockOf()).toEqual({ me: 1 })
        expect(queuedClock()).toEqual({ me: 1 })
      })

      // This database plays both devices: first the upgraded one, holding the
      // day at `{me: 1}` with a shipped-build ack (no stamp), then the peer,
      // holding it with an unpushed tag edit at `{me: 1, b: 1}`.
      it("leaves a peer's unpushed tag edit standing", () => {
        journalHandler.applyUpsert(
          ctx,
          DAY,
          { date: DATE, content: 'held\n', tags: ['a'] },
          { me: 1 }
        )
        data.db.update(noteMetadata).set({ syncedAt: null }).where(eq(noteMetadata.id, DAY)).run()
        expect(sweep().journals).toBe(1)
        const pushed = queuedClock()
        for (const row of queue.peek(10)) queue.markSuccess(row.id)

        expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toEqual(['a'])
        fs.writeFileSync(
          path.join(vaultPath, DAY_PATH),
          dayFile().replace('  - a\n', '  - a\n  - peer\n')
        )
        data.db
          .update(noteMetadata)
          .set({ clock: { me: 1, b: 1 } })
          .where(eq(noteMetadata.id, DAY))
          .run()
        journalHandler.applyUpsert(ctx, DAY, { date: DATE, content: null, tags: ['a'] }, pushed)

        expect(parseJournalEntry(dayFile(), DATE).frontmatter.tags).toEqual(['a', 'peer'])
      })

      it('pushes nothing for it once acked, and an edit after that under a fresh clock', () => {
        foreignRow({ me: 1 }, { body: holderFile(['a', 'b']) })
        expect(sweep().journals).toBe(1)
        answer(build())

        expect(sweep().journals).toBe(0)
        expect(queue.getPendingCount()).toBe(0)
        expect(clockOf()).toEqual({ me: 1 })

        fs.writeFileSync(path.join(vaultPath, DAY_PATH), holderFile(['a', 'b', 'c']))
        data.db
          .update(noteMetadata)
          .set({ modifiedAt: '2026-06-09T10:00:00.000Z' })
          .where(eq(noteMetadata.id, FOREIGN))
          .run()

        expect(sweep().journals).toBe(1)
        expect(clockOf()).toEqual({ me: 2 })
        expect(queuedClock()).toEqual({ me: 2 })
      })
    })
  })
})
