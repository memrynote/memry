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
import { eq } from 'drizzle-orm'
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
import { listNoteMetadataByFoldedPath, upsertNoteMetadata } from '@memry/storage-data'

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
vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: vi.fn()
}))

import { getDatabase, getIndexDatabase } from '../database'
import { getDatabase as getClientDatabase } from '../database/client'
import { oweUnsyncedFileBody, owesFileBody } from '../sync/crdt-owed-file-body'
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
import {
  clearAllPendingDeletes,
  registerRenameSyncCallback,
  unregisterRenameSyncCallback
} from './rename-tracker'
import { findCanonicalNoteForFile } from './note-sync'
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

describe.runIf(fileSystemIgnoresCase())('remote apply into a case-variant folder', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('case-variant-apply')
    // The watcher takes a vault without its database for one that went away.
    fs.writeFileSync(path.join(vault.memryDir, 'data.db'), '')
    fs.mkdirSync(path.join(vault.path, 'Sentinel'))
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getClientDatabase).mockReturnValue(asClientDb(data.db))
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

  /**
   * A note or attachment as the vault holds it: the canonical row, its index
   * row unless `indexed` is false, and the file written at the row's spelling,
   * which the disk puts in a folder it already has in another case. A remote
   * apply also marks the write as its own, under the spelling it wrote.
   */
  function seed(
    id: string,
    relativePath: string,
    body: string,
    options: { indexed?: boolean; remote?: boolean; emoji?: string; localOnly?: boolean } = {}
  ): void {
    const isMarkdown = relativePath.endsWith('.md')
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, path.extname(relativePath)),
      fileType: isMarkdown ? ('markdown' as const) : ('image' as const),
      emoji: options.emoji ?? null,
      localOnly: options.localOnly ?? false,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: '2026-01-12T00:00:00.000Z'
    }
    // Through the repository, as sync and the indexer write rows.
    upsertNoteMetadata(asClientDb(data.db), fields)
    if (options.indexed !== false) {
      insertNoteCache(index.db, {
        ...fields,
        fileSize: body.length,
        contentHash: isMarkdown ? generateContentHash(body) : null
      })
    }
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    if (options.remote !== false) markWritebackIgnored(absolutePath)
    fs.writeFileSync(absolutePath, body)
  }

  const allMetadataRows = () =>
    data.db
      .select({ id: noteMetadata.id, path: noteMetadata.path })
      .from(noteMetadata)
      .all()
      .toSorted((a, b) => a.id.localeCompare(b.id))

  const isSentinel = (row: { path: string }) => row.path.startsWith('Sentinel/')

  const metadataRows = () => allMetadataRows().filter((row) => !isSentinel(row))

  const cacheRows = () =>
    index.db
      .select({ id: noteCache.id, path: noteCache.path })
      .from(noteCache)
      .all()
      .filter((row) => !isSentinel(row))
      .toSorted((a, b) => a.id.localeCompare(b.id))

  /** Note creates pushed for anything but a sentinel. */
  const noteCreates = () => {
    const sentinels = new Set(
      allMetadataRows()
        .filter(isSentinel)
        .map((row) => row.id)
    )
    return vi
      .mocked(enqueueLocalSyncCreate)
      .mock.calls.filter(([type, id]) => type === 'note' && !sentinels.has(id))
  }

  /** Waits until the watcher reached `expected`, then for the work it queued. */
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

  let sentinelCount = 0

  /**
   * An outside file whose own add marks that the watcher handled every event
   * before it: right after start, when fsevents can still miss a write, and
   * for an outcome where nothing changes.
   */
  async function passSentinel(): Promise<void> {
    sentinelCount += 1
    const relativePath = `Sentinel/s-${sentinelCount}.md`
    const absolutePath = path.join(vault.path, relativePath)
    // fsevents can drop a write made right after the watcher starts, so the
    // sentinel is written again until its add lands, each time after the
    // watcher's 100 ms write-finish window has had time to close.
    let writtenAt = 0
    await settleOn(() => {
      if (allMetadataRows().some((row) => row.path === relativePath)) return
      if (Date.now() - writtenAt > 1000) {
        writtenAt = Date.now()
        fs.writeFileSync(absolutePath, `sentinel ${writtenAt}\n`)
      }
      throw new Error(`waiting for ${relativePath}`)
    })
  }

  async function watch(): Promise<void> {
    await startWatcher(vault.path)
    await passSentinel()
  }

  it('the watcher keeps the applied note and attachment ids and pushes no create', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    await watch()
    seed('remote-note', 'SuperNotes/a.md', '# a\n\nbody\n')
    seed('remote-file', 'SuperNotes/p.png', 'png-bytes')
    const expected = [
      { id: 'remote-file', path: 'Supernotes/p.png' },
      { id: 'remote-note', path: 'Supernotes/a.md' }
    ]
    await settleOn(() => expect(cacheRows()).toEqual(expected))

    expect(metadataRows()).toEqual(expected)
    expect(noteCreates()).toEqual([])
    expect(renameSynced).not.toHaveBeenCalled()

    // A later edit of the file is an edit of the applied note.
    fs.writeFileSync(path.join(vault.path, 'Supernotes/a.md'), '# a\n\nedited\n')
    await settleOn(() =>
      expect(feedExternalEditToCrdt).toHaveBeenCalledWith(
        'remote-note',
        expect.stringContaining('edited'),
        expect.anything()
      )
    )
    expect(noteCreates()).toEqual([])
    expect(metadataRows()).toEqual(expected)
  }, 20_000)

  // The file's mtime is sync's own write. Stamped onto the row, a note that was
  // only pulled reads as edited since its sync, and the first pull into a doc
  // the store never held takes the file over the server body (#5276).
  it('the watcher leaves an applied note synced, so the pull merges its server body', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    await watch()
    seed('remote-note', 'SuperNotes/a.md', '# a\n\nbody\n')
    seed('remote-file', 'SuperNotes/p.png', 'png-bytes')
    await settleOn(() =>
      expect(metadataRows()).toEqual([
        { id: 'remote-file', path: 'Supernotes/p.png' },
        { id: 'remote-note', path: 'Supernotes/a.md' }
      ])
    )

    const modified = data.db
      .select({ id: noteMetadata.id, modifiedAt: noteMetadata.modifiedAt })
      .from(noteMetadata)
      .all()
      .filter((row) => !row.id.startsWith('Sentinel'))
    expect(modified).toEqual(
      expect.arrayContaining([
        { id: 'remote-note', modifiedAt: '2026-01-12T00:00:00.000Z' },
        { id: 'remote-file', modifiedAt: '2026-01-12T00:00:00.000Z' }
      ])
    )
    oweUnsyncedFileBody('remote-note')
    expect(owesFileBody('remote-note')).toBe(false)
  }, 20_000)

  it('the watcher keeps the emoji of an applied attachment', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    await watch()
    seed('remote-file', 'SuperNotes/p.png', 'png', { emoji: 'X' })
    await settleOn(() =>
      expect(metadataRows()).toEqual([{ id: 'remote-file', path: 'Supernotes/p.png' }])
    )
    const row = data.db
      .select({ emoji: noteMetadata.emoji })
      .from(noteMetadata)
      .where(eq(noteMetadata.id, 'remote-file'))
      .get()
    expect(row?.emoji).toBe('X')
  }, 20_000)

  // The projection runs behind the canonical write, so the index row can be
  // missing when the file arrives: the re-key takes emoji and local-only from
  // the canonical row.
  it('the watcher keeps the emoji and local-only flag of an applied note the index has not seen', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    await watch()
    seed('remote', 'SuperNotes/a.md', '# a\n\nbody\n', {
      emoji: 'X',
      indexed: false,
      localOnly: true
    })
    await settleOn(() =>
      expect(metadataRows()).toEqual([{ id: 'remote', path: 'Supernotes/a.md' }])
    )
    const row = data.db
      .select({ emoji: noteMetadata.emoji, localOnly: noteMetadata.localOnly })
      .from(noteMetadata)
      .where(eq(noteMetadata.id, 'remote'))
      .get()
    expect(row).toEqual({ emoji: 'X', localOnly: true })
  }, 20_000)

  it('the watcher keeps the id of a note applied into a non-ASCII case-variant folder', async () => {
    fs.mkdirSync(path.join(vault.path, 'ärzte'))
    await watch()
    seed('remote', 'Ärzte/a.md', '# a\n\nbody\n')
    await settleOn(() => expect(cacheRows()).toEqual([{ id: 'remote', path: 'ärzte/a.md' }]))
    expect(metadataRows()).toEqual([{ id: 'remote', path: 'ärzte/a.md' }])
    expect(noteCreates()).toEqual([])
  }, 20_000)

  // An HFS+ vault stores names decomposed (NFD), and sync writes them composed
  // (NFC). The volume ignores both case and normalization, so the row moves to
  // the spelling the disk stores, byte for byte.
  it('keeps the id of a note applied in NFC into an NFD case-variant folder', async () => {
    const nfdFolder = 'a\u0308rzte'
    fs.mkdirSync(path.join(vault.path, nfdFolder))
    await watch()
    seed('remote', '\u00c4rzte/a.md', '# a\n\nbody\n')
    const expected = [{ id: 'remote', path: `${nfdFolder}/a.md` }]
    await settleOn(() => expect(cacheRows()).toEqual(expected))
    expect(metadataRows()).toEqual(expected)
    expect(noteCreates()).toEqual([])
  }, 20_000)

  // APFS folds `İ` (U+0130) to `i` + U+0307, as `toLowerCase` does, not to a
  // plain `i`, so `İş/` and `iş/` are two folders on the disk and two notes
  // here: neither row may be merged onto the other.
  it('keeps a note in İş/ apart from a note in iş/', async () => {
    seed('local', 'iş/a.md', '# a\n\nlocal\n', { remote: false })
    await watch()
    seed('remote', 'İş/a.md', '# a\n\nremote\n')
    await passSentinel()

    expect(metadataRows()).toEqual([
      { id: 'local', path: 'iş/a.md' },
      { id: 'remote', path: 'İş/a.md' }
    ])
    expect(fs.readFileSync(path.join(vault.path, 'iş/a.md'), 'utf8')).toContain('local')
    expect(fs.readFileSync(path.join(vault.path, 'İş/a.md'), 'utf8')).toContain('remote')
    expect(noteCreates()).toEqual([])
  }, 20_000)

  it('an outside case-only file rename stays a synced rename', async () => {
    seed('n1', 'Docs/apple.md', '# apple\n\nbody\n', { remote: false })
    await watch()
    fs.renameSync(path.join(vault.path, 'Docs/apple.md'), path.join(vault.path, 'Docs/Apple.md'))
    await settleOn(() => expect(renameSynced).toHaveBeenCalledWith('n1'))

    expect(metadataRows()).toEqual([{ id: 'n1', path: 'Docs/Apple.md' }])
    const row = data.db
      .select({ title: noteMetadata.title })
      .from(noteMetadata)
      .where(eq(noteMetadata.id, 'n1'))
      .get()
    expect(row?.title).toBe('Apple')
  }, 20_000)

  // Two remote notes whose paths differ only in case share one file here, so
  // the second write replaces the first body on disk (#5263). The file still
  // belongs to the row the disk spells: neither row is re-keyed onto the
  // other, and nothing is pushed.
  it('keeps both rows of two remote notes that share one file', async () => {
    await watch()
    seed('remote-lower', 'Supernotes/a.md', '# a\n\nlower\n')
    seed('remote-upper', 'SuperNotes/a.md', '# a\n\nupper\n')
    await passSentinel()

    expect(metadataRows()).toEqual([
      { id: 'remote-lower', path: 'Supernotes/a.md' },
      { id: 'remote-upper', path: 'SuperNotes/a.md' }
    ])
    expect(fs.readFileSync(path.join(vault.path, 'Supernotes/a.md'), 'utf8')).toContain('upper')
    expect(noteCreates()).toEqual([])
  }, 20_000)

  it('vault open keeps the applied rows when the index is rebuilt', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    fs.mkdirSync(path.join(vault.path, 'ärzte'))
    seed('remote-note', 'SuperNotes/a.md', '# a\n\nbody\n', { indexed: false })
    seed('remote-file', 'SuperNotes/p.png', 'png-bytes', { indexed: false })
    seed('remote-umlaut', 'Ärzte/b.md', '# b\n\nbody\n', { indexed: false })

    // The open-time order: heal, then the walk.
    await healCaseVariantRows(vault.path)
    await indexVault(vault.path)
    await flushProjectionEvents()
    // The next open heals the rows the last one indexed.
    await healCaseVariantRows(vault.path)

    expect(metadataRows()).toEqual([
      { id: 'remote-file', path: 'Supernotes/p.png' },
      { id: 'remote-note', path: 'Supernotes/a.md' },
      { id: 'remote-umlaut', path: 'ärzte/b.md' }
    ])
    expect(cacheRows()).toEqual(metadataRows())
    expect(noteCreates()).toEqual([])
  })

  // The fold index is a cache of note_metadata: the exact path goes to the
  // table first, so a row the index has not seen is still found.
  it('finds a row the fold index missed by its exact path', () => {
    seed('seen', 'Docs/a.md', '# a\n', { remote: false })
    expect(findCanonicalNoteForFile(vault.path, 'Docs/none.md')).toBeNull()
    data.db
      .insert(noteMetadata)
      .values({
        id: 'unseen',
        path: 'Docs/b.md',
        title: 'b',
        createdAt: '2026-01-10T00:00:00.000Z',
        modifiedAt: '2026-01-12T00:00:00.000Z'
      })
      .run()
    fs.writeFileSync(path.join(vault.path, 'Docs/b.md'), '# b\n')

    expect(listNoteMetadataByFoldedPath(asClientDb(data.db), 'Docs/b.md')).toEqual([])
    expect(findCanonicalNoteForFile(vault.path, 'Docs/b.md')?.id).toBe('unseen')
  })
})
