/**
 * A note or attachment that sync applies at `SuperNotes/a.md` lands in an
 * existing `Supernotes/` folder on a case-insensitive disk. The watcher and
 * the vault-open indexer see the disk spelling, and must match it to the
 * applied row: same id, no new row, no create pushed (#5261).
 *
 * @module vault/case-variant-remote-apply.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch as chokidarWatch } from 'chokidar'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
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
  ORIGIN_LOCAL: 'local',
  getCrdtProvider: vi.fn(() => ({
    initForNote: vi.fn(async () => {}),
    updateMeta: vi.fn(),
    getDoc: () => undefined,
    recordOwedFullState: vi.fn(),
    hasPersistence: () => true,
    awaitPendingInit: async () => {},
    readOnlyStore: () => ({ docNames: async () => [], updates: async () => [] })
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
import { oweUnsyncedFileBody, owesFileBody } from '../sync/crdt-owed-file-body'
import { getStatus } from './index'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'
import { feedExternalEditToCrdt, takeOwedFile } from '../sync/crdt-external-feed'
import { markdownToYFragment } from '../sync/blocknote-converter'
import { writebackNow } from '../sync/crdt-writeback'
import { recordAppWrite } from './app-writes'
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

/**
 * How long the app's watcher may take to hear a folder's change. macOS reports
 * one through FSEvents, which fseventsd delivers up to 30 s late when other
 * processes keep it busy, and a process's first stream starts late too. A test
 * waits on `watch` and up to two more folder events, 150 s in all.
 */
const FS_EVENTS_TIMEOUT_MS = 45_000

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
    options: {
      indexed?: boolean
      remote?: boolean
      emoji?: string
      localOnly?: boolean
      fileSize?: number
    } = {}
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
      syncedAt: '2026-01-12T00:00:00.000Z',
      fileSize: options.fileSize ?? Buffer.byteLength(body)
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
    const landed = options.remote !== false ? recordAppWrite(absolutePath, body) : null
    fs.writeFileSync(absolutePath, body)
    landed?.()
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
      { timeout: FS_EVENTS_TIMEOUT_MS, interval: 100 }
    )
    await drainIngestBackfill()
    await flushProjectionEvents()
  }

  /**
   * Two devices pull the note's server body into a store that never held its
   * doc, as a fresh download does, while a peer edits the note. Each decides
   * whether the doc owes the vault file, as `crdt-sync-coordinator` does, and
   * takes it as `CrdtProvider.takeFileAfterMerge` does. Answers how many copies
   * of the body the server ends with and whether the peer's edit survives.
   */
  async function pullOnTwoDevices(noteId: string, relativePath: string) {
    const raw = fs.readFileSync(path.join(vault.path, relativePath), 'utf8')
    const server = new Y.Doc()
    await markdownToYFragment(raw, server.getXmlFragment('prosemirror'), relativePath)
    const base = Y.encodeStateAsUpdate(server)
    const pushOf = async (edit: (doc: Y.Doc) => Promise<void>) => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, base)
      const before = Y.encodeStateVector(doc)
      await edit(doc)
      return Y.encodeStateAsUpdate(doc, before)
    }
    const devicePull = async (doc: Y.Doc) => {
      oweUnsyncedFileBody(noteId)
      if (owesFileBody(noteId))
        await takeOwedFile(noteId, doc, { path: relativePath, raw, title: 'a' })
    }
    const peerEdit = async (doc: Y.Doc) => {
      const texts = [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)]
      const text = texts.find((node) => node instanceof Y.XmlText && node.toString() === 'body')
      ;(text as Y.XmlText).insert(4, ' peer')
    }
    const pushes = [await pushOf(peerEdit), await pushOf(devicePull), await pushOf(devicePull)]

    const merged = new Y.Doc()
    Y.applyUpdate(merged, base)
    for (const push of pushes) Y.applyUpdate(merged, push)
    const body = merged.getXmlFragment('prosemirror').toJSON()
    return { copies: body.split('body').length - 1, peerEdit: body.includes('body peer') }
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
  }, 150_000)

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
    expect(await pullOnTwoDevices('remote-note', 'Supernotes/a.md')).toEqual({
      copies: 1,
      peerEdit: true
    })

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
  }, 150_000)

  it('the watcher pushes an applied attachment replaced before it was adopted', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    await watch()
    seed('replaced', 'SuperNotes/p.png', 'png-bytes')
    seed('downloading', 'SuperNotes/q.png', 'png-bytes', { fileSize: 0 })
    fs.writeFileSync(path.join(vault.path, 'Supernotes/p.png'), 'other-png-bytes')
    await settleOn(() =>
      expect(metadataRows()).toEqual([
        { id: 'downloading', path: 'Supernotes/q.png' },
        { id: 'replaced', path: 'Supernotes/p.png' }
      ])
    )
    await passSentinel()

    const unsynced = data.db
      .select({ id: noteMetadata.id, path: noteMetadata.path, modifiedAt: noteMetadata.modifiedAt })
      .from(noteMetadata)
      .all()
      .filter((row) => !isSentinel(row) && row.modifiedAt > '2026-01-12T00:00:00.000Z')
    const updates = vi
      .mocked(enqueueLocalSyncUpdate)
      .mock.calls.filter(([, id]) => id === 'replaced' || id === 'downloading')
    expect({ unsynced: unsynced.map((row) => row.id), updates }).toEqual({
      unsynced: ['replaced'],
      updates: [['note', 'replaced']]
    })
  }, 150_000)

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
  }, 150_000)

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
  }, 150_000)

  it('the watcher keeps the id of a note applied into a non-ASCII case-variant folder', async () => {
    fs.mkdirSync(path.join(vault.path, 'ärzte'))
    await watch()
    seed('remote', 'Ärzte/a.md', '# a\n\nbody\n')
    await settleOn(() => expect(cacheRows()).toEqual([{ id: 'remote', path: 'ärzte/a.md' }]))
    expect(metadataRows()).toEqual([{ id: 'remote', path: 'ärzte/a.md' }])
    expect(noteCreates()).toEqual([])
  }, 150_000)

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
  }, 150_000)

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
  }, 150_000)

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
  }, 150_000)

  // An outside save, then a case-only rename while the watcher still holds the
  // save's change: the change lands after the rename under the old spelling.
  // It stays a change of the note, so the rename keeps the id and syncs no
  // delete (#5247). fsevents replaying the seed write as a change made the
  // test above flaky the same way.
  it('a case-only rename right after an outside save keeps the note id', async () => {
    seed('n1', 'Docs/apple.md', '# apple\n\nbody\n', { remote: false })
    await watch()
    const oldPath = path.join(vault.path, 'Docs/apple.md')
    // Hears the save when the app's watcher does: same write-finish window.
    const observer = chokidarWatch(oldPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
    })
    try {
      await new Promise<void>((resolve) => observer.on('ready', resolve))
      const changed = new Promise((resolve) => observer.on('change', resolve))
      fs.writeFileSync(oldPath, '# apple\n\nbody\n')
      await changed
      fs.renameSync(oldPath, path.join(vault.path, 'Docs/Apple.md'))
    } finally {
      await observer.close()
    }
    await settleOn(() => expect(renameSynced).toHaveBeenCalledWith('n1'))

    expect(metadataRows()).toEqual([{ id: 'n1', path: 'Docs/Apple.md' }])
    expect(cacheRows()).toEqual([{ id: 'n1', path: 'Docs/Apple.md' }])
    expect(enqueueLocalSyncDelete).not.toHaveBeenCalled()
  }, 150_000)

  // The same rename made while the app is closed: vault open sees only the
  // new spelling, and the changed file name marks it as the user's rename,
  // not a folder spelling written by sync.
  it('vault open takes an offline case-only file rename as a local edit', async () => {
    seed('n1', 'Docs/apple.md', '# apple\n\nbody\n', { remote: false })
    fs.renameSync(path.join(vault.path, 'Docs/apple.md'), path.join(vault.path, 'Docs/Apple.md'))

    await indexVault(vault.path)
    await flushProjectionEvents()

    const row = data.db
      .select({
        path: noteMetadata.path,
        title: noteMetadata.title,
        modifiedAt: noteMetadata.modifiedAt
      })
      .from(noteMetadata)
      .where(eq(noteMetadata.id, 'n1'))
      .get()
    expect(row?.path).toBe('Docs/Apple.md')
    expect(row?.title).toBe('Apple')
    expect(row?.modifiedAt).not.toBe('2026-01-12T00:00:00.000Z')
  })

  // Two remote notes whose paths differ only in case share one file here, so
  // the second write replaces the first body on disk (#5263). The file still
  // belongs to the row the disk spells: neither row is re-keyed onto the
  // other, and nothing is pushed.
  it('the watcher pushes no applied attachment that shares its file with a case twin', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    await watch()
    seed('twin-small', 'SuperNotes/p.png', 'png')
    seed('twin-large', 'SUPERNOTES/p.png', 'larger-png-bytes')
    await passSentinel()

    const updates = vi
      .mocked(enqueueLocalSyncUpdate)
      .mock.calls.filter(([, id]) => id.startsWith('twin-'))
    expect(updates).toEqual([])
  }, 150_000)

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
  }, 150_000)

  /** Each feed of a file body into a doc, as the twin whose body it is. */
  const fedBodies = () =>
    vi
      .mocked(feedExternalEditToCrdt)
      .mock.calls.map(([id, markdown]) => [
        id,
        markdown.includes('upper') ? 'upper' : markdown.includes('lower') ? 'lower' : markdown
      ])

  // The shared file holds one twin's body, so neither note may take it as an
  // outside edit of its own: that pushes one note's body into the other (#5297).
  it('an outside edit to a file shared with a case twin feeds neither note', async () => {
    await watch()
    seed('remote-lower', 'Supernotes/a.md', '# a\n\nlower\n')
    seed('remote-upper', 'SuperNotes/a.md', '# a\n\nupper\n')
    seed('control', 'Supernotes/c.md', '# c\n\nbody\n')
    await passSentinel()
    // Past the window in which the watcher drops the apply's own writes. The
    // control note's edit lands in the same batch, and marks it handled.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 })
    try {
      fs.writeFileSync(path.join(vault.path, 'Supernotes/a.md'), '# a\n\nupper outside\n')
      fs.writeFileSync(path.join(vault.path, 'Supernotes/c.md'), '# c\n\nbody outside\n')
      await settleOn(() => expect(fedBodies().map(([id]) => id)).toContain('control'))
    } finally {
      vi.useRealTimers()
    }

    expect(fedBodies().filter(([id]) => id !== 'control')).toEqual([])
    expect(metadataRows().map((row) => row.id)).toEqual(['control', 'remote-lower', 'remote-upper'])
  }, 150_000)

  it('vault open leaves case twins sharing a file to their own bodies on write-back', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    seed('remote-lower', 'SuperNotes/a.md', '# a\n\nlower\n')
    seed('remote-upper', 'SUPERNOTES/a.md', '# a\n\nupper\n')

    await healCaseVariantRows(vault.path)
    await indexVault(vault.path)
    await flushProjectionEvents()
    await writebackNow('remote-lower', await storedDoc('# a\n\nlower\n', 'Supernotes/a.md'))
    await writebackNow('remote-upper', await storedDoc('# a\n\nupper\n', 'Supernotes/a.md'))

    expect({
      rows: metadataRows().map((row) => row.id),
      file: fs.readFileSync(path.join(vault.path, 'Supernotes/a.md'), 'utf8'),
      fed: fedBodies(),
      creates: noteCreates()
    }).toEqual({
      rows: ['remote-lower', 'remote-upper'],
      file: '# a\n\nupper\n',
      fed: [],
      creates: []
    })
  })

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

  // A restart before the watcher adopts the applied rows: the open-time walk
  // moves them to the disk's spelling, and sync's file mtime is no local edit
  // there either. The pull wrote their index rows under its own spelling.
  it('vault open leaves an applied note synced, so the pull merges its server body', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    seed('remote-note', 'SuperNotes/a.md', '# a\n\nbody\n')
    seed('remote-file', 'SuperNotes/p.png', 'png-bytes')

    await indexVault(vault.path)
    await flushProjectionEvents()

    expect(await pullOnTwoDevices('remote-note', 'Supernotes/a.md')).toEqual({
      copies: 1,
      peerEdit: true
    })
    expect(
      data.db
        .select({ id: noteMetadata.id, modifiedAt: noteMetadata.modifiedAt })
        .from(noteMetadata)
        .all()
    ).toEqual(
      expect.arrayContaining([
        { id: 'remote-note', modifiedAt: '2026-01-12T00:00:00.000Z' },
        { id: 'remote-file', modifiedAt: '2026-01-12T00:00:00.000Z' }
      ])
    )
  })

  // The fold index is a cache of note_metadata: the exact path goes to the
  // table first, so a row the index has not seen is still found.
  // Quit after the pull wrote the file, edited outside before the next open:
  // the walk finds a body other than the indexed one, a local edit.
  /** The doc the store holds for a pulled note: its body as the server has it. */
  async function storedDoc(markdown: string, relativePath: string): Promise<Y.Doc> {
    const doc = new Y.Doc()
    await markdownToYFragment(markdown, doc.getXmlFragment('prosemirror'), relativePath)
    return doc
  }

  // The store holds the pulled doc, so no pull owes the file. A remote update
  // writes the doc back after the walk, and must take the edit in, not
  // overwrite it.
  it('vault open leaves an outside edit for the doc to take, so a write-back keeps it', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    seed('remote-note', 'SuperNotes/a.md', '# a\n\nbody\n')
    fs.writeFileSync(path.join(vault.path, 'Supernotes/a.md'), '# a\n\noffline edit\n')

    await indexVault(vault.path)
    await flushProjectionEvents()
    await writebackNow('remote-note', await storedDoc('# a\n\nbody remote\n', 'Supernotes/a.md'))

    expect({
      file: fs.readFileSync(path.join(vault.path, 'Supernotes/a.md'), 'utf8'),
      fed: vi.mocked(feedExternalEditToCrdt).mock.calls.map(([id, markdown]) => [id, markdown])
    }).toEqual({
      file: '# a\n\noffline edit\n',
      fed: [['remote-note', expect.stringContaining('offline edit')]]
    })
  })

  it('vault open with no outside edit keeps the indexed hash and feeds nothing', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    seed('remote-note', 'SuperNotes/a.md', '# a\n\nbody\n')

    await indexVault(vault.path)
    await flushProjectionEvents()
    await writebackNow('remote-note', await storedDoc('# a\n\nbody\n', 'Supernotes/a.md'))

    expect({
      cache: index.db
        .select({ path: noteCache.path, contentHash: noteCache.contentHash })
        .from(noteCache)
        .where(eq(noteCache.id, 'remote-note'))
        .get(),
      fed: vi.mocked(feedExternalEditToCrdt).mock.calls.length
    }).toEqual({
      cache: { path: 'Supernotes/a.md', contentHash: generateContentHash('# a\n\nbody\n') },
      fed: 0
    })
  })

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

  // The fold finds candidates and the disk proves them with the same fold, so
  // a row sync spelled `STRASSE.md` matches the `straße.md` APFS holds for it.
  it('proves a candidate the disk folds beyond case, as the lookup does', () => {
    seed('sharp', 'Docs/STRASSE.md', '# s\n', { remote: false, indexed: false })
    fs.renameSync(path.join(vault.path, 'Docs/STRASSE.md'), path.join(vault.path, 'Docs/tmp.md'))
    fs.renameSync(path.join(vault.path, 'Docs/tmp.md'), path.join(vault.path, 'Docs/straße.md'))

    expect(findCanonicalNoteForFile(vault.path, 'Docs/straße.md')?.id).toBe('sharp')
  })

  // `ılık.md` and `ilık.md` share a fold key but are two files on APFS: only
  // rows that resolve to the file on disk make it a shared file.
  it('counts only rows on the same disk file as twins', () => {
    seed('dotted', 'Docs/ilık.md', '# i\n', { remote: false, indexed: false })
    seed('dotless', 'Docs/ılık.md', '# ı\n', { remote: false, indexed: false })
    fs.renameSync(path.join(vault.path, 'Docs/ilık.md'), path.join(vault.path, 'Docs/tmp.md'))
    fs.renameSync(path.join(vault.path, 'Docs/tmp.md'), path.join(vault.path, 'Docs/Ilık.md'))

    expect(findCanonicalNoteForFile(vault.path, 'Docs/Ilık.md')).toMatchObject({
      id: 'dotted',
      sharesFile: false
    })
  })
})
