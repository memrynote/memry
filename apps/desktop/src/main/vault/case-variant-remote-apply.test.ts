/**
 * A note or attachment that sync applies at `SuperNotes/a.md` lands in an
 * existing `Supernotes/` folder on a case-insensitive disk. The watcher and
 * the vault-open indexer see the disk spelling, and must match it to the
 * applied row: same id, no new row, no create pushed (#5261).
 *
 * @module vault/case-variant-remote-apply.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
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
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))
vi.mock('../sync/crdt-provider', () => ({
  getCrdtProvider: vi.fn(() => ({ initForNote: vi.fn(async () => {}), updateMeta: vi.fn() }))
}))
vi.mock('../sync/attachment-backfill', () => ({ queueEmbeddedVaultFiles: vi.fn() }))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => false) }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => 0)
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))

import { getDatabase, getIndexDatabase } from '../database'
import { getStatus } from './index'
import { enqueueLocalSyncCreate } from '../sync/local-mutations'
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { markWritebackIgnored } from '../sync/crdt-writeback'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { generateContentHash } from './frontmatter'
import { healCaseVariantRows } from './case-variant-heal'
import { clearIngestBackfill, drainIngestBackfill } from './ingest-backfill'
import { indexVault } from './indexer'
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

describe.runIf(fileSystemIgnoresCase())('remote apply into a case-variant folder', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('case-variant-apply')
    // The watcher takes a vault without its database for one that went away.
    fs.writeFileSync(path.join(vault.memryDir, 'data.db'), '')
    // The folder this device already has, in the other spelling.
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
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

  /**
   * What the note handler leaves after applying a remote create: the canonical
   * row and its index row at the remote spelling, and the file written there,
   * which the disk puts in the existing folder.
   */
  function applyRemote(
    id: string,
    relativePath: string,
    body: string,
    options: { indexed: boolean }
  ): void {
    const isMarkdown = relativePath.endsWith('.md')
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, path.extname(relativePath)),
      fileType: isMarkdown ? ('markdown' as const) : ('image' as const),
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    }
    data.db.insert(noteMetadata).values(fields).run()
    if (options.indexed) {
      insertNoteCache(index.db, {
        ...fields,
        fileSize: body.length,
        contentHash: isMarkdown ? generateContentHash(body) : null
      })
    }
    const absolutePath = path.join(vault.path, relativePath)
    markWritebackIgnored(absolutePath)
    fs.writeFileSync(absolutePath, body)
  }

  const metadataRows = () =>
    data.db
      .select({ id: noteMetadata.id, path: noteMetadata.path })
      .from(noteMetadata)
      .all()
      .toSorted((a, b) => a.id.localeCompare(b.id))

  const cacheRows = () =>
    index.db
      .select({ id: noteCache.id, path: noteCache.path })
      .from(noteCache)
      .all()
      .toSorted((a, b) => a.id.localeCompare(b.id))

  async function settleWatcher(): Promise<void> {
    await sleep(1500)
    await drainIngestBackfill()
    await flushProjectionEvents()
  }

  it('the watcher keeps the applied note and attachment ids and pushes no create', async () => {
    await startWatcher(vault.path)
    applyRemote('remote-note', 'SuperNotes/a.md', '# a\n\nbody\n', { indexed: true })
    applyRemote('remote-file', 'SuperNotes/p.png', 'png-bytes', { indexed: true })
    await settleWatcher()

    expect(metadataRows()).toEqual([
      { id: 'remote-file', path: 'Supernotes/p.png' },
      { id: 'remote-note', path: 'Supernotes/a.md' }
    ])
    expect(cacheRows()).toEqual(metadataRows())
    expect(enqueueLocalSyncCreate).not.toHaveBeenCalled()

    // A later edit of the file is an edit of the applied note.
    fs.writeFileSync(path.join(vault.path, 'Supernotes/a.md'), '# a\n\nedited\n')
    await settleWatcher()

    expect(feedExternalEditToCrdt).toHaveBeenCalledWith(
      'remote-note',
      expect.stringContaining('edited'),
      expect.anything()
    )
    expect(enqueueLocalSyncCreate).not.toHaveBeenCalled()
    expect(metadataRows()).toHaveLength(2)
  }, 20_000)

  // Two remote notes whose paths differ only in case share one file here, so
  // the second write replaces the first body on disk (follow-up in #5261).
  // The file still belongs to the row the disk spells: neither row is
  // re-keyed onto the other, and nothing is pushed.
  it('keeps both rows of two remote notes that share one file', async () => {
    await startWatcher(vault.path)
    applyRemote('remote-lower', 'Supernotes/a.md', '# a\n\nlower\n', { indexed: true })
    applyRemote('remote-upper', 'SuperNotes/a.md', '# a\n\nupper\n', { indexed: true })
    await settleWatcher()

    expect(metadataRows()).toEqual([
      { id: 'remote-lower', path: 'Supernotes/a.md' },
      { id: 'remote-upper', path: 'SuperNotes/a.md' }
    ])
    expect(fs.readFileSync(path.join(vault.path, 'Supernotes/a.md'), 'utf8')).toContain('upper')
    expect(enqueueLocalSyncCreate).not.toHaveBeenCalled()
  }, 20_000)

  it('vault open keeps the applied rows when the index is rebuilt', async () => {
    applyRemote('remote-note', 'SuperNotes/a.md', '# a\n\nbody\n', { indexed: false })
    applyRemote('remote-file', 'SuperNotes/p.png', 'png-bytes', { indexed: false })

    // The open-time order: heal, then the walk.
    await healCaseVariantRows(vault.path)
    await indexVault(vault.path)
    await flushProjectionEvents()
    // The next open heals the rows the last one indexed.
    await healCaseVariantRows(vault.path)

    expect(metadataRows()).toEqual([
      { id: 'remote-file', path: 'Supernotes/p.png' },
      { id: 'remote-note', path: 'Supernotes/a.md' }
    ])
    expect(cacheRows()).toEqual(metadataRows())
    expect(enqueueLocalSyncCreate).not.toHaveBeenCalled()
  })
})
