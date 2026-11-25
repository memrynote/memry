/**
 * Deleting one of two case twins on a case-insensitive disk when a twin is a
 * binary note (#5562). A binary survivor keeps the shared file's bytes as they
 * are: it has no doc to rebuild a file from. A markdown survivor of a binary
 * twin gets its own file back.
 *
 * @module vault/case-twins-binary-delete.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
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
    // The issue's repro: any doc opened for a note is empty, a binary one too.
    open: vi.fn(async (id: string) => {
      if (unavailable.has(id)) await unavailable.get(id)
      return docs.get(id) ?? new Y.Doc()
    }),
    withDocLoaded: vi.fn(async (id: string, run: () => void) => {
      if (unavailable.has(id)) await unavailable.get(id)
      run()
    }),
    closeIfInactive: async () => {},
    whenPersisted: async () => {},
    holdsDoc: () => true,
    purge: vi.fn(async () => {})
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
import { getCrdtProvider } from '../sync/crdt-provider'
import { markdownToYFragment } from '../sync/blocknote-converter'
import { recordAppWrite } from './app-writes'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { generateContentHash, parseNote } from './frontmatter'
import { deleteNoteCommand } from '../notes/domain'
import { enqueueLocalSyncDelete } from '../sync/local-mutations'
import { noteHandler } from '../sync/item-handlers/note-handler'

function fileSystemIgnoresCase(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-case-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '')
    return fs.existsSync(path.join(dir, 'PROBE'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** PNG signature, then bytes that are not valid UTF-8. */
const B_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x62
])
const SURVIVOR_MD = '# a\n\nsurvivor body\n'

describe.runIf(fileSystemIgnoresCase())('deleting a case twin of a binary note', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('case-twins-binary-delete')
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
    await stopProjectionRuntime({ drain: true })
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  /** A synced row and its index row; a binary one has no content hash. */
  function row(id: string, relativePath: string, fileType: 'markdown' | 'image', hashOf?: string) {
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, path.extname(relativePath)),
      fileType,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: '2026-01-12T00:00:00.000Z',
      fileSize: B_BYTES.length
    }
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, {
      ...fields,
      contentHash: hashOf === undefined ? null : generateContentHash(hashOf)
    })
  }

  function onDisk(relativePath: string, bytes: Buffer | string): void {
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    const landed = recordAppWrite(absolutePath, bytes)
    fs.writeFileSync(absolutePath, bytes)
    landed()
  }

  const fileAt = (relativePath: string) => fs.readFileSync(path.join(vault.path, relativePath))
  const rowIds = () =>
    data.db
      .select({ id: noteMetadata.id })
      .from(noteMetadata)
      .all()
      .map((r) => r.id)
      .toSorted()
  const deletes = () => vi.mocked(enqueueLocalSyncDelete).mock.calls
  const applyPeerDelete = (id: string) =>
    noteHandler.applyDelete({ db: asClientDb(data.db), emit: vi.fn() }, id)

  /** The issue's repro: A and B, binary, on one file holding B's bytes. */
  function binaryTwins(): void {
    row('twin-a', 'Supernotes/p.png', 'image')
    row('twin-b', 'SUPERNOTES/p.png', 'image')
    onDisk('Supernotes/p.png', B_BYTES)
  }

  it("deleting a binary twin keeps the shared file's bytes for the binary survivor", async () => {
    binaryTwins()

    await deleteNoteCommand('twin-b')

    expect({ file: fileAt('Supernotes/p.png'), rows: rowIds(), deletes: deletes() }).toEqual({
      file: B_BYTES,
      rows: ['twin-a'],
      deletes: [['note', 'twin-b']]
    })
  })

  it("a peer's delete of a binary twin keeps the shared file's bytes for the binary survivor", () => {
    binaryTwins()

    expect(applyPeerDelete('twin-b')).toBe('applied')

    expect({ file: fileAt('Supernotes/p.png'), rows: rowIds(), deletes: deletes() }).toEqual({
      file: B_BYTES,
      rows: ['twin-a'],
      deletes: []
    })
  })

  // A binary row on a markdown-named file: an older build saved some binary
  // notes under the markdown type and name (`isBinaryNoteRow`).
  it('deleting a markdown twin keeps the shared file as it is for a binary survivor', async () => {
    row('md', 'Supernotes/a.md', 'markdown', SURVIVOR_MD)
    row('bin', 'SUPERNOTES/a.md', 'image')
    onDisk('Supernotes/a.md', B_BYTES)

    await deleteNoteCommand('md')

    expect({ file: fileAt('Supernotes/a.md'), rows: rowIds(), deletes: deletes() }).toEqual({
      file: B_BYTES,
      rows: ['bin'],
      deletes: [['note', 'md']]
    })
  })

  it("deleting a binary twin gives a markdown survivor its own file in place of the binary's bytes", async () => {
    row('md', 'Supernotes/a.md', 'markdown', SURVIVOR_MD)
    row('bin', 'SUPERNOTES/a.md', 'image')
    onDisk('Supernotes/a.md', B_BYTES)
    const doc = new Y.Doc()
    await markdownToYFragment('survivor body', doc.getXmlFragment('prosemirror'), 'Supernotes/a.md')
    docs.set('md', doc)

    await deleteNoteCommand('bin')

    const file = fileAt('Supernotes/a.md').toString('utf8')
    expect({ body: parseNote(file).content.trim(), rows: rowIds(), deletes: deletes() }).toEqual({
      body: 'survivor body',
      rows: ['md'],
      deletes: [['note', 'bin']]
    })
  })

  it('a binary twin delete that hangs before its step changes nothing', async () => {
    binaryTwins()
    let fail = (): void => {}
    const stalled = new Promise<never>((_resolve, reject) => {
      fail = () => reject(new Error('store gone'))
    })
    stalled.catch(() => {})
    unavailable.set('twin-b', stalled)

    const deleting = deleteNoteCommand('twin-b')
    await vi.waitFor(() =>
      expect(getCrdtProvider().withDocLoaded).toHaveBeenCalledWith('twin-b', expect.any(Function))
    )
    const hung = { file: fileAt('Supernotes/p.png'), rows: rowIds(), deletes: deletes() }
    fail()
    await expect(deleting).rejects.toThrow('store gone')

    const unchanged = { file: B_BYTES, rows: ['twin-a', 'twin-b'], deletes: [] }
    expect(hung).toEqual(unchanged)
    expect({ file: fileAt('Supernotes/p.png'), rows: rowIds(), deletes: deletes() }).toEqual(
      unchanged
    )
  })

  it('a binary twin delete whose file cannot be read changes nothing', async () => {
    binaryTwins()
    fs.chmodSync(path.join(vault.path, 'Supernotes/p.png'), 0o000)

    await expect(deleteNoteCommand('twin-b')).rejects.toThrow(/EACCES/)

    fs.chmodSync(path.join(vault.path, 'Supernotes/p.png'), 0o644)
    expect({ file: fileAt('Supernotes/p.png'), rows: rowIds(), deletes: deletes() }).toEqual({
      file: B_BYTES,
      rows: ['twin-a', 'twin-b'],
      deletes: []
    })
  })
})
