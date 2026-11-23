/**
 * Two synced notes whose paths differ only in case share one file on a
 * case-insensitive disk, and the file holds one twin's body. Neither note
 * ever takes the other's body: not after a vault open's heal, and not
 * through an operation that rewrites the file (#5297).
 *
 * @module vault/case-twins.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { getInboundLinkSourceIds, insertNoteCache } from '@main/database/queries/notes'
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
    isNoteLocalOnly: () => false,
    isAwaitingMerge: () => false,
    open: async (id: string) => docs.get(id),
    withDocLoaded: async (_id: string, run: () => void) => run(),
    closeIfInactive: async () => {},
    purge: vi.fn()
  }
  return { ORIGIN_LOCAL: 'local', getCrdtProvider: vi.fn(() => stub) }
})
vi.mock('../sync/attachment-backfill', () => ({ queueEmbeddedVaultFiles: vi.fn() }))
vi.mock('../sync/crdt-external-feed', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...real, feedExternalEditToCrdt: vi.fn(real.feedExternalEditToCrdt as never) }
})
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
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { getCrdtProvider } from '../sync/crdt-provider'
import { recordOwedFileBody } from '../sync/crdt-owed-file-body'
import { markdownToYFragment } from '../sync/blocknote-converter'
import { markWritebackIgnored, writebackNow } from '../sync/crdt-writeback'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { generateContentHash, parseNote } from './frontmatter'
import { syncNoteToCache } from './note-sync'
import { healCaseVariantRows } from './case-variant-heal'
import { clearIngestBackfill, drainIngestBackfill } from './ingest-backfill'
import { indexVault } from './indexer'
import { appendBlocksToNote } from './append-blocks'
import { rewriteInboundWikiLinks } from './rename-link-rewrite'
import { clearAllPendingDeletes } from './rename-tracker'
import { startWatcher, stopWatcher, getWatcher } from './watcher'
import { deleteNoteCommand } from '../notes/domain'
import { enqueueLocalSyncDelete } from '../sync/local-mutations'

function fileSystemIgnoresCase(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-case-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '')
    return fs.existsSync(path.join(dir, 'PROBE'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe.runIf(fileSystemIgnoresCase())('case twins sharing one file', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('case-twins')
    // The watcher takes a vault without its database for one that went away.
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

  /**
   * A pulled note as the vault holds it: a synced canonical row, its index
   * row, and its body written by sync at the row's spelling.
   */
  function seed(id: string, relativePath: string, body: string, synced = true): void {
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, '.md'),
      fileType: 'markdown' as const,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: synced ? '2026-01-12T00:00:00.000Z' : null,
      fileSize: Buffer.byteLength(body)
    }
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, { ...fields, contentHash: generateContentHash(body) })
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    markWritebackIgnored(absolutePath)
    fs.writeFileSync(absolutePath, body)
  }

  const LOWER = '# a\n\nlower [[x]]\n'
  const UPPER = '# a\n\nupper [[x]]\n'

  const rowIds = () =>
    data.db
      .select({ id: noteMetadata.id })
      .from(noteMetadata)
      .all()
      .map((row) => row.id)
      .toSorted()

  const shared = () => fs.readFileSync(path.join(vault.path, 'Supernotes/a.md'), 'utf8')

  /** Each feed into a twin's doc of a body that is not its own. */
  const crossed = () =>
    vi
      .mocked(feedExternalEditToCrdt)
      .mock.calls.map(([id, markdown]) => [id, markdown])
      .filter(
        ([id, markdown]) =>
          (id === 'lower' && markdown.includes('upper')) ||
          (id === 'upper' && markdown.includes('lower'))
      )

  /** Vault open order: heal, replay missed removals, then the walk. */
  async function openVault(): Promise<void> {
    await healCaseVariantRows(vault.path)
    await startWatcher(vault.path)
    await getWatcher().replayMissedRemovals()
    await indexVault(vault.path)
    await flushProjectionEvents()
    await drainIngestBackfill()
    await flushProjectionEvents()
  }

  async function docOf(markdown: string): Promise<Y.Doc> {
    const doc = new Y.Doc()
    await markdownToYFragment(markdown, doc.getXmlFragment('prosemirror'), 'Supernotes/a.md')
    return doc
  }

  async function writeBack(id: string, markdown: string): Promise<void> {
    const doc = await docOf(markdown)
    docs.set(id, doc)
    await writebackNow(id, doc)
  }

  /** The twins, the upper body last on disk, after one vault open. */
  async function twins(lowerPath = 'SuperNotes/a.md'): Promise<void> {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'), { recursive: true })
    seed('lower', lowerPath, LOWER)
    seed('upper', 'SUPERNOTES/a.md', UPPER)
    await openVault()
    docs.set('lower', await docOf(LOWER))
    docs.set('upper', await docOf(UPPER))
  }

  it('one vault open keeps both twins when one already spells the disk folder', async () => {
    await twins('Supernotes/a.md')
    await writeBack('lower', LOWER)

    expect({ rows: rowIds(), crossed: crossed() }).toEqual({
      rows: ['lower', 'upper'],
      crossed: []
    })
  }, 30_000)

  // A twin that never synced has its own body all the same: the one on disk.
  it('one vault open keeps a never-synced twin whose body is on disk', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    seed('lower', 'Supernotes/a.md', LOWER)
    seed('upper', 'SUPERNOTES/a.md', UPPER, false)
    await openVault()
    await writeBack('lower', LOWER)

    expect({ rows: rowIds(), crossed: crossed() }).toEqual({
      rows: ['lower', 'upper'],
      crossed: []
    })
  }, 30_000)

  // The take refuses a twin's file, so the marker stays, and a full-state row
  // queued on each pass would only queue the next one.
  it('a twin that owes its file is not queued again for a take that refuses it', async () => {
    await twins()
    recordOwedFileBody('lower')

    await writeBack('lower', LOWER)

    expect(getCrdtProvider().recordOwedFullState).not.toHaveBeenCalled()
  }, 30_000)

  it('a second vault open keeps both twins apart', async () => {
    await twins()
    await writeBack('lower', LOWER)
    await writeBack('upper', UPPER)
    await stopWatcher()
    await openVault()
    await writeBack('lower', LOWER)

    expect({ rows: rowIds(), crossed: crossed() }).toEqual({
      rows: ['lower', 'upper'],
      crossed: []
    })
  }, 30_000)

  it('moving a block into a twin fails and leaves the shared file alone', async () => {
    await twins()
    seed('source', 'Other/s.md', '# s\n\nsource\n')

    await expect(
      appendBlocksToNote({ sourceNoteId: 'source', targetNoteId: 'lower', markdown: 'moved' })
    ).rejects.toThrow('errors:note.appendIntoCaseTwin')
    expect({ file: shared(), crossed: crossed() }).toEqual({ file: UPPER, crossed: [] })
  }, 30_000)

  it('renaming a note the twins link to leaves their shared file alone', async () => {
    seed('x', 'Other/x.md', '# x\n\nx\n')
    await twins()
    // Each twin's links, as the index reads them from its own body.
    for (const [id, body] of [
      ['lower', LOWER],
      ['upper', UPPER]
    ] as const) {
      const row = data.db.select().from(noteMetadata).where(eq(noteMetadata.id, id)).get()!
      const parsed = parseNote(body, row.path)
      syncNoteToCache(
        index.db,
        {
          id,
          path: row.path,
          fileContent: body,
          frontmatter: parsed.frontmatter,
          parsedContent: parsed.content,
          title: 'a',
          createdAt: row.createdAt,
          modifiedAt: row.modifiedAt
        },
        { isNew: false }
      )
    }
    await flushProjectionEvents()
    expect(getInboundLinkSourceIds(index.db, 'x', 'x', 'Other/x.md').toSorted()).toEqual([
      'lower',
      'upper'
    ])

    await rewriteInboundWikiLinks({
      noteId: 'x',
      from: { title: 'x', pathStem: 'Other/x' },
      to: { title: 'y', pathStem: 'Other/y' },
      oldPath: 'Other/x.md',
      newPath: 'Other/y.md'
    })

    expect({ file: shared(), crossed: crossed() }).toEqual({ file: UPPER, crossed: [] })
  }, 30_000)

  it('deleting a twin drops its row and keeps the file the other twin shares', async () => {
    await twins()

    await deleteNoteCommand('lower')

    expect({
      file: shared(),
      rows: rowIds(),
      syncedDeletes: vi.mocked(enqueueLocalSyncDelete).mock.calls
    }).toEqual({ file: UPPER, rows: ['upper'], syncedDeletes: [['note', 'lower']] })
  }, 30_000)

  it('deleting a note with no twin removes its file', async () => {
    await twins()
    seed('solo', 'Other/s.md', '# s\n\nsolo\n')

    await deleteNoteCommand('solo')

    expect({
      exists: fs.existsSync(path.join(vault.path, 'Other/s.md')),
      rows: rowIds()
    }).toEqual({ exists: false, rows: ['lower', 'upper'] })
  }, 30_000)
})
