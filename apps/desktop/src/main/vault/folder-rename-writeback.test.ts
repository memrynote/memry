/**
 * A note's write-back never writes the path its folder had before a rename
 * (#5671). A pass takes its note's path from the index row it read, so a pass
 * that read the row before the folder moved would write the old path after:
 * it makes the old folder again with the note's body in it, puts the note's
 * rows back there, and the next vault open lists the file left at the new
 * path as a second note.
 *
 * @module vault/folder-rename-writeback.test
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
import { getNoteCacheById, insertNoteCache } from '@main/database/queries/notes'
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
    awaitPendingInit: async () => {},
    readOnlyStore: () => ({ docNames: async () => [], updates: async () => [] }),
    isNoteLocalOnly: () => false,
    isAwaitingMerge: () => false,
    open: vi.fn(async (id: string) => docs.get(id)),
    withDocLoaded: vi.fn(async (_id: string, run: () => void) => run()),
    closeIfInactive: async () => {},
    whenPersisted: async () => {},
    purge: vi.fn(async () => {})
  }
  return { ORIGIN_LOCAL: 'local', getCrdtProvider: vi.fn(() => stub) }
})
vi.mock('../sync/attachment-backfill', () => ({ queueEmbeddedVaultFiles: vi.fn() }))
vi.mock('./file-ops', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...real, atomicWrite: vi.fn(real.atomicWrite as never) }
})
vi.mock('./move-directory', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...real, moveDirectory: vi.fn(real.moveDirectory as never) }
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
import { markdownToYFragment } from '../sync/blocknote-converter'
import { writebackNow } from '../sync/crdt-writeback'
import { readyWritebackConverter } from '../sync/converter-worker-bridge'
import { recordAppWrite } from './app-writes'
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
import { renameFolderCommand } from '../notes/domain'
import { atomicWrite } from './file-ops'
import { moveDirectory } from './move-directory'

const BODY = '# n\n\nplain body\n'
const EDITED = '# n\n\nplain edited\n'

describe('a write-back across its folder rename (#5671)', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('folder-rename-writeback')
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
    await stopProjectionRuntime({ drain: true })
    clearIngestBackfill()
    clearAllPendingDeletes()
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  /** A synced note at `Folder/n.md`, as a pull leaves it, then one vault open. */
  async function seedNote(): Promise<void> {
    const relativePath = 'Folder/n.md'
    const fields = {
      id: 'plain',
      path: relativePath,
      title: 'n',
      fileType: 'markdown' as const,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: '2026-01-12T00:00:00.000Z',
      fileSize: Buffer.byteLength(BODY)
    }
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, { ...fields, contentHash: generateContentHash(BODY) })
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    const landed = recordAppWrite(absolutePath, BODY)
    fs.writeFileSync(absolutePath, BODY)
    landed()
    await openVault()
  }

  async function openVault(): Promise<void> {
    await indexVault(vault.path)
    await flushProjectionEvents()
    await drainIngestBackfill()
    await flushProjectionEvents()
  }

  async function writeBack(markdown: string): Promise<void> {
    const doc = new Y.Doc()
    await markdownToYFragment(markdown, doc.getXmlFragment('prosemirror'), 'Folder/n.md')
    docs.set('plain', doc)
    await writebackNow('plain', doc)
  }

  const read = (relativePath: string) =>
    fs.existsSync(path.join(vault.path, relativePath))
      ? fs.readFileSync(path.join(vault.path, relativePath), 'utf8')
      : null

  /** Where the note and its edit are after the rename, then its rows after a vault open. */
  async function afterRename() {
    await flushProjectionEvents()
    const renamed = {
      row: data.db.select().from(noteMetadata).where(eq(noteMetadata.id, 'plain')).get()?.path,
      indexed: getNoteCacheById(index.db, 'plain')?.path,
      file: read('Renamed/n.md'),
      oldFolder: fs.existsSync(path.join(vault.path, 'Folder'))
    }
    await openVault()
    const rows = data.db.select({ path: noteMetadata.path }).from(noteMetadata).all()
    return { ...renamed, reopened: rows.map((row) => row.path).toSorted() }
  }

  const RENAMED_WITH_EDIT = {
    row: 'Renamed/n.md',
    indexed: 'Renamed/n.md',
    file: expect.stringContaining('plain edited'),
    oldFolder: false,
    reopened: ['Renamed/n.md']
  }

  it("a folder rename waits for a note's write-back in flight", async () => {
    await seedNote()
    let release = (): void => {}
    let reached = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const atWrite = new Promise<void>((resolve) => (reached = resolve))
    const real = vi.mocked(atomicWrite).getMockImplementation()!
    vi.mocked(atomicWrite).mockImplementation(async (filePath, content) => {
      if (content.includes('plain edited')) {
        reached()
        await gate
      }
      return real(filePath, content)
    })
    const pass = writeBack(EDITED)
    await atWrite

    const renaming = renameFolderCommand('Folder', 'Renamed')
    try {
      // Long enough for the rename to move the folder if nothing held it back.
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      release()
    }
    await pass
    await renaming

    expect(await afterRename()).toEqual(RENAMED_WITH_EDIT)
  }, 30_000)

  it('a write-back that starts while its folder moves waits for the rename', async () => {
    await seedNote()
    await readyWritebackConverter()
    let release = (): void => {}
    let reached = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const moved = new Promise<void>((resolve) => (reached = resolve))
    const real = vi.mocked(moveDirectory).getMockImplementation()!
    vi.mocked(moveDirectory).mockImplementationOnce(async (from, to) => {
      await real(from, to)
      reached()
      await gate
    })

    const renaming = renameFolderCommand('Folder', 'Renamed')
    let pass: Promise<void> = Promise.resolve()
    try {
      await moved
      pass = writeBack(EDITED)
      // Long enough for the pass to write if nothing held it back.
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      release()
    }
    await renaming
    await pass

    expect(await afterRename()).toEqual(RENAMED_WITH_EDIT)
  }, 30_000)
})
