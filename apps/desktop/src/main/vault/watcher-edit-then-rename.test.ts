/**
 * An outside edit, then a rename while the watcher still holds the edit's
 * change: the index row carries the hash from before the edit, and the renamed
 * file has the edited hash. The rename keeps the note's id and syncs no delete
 * (#5518). A delete of the edited file plus an unrelated new file of the same
 * size and mtime stays a delete and a create.
 *
 * @module vault/watcher-edit-then-rename.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
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
import type * as Chokidar from 'chokidar'

vi.mock('electron', () => ({
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
vi.mock('../sync/crdt-provider', () => ({
  ORIGIN_LOCAL: 'local',
  getCrdtProvider: vi.fn(() => ({
    initForNote: vi.fn(async () => {}),
    updateMeta: vi.fn(),
    getDoc: () => undefined,
    recordOwedFullState: vi.fn(),
    hasPersistence: () => true,
    awaitPendingInit: async () => {},
    readOnlyStore: () => ({ docNames: async () => [], updates: async () => [] }),
    withDocLoaded: async (_id: string, run: () => void) => run(),
    purge: async () => {}
  }))
}))
vi.mock('../sync/attachment-backfill', () => ({ queueEmbeddedVaultFiles: vi.fn() }))
vi.mock('../sync/crdt-external-feed', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  feedExternalEditToCrdt: vi.fn(async () => false)
}))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => 0)
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
// Tells the test when the app's watcher hears a change: a listener on its own
// chokidar watcher, added before the app's, so the app's runs in the same emit.
const changeHeard = vi.hoisted(() => ({ path: '', resolve: () => {} }))
vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof Chokidar>()
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) =>
      actual.watch(...args).on('change', (filePath: string) => {
        if (filePath === changeHeard.path) changeHeard.resolve()
      })
  }
})
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
import { enqueueLocalSyncDelete } from '../sync/local-mutations'
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { generateContentHash } from './frontmatter'
import { clearIngestBackfill, drainIngestBackfill } from './ingest-backfill'
import {
  clearAllPendingDeletes,
  registerRenameSyncCallback,
  unregisterRenameSyncCallback
} from './rename-tracker'
import { startWatcher, stopWatcher } from './watcher'

function fileSystemIgnoresCase(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-case-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '')
    return fs.existsSync(path.join(dir, 'PROBE'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const renameSynced = vi.fn()

describe('an outside edit followed by a rename inside the change debounce', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('edit-then-rename')
    // The watcher takes a vault without its database for one that went away.
    fs.writeFileSync(path.join(vault.memryDir, 'data.db'), '')
    fs.mkdirSync(path.join(vault.path, 'Sentinel'))
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getClientDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getClientIndexDatabase).mockReturnValue(index.db)
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    vi.mocked(getStatus).mockReturnValue({
      isOpen: true,
      path: vault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    })
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
    registerRenameSyncCallback(renameSynced)
  })

  afterEach(async () => {
    unregisterRenameSyncCallback()
    await stopWatcher()
    await stopProjectionRuntime({ drain: true })
    clearIngestBackfill()
    clearAllPendingDeletes()
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  /** A note the index has read: canonical row, index row with its hash, file. */
  function seed(id: string, relativePath: string, body: string): void {
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, '.md'),
      fileType: 'markdown' as const,
      emoji: null,
      localOnly: false,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: '2026-01-12T00:00:00.000Z',
      fileSize: Buffer.byteLength(body)
    }
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, { ...fields, contentHash: generateContentHash(body) })
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, body)
  }

  /** The edit reached the note's doc under the note's own id. */
  const editFedTo = (id: string) =>
    vi
      .mocked(feedExternalEditToCrdt)
      .mock.calls.some(([noteId, body]) => noteId === id && body.includes('body edited'))

  const metadataRows = () =>
    data.db
      .select({ id: noteMetadata.id, path: noteMetadata.path })
      .from(noteMetadata)
      .all()
      .filter((row) => !row.path.startsWith('Sentinel/'))

  async function settleOn(expected: () => void): Promise<void> {
    await vi.waitFor(
      async () => {
        await flushProjectionEvents()
        expected()
      },
      { timeout: 10_000, interval: 100 }
    )
    await drainIngestBackfill()
    await flushProjectionEvents()
  }

  /** An outside file whose add marks that the watcher handled every event before it. */
  async function watch(): Promise<void> {
    await startWatcher(vault.path)
    const relativePath = 'Sentinel/s.md'
    let writtenAt = 0
    // fsevents can drop a write made right after the watcher starts.
    await settleOn(() => {
      if (
        data.db
          .select()
          .from(noteMetadata)
          .all()
          .some((row) => row.path === relativePath)
      )
        return
      if (Date.now() - writtenAt > 1000) {
        writtenAt = Date.now()
        fs.writeFileSync(path.join(vault.path, relativePath), `sentinel ${writtenAt}\n`)
      }
      throw new Error(`waiting for ${relativePath}`)
    })
  }

  /**
   * Writes `body` to the file outside the app and runs `then` the moment the
   * app's watcher hears the save, so `then` lands inside the watcher's 100 ms
   * change debounce, before the edit is indexed.
   */
  async function editThen(relativePath: string, body: string, then: () => void): Promise<void> {
    const absolutePath = path.join(vault.path, relativePath)
    const heard = new Promise<void>((resolve) => {
      changeHeard.path = absolutePath
      changeHeard.resolve = resolve
    })
    fs.writeFileSync(absolutePath, body)
    await heard
    changeHeard.path = ''
    then()
  }

  /**
   * Writes `body` to the file outside the app and runs `then` 20 ms later,
   * inside chokidar's write-finish wait, so the app never hears the edit as a
   * change (#5549).
   */
  async function editThenBeforeChange(
    relativePath: string,
    body: string,
    then: () => void
  ): Promise<void> {
    const absolutePath = path.join(vault.path, relativePath)
    let heard = false
    changeHeard.path = absolutePath
    changeHeard.resolve = () => {
      heard = true
    }
    fs.writeFileSync(absolutePath, body)
    await new Promise((resolve) => setTimeout(resolve, 20))
    then()
    changeHeard.path = ''
    expect(heard).toBe(false)
  }

  it('a rename inside the write-finish wait after an outside edit keeps the note id', async () => {
    seed('n1', 'Docs/apple.md', '# apple\n\nbody\n')
    await watch()
    await editThenBeforeChange('Docs/apple.md', '# apple\n\nbody edited\n', () =>
      fs.renameSync(path.join(vault.path, 'Docs/apple.md'), path.join(vault.path, 'Docs/pear.md'))
    )
    await settleOn(() => expect(renameSynced).toHaveBeenCalledWith('n1'))

    await settleOn(() => expect(editFedTo('n1')).toBe(true))
    expect(metadataRows()).toEqual([{ id: 'n1', path: 'Docs/pear.md' }])
    expect(enqueueLocalSyncDelete).not.toHaveBeenCalled()
  }, 20_000)

  it.runIf(fileSystemIgnoresCase())(
    'a case-only rename inside the write-finish wait after an outside edit keeps the note id',
    async () => {
      seed('n1', 'Docs/apple.md', '# apple\n\nbody\n')
      await watch()
      await editThenBeforeChange('Docs/apple.md', '# apple\n\nbody edited\n', () =>
        fs.renameSync(
          path.join(vault.path, 'Docs/apple.md'),
          path.join(vault.path, 'Docs/Apple.md')
        )
      )
      await settleOn(() => expect(renameSynced).toHaveBeenCalledWith('n1'))

      await settleOn(() => expect(editFedTo('n1')).toBe(true))
      expect(metadataRows()).toEqual([{ id: 'n1', path: 'Docs/Apple.md' }])
      expect(enqueueLocalSyncDelete).not.toHaveBeenCalled()
    },
    20_000
  )

  it('a rename right after an outside edit keeps the note id', async () => {
    seed('n1', 'Docs/apple.md', '# apple\n\nbody\n')
    await watch()
    await editThen('Docs/apple.md', '# apple\n\nbody edited\n', () =>
      fs.renameSync(path.join(vault.path, 'Docs/apple.md'), path.join(vault.path, 'Docs/pear.md'))
    )
    await settleOn(() => expect(renameSynced).toHaveBeenCalledWith('n1'))

    await settleOn(() => expect(editFedTo('n1')).toBe(true))
    expect(metadataRows()).toEqual([{ id: 'n1', path: 'Docs/pear.md' }])
    expect(enqueueLocalSyncDelete).not.toHaveBeenCalled()
  }, 20_000)

  it.runIf(fileSystemIgnoresCase())(
    'a case-only rename right after an outside edit keeps the note id',
    async () => {
      seed('n1', 'Docs/apple.md', '# apple\n\nbody\n')
      await watch()
      await editThen('Docs/apple.md', '# apple\n\nbody edited\n', () =>
        fs.renameSync(
          path.join(vault.path, 'Docs/apple.md'),
          path.join(vault.path, 'Docs/Apple.md')
        )
      )
      await settleOn(() => expect(renameSynced).toHaveBeenCalledWith('n1'))

      await settleOn(() => expect(editFedTo('n1')).toBe(true))
      expect(metadataRows()).toEqual([{ id: 'n1', path: 'Docs/Apple.md' }])
      expect(enqueueLocalSyncDelete).not.toHaveBeenCalled()
    },
    20_000
  )

  /**
   * Deletes the edited file and writes an unrelated file of the same size,
   * whose mtime is pinned to the deleted file's: same-mtime files are common
   * (1-2 s mtime filesystems, `cp -p`, `rsync -t`, unzip, sync clients).
   */
  function deleteAndWriteLookalike(relativePath: string, lookalikePath: string, body: string) {
    const absolutePath = path.join(vault.path, relativePath)
    const { atime, mtime } = fs.statSync(absolutePath)
    fs.unlinkSync(absolutePath)
    const lookalike = path.join(vault.path, lookalikePath)
    fs.writeFileSync(lookalike, body)
    fs.utimesSync(lookalike, atime, mtime)
  }

  async function expectDeleteAndCreate(): Promise<void> {
    await settleOn(() => {
      expect(enqueueLocalSyncDelete).toHaveBeenCalledWith('note', 'n1')
      expect(metadataRows().map((row) => row.path)).toEqual(['Docs/pear.md'])
    })
    expect(metadataRows()[0]?.id).not.toBe('n1')
    expect(renameSynced).not.toHaveBeenCalled()
  }

  // Same size and mtime as the edited body, so only the file's identity tells them apart.
  it('a delete right after an outside edit, plus an unrelated same-size same-mtime file, stays a delete and a create', async () => {
    seed('n1', 'Docs/apple.md', '# apple\n\nbody\n')
    await watch()
    await editThen('Docs/apple.md', '# apple\n\nbody edited\n', () =>
      deleteAndWriteLookalike('Docs/apple.md', 'Docs/pear.md', '# pear!\n\nbody edited\n')
    )
    await expectDeleteAndCreate()
  }, 20_000)

  it('a delete inside the write-finish wait after an outside edit, plus an unrelated same-size same-mtime file, stays a delete and a create', async () => {
    seed('n1', 'Docs/apple.md', '# apple\n\nbody\n')
    await watch()
    await editThenBeforeChange('Docs/apple.md', '# apple\n\nbody edited\n', () =>
      deleteAndWriteLookalike('Docs/apple.md', 'Docs/pear.md', '# pear!\n\nbody edited\n')
    )
    await expectDeleteAndCreate()
  }, 20_000)

  it('a delete long after an outside edit settled, plus an unrelated same-size same-mtime file, stays a delete and a create', async () => {
    seed('n1', 'Docs/apple.md', '# apple\n\nbody\n')
    await watch()
    await editThen('Docs/apple.md', '# apple\n\nbody edited\n', () => {})
    await settleOn(() => expect(editFedTo('n1')).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 3000))

    deleteAndWriteLookalike('Docs/apple.md', 'Docs/pear.md', '# pear!\n\nbody edited\n')
    await expectDeleteAndCreate()
  }, 25_000)

  // The index has not read the body yet, so the rename matches by size + mtime;
  // there is no earlier hash for the renamed file to differ from.
  it('a rename of a note the index has not read does not read its body', async () => {
    seed('n1', 'Docs/apple.md', '# apple\n\nbody\n')
    const modifiedAt = new Date('2026-01-12T00:00:00.000Z')
    fs.utimesSync(path.join(vault.path, 'Docs/apple.md'), modifiedAt, modifiedAt)
    await watch()
    // fsevents can replay the seed's write as a change, which reads the body
    // and fills the hash, so the hash is taken away after that settles.
    await new Promise((resolve) => setTimeout(resolve, 500))
    await flushProjectionEvents()
    index.db.update(noteCache).set({ contentHash: null }).where(eq(noteCache.id, 'n1')).run()
    vi.mocked(feedExternalEditToCrdt).mockClear()

    fs.renameSync(path.join(vault.path, 'Docs/apple.md'), path.join(vault.path, 'Docs/pear.md'))
    await settleOn(() => expect(renameSynced).toHaveBeenCalledWith('n1'))

    expect(metadataRows()).toEqual([{ id: 'n1', path: 'Docs/pear.md' }])
    expect(feedExternalEditToCrdt).not.toHaveBeenCalled()
  }, 20_000)
})
