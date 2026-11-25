/**
 * A journal day edited outside the app while it was closed (#5752). The vault
 * open's replay finds the edit and ticks the day, so its tags push and a peer's
 * delete that never saw it keeps the edited text instead of removing it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { upsertNoteMetadata } from '@memry/storage-data'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { getNoteCacheById, insertNoteCache } from '@main/database/queries/notes'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() }
}))
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  requireDatabase: vi.fn(),
  isDatabaseInitialized: () => true,
  updateFtsContent: vi.fn()
}))
vi.mock('./status', async () => await import('./index'))
vi.mock('./index', () => ({
  emitIndexProgress: vi.fn(),
  getConfig: vi.fn(() => ({
    excludePatterns: [],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  })),
  getStatus: vi.fn()
}))
const docs = vi.hoisted(() => new Map<string, Y.Doc>())
/** Docs no editor holds: the feed opens them, and declines an empty one. */
const closed = vi.hoisted(() => new Set<string>())
vi.mock('../sync/crdt-provider', () => {
  const stub = {
    initForNote: vi.fn(async () => {}),
    updateMeta: vi.fn(),
    getDoc: (id: string) => (closed.has(id) ? undefined : docs.get(id)),
    recordOwedFullState: vi.fn(),
    hasPersistence: () => true,
    isPersistent: () => true,
    isNoteLocalOnly: () => false,
    isAwaitingMerge: () => false,
    open: async (id: string) => docs.get(id),
    closeIfInactive: async () => {},
    whenPersisted: async () => {},
    withDocLoaded: async (_id: string, enqueue: () => void) => enqueue(),
    getStateVector: () => null,
    purge: vi.fn(async () => {})
  }
  return { ORIGIN_LOCAL: 'local', getCrdtProvider: vi.fn(() => stub) }
})
vi.mock('../sync/attachment-backfill', () => ({ queueEmbeddedVaultFiles: vi.fn() }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => 0)
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn() }))
vi.mock('../inbox/runtime-effects', () => ({ syncInboxCreate: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))

import { getDatabase, getIndexDatabase } from '../database'
import {
  getDatabase as getClientDatabase,
  getIndexDatabase as getClientIndexDatabase
} from '../database/client'
import { getStatus } from './index'
import { markdownToYFragment } from '../sync/blocknote-converter'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { generateContentHash } from './frontmatter'
import { clearIngestBackfill } from './ingest-backfill'
import { clearAllPendingDeletes } from './rename-tracker'
import { getWatcher, startWatcher, stopWatcher } from './watcher'
import { initJournalSyncService, resetJournalSyncService } from '../sync/journal-sync'
import { journalHandler } from '../sync/item-handlers/journal-handler'

function fileSystemIgnoresCase(): boolean {
  return fs.existsSync(os.tmpdir().toUpperCase())
}

const DATE = '2026-11-20'
const ID = `j${DATE}`
const DAY_PATH = `journal/${DATE}.md`
const SYNCED = '---\ntags:\n  - daily\n---\n\nMorning pages.\n'
const EDITED = '---\ntags:\n  - daily\n  - travel\n---\n\nMorning pages. Written on the train.\n'

describe('a journal day edited while the app was closed (#5752)', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let queue: SyncQueueManager

  beforeEach(async () => {
    vault = createTestVault('missed-journal-edit')
    fs.writeFileSync(path.join(vault.memryDir, 'data.db'), '')
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getClientDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    vi.mocked(getClientIndexDatabase).mockReturnValue(index.db)
    vi.mocked(getStatus).mockReturnValue({
      isOpen: true,
      path: vault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    })
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
    queue = new SyncQueueManager(asSyncDb(data.db))
    initJournalSyncService({ queue, getDeviceId: () => 'device-a' })

    // #given a day this device synced at {device-a: 1}, its file and its doc
    const fields = {
      id: ID,
      path: DAY_PATH,
      title: DATE,
      fileType: 'markdown' as const,
      localOnly: false,
      journalDate: DATE,
      date: DATE,
      createdAt: '2026-11-20T06:00:00.000Z',
      modifiedAt: '2026-11-20T07:00:00.000Z',
      syncedAt: '2026-11-20T07:00:00.000Z',
      fileSize: Buffer.byteLength(SYNCED)
    }
    upsertNoteMetadata(asClientDb(data.db), { ...fields, clock: { 'device-a': 1 } })
    insertNoteCache(index.db, { ...fields, contentHash: generateContentHash(SYNCED) })
    fs.mkdirSync(path.join(vault.path, 'journal'), { recursive: true })
    fs.writeFileSync(path.join(vault.path, DAY_PATH), SYNCED)
    const doc = new Y.Doc()
    await markdownToYFragment('Morning pages.\n', doc.getXmlFragment('prosemirror'), DAY_PATH)
    docs.set(ID, doc)
  })

  afterEach(async () => {
    docs.clear()
    closed.clear()
    resetJournalSyncService()
    await stopWatcher()
    await stopProjectionRuntime({ drain: true })
    clearIngestBackfill()
    clearAllPendingDeletes()
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  async function openVault(): Promise<void> {
    await startWatcher(vault.path)
    await getWatcher().replayMissedJournalEdits()
    await flushProjectionEvents()
  }

  function storedClock(): unknown {
    return data.db.select().from(noteMetadata).where(eq(noteMetadata.id, ID)).get()?.clock
  }

  it('pushes the edit and keeps its text from a peer delete that never saw it', async () => {
    // #and while the app is closed the user edits the day
    fs.writeFileSync(path.join(vault.path, DAY_PATH), EDITED)

    // #when the vault opens
    await openVault()

    // #then the day is ticked and its new tags are queued
    expect(storedClock()).toEqual({ 'device-a': 2 })
    const rows = data.db.select().from(syncQueue).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'journal', itemId: ID, operation: 'update' })
    expect(JSON.parse(rows[0].payload)).toMatchObject({ tags: ['daily', 'travel'] })

    // #and the doc takes the edit, so the next open finds nothing to tick
    await vi.waitFor(() =>
      expect(getNoteCacheById(index.db, ID)?.contentHash).toBe(generateContentHash(EDITED))
    )
    await stopWatcher()
    await openVault()
    expect(storedClock()).toEqual({ 'device-a': 2 })

    // #and a peer's delete made from {device-a: 1} is concurrent with the edit,
    // so the edited text is kept rather than removed with the day
    journalHandler.applyDelete(
      { db: asSyncDb(data.db), emit: vi.fn() },
      ID,
      { 'device-a': 1, 'device-b': 1 },
      Date.now()
    )
    const kept = data.db.select().from(inboxItems).all()
    expect(kept).toHaveLength(1)
    expect(kept[0].content).toContain('Written on the train.')
  }, 30_000)

  function applyPeerDelete(): void {
    // A peer's delete made from {device-a: 1}: by the clocks, it saw this day.
    journalHandler.applyDelete(
      { db: asSyncDb(data.db), emit: vi.fn() },
      ID,
      { 'device-a': 1, 'device-b': 1 },
      Date.now()
    )
  }

  function keptTexts(): string[] {
    return data.db
      .select()
      .from(inboxItems)
      .all()
      .map((item) => item.content ?? '')
  }

  it('keeps a closed-app edit from a peer delete the first pull applies before the replay', async () => {
    // #given the day edited while the app was closed
    fs.writeFileSync(path.join(vault.path, DAY_PATH), EDITED)

    // #when the vault open's first pull applies the delete before the replay ran
    applyPeerDelete()

    // #then the edit, which no clock covers yet, is kept in the inbox
    const kept = keptTexts()
    expect(kept).toHaveLength(1)
    expect(kept[0]).toContain('Written on the train.')
  }, 30_000)

  it('keeps a live outside edit the watcher has not taken yet from a peer delete', async () => {
    await openVault()

    // #given an edit made outside the app, still inside the watcher's debounce
    fs.writeFileSync(path.join(vault.path, DAY_PATH), EDITED)

    // #when a pull applies the delete before the watcher reads the file
    applyPeerDelete()

    // #then the edited text is kept
    const kept = keptTexts()
    expect(kept).toHaveLength(1)
    expect(kept[0]).toContain('Written on the train.')
  }, 30_000)

  it('keeps nothing when the file holds the bytes this device ingested', async () => {
    applyPeerDelete()

    expect(keptTexts()).toHaveLength(0)
  }, 30_000)

  it('ticks a never-opened day once per edit, not on every open', async () => {
    // #given a day whose doc was never opened: empty, so it declines the feed
    docs.set(ID, new Y.Doc())
    closed.add(ID)
    fs.writeFileSync(path.join(vault.path, DAY_PATH), EDITED)

    // #when the vault opens twice
    await openVault()
    expect(storedClock()).toEqual({ 'device-a': 2 })
    await stopWatcher()
    await openVault()

    // #then the edit was ticked once
    expect(storedClock()).toEqual({ 'device-a': 2 })
    expect(getNoteCacheById(index.db, ID)?.contentHash).toBe(generateContentHash(SYNCED))

    // #and a later edit ticks again
    await stopWatcher()
    fs.writeFileSync(path.join(vault.path, DAY_PATH), `${EDITED}\nOne more line.\n`)
    await openVault()
    expect(storedClock()).toEqual({ 'device-a': 3 })
  }, 30_000)

  it.runIf(fileSystemIgnoresCase())(
    'ticks nothing for a day whose file a case twin shares',
    async () => {
      // #given a note row whose path differs from the day's only by case
      upsertNoteMetadata(asClientDb(data.db), {
        id: 'n-twin',
        path: `Journal/${DATE}.md`,
        title: 'Twin',
        fileType: 'markdown',
        localOnly: false,
        createdAt: '2026-11-20T06:00:00.000Z',
        modifiedAt: '2026-11-20T07:00:00.000Z'
      })
      fs.writeFileSync(path.join(vault.path, DAY_PATH), EDITED)

      // #when the vault opens
      await openVault()

      // #then the refused edit moves no clock
      expect(storedClock()).toEqual({ 'device-a': 1 })
      expect(data.db.select().from(syncQueue).all()).toHaveLength(0)
    },
    30_000
  )

  it('ticks nothing when the bytes are the ones it synced', async () => {
    // #given the file touched but not changed (a re-index, a copy that kept the bytes)
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(path.join(vault.path, DAY_PATH), later, later)

    await openVault()

    expect(storedClock()).toEqual({ 'device-a': 1 })
    expect(data.db.select().from(syncQueue).all()).toHaveLength(0)
  }, 30_000)
})
