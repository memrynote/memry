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
  getNoteProperties,
  getNoteSnapshots,
  getNoteTags,
  getPropertyType,
  insertNoteCache,
  reindexNoteNames,
  setNoteProperties,
  setNoteTags,
  updateNoteCache
} from '@main/database/queries/notes'
import { upsertNoteMetadata } from '@memry/storage-data'
import { NotesChannels } from '@memry/contracts/notes-api'
import { invokeHandler, mockIpcMain } from '@tests/utils/mock-ipc'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) =>
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    ),
    removeHandler: vi.fn()
  },
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
vi.mock('../lib/paths', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...real, openVaultFile: vi.fn(real.openVaultFile as never) }
})
vi.mock('../sync/writeback-baseline', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...real, recordBaseline: vi.fn(real.recordBaseline as never) }
})
vi.mock('../sync/crdt-external-feed', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...real, feedExternalEditToCrdt: vi.fn(real.feedExternalEditToCrdt as never) }
})
vi.mock('./file-ops', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...real,
    safeRead: vi.fn(real.safeRead as never),
    atomicWrite: vi.fn(real.atomicWrite as never)
  }
})
vi.mock('./move-directory', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...real, moveDirectory: vi.fn(real.moveDirectory as never) }
})
vi.mock('./note-sync', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...real,
    syncNoteToCache: vi.fn(real.syncNoteToCache as never),
    persistNoteToCache: vi.fn(real.persistNoteToCache as never)
  }
})
vi.mock('../projections', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...real, publishProjectionEvent: vi.fn(real.publishProjectionEvent as never) }
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
import { writebackNow } from '../sync/crdt-writeback'
import { recordAppWrite } from './app-writes'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  publishProjectionEvent,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { extractProperties, generateContentHash, parseNote, serializeNote } from './frontmatter'
import { inferPropertyType } from './property-type'
import { persistNoteToCache, syncNoteToCache } from './note-sync'
import { healCaseVariantRows } from './case-variant-heal'
import { clearIngestBackfill, drainIngestBackfill } from './ingest-backfill'
import { indexVault } from './indexer'
import { appendBlocksToNote } from './append-blocks'
import { rewriteInboundWikiLinks } from './rename-link-rewrite'
import { clearAllPendingDeletes } from './rename-tracker'
import { startWatcher, stopWatcher, getWatcher } from './watcher'
import {
  deleteNoteCommand,
  moveNoteCommand,
  renameFolderCommand,
  renameNoteCommand
} from '../notes/domain'
import { atomicWrite, safeRead, setVaultFileWriteGuard } from './file-ops'
import { moveDirectory } from './move-directory'
import { readyWritebackConverter } from '../sync/converter-worker-bridge'
import { enqueueLocalSyncDelete } from '../sync/local-mutations'
import { noteHandler } from '../sync/item-handlers/note-handler'
import { noteCoverForPush, recordAppliedNoteCover } from '../sync/item-handlers/note-cover-sync'
import { PendingSyncIntentError } from '../sync/pending-sync-intent-error'
import { NoteError } from '../lib/errors'
import { openVaultFile } from '../lib/paths'
import { beginPageApply, writeNoteFileNow, writeSyncedVaultFile } from '../sync/bulk-apply'
import { prepareCaseTwinLeave } from './case-twin-file'
import { createSnapshot } from './note-snapshots'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { registerNotesHandlers } from '../ipc/notes-handlers'
import { COVER_ZOOM_FRONTMATTER_KEY } from '@memry/shared/cover-image'

const realAtomicWrite = vi.mocked(atomicWrite).getMockImplementation()!

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
    vi.mocked(atomicWrite).mockImplementation(realAtomicWrite)
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
    const landed = recordAppWrite(absolutePath, body)
    fs.writeFileSync(absolutePath, body)
    landed()
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

  /** Note upper alone on the file, as before its twin arrives. */
  async function lone(): Promise<void> {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'), { recursive: true })
    seed('upper', 'SUPERNOTES/a.md', UPPER)
    await openVault()
  }

  it('a delete that finds a twin arrived before its tombstone changes nothing', async () => {
    await lone()
    let loaded = (): void => {}
    unavailable.set(
      'upper',
      new Promise<never>((resolve) => (loaded = () => resolve(undefined as never)))
    )
    const deleting = deleteNoteCommand('upper')
    await vi.waitFor(() =>
      expect(getCrdtProvider().withDocLoaded).toHaveBeenCalledWith('upper', expect.any(Function))
    )
    seed('lower', 'SuperNotes/a.md', LOWER)
    unavailable.delete('upper')
    loaded()

    await expect(deleting).rejects.toBeInstanceOf(NoteError)
    expect({
      file: shared(),
      rows: rowIds(),
      deletes: vi.mocked(enqueueLocalSyncDelete).mock.calls
    }).toEqual({ file: LOWER, rows: ['lower', 'upper'], deletes: [] })
  }, 30_000)

  it('a delete that finds a twin arrived after its tombstone leaves the file to the twin', async () => {
    await lone()
    let purged = (): void => {}
    vi.mocked(getCrdtProvider().purge).mockImplementationOnce(
      () => new Promise<void>((resolve) => (purged = resolve))
    )
    const deleting = deleteNoteCommand('upper')
    await vi.waitFor(() => expect(getCrdtProvider().purge).toHaveBeenCalledWith('upper'))
    seed('lower', 'SuperNotes/a.md', LOWER)
    purged()
    await deleting

    expect({
      file: shared(),
      rows: rowIds(),
      deletes: vi.mocked(enqueueLocalSyncDelete).mock.calls
    }).toEqual({ file: LOWER, rows: ['lower'], deletes: [['note', 'upper']] })
  }, 30_000)

  it('a delete that finds a twin arrived right before its unlink leaves the file to the twin', async () => {
    await lone()
    // The twin lands while the unlink awaits the lock check.
    setVaultFileWriteGuard({
      beforeWrite: async () => {
        seed('lower', 'SuperNotes/a.md', LOWER)
        return null
      },
      afterWrite: async () => {}
    })
    try {
      await deleteNoteCommand('upper')
    } finally {
      setVaultFileWriteGuard(null)
    }

    expect({ file: shared(), rows: rowIds() }).toEqual({ file: LOWER, rows: ['lower'] })
  }, 30_000)

  const snapshotsOf = (id: string) =>
    getNoteSnapshots(index.db, id).map((snapshot) => snapshot.fileContent)

  it("a twin delete keeps the deleted twin's bytes out of the survivor's history", async () => {
    await twins()

    await deleteNoteCommand('upper')

    expect({ file: shared(), lower: snapshotsOf('lower') }).toEqual({ file: LOWER, lower: [] })
  }, 30_000)

  it("a twin delete keeps bytes no twin holds in the survivor's history", async () => {
    await twins()
    await stopWatcher()
    const outside = '# a\n\noutside edit\n'
    fs.writeFileSync(path.join(vault.path, 'Supernotes/a.md'), outside)

    await deleteNoteCommand('upper')

    expect({ file: shared(), lower: snapshotsOf('lower') }).toEqual({
      file: LOWER,
      lower: [outside]
    })
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
  const LOWER_TAGGED = '# a\n\nlower [[x]] #lowertag #lowinline\n'
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

  it("a twin delete keeps the survivor's cover removal pending", async () => {
    await headerTwins()
    const db = asClientDb(data.db)
    // Lower's cover reached the server, then was removed here; its null waits for the ack.
    recordAppliedNoteCover(db, 'lower', { cover: 'wash:sage' })
    expect(noteCoverForPush(db, 'lower', {})).toBeNull()
    updateNoteCache(index.db, 'lower', { cover: null })

    await deleteNoteCommand('upper')

    const frontmatter = parseNote(shared()).frontmatter
    expect({ cover: frontmatter.cover, push: noteCoverForPush(db, 'lower', frontmatter) }).toEqual({
      cover: undefined,
      push: null
    })
  }, 30_000)

  it('a survivor with an empty doc keeps its own header and never the deleted twin body', async () => {
    await headerTwins()
    docs.set('lower', new Y.Doc())

    await deleteNoteCommand('upper')

    expect({ file: shared(), crossed: crossed() }).toEqual({ file: LOWER_HEAD, crossed: [] })
  }, 30_000)

  // VERIFY-5499R5 #9 (#5558): the rebuilt header keeps each value's YAML type.
  for (const [how, remove] of [
    ['local', () => deleteNoteCommand('upper')],
    ['peer', () => applyPeerDeleteWhenReady('upper')]
  ] as const) {
    it(`a ${how} twin delete rebuilds the survivor's typed header as the serializer writes it`, async () => {
      const typed =
        '---\ntags:\n  - lowertag\nlist:\n  - a\n  - b\nwhen: 2026-01-02\nat: 2026-01-02T10:30:00.000Z\n' +
        'count: 3\nratio: 0.5\ndone: true\nnested:\n  k: v\nnote: plain\n---\n'
      fs.mkdirSync(path.join(vault.path, 'Supernotes'), { recursive: true })
      seed('lower', 'SuperNotes/a.md', typed + LOWER)
      seed('upper', 'SUPERNOTES/a.md', UPPER_HEAD + UPPER)
      await openVault()
      // The index rows lower's own file gave it, as the projector writes them.
      const own = parseNote(typed + LOWER)
      setNoteTags(index.db, 'lower', { header: ['lowertag'], inline: [] })
      setNoteProperties(index.db, 'lower', extractProperties(own.frontmatter), (name, value) =>
        getPropertyType(index.db, name, value, inferPropertyType)
      )
      const indexed = getNoteProperties(index.db, 'lower')
      docs.set('lower', await docOf(LOWER))
      docs.set('upper', await docOf(UPPER))

      await remove()

      expect(shared()).toBe(serializeNote(own.frontmatter, LOWER))
      // Read back in, the file indexes to the rows it was rebuilt from.
      await afterDelete('lower')
      await flushProjectionEvents()
      expect(getNoteProperties(index.db, 'lower')).toEqual(indexed)
    }, 30_000)
  }

  const QUOTED = "---\nwhen: '2026-01-02'\nids: '[1,2]'\nat: 2026-01-03\n---\n"
  const TYPED = '---\nwhen: 2026-01-02\nids: [1,2]\n---\n'

  /**
   * Twins whose own files carry `lowerOwn` and `upperOwn`, upper's bytes
   * on disk, with lower's property rows indexed from its own header. A
   * version of lower's own bytes is kept when `lowerVersion`. Returns lower's
   * own header.
   */
  async function propertyTwins(lowerOwn: string, upperOwn: string, lowerVersion: boolean) {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'), { recursive: true })
    seed('lower', 'SuperNotes/a.md', lowerOwn + LOWER)
    seed('upper', 'SUPERNOTES/a.md', upperOwn + UPPER)
    await openVault()
    const own = parseNote(lowerOwn + LOWER)
    setNoteProperties(index.db, 'lower', extractProperties(own.frontmatter), (name, value) =>
      getPropertyType(index.db, name, value, inferPropertyType)
    )
    if (lowerVersion) {
      createSnapshot('lower', lowerOwn + LOWER, 'a', SnapshotReasons.CLOSE)
    }
    docs.set('lower', await docOf(LOWER))
    docs.set('upper', await docOf(UPPER))
    return own.frontmatter
  }

  // A quoted string that spells a date or JSON is stored as the date's or the
  // list's text: the rebuilt header keeps the string the survivor's own last
  // file holds, which a version of it keeps.
  for (const [name, upperHeader] of [
    ['shares its header', QUOTED],
    ['has no header', '']
  ] as const) {
    it(`a twin delete keeps the survivor's quoted strings when the leaving twin ${name}`, async () => {
      const own = await propertyTwins(QUOTED, upperHeader, true)

      await deleteNoteCommand('upper')

      expect(parseNote(shared()).frontmatter).toEqual(own)
      expect(shared()).toBe(serializeNote(own, LOWER))
    }, 30_000)
  }

  // The leaving twin's header is not the survivor's: its quoted strings never
  // type the survivor's dates and lists.
  it("a twin delete keeps the survivor's dates and lists the leaving twin quotes", async () => {
    const own = await propertyTwins(TYPED, QUOTED, false)

    await deleteNoteCommand('upper')

    expect(parseNote(shared()).frontmatter).toEqual(own)
  }, 30_000)

  it("a twin move keeps its dates and lists the staying twin's header quotes", async () => {
    const own = await propertyTwins(TYPED, QUOTED, false)

    await renameNoteCommand('lower', 'b')

    const moved = fs.readFileSync(path.join(vault.path, 'SuperNotes/b.md'), 'utf8')
    expect(parseNote(moved).frontmatter).toMatchObject(own)
  }, 30_000)

  it('a twin move keeps its own quoted strings from its own version', async () => {
    const own = await propertyTwins(QUOTED, TYPED, true)

    await renameNoteCommand('lower', 'b')

    const moved = fs.readFileSync(path.join(vault.path, 'SuperNotes/b.md'), 'utf8')
    expect(parseNote(moved).frontmatter).toMatchObject(own)
  }, 30_000)

  /** Holds twin upper's next file write until `release`; resolves `reached` when it gets there. */
  function holdUpperWrite() {
    let release = (): void => {}
    let reached = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const atWrite = new Promise<void>((resolve) => (reached = resolve))
    const real = vi.mocked(atomicWrite).getMockImplementation()!
    vi.mocked(atomicWrite).mockImplementation(async (filePath, content) => {
      if (content.includes('upper edited')) {
        reached()
        await gate
      }
      return real(filePath, content)
    })
    return { release, atWrite }
  }

  const UPPER_EDITED = '# a\n\nupper edited [[x]]\n'
  const upperGone = () => ({
    file: shared(),
    rows: rowIds(),
    indexed: getNoteCacheById(index.db, 'upper')?.id ?? null
  })

  // VERIFY-5499R5 #11 (#5559): a write-back of the deleted twin past its
  // checks would land its body on the survivor's file and re-create its row.
  it("a twin delete waits for the twin's write-back in flight, and the tombstone wins", async () => {
    await twins()
    const held = holdUpperWrite()
    const pass = writeBack('upper', UPPER_EDITED)
    await held.atWrite

    const deleted = deleteNoteCommand('upper')
    try {
      // Long enough for the delete to reach its step if nothing held it back.
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      held.release()
    }
    await pass
    await deleted
    await flushProjectionEvents()

    expect(upperGone()).toEqual({ file: LOWER, rows: ['lower'], indexed: null })
    expect(vi.mocked(enqueueLocalSyncDelete).mock.calls).toEqual([['note', 'upper']])
    expect(await afterDelete('lower')).toMatchObject({ file: LOWER, rows: ['lower'], crossed: [] })
  }, 30_000)

  // A save that starts while the delete awaits its doc meets the delete's step.
  it("a twin delete whose step meets the twin's write-back runs again after it", async () => {
    await twins()
    let loaded = (): void => {}
    unavailable.set(
      'upper',
      new Promise<never>((resolve) => (loaded = () => resolve(undefined as never)))
    )
    const deleted = deleteNoteCommand('upper')
    await vi.waitFor(() =>
      expect(getCrdtProvider().withDocLoaded).toHaveBeenCalledWith('upper', expect.any(Function))
    )
    const held = holdUpperWrite()
    const pass = writeBack('upper', UPPER_EDITED)
    try {
      await held.atWrite
      unavailable.delete('upper')
      loaded()
      // Long enough for the delete's step to meet the write-back's turn.
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      held.release()
    }
    await pass
    await deleted
    await flushProjectionEvents()

    expect(upperGone()).toEqual({ file: LOWER, rows: ['lower'], indexed: null })
    expect(vi.mocked(enqueueLocalSyncDelete).mock.calls).toEqual([['note', 'upper']])
  }, 30_000)

  it("a peer's twin delete waits while the twin's write-back is in flight", async () => {
    await twins()
    // The survivor's file is ready, as on a pull's retry.
    await prepareCaseTwinLeave(vault.path, 'SUPERNOTES/a.md', 'upper')
    const held = holdUpperWrite()
    const pass = writeBack('upper', UPPER_EDITED)
    try {
      await held.atWrite
      expect(() => applyPeerDelete('upper')).toThrow(PendingSyncIntentError)
      expect(rowIds()).toEqual(['lower', 'upper'])
    } finally {
      held.release()
    }
    await pass

    expect(await applyPeerDeleteWhenReady('upper')).toEqual({ file: LOWER, rows: ['lower'] })
    await flushProjectionEvents()
    expect(upperGone()).toEqual({ file: LOWER, rows: ['lower'], indexed: null })
    expect(await afterDelete('lower')).toMatchObject({ file: LOWER, rows: ['lower'], crossed: [] })
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

  // ==========================================================================
  // Rename and move (#5498)
  // ==========================================================================

  const read = (relativePath: string) =>
    fs.existsSync(path.join(vault.path, relativePath))
      ? fs.readFileSync(path.join(vault.path, relativePath), 'utf8')
      : null

  const pathOf = (id: string) =>
    data.db.select().from(noteMetadata).where(eq(noteMetadata.id, id)).get()?.path

  /** Whether the note's index baseline is the bytes of its file. */
  const ownBaseline = (id: string) => {
    const file = read(pathOf(id) ?? '')
    return (
      file !== null && getNoteCacheById(index.db, id)?.contentHash === generateContentHash(file)
    )
  }

  /** A peer's rename or move as a pull applies it. */
  const applyPeerMove = (id: string, title: string, folderPath: string) =>
    noteHandler.applyUpsert(
      { db: asClientDb(data.db), emit: vi.fn() },
      id,
      { title, folderPath, modifiedAt: '2026-02-01T00:00:00.000Z' },
      { peer: 1 }
    )

  async function applyPeerMoveWhenReady(id: string, title: string, folderPath: string) {
    await vi.waitFor(() => expect(applyPeerMove(id, title, folderPath)).toBe('applied'))
  }

  /** Nothing of a twin move has happened. */
  const unmoved = () => ({
    rows: [pathOf('lower'), pathOf('upper')],
    file: shared(),
    b: read('Supernotes/b.md')
  })
  const UNMOVED = { rows: ['Supernotes/a.md', 'SUPERNOTES/a.md'], file: UPPER, b: null }

  /** The survivor's write-back after the next vault open takes no foreign body. */
  async function survivorKeepsOwn(survivor: 'lower' | 'upper') {
    await stopWatcher()
    await openVault()
    await writeBack(survivor, survivor === 'lower' ? LOWER : UPPER)
    return crossed()
  }

  for (const [how, move] of [
    ['local', () => renameNoteCommand('lower', 'b')],
    ['peer', () => applyPeerMoveWhenReady('lower', 'b', 'Supernotes')]
  ] as const) {
    it(`a ${how} rename of a twin writes its own body to the new file and leaves the shared file`, async () => {
      await twins()

      await move()

      expect({
        rows: { lower: pathOf('lower'), upper: pathOf('upper') },
        renamed: read('Supernotes/b.md'),
        file: shared(),
        baselines: [ownBaseline('lower'), ownBaseline('upper')]
      }).toEqual({
        rows: { lower: 'Supernotes/b.md', upper: 'SUPERNOTES/a.md' },
        renamed: expect.stringContaining('lower [[x]]'),
        file: UPPER,
        baselines: [true, true]
      })
      expect(read('Supernotes/b.md')).not.toContain('upper')
      expect(await survivorKeepsOwn('upper')).toEqual([])
    }, 30_000)
  }

  // REVIEW-5501 (1, 2): the twin whose bytes are on disk moves; the shared
  // file becomes the survivor's own in the same step.
  for (const [how, move] of [
    ['local', () => moveNoteCommand('upper', 'Other')],
    ['peer', () => applyPeerMoveWhenReady('upper', 'a', 'Other')]
  ] as const) {
    it(`a ${how} move of the twin on disk leaves the survivor its own file`, async () => {
      await twins()

      await move()

      expect({
        rows: { lower: pathOf('lower'), upper: pathOf('upper') },
        moved: read('Other/a.md'),
        file: shared(),
        baselines: [ownBaseline('lower'), ownBaseline('upper')]
      }).toEqual({
        rows: { lower: 'Supernotes/a.md', upper: 'Other/a.md' },
        moved: UPPER,
        file: expect.stringContaining('lower [[x]]'),
        baselines: [true, true]
      })
      expect(shared()).not.toContain('upper')
      expect(await survivorKeepsOwn('lower')).toEqual([])
    }, 30_000)
  }

  /** Runs `leave` right after the watcher's next file read, before it checks for twins. */
  function leaveAfterRead(leave: () => Promise<unknown>): () => boolean {
    let left = false
    const real = vi.mocked(openVaultFile).getMockImplementation()!
    vi.mocked(openVaultFile).mockImplementationOnce(async (...args) => {
      const file = await real(...args)
      if (file === null) return null
      const close = file.close.bind(file)
      file.close = async () => {
        await close()
        await leave()
        left = true
      }
      return file
    })
    return () => left
  }

  const leaves = (id: 'lower' | 'upper') => {
    const folder = id === 'lower' ? 'Supernotes' : 'SUPERNOTES'
    return [
      ['local delete', () => deleteNoteCommand(id), null],
      ["peer's delete", () => applyPeerDeleteWhenReady(id), null],
      ['local rename', () => renameNoteCommand(id, 'b'), `${folder}/b.md`],
      ["peer's rename", () => applyPeerMoveWhenReady(id, 'b', folder), `${folder}/b.md`],
      ['local move', () => moveNoteCommand(id, 'Other'), 'Other/a.md'],
      ["peer's move", () => applyPeerMoveWhenReady(id, 'a', 'Other'), 'Other/a.md']
    ] as const
  }

  // #5624: the watcher read the shared file and only then asked whether a twin
  // shares it. A twin that left in between made the file unshared, and the
  // bytes read went into the other twin's index and doc.
  for (const [leaver, survivor] of [
    ['upper', 'lower'],
    ['lower', 'upper']
  ] as const) {
    for (const [how, leave, leftAt] of leaves(leaver)) {
      it(`a ${how} of twin ${leaver} while the watcher reads the shared file feeds neither twin`, async () => {
        await twins()
        const left = leaveAfterRead(leave)
        // Past the window of the seeds' own writes: an outside change.
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10_000 })
        try {
          await getWatcher()['handleFileChange'](path.join(vault.path, 'Supernotes/a.md'))
          await flushProjectionEvents()
        } finally {
          vi.useRealTimers()
        }
        // The feed into the doc runs once the projection queue drains.
        await new Promise((resolve) => setImmediate(resolve))

        expect({
          left: left(),
          crossed: crossed(),
          leaver: {
            row: pathOf(leaver) ?? null,
            indexed: getNoteCacheById(index.db, leaver)?.path ?? null
          },
          survivorOwn: ownBaseline(survivor)
        }).toEqual({
          left: true,
          crossed: [],
          leaver: { row: leftAt, indexed: leftAt },
          survivorOwn: true
        })
      }, 30_000)
    }
  }

  // REVIEW-5632 (1): each twin's write is recorded under its own spelling, and
  // the other twin's later write left it the app's until it expired.
  it("an outside restore of one twin's write is no echo once the other twin wrote", async () => {
    await twins()
    const LOWER_PULLED = '# a\n\nlower pulled [[x]]\n'
    // Each by its row's spelling, as a pull writes them.
    writeNoteFileNow(path.join(vault.path, pathOf('lower')!), LOWER_PULLED)
    writeNoteFileNow(path.join(vault.path, pathOf('upper')!), UPPER_EDITED)

    fs.writeFileSync(path.join(vault.path, 'Supernotes/a.md'), LOWER_PULLED)

    expect(await getWatcher()['isOwnWrite'](path.join(vault.path, 'Supernotes/a.md'))).toBe(false)
  }, 30_000)

  // REVIEW-5501 (3): each twin keeps its own header across the move.
  it("a moved twin keeps its own header, and the survivor's file keeps its own", async () => {
    await headerTwins()

    await moveNoteCommand('upper', 'Other')
    await flushProjectionEvents()

    expect({ moved: read('Other/a.md'), ...lowerHeader() }).toEqual({
      moved: UPPER_HEAD + UPPER,
      ...LOWER_KEPT
    })
  }, 30_000)

  it('a twin moved off bytes that are not its own gets its header from its index rows', async () => {
    await headerTwins()

    await moveNoteCommand('lower', 'Other')

    expect({ moved: read('Other/a.md'), file: shared() }).toEqual({
      moved: expect.stringMatching(LOWER_HEAD_RE),
      file: UPPER_HEAD + UPPER
    })
  }, 30_000)

  it("a twin whose own body is not on this device moves without the other's body", async () => {
    await twins()
    docs.set('lower', new Y.Doc())

    await renameNoteCommand('lower', 'b')

    expect({ row: pathOf('lower'), file: shared() }).toEqual({
      row: 'Supernotes/b.md',
      file: UPPER
    })
    expect(read('Supernotes/b.md')).not.toContain('upper')
  }, 30_000)

  // REVIEW-5501 (4): a twin that would become a journal is refused.
  it('a twin rename that would make it a journal is refused and changes nothing', async () => {
    fs.mkdirSync(path.join(vault.path, 'journal'), { recursive: true })
    seed('lower', 'journal/a.md', LOWER)
    seed('upper', 'journal/A.md', UPPER)
    await openVault()
    docs.set('lower', await docOf(LOWER))

    await expect(renameNoteCommand('lower', '2026-01-15')).rejects.toThrow(
      'errors:note.caseTwinMoveRefused'
    )
    expect({
      rows: [pathOf('lower'), pathOf('upper')],
      file: read('journal/a.md'),
      dated: read('journal/2026-01-15.md')
    }).toEqual({ rows: ['journal/a.md', 'journal/A.md'], file: UPPER, dated: null })
  }, 30_000)

  it('renaming a note with no twin moves its file', async () => {
    await twins()
    seed('solo', 'Other/s.md', '# s\n\nsolo\n')

    await renameNoteCommand('solo', 't')

    expect({ old: read('Other/s.md'), renamed: read('Other/t.md'), row: pathOf('solo') }).toEqual({
      old: null,
      renamed: '# s\n\nsolo\n',
      row: 'Other/t.md'
    })
  }, 30_000)

  // Nothing durable happens before the move's step.
  for (const stalled of ['lower', 'upper'] as const) {
    it(`a twin rename waiting on ${stalled}'s doc changes nothing, and fails when it cannot load`, async () => {
      await twins()
      const store = stall()
      unavailable.set(stalled, store.promise)

      const first = renameNoteCommand('lower', 'b')
      await vi.waitFor(() =>
        expect(getCrdtProvider().open).toHaveBeenCalledWith(stalled, undefined, { skipSeed: true })
      )
      expect(unmoved()).toEqual(UNMOVED)

      store.fail()
      await expect(first).rejects.toBeInstanceOf(NoteError)
      unavailable.clear()
      expect(unmoved()).toEqual(UNMOVED)
      expect(await survivorKeepsOwn('upper')).toEqual([])

      await renameNoteCommand('lower', 'b')
      expect({ row: pathOf('lower'), file: shared() }).toEqual({
        row: 'Supernotes/b.md',
        file: UPPER
      })
    }, 30_000)

    it(`a peer's twin move keeps waiting while ${stalled}'s doc cannot load`, async () => {
      await twins()
      const store = stall()
      unavailable.set(stalled, store.promise)

      expect(() => applyPeerMove('upper', 'a', 'Other')).toThrow(PendingSyncIntentError)
      await vi.waitFor(() =>
        expect(getCrdtProvider().open).toHaveBeenCalledWith(stalled, undefined, { skipSeed: true })
      )
      expect(() => applyPeerMove('upper', 'a', 'Other')).toThrow(PendingSyncIntentError)
      expect({ ...unmoved(), moved: read('Other/a.md') }).toEqual({ ...UNMOVED, moved: null })

      store.fail()
      unavailable.clear()
      await applyPeerMoveWhenReady('upper', 'a', 'Other')
      expect({ upper: pathOf('upper'), moved: read('Other/a.md'), file: shared() }).toEqual({
        upper: 'Other/a.md',
        moved: UPPER,
        file: expect.stringContaining('lower [[x]]')
      })
    }, 30_000)
  }

  // The two files and the row's move are one step.
  it('a twin move that stops right after its step leaves both twins their own files', async () => {
    await twins()
    const real = vi.mocked(safeRead).getMockImplementation()
    vi.mocked(safeRead).mockImplementation((p: string) =>
      p.endsWith(`${path.sep}a.md`) && p.includes(`${path.sep}Other${path.sep}`)
        ? new Promise(() => {})
        : real!(p)
    )
    try {
      void moveNoteCommand('upper', 'Other')
      await vi.waitFor(() => expect(pathOf('upper')).toBe('Other/a.md'))

      expect({
        moved: read('Other/a.md'),
        file: shared(),
        baselines: [ownBaseline('lower'), ownBaseline('upper')]
      }).toEqual({
        moved: UPPER,
        file: expect.stringContaining('lower [[x]]'),
        baselines: [true, true]
      })
    } finally {
      vi.mocked(safeRead).mockImplementation(real!)
    }
    expect(await survivorKeepsOwn('lower')).toEqual([])
  }, 30_000)

  // REVIEW-5609 (#5610): a pass of the moving twin that read its row before
  // the step writes its old path after it: its body over the survivor's file,
  // and its row back to the shared file.
  for (const [how, move, movedTo] of [
    ['move', () => moveNoteCommand('upper', 'Other'), 'Other/a.md'],
    ['rename', () => renameNoteCommand('upper', 'b'), 'SUPERNOTES/b.md']
  ] as const) {
    it(`a twin ${how} waits for the twin's write-back in flight`, async () => {
      await twins()
      const held = holdUpperWrite()
      const pass = writeBack('upper', UPPER_EDITED)
      await held.atWrite

      const moving = move()
      try {
        // Long enough for the move to reach its step if nothing held it back.
        await new Promise((resolve) => setTimeout(resolve, 200))
      } finally {
        held.release()
      }
      await pass
      await moving
      await flushProjectionEvents()

      expect({
        row: pathOf('upper'),
        indexed: getNoteCacheById(index.db, 'upper')?.path,
        moved: read(movedTo),
        file: shared(),
        baselines: [ownBaseline('lower'), ownBaseline('upper')]
      }).toEqual({
        row: movedTo,
        indexed: movedTo,
        moved: expect.stringContaining('upper edited [[x]]'),
        file: expect.stringContaining('lower [[x]]'),
        baselines: [true, true]
      })
      expect(shared()).not.toContain('upper')
      // The survivor's own write-back still lands on its file.
      await writeBack('lower', '# a\n\nlower edited [[x]]\n')
      expect({ file: shared(), crossed: crossed() }).toEqual({
        file: expect.stringContaining('lower edited [[x]]'),
        crossed: []
      })
    }, 30_000)
  }

  it("a peer's twin move waits while the twin's write-back is in flight", async () => {
    await twins()
    // Both files are ready, as on a pull's retry.
    await prepareCaseTwinLeave(vault.path, 'SUPERNOTES/a.md', 'upper', true)
    const held = holdUpperWrite()
    const pass = writeBack('upper', UPPER_EDITED)
    try {
      await held.atWrite
      expect(() => applyPeerMove('upper', 'a', 'Other')).toThrow(PendingSyncIntentError)
      expect({ ...unmoved(), moved: read('Other/a.md') }).toEqual({ ...UNMOVED, moved: null })
    } finally {
      held.release()
    }
    await pass

    await applyPeerMoveWhenReady('upper', 'a', 'Other')
    expect({ upper: pathOf('upper'), moved: read('Other/a.md'), file: shared() }).toEqual({
      upper: 'Other/a.md',
      moved: expect.stringContaining('upper edited [[x]]'),
      file: expect.stringContaining('lower [[x]]')
    })
    expect(shared()).not.toContain('upper')
  }, 30_000)

  /** Fails twin upper's baseline record, which its move's step makes after writing its file. */
  function failUpperBaseline(): () => void {
    const real = vi.mocked(recordBaseline).getMockImplementation()!
    vi.mocked(recordBaseline).mockImplementation((...args: Parameters<typeof recordBaseline>) => {
      if (args[1] === 'upper') throw new Error('index gone')
      real(...args)
    })
    return () => vi.mocked(recordBaseline).mockImplementation(real)
  }

  // VERIFY-5501 (14): a throw after the moved twin's file is written leaves a
  // file no row names, which the next vault open lists as a third note.
  for (const [how, move] of [
    ['local', () => moveNoteCommand('upper', 'Other')],
    [
      'peer',
      async () => {
        await prepareCaseTwinLeave(vault.path, 'SUPERNOTES/a.md', 'upper', true)
        applyPeerMove('upper', 'a', 'Other')
      }
    ]
  ] as const) {
    it(`a ${how} twin move that throws after writing the moved file leaves no file there`, async () => {
      await twins()
      const restore = failUpperBaseline()
      try {
        await expect(move()).rejects.toThrow('index gone')
      } finally {
        restore()
      }

      expect({ row: pathOf('upper'), moved: read('Other/a.md') }).toEqual({
        row: 'SUPERNOTES/a.md',
        moved: null
      })
      await stopWatcher()
      await openVault()
      expect(rowIds()).toEqual(['lower', 'upper'])
      await (how === 'local'
        ? moveNoteCommand('upper', 'Other')
        : applyPeerMoveWhenReady('upper', 'a', 'Other'))
      expect({ row: pathOf('upper'), moved: read('Other/a.md') }).toEqual({
        row: 'Other/a.md',
        moved: expect.stringContaining('upper [[x]]')
      })
    }, 30_000)
  }

  /** Fails twin upper's row move to Other/a.md, inside its transaction, before or after its canonical row moved. */
  function failUpperRowMove(when: 'before' | 'after'): () => void {
    const real = vi.mocked(persistNoteToCache).getMockImplementation()!
    vi.mocked(persistNoteToCache).mockImplementation(
      (...args: Parameters<typeof persistNoteToCache>) => {
        const fails = args[0].id === 'upper' && args[0].path === 'Other/a.md'
        if (fails && when === 'before') throw new Error('index gone')
        const persisted = real(...args)
        if (fails) throw new Error('index gone')
        return persisted
      }
    )
    return () => vi.mocked(persistNoteToCache).mockImplementation(real)
  }

  // REVIEW-5618 (1): a throw after the canonical row moved left the row on a
  // file the step then removed, with the index still on the shared file.
  for (const when of ['before', 'after'] as const) {
    it(`a twin move whose row move throws ${when} the canonical row moves leaves the row and no new file`, async () => {
      await twins()
      const restore = failUpperRowMove(when)
      try {
        await expect(moveNoteCommand('upper', 'Other')).rejects.toThrow('index gone')
      } finally {
        restore()
      }
      await flushProjectionEvents()

      expect({ row: pathOf('upper'), moved: read('Other/a.md') }).toEqual({
        row: 'SUPERNOTES/a.md',
        moved: null
      })
      // Neither twin takes the other's body, and a retry lands the move.
      await writeBack('upper', UPPER)
      expect({ file: shared(), crossed: crossed() }).toEqual({
        file: expect.stringContaining('lower [[x]]'),
        crossed: []
      })
      expect(await survivorKeepsOwn('lower')).toEqual([])
      await moveNoteCommand('upper', 'Other')
      expect({ row: pathOf('upper'), moved: read('Other/a.md'), rows: rowIds() }).toEqual({
        row: 'Other/a.md',
        moved: expect.stringContaining('upper [[x]]'),
        rows: ['lower', 'upper']
      })
    }, 30_000)
  }

  // VERIFY-5618 (7): the local move published its index event inside the row
  // move's transaction, so a commit that failed left the index on a row move
  // the data DB rolled back.
  it("a twin move publishes the moved row's index event once the row move commits", async () => {
    await twins()
    const published: boolean[] = []
    const real = vi.mocked(publishProjectionEvent).getMockImplementation()!
    vi.mocked(publishProjectionEvent).mockImplementation((event) => {
      if (event.type === 'note.upserted' && event.note.path === 'Other/a.md') {
        published.push(data.sqlite.inTransaction)
      }
      real(event)
    })
    try {
      await moveNoteCommand('upper', 'Other')
    } finally {
      vi.mocked(publishProjectionEvent).mockImplementation(real)
    }

    expect({
      row: pathOf('upper'),
      published: published.length > 0,
      insideTransaction: published.includes(true)
    }).toEqual({ row: 'Other/a.md', published: true, insideTransaction: false })
  }, 30_000)

  // VERIFY-5618 (6): the peer's step moved the data row only, and the index
  // row followed at the end of the apply. A throw in between, outside a page as
  // a retried item applies, left the index row on the shared file, and the
  // twin's next write-back took that file for its own.
  it("a peer's twin move that throws after its step keeps the index row with its row", async () => {
    await twins()
    await prepareCaseTwinLeave(vault.path, 'SUPERNOTES/a.md', 'upper', true)
    const emit = vi.fn((channel: string) => {
      if (channel === NotesChannels.events.MOVED) throw new Error('window gone')
    })
    expect(() =>
      noteHandler.applyUpsert(
        { db: asClientDb(data.db), emit },
        'upper',
        { title: 'a', folderPath: 'Other', modifiedAt: '2026-02-01T00:00:00.000Z' },
        { peer: 1 }
      )
    ).toThrow('window gone')

    await writeBack('upper', UPPER_EDITED)
    expect({
      row: pathOf('upper'),
      indexed: getNoteCacheById(index.db, 'upper')?.path,
      moved: read('Other/a.md'),
      file: shared(),
      crossed: crossed()
    }).toEqual({
      row: 'Other/a.md',
      indexed: 'Other/a.md',
      moved: expect.stringContaining('upper edited [[x]]'),
      file: expect.stringContaining('lower [[x]]'),
      crossed: []
    })
  }, 30_000)

  /** A peer's update of a twin's header tags and cover, as a pull applies it. */
  const applyPeerHeader = (id: 'lower' | 'upper', tags: string[], cover: string) =>
    noteHandler.applyUpsert(
      { db: asClientDb(data.db), emit: vi.fn() },
      id,
      {
        title: 'a',
        folderPath: path.posix.dirname(pathOf(id)!),
        tags,
        cover: { ref: cover },
        modifiedAt: '2026-02-01T00:00:00.000Z'
      },
      { peer: 1 }
    )

  // VERIFY-5501 (15, #5561): the shared file holds upper's bytes. Patching
  // them for lower put upper's body under lower's tags, and upper's aliases
  // and body tags into lower's index rows.
  // REVIEW-5618 (3): its body tags come from its own body, so one also in
  // its header stays when the update drops it from the header.
  it("a peer's header update of the twin off the shared file lands on its own header only", async () => {
    await headerTwins()
    docs.set('lower', await docOf(LOWER_TAGGED))
    // As the index holds lower's own file: a tag in both is one header row.
    setNoteTags(index.db, 'lower', { header: ['lowertag'], inline: ['lowertag', 'lowinline'] })

    await vi.waitFor(() =>
      expect(applyPeerHeader('lower', ['newtag'], 'wash:moss')).toBe('applied')
    )
    await flushProjectionEvents()

    expect({
      file: shared(),
      tags: getNoteTags(index.db, 'lower'),
      aliases: getAliasesForNotes(index.db, ['lower']).get('lower'),
      cover: getNoteCacheById(index.db, 'lower')?.cover
    }).toEqual({
      file: UPPER_HEAD + UPPER,
      tags: ['newtag', 'lowertag', 'lowinline'],
      aliases: ['lowalias'],
      cover: 'wash:moss'
    })
    // A split gives lower its own file, with the update.
    await moveNoteCommand('lower', 'Other')
    expect(read('Other/a.md')).toMatch(
      /^---\ntags:\n {2}- newtag\nstatus: low\ncover: 'wash:moss'\naliases:\n {2}- lowalias\n---\n[\s\S]*lower \[\[x\]\] #lowertag #lowinline\n$/
    )
    expect(await survivorKeepsOwn('upper')).toEqual([])
  }, 30_000)

  // VERIFY-5618 (8): a doc that cannot convert held the update for good.
  it("a peer's header update of a twin off the shared file whose doc cannot convert keeps its indexed body tags", async () => {
    await headerTwins()
    setNoteTags(index.db, 'lower', { header: ['lowertag'], inline: ['lowinline'] })
    const store = stall()
    unavailable.set('lower', store.promise)
    store.fail()

    await vi.waitFor(() =>
      expect(applyPeerHeader('lower', ['newtag'], 'wash:moss')).toBe('applied')
    )
    await flushProjectionEvents()

    expect({
      file: shared(),
      tags: getNoteTags(index.db, 'lower'),
      cover: getNoteCacheById(index.db, 'lower')?.cover
    }).toEqual({ file: UPPER_HEAD + UPPER, tags: ['newtag', 'lowinline'], cover: 'wash:moss' })
  }, 30_000)

  it("a peer's header update of the twin on the shared file lands in the file", async () => {
    await headerTwins()

    expect(applyPeerHeader('upper', ['newup'], 'wash:moss')).toBe('applied')

    expect({
      file: shared(),
      lowerTags: getNoteTags(index.db, 'lower'),
      lowerAliases: getAliasesForNotes(index.db, ['lower']).get('lower')
    }).toEqual({
      file: expect.stringMatching(
        /^---\ntags:\n {2}- newup\nstatus: secret\naliases:\n {2}- upalias\ncover: 'wash:moss'\n---\n# a\n\nupper \[\[x\]\]\n$/
      ),
      lowerTags: ['lowertag'],
      lowerAliases: ['lowalias']
    })
  }, 30_000)

  it('renaming the folder of two twins keeps both on the file they share', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'), { recursive: true })
    seed('lower', 'Supernotes/a.md', LOWER)
    seed('upper', 'Supernotes/A.md', UPPER)
    await openVault()

    await renameFolderCommand('Supernotes', 'Renamed')

    expect({
      rows: { lower: pathOf('lower'), upper: pathOf('upper') },
      file: read('Renamed/a.md')
    }).toEqual({ rows: { lower: 'Renamed/a.md', upper: 'Renamed/A.md' }, file: UPPER })
  }, 30_000)

  it('renaming a folder that would strand a twin spelled in another case is refused', async () => {
    await twins()

    await expect(renameFolderCommand('Supernotes', 'Renamed')).rejects.toThrow(
      'errors:folder.renameCaseTwins'
    )
    expect({ ...unmoved(), renamed: fs.existsSync(path.join(vault.path, 'Renamed')) }).toEqual({
      ...UNMOVED,
      renamed: false
    })
  }, 30_000)

  // VERIFY-5618 (#5643): a pass of a twin that read its row before a folder
  // rename writes the old path after the folder moved. It makes the old folder
  // again with that twin's body alone and puts its row back there, so the
  // other twin's file holds bytes that are not its own, and the next vault
  // open feeds them into it.
  async function folderTwins(): Promise<void> {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'), { recursive: true })
    seed('lower', 'Supernotes/a.md', LOWER)
    seed('upper', 'Supernotes/A.md', UPPER)
    await openVault()
    docs.set('lower', await docOf(LOWER))
    docs.set('upper', await docOf(UPPER))
  }

  /** Where the twins and upper's edit are after the rename, then after a vault open. */
  async function afterFolderRename() {
    await flushProjectionEvents()
    const renamed = {
      rows: [pathOf('lower'), pathOf('upper')],
      indexed: [
        getNoteCacheById(index.db, 'lower')?.path,
        getNoteCacheById(index.db, 'upper')?.path
      ],
      file: read('Renamed/a.md'),
      oldFolder: fs.existsSync(path.join(vault.path, 'Supernotes'))
    }
    await openVault()
    // Lower's write-back, with the file it shares holding upper's edit.
    await writeBack('lower', LOWER)
    return { ...renamed, reopened: rowIds(), crossed: crossed() }
  }

  const RENAMED_WITH_EDIT = {
    rows: ['Renamed/a.md', 'Renamed/A.md'],
    indexed: ['Renamed/a.md', 'Renamed/A.md'],
    file: expect.stringContaining('upper edited [[x]]'),
    oldFolder: false,
    reopened: ['lower', 'upper'],
    crossed: []
  }

  it("a folder rename waits for a twin's write-back in flight", async () => {
    await folderTwins()
    const held = holdUpperWrite()
    const pass = writeBack('upper', UPPER_EDITED)
    await held.atWrite

    const renaming = renameFolderCommand('Supernotes', 'Renamed')
    try {
      // Long enough for the rename to move the folder if nothing held it back.
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      held.release()
    }
    await pass
    await renaming

    expect(await afterFolderRename()).toEqual(RENAMED_WITH_EDIT)
  }, 30_000)

  it('a twin write-back that starts while its folder moves waits for the rename', async () => {
    await folderTwins()
    await stopWatcher()
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

    const renaming = renameFolderCommand('Supernotes', 'Renamed')
    let pass: Promise<void> = Promise.resolve()
    try {
      await moved
      pass = writeBack('upper', UPPER_EDITED)
      // Long enough for the pass to write if nothing held it back.
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      release()
    }
    await renaming
    await pass

    expect(await afterFolderRename()).toEqual(RENAMED_WITH_EDIT)
  }, 30_000)

  // ==========================================================================
  // Folder delete (#5642)
  // ==========================================================================

  const REAL = '# real\n\nreal body\n'

  /** The sidebar's folder delete, through its IPC handler. */
  async function deleteFolderFromSidebar(folderPath: string) {
    registerNotesHandlers()
    return invokeHandler(NotesChannels.invoke.DELETE_FOLDER, folderPath)
  }

  /**
   * The disk holds `SuperNotes/` with `a.md` and `real.md`. The twin `upper`
   * is filed under `Supernotes/`, so the sidebar draws that folder too.
   */
  async function twinInOldSpelling(): Promise<void> {
    fs.mkdirSync(path.join(vault.path, 'SuperNotes'))
    seed('lower', 'SuperNotes/a.md', LOWER)
    seed('upper', 'Supernotes/a.md', UPPER)
    seed('real', 'SuperNotes/real.md', REAL)
    await openVault()
  }

  const folderOnDisk = () => {
    const folder = path.join(vault.path, 'SuperNotes')
    return {
      rows: rowIds(),
      files: fs.existsSync(folder) ? fs.readdirSync(folder).toSorted() : null,
      real: read('SuperNotes/real.md')
    }
  }
  const UNDELETED = { rows: ['lower', 'real', 'upper'], files: ['a.md', 'real.md'], real: REAL }

  for (const [which, folderPath] of [
    ['the old-spelling folder of a twin', 'Supernotes'],
    ['the old-spelling folder of a twin with a trailing slash', 'Supernotes/'],
    ['the old-spelling folder of a twin as ./Supernotes', './Supernotes'],
    ['the old-spelling folder of a twin as Supernotes/.', 'Supernotes/.'],
    ['the folder on disk while a twin is filed in another spelling', 'SuperNotes']
  ] as const) {
    it(`deleting ${which} is refused and deletes nothing`, async () => {
      await twinInOldSpelling()

      const response = await deleteFolderFromSidebar(folderPath)

      expect({ response, ...folderOnDisk() }).toEqual({
        response: { success: false, error: 'errors:folder.deleteCaseTwins' },
        ...UNDELETED
      })
    }, 30_000)
  }

  for (const vaultRoot of ['', '.', '/']) {
    it(`deleting the vault itself as '${vaultRoot}' is refused and deletes nothing (#5653)`, async () => {
      await twinInOldSpelling()

      const response = await deleteFolderFromSidebar(vaultRoot)

      expect({ response, memry: fs.existsSync(vault.memryDir), ...folderOnDisk() }).toEqual({
        response: { success: false, error: 'Not a vault folder that can be deleted' },
        memry: true,
        ...UNDELETED
      })
    }, 30_000)
  }

  it('deleting a folder that holds twins spelled with its own name deletes it', async () => {
    fs.mkdirSync(path.join(vault.path, 'Supernotes'))
    seed('lower', 'Supernotes/a.md', LOWER)
    seed('upper', 'Supernotes/A.md', UPPER)
    await openVault()

    expect(await deleteFolderFromSidebar('Supernotes')).toEqual({ success: true })
    expect(fs.existsSync(path.join(vault.path, 'Supernotes'))).toBe(false)
  }, 30_000)
})
