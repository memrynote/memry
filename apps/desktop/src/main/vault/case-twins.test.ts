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
import {
  getAliasesForNotes,
  getInboundLinkSourceIds,
  getNoteCacheById,
  getNoteTags,
  insertNoteCache,
  reindexNoteNames,
  setNoteProperties,
  setNoteTags,
  updateNoteCache
} from '@main/database/queries/notes'
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
/** A doc the provider cannot hand out yet: `open` and `withDocLoaded` wait on this. */
const unavailable = vi.hoisted(() => new Map<string, Promise<never>>())
vi.mock('../sync/crdt-provider', () => {
  const stub = {
    initForNote: vi.fn(async () => {}),
    updateMeta: vi.fn(),
    getDoc: (id: string) => (unavailable.has(id) ? undefined : docs.get(id)),
    recordOwedFullState: vi.fn(),
    hasPersistence: () => true,
    awaitPendingInit: async () => {},
    readOnlyStore: () => ({ docNames: async () => [], updates: async () => [] }),
    isNoteLocalOnly: () => false,
    isAwaitingMerge: () => false,
    open: vi.fn(async (id: string) => {
      if (unavailable.has(id)) await unavailable.get(id)
      return docs.get(id)
    }),
    withDocLoaded: vi.fn(async (id: string, run: () => void) => {
      if (unavailable.has(id)) await unavailable.get(id)
      run()
    }),
    closeIfInactive: async () => {},
    whenPersisted: async () => {},
    purge: vi.fn(async () => {})
  }
  return { ORIGIN_LOCAL: 'local', getCrdtProvider: vi.fn(() => stub) }
})
vi.mock('../sync/attachment-backfill', () => ({ queueEmbeddedVaultFiles: vi.fn() }))
vi.mock('../sync/writeback-baseline', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...real, recordBaseline: vi.fn(real.recordBaseline as never) }
})
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
import { owesFileBody, recordOwedFileBody } from '../sync/crdt-owed-file-body'
import { recordBaseline } from '../sync/writeback-baseline'
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
import { noteHandler } from '../sync/item-handlers/note-handler'
import { noteCoverForPush, recordAppliedNoteCover } from '../sync/item-handlers/note-cover-sync'
import { PendingSyncIntentError } from '../sync/pending-sync-intent-error'
import { NoteError } from '../lib/errors'
import { beginPageApply, writeSyncedVaultFile } from '../sync/bulk-apply'
import { prepareCaseTwinLeave } from './case-twin-file'
import { COVER_ZOOM_FRONTMATTER_KEY } from '@memry/shared/cover-image'

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
    unavailable.clear()
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

  /** After a twin's delete: the next vault open and the survivor's write-back. */
  async function afterDelete(survivor: 'lower' | 'upper') {
    await stopWatcher()
    await openVault()
    await writeBack(survivor, survivor === 'lower' ? LOWER : UPPER)
    return {
      file: shared(),
      rows: rowIds(),
      crossed: crossed(),
      deletes: vi.mocked(enqueueLocalSyncDelete).mock.calls
    }
  }

  const applyPeerDelete = (id: string) =>
    noteHandler.applyDelete({ db: asClientDb(data.db), emit: vi.fn() }, id)

  /**
   * A peer's delete as a pull applies it: retried until the survivor's file is
   * ready. Answers the shared file and the rows as the apply left them, read
   * before anything else runs.
   */
  async function applyPeerDeleteWhenReady(id: string) {
    let applied = { file: '', rows: [] as string[] }
    await vi.waitFor(() => {
      expect(applyPeerDelete(id)).toBe('applied')
      applied = { file: shared(), rows: rowIds() }
    })
    return applied
  }

  /** A doc store that hangs until the test fails it. */
  function stall(): { promise: Promise<never>; fail: () => void } {
    let fail = (): void => {}
    const promise = new Promise<never>((_resolve, reject) => {
      fail = () => reject(new Error('store gone'))
    })
    promise.catch(() => {})
    return { promise, fail }
  }

  for (const [deleted, survivor, body] of [
    ['lower', 'upper', UPPER],
    ['upper', 'lower', LOWER]
  ] as const) {
    it(`deleting twin ${deleted} keeps the shared file with ${survivor}'s body`, async () => {
      await twins()

      await deleteNoteCommand(deleted)

      expect(shared()).toBe(body)
      expect(await afterDelete(survivor)).toEqual({
        file: body,
        rows: [survivor],
        crossed: [],
        deletes: [['note', deleted]]
      })
    }, 30_000)

    it(`a peer's delete of twin ${deleted} keeps the shared file with ${survivor}'s body`, async () => {
      await twins()

      // The survivor's file is written in the delete's own step.
      expect(await applyPeerDeleteWhenReady(deleted)).toEqual({ file: body, rows: [survivor] })
      expect(await afterDelete(survivor)).toEqual({
        file: body,
        rows: [survivor],
        crossed: [],
        deletes: []
      })
    }, 30_000)
  }

  it('deleting a note with no twin removes its file', async () => {
    await twins()
    seed('solo', 'Other/s.md', '# s\n\nsolo\n')

    await deleteNoteCommand('solo')

    expect({
      exists: fs.existsSync(path.join(vault.path, 'Other/s.md')),
      rows: rowIds()
    }).toEqual({ exists: false, rows: ['lower', 'upper'] })
  }, 30_000)

  it('deleting the last twin removes the shared file', async () => {
    await twins()

    await deleteNoteCommand('upper')
    await deleteNoteCommand('lower')

    expect({
      exists: fs.existsSync(path.join(vault.path, 'Supernotes/a.md')),
      rows: rowIds()
    }).toEqual({ exists: false, rows: [] })
  }, 30_000)

  it('a survivor that owes its file body never takes the deleted twin body', async () => {
    await twins()
    recordOwedFileBody('lower')

    await deleteNoteCommand('upper')

    expect({ file: shared(), owes: owesFileBody('lower') }).toEqual({ file: LOWER, owes: false })
    expect(await afterDelete('lower')).toEqual({
      file: LOWER,
      rows: ['lower'],
      crossed: [],
      deletes: [['note', 'upper']]
    })
  }, 30_000)

  const LOWER_HEAD =
    "---\ntags:\n  - lowertag\nstatus: low\ncover: 'wash:sage'\naliases:\n  - lowalias\n---\n"
  const UPPER_HEAD =
    "---\ntags:\n  - uppersecret\nstatus: secret\ncover: 'wash:clay'\naliases:\n  - upalias\n---\n"
  const LOWER_HEAD_RE =
    /^---\ntags:\n {2}- lowertag\nstatus: low\ncover: 'wash:sage'\naliases:\n {2}- lowalias\n---\n[\s\S]*lower \[\[x\]\]\n$/

  /** The twins with headers, each indexed from its own, the upper file last on disk. */
  async function headerTwins(lowerCover = 'wash:sage'): Promise<void> {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'), { recursive: true })
    seed('lower', 'SuperNotes/a.md', LOWER_HEAD + LOWER)
    seed('upper', 'SUPERNOTES/a.md', UPPER_HEAD + UPPER)
    await openVault()
    for (const [id, tag, status, cover, alias] of [
      ['lower', 'lowertag', 'low', lowerCover, 'lowalias'],
      ['upper', 'uppersecret', 'secret', 'wash:clay', 'upalias']
    ] as const) {
      setNoteTags(index.db, id, { header: [tag], inline: [] })
      setNoteProperties(index.db, id, { status }, () => 'text')
      reindexNoteNames(index.db, {
        noteId: id,
        title: 'a',
        aliases: { kind: 'read', aliases: [alias] }
      })
      updateNoteCache(index.db, id, { cover })
    }
    docs.set('lower', await docOf(LOWER))
    docs.set('upper', await docOf(UPPER))
  }

  /** What the shared file and the index say about the survivor's header. */
  const lowerHeader = () => ({
    file: shared(),
    upperInFile: /upper|clay/.test(shared()),
    lowerTags: getNoteTags(index.db, 'lower'),
    lowerAliases: getAliasesForNotes(index.db, ['lower']).get('lower')
  })
  const LOWER_KEPT = {
    file: expect.stringMatching(LOWER_HEAD_RE),
    upperInFile: false,
    lowerTags: ['lowertag'],
    lowerAliases: ['lowalias']
  }

  /** Nothing of a twin delete has happened: both rows, upper's file, no tombstone, no purge. */
  const untouched = () => ({
    file: shared(),
    rows: rowIds(),
    deletes: vi.mocked(enqueueLocalSyncDelete).mock.calls,
    purged: vi.mocked(getCrdtProvider().purge).mock.calls
  })
  const UNTOUCHED = { file: UPPER_HEAD + UPPER, rows: ['lower', 'upper'], deletes: [], purged: [] }

  /**
   * After a twin delete that stopped before its step: a vault open and the
   * survivor's write-back take nothing, and a retried delete leaves the
   * survivor its own file.
   */
  async function expectStoppedDeleteHarmless(): Promise<void> {
    await stopWatcher()
    await openVault()
    await writeBack('lower', LOWER)
    expect({ ...untouched(), crossed: crossed() }).toEqual({ ...UNTOUCHED, crossed: [] })

    await deleteNoteCommand('upper')
    await afterDelete('lower')
    await flushProjectionEvents()
    expect({
      ...lowerHeader(),
      deletes: vi.mocked(enqueueLocalSyncDelete).mock.calls
    }).toEqual({ ...LOWER_KEPT, deletes: [['note', 'upper']] })
  }

  it("a deleted twin's header never lands on the survivor", async () => {
    await headerTwins()

    await deleteNoteCommand('upper')
    await afterDelete('lower')
    await flushProjectionEvents()

    expect(lowerHeader()).toEqual(LOWER_KEPT)
  }, 30_000)

  // VERIFY-5499R4 (1a): nothing durable happens before the delete's step.
  it("a twin delete waiting on the survivor's doc changes nothing, and fails when it cannot load", async () => {
    await headerTwins()
    const store = stall()
    unavailable.set('lower', store.promise)

    const first = deleteNoteCommand('upper')
    await vi.waitFor(() =>
      expect(getCrdtProvider().open).toHaveBeenCalledWith('lower', undefined, { skipSeed: true })
    )
    expect(untouched()).toEqual(UNTOUCHED)

    store.fail()
    await expect(first).rejects.toBeInstanceOf(NoteError)
    unavailable.clear()
    expect(untouched()).toEqual(UNTOUCHED)
    await expectStoppedDeleteHarmless()
  }, 30_000)

  it('a twin delete stopped before its step changes nothing', async () => {
    await headerTwins()
    unavailable.set('upper', stall().promise)

    void deleteNoteCommand('upper')
    await vi.waitFor(() =>
      expect(getCrdtProvider().withDocLoaded).toHaveBeenCalledWith('upper', expect.any(Function))
    )
    expect(untouched()).toEqual(UNTOUCHED)

    unavailable.clear()
    await expectStoppedDeleteHarmless()
  }, 30_000)

  // VERIFY-5499R4 (1b): the survivor's file, the tombstone and the row drop are one step.
  it('a twin delete that stops right after its step leaves the survivor its own file', async () => {
    await headerTwins()
    vi.mocked(getCrdtProvider().purge).mockImplementationOnce(() => new Promise(() => {}))

    void deleteNoteCommand('upper')
    await vi.waitFor(() => expect(rowIds()).toEqual(['lower']))

    expect({
      file: shared(),
      deletes: vi.mocked(enqueueLocalSyncDelete).mock.calls
    }).toEqual({ file: expect.stringMatching(LOWER_HEAD_RE), deletes: [['note', 'upper']] })
    await afterDelete('lower')
    await flushProjectionEvents()
    expect({
      ...lowerHeader(),
      push: noteCoverForPush(asClientDb(data.db), 'lower', parseNote(shared()).frontmatter)
    }).toEqual({ ...LOWER_KEPT, push: { ref: 'wash:sage' } })
  }, 30_000)

  it("a peer's twin delete waits for the survivor's file, then lands it in its own step", async () => {
    await headerTwins()

    expect(() => applyPeerDelete('upper')).toThrow(PendingSyncIntentError)
    expect(untouched()).toEqual(UNTOUCHED)

    expect(await applyPeerDeleteWhenReady('upper')).toEqual({
      file: expect.stringMatching(LOWER_HEAD_RE),
      rows: ['lower']
    })
    await afterDelete('lower')
    await flushProjectionEvents()
    expect(lowerHeader()).toEqual(LOWER_KEPT)
  }, 30_000)

  it("a peer's twin delete keeps waiting while the survivor's doc cannot load", async () => {
    await headerTwins()
    const store = stall()
    unavailable.set('lower', store.promise)

    expect(() => applyPeerDelete('upper')).toThrow(PendingSyncIntentError)
    await vi.waitFor(() =>
      expect(getCrdtProvider().open).toHaveBeenCalledWith('lower', undefined, { skipSeed: true })
    )
    expect(() => applyPeerDelete('upper')).toThrow(PendingSyncIntentError)
    expect(untouched()).toEqual(UNTOUCHED)

    store.fail()
    unavailable.clear()
    await applyPeerDeleteWhenReady('upper')
    expect(lowerHeader()).toEqual(LOWER_KEPT)
  }, 30_000)

  // A write a page apply deferred lands after the delete's step, and would put
  // the other twin's bytes under the survivor's new baseline.
  it("a peer's twin delete waits while a page apply owes the shared file a write", async () => {
    await headerTwins()
    await prepareCaseTwinLeave(vault.path, 'SUPERNOTES/a.md', 'upper')
    const page = beginPageApply(asClientDb(data.db))
    try {
      writeSyncedVaultFile(path.join(vault.path, 'supernotes/A.md'), UPPER_HEAD + UPPER)

      expect(() => applyPeerDelete('upper')).toThrow(PendingSyncIntentError)
      expect(untouched()).toEqual(UNTOUCHED)
    } finally {
      page.rollback()
    }

    await applyPeerDeleteWhenReady('upper')
    expect(lowerHeader()).toEqual(LOWER_KEPT)
  }, 30_000)

  // An image cover's framing and credit live only in the file. The rebuilt
  // file keeps the ref; the push leaves the cover out until it changes here,
  // so peers keep its framing.
  for (const [how, remove] of [
    ['local', () => deleteNoteCommand('upper')],
    ['peer', () => applyPeerDeleteWhenReady('upper')]
  ] as const) {
    it(`a ${how} twin delete keeps the survivor's image cover without resetting it on peers`, async () => {
      await headerTwins('covers/low.png')
      // The server holds the cover with its framing.
      recordAppliedNoteCover(asClientDb(data.db), 'lower', { cover: 'covers/low.png' })

      await remove()
      await flushProjectionEvents()

      const frontmatter = parseNote(shared()).frontmatter
      const db = asClientDb(data.db)
      expect({
        cover: frontmatter.cover,
        aliases: frontmatter.aliases,
        indexed: getNoteCacheById(index.db, 'lower')?.cover,
        push: noteCoverForPush(db, 'lower', frontmatter),
        reframed: noteCoverForPush(db, 'lower', { ...frontmatter, [COVER_ZOOM_FRONTMATTER_KEY]: 2 })
          ?.zoom
      }).toEqual({
        cover: 'covers/low.png',
        aliases: ['lowalias'],
        indexed: 'covers/low.png',
        push: undefined,
        reframed: 2
      })
    }, 30_000)
  }

  it('a survivor with an empty doc keeps its own header and never the deleted twin body', async () => {
    await headerTwins()
    docs.set('lower', new Y.Doc())

    await deleteNoteCommand('upper')

    expect({ file: shared(), crossed: crossed() }).toEqual({ file: LOWER_HEAD, crossed: [] })
  }, 30_000)

  // A failure before the survivor's file is written aborts the delete with
  // both rows and the file as they were; one after it leaves the survivor's
  // own file.
  for (const [failure, fail, file] of [
    [
      'an unreadable shared file',
      () => fs.chmodSync(path.join(vault.path, 'Supernotes/a.md'), 0o000),
      UPPER
    ],
    [
      'a baseline that cannot be recorded',
      () =>
        vi.mocked(recordBaseline).mockImplementationOnce(() => {
          throw new Error('index gone')
        }),
      LOWER
    ]
  ] as const) {
    it(`${failure} aborts a twin delete with both rows intact`, async () => {
      await twins()
      fail()

      await expect(deleteNoteCommand('upper')).rejects.toThrow(/EACCES|index gone/)

      fs.chmodSync(path.join(vault.path, 'Supernotes/a.md'), 0o644)
      // Peers never hear of a delete this device did not make.
      expect({ rows: rowIds(), deletes: vi.mocked(enqueueLocalSyncDelete).mock.calls }).toEqual({
        rows: ['lower', 'upper'],
        deletes: []
      })
      await stopWatcher()
      await openVault()
      await writeBack('lower', LOWER)
      expect({ file: shared(), rows: rowIds(), crossed: crossed() }).toEqual({
        file,
        rows: ['lower', 'upper'],
        crossed: []
      })
    }, 30_000)
  }
})
