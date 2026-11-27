/**
 * A folder rename carries every note of the folder to the new path, and a
 * case-only rename (`Supernotes` -> `SuperNotes`) on a case-insensitive file
 * system does too: one note per file, ids kept, no old-case folder left behind.
 *
 * @module vault/case-only-folder-rename.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'

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
vi.mock('../notes/runtime-effects', () => ({
  syncNoteCreate: vi.fn(),
  syncNoteDelete: vi.fn(),
  syncNoteUpdate: vi.fn(),
  setNoteLocalOnlyState: vi.fn(),
  cleanupProjectLinksForDeletedNote: vi.fn(),
  unlinkTasksFromDeletedNote: vi.fn(),
  queueEmbeddedVaultFiles: vi.fn()
}))
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))
vi.mock('../ipc/settings-handlers', () => ({ followFolderRenameInShortcuts: vi.fn() }))
vi.mock('../readwise/settings', () => ({ followFolderRenameInReadwise: vi.fn() }))
vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  enqueueJournalDelete: vi.fn(),
  initializeJournalCrdt: vi.fn()
}))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => false) }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => 0)
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))

import { getDatabase, getIndexDatabase } from '../database'
import { getStatus } from './index'
import { syncNoteCreate } from '../notes/runtime-effects'
import { renameFolderCommand } from '../notes/domain'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { DEFAULT_PROJECTION_QUEUE_LIMIT } from '../projections/bus'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { clearIngestBackfill } from './ingest-backfill'
import { clearAllPendingDeletes } from './rename-tracker'
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('folder rename', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('folder-rename')
    // The watcher takes a vault without its database for one that went away.
    fs.writeFileSync(path.join(vault.memryDir, 'data.db'), '')
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
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
    await stopWatcher()
    await stopProjectionRuntime({ drain: true })
    clearIngestBackfill()
    clearAllPendingDeletes()
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  /** A note on disk with its canonical and index rows, as an indexed vault has it. */
  function seedNote(id: string, relativePath: string): void {
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, `${id}\n`)
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, '.md'),
      fileType: 'markdown' as const,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    }
    insertNoteCache(index.db, { ...fields, fileSize: 13, contentHash: `hash-${id}` })
    data.db.insert(noteMetadata).values(fields).run()
  }

  const sortedPaths = (rows: Array<{ id: string; path: string }>) =>
    rows.map((row) => [row.id, row.path]).toSorted((a, b) => a[0].localeCompare(b[0]))

  it('moves every note of a folder larger than a projection lane holds', async () => {
    const count = DEFAULT_PROJECTION_QUEUE_LIMIT + 100
    for (let i = 0; i < count; i++) seedNote(`note-${i}`, `Big/Note ${i}.md`)

    await renameFolderCommand('Big', 'Moved')
    await flushProjectionEvents()

    const rows = index.db.select({ id: noteCache.id, path: noteCache.path }).from(noteCache).all()
    expect(rows.filter((row) => !row.path.startsWith('Moved/'))).toEqual([])
    expect(rows).toHaveLength(count)
  })

  it.runIf(fileSystemIgnoresCase())(
    'a case-only rename keeps one note per file and no old-case folder',
    async () => {
      const ids = Array.from({ length: 20 }, (_, i) => `note-${i}`)
      ids.forEach((id, i) => seedNote(id, `Supernotes/${i % 2 ? 'Sub/' : ''}${id}.md`))
      for (const folder of ['Supernotes', 'Supernotes/Sub']) {
        data.db
          .insert(folderConfigs)
          .values({ path: folder, icon: null, createdAt: 'x', modifiedAt: 'x' })
          .run()
      }
      await startWatcher(vault.path)

      await renameFolderCommand('Supernotes', 'SuperNotes')
      // chokidar reports the old spelling after the rename settles on disk.
      await sleep(3000)
      await flushProjectionEvents()

      const expected = ids.map((id, i) => [id, `SuperNotes/${i % 2 ? 'Sub/' : ''}${id}.md`])
      const select = { id: noteMetadata.id, path: noteMetadata.path }
      expect(sortedPaths(data.db.select(select).from(noteMetadata).all())).toEqual(
        expected.toSorted((a, b) => a[0].localeCompare(b[0]))
      )
      expect(
        sortedPaths(
          index.db.select({ id: noteCache.id, path: noteCache.path }).from(noteCache).all()
        )
      ).toEqual(expected.toSorted((a, b) => a[0].localeCompare(b[0])))
      expect(
        data.db
          .select({ path: folderConfigs.path })
          .from(folderConfigs)
          .all()
          .map((row) => row.path)
          .toSorted()
      ).toEqual(['SuperNotes', 'SuperNotes/Sub'])
      expect(syncNoteCreate).not.toHaveBeenCalled()
    },
    20_000
  )
})
