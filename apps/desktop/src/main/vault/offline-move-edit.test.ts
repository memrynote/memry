/**
 * A note moved and edited while Memry was closed keeps its edit when the next
 * remote update writes the note back (#5292). Vault open replays the move, and
 * the edit is only ingested by the write-back's outside-edit check, so nothing
 * on the open path may record the edited bytes as Memry's own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'
import { upsertNoteMetadata } from '@memry/storage-data'

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
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))
const docs = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../sync/crdt-provider', () => {
  const stub = {
    initForNote: vi.fn(async () => {}),
    updateMeta: vi.fn(),
    getDoc: (id: string) => docs.get(id),
    recordOwedFullState: vi.fn(),
    hasPersistence: () => true,
    isPersistent: () => true,
    isNoteLocalOnly: () => false,
    isAwaitingMerge: () => false,
    open: async (id: string) => docs.get(id),
    closeIfInactive: async () => {},
    whenPersisted: async () => {},
    withDocLoaded: async (_id: string, enqueue: () => void) => enqueue(),
    purge: vi.fn()
  }
  return { ORIGIN_LOCAL: 'local', getCrdtProvider: vi.fn(() => stub) }
})
vi.mock('../sync/attachment-backfill', () => ({ queueEmbeddedVaultFiles: vi.fn() }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => 0)
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn() }))
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
import { markdownToYFragment, yDocToMarkdown } from '../sync/blocknote-converter'
import { writebackNow } from '../sync/crdt-writeback'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { generateContentHash } from './frontmatter'
import { clearIngestBackfill, drainIngestBackfill } from './ingest-backfill'
import { indexVault } from './indexer'
import { clearAllPendingDeletes } from './rename-tracker'
import { getWatcher, startWatcher, stopWatcher } from './watcher'

const BODY = '# Plan\n\nWrite the draft.\n'
const EDITED = '# Plan\n\nWrite the draft. Edited offline.\n'

describe('a note moved while the app was closed and edited as the vault opens (#5292)', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('offline-move-edit')
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
  })

  afterEach(async () => {
    docs.clear()
    await stopWatcher()
    await stopProjectionRuntime({ drain: true })
    clearIngestBackfill()
    clearAllPendingDeletes()
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  async function docHolding(markdown: string, notePath: string): Promise<Y.Doc> {
    const doc = new Y.Doc()
    await markdownToYFragment(markdown, doc.getXmlFragment('prosemirror'), notePath)
    return doc
  }

  it('keeps the edit when the next remote update writes the note back', async () => {
    // #given a synced note the index measured, and its doc in the store
    const fields = {
      id: 'moved',
      path: 'Drafts/plan.md',
      title: 'plan',
      fileType: 'markdown' as const,
      localOnly: false,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: '2026-01-12T00:00:00.000Z',
      fileSize: Buffer.byteLength(BODY)
    }
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, { ...fields, contentHash: generateContentHash(BODY) })
    fs.mkdirSync(path.join(vault.path, 'Drafts'))
    fs.mkdirSync(path.join(vault.path, 'Archive'))
    fs.writeFileSync(path.join(vault.path, 'Drafts/plan.md'), BODY)
    const doc = await docHolding(BODY, 'Drafts/plan.md')
    docs.set('moved', doc)

    // #and while the app is closed the user moves the file
    fs.renameSync(path.join(vault.path, 'Drafts/plan.md'), path.join(vault.path, 'Archive/plan.md'))

    // #when the vault opens, replays the move, and the edit lands before the
    // backfill reads the moved file (a sync client finishing, or a dropped event)
    await startWatcher(vault.path)
    await getWatcher().replayMissedRemovals()
    await indexVault(vault.path)
    await flushProjectionEvents()
    fs.writeFileSync(path.join(vault.path, 'Archive/plan.md'), EDITED)
    await drainIngestBackfill()
    await flushProjectionEvents()
    // The watcher's change event for the edit settles after the backfill.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await flushProjectionEvents()
    const moved = index.db
      .select({ path: noteCache.path })
      .from(noteCache)
      .where(eq(noteCache.id, 'moved'))
      .get()
    expect(moved?.path).toBe('Archive/plan.md')
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
    const seen = Y.encodeStateVector(peer)
    const heading = [...peer.getXmlFragment('prosemirror').createTreeWalker(() => true)].find(
      (node): node is Y.XmlText => node instanceof Y.XmlText && node.toString() === 'Plan'
    )
    heading?.insert(heading.length, ' (peer)')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, seen), 'remote')
    await writebackNow('moved', doc)

    // #then the file keeps the edit beside the peer's, and the doc took it so it syncs
    const file = fs.readFileSync(path.join(vault.path, 'Archive/plan.md'), 'utf8')
    expect(file).toContain('Edited offline.')
    expect(file).toContain('Plan (peer)')
    expect(await yDocToMarkdown(doc, 'prosemirror', { notePath: 'Archive/plan.md' })).toContain(
      'Edited offline.'
    )
  }, 30_000)
})
