/**
 * An edit made outside the app a moment after a write-back reaches the doc
 * then, not at some later pass that replaces the body with the file (#5605).
 * The watcher used to drop every event on a path for 5 s after the app wrote
 * it. The edit then waited on disk until the next pass, armed by a peer's
 * update, took the file over the doc and deleted the peer's edit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import type { LogMessage } from 'electron-log'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { getNoteCacheById, insertNoteCache } from '@main/database/queries/notes'
import { upsertNoteMetadata } from '@memry/storage-data'
import type * as FileOps from './file-ops'

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
    isPersistent: () => true,
    isNoteLocalOnly: () => false,
    isAwaitingMerge: () => false,
    open: async (id: string) => docs.get(id),
    closeIfInactive: async () => {},
    whenPersisted: async () => {},
    isStoring: () => false,
    withDocLoaded: async (_id: string, enqueue: () => void) => enqueue(),
    purge: vi.fn()
  }
  return { ORIGIN_LOCAL: 'local', getCrdtProvider: vi.fn(() => stub) }
})
// Runs a step between a pass's file write and the end of that pass, the
// moment a late watcher event can read the file.
const afterNextWrite = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }))
vi.mock('./file-ops', async (importOriginal) => {
  const real = await importOriginal<typeof FileOps>()
  return {
    ...real,
    atomicWrite: async (filePath: string, content: string) => {
      await real.atomicWrite(filePath, content)
      const run = afterNextWrite.run
      afterNextWrite.run = null
      await run?.()
    }
  }
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
import { log } from '../lib/logger'
import { markdownToYFragment, yDocToMarkdown } from '../sync/blocknote-converter'
import { resetWritebackState, writebackNow } from '../sync/crdt-writeback'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { generateContentHash } from './frontmatter'
import { clearIngestBackfill } from './ingest-backfill'
import { getWatcher, startWatcher, stopWatcher } from './watcher'

const BODY = '# Plan\n\nWrite the draft.\n'
const NOTE_PATH = 'notes/plan.md'

/** The watcher's change handler, past chokidar's debounce, so a test can time the event. */
interface ChangeHandler {
  handleFileChange(eventPath: string): Promise<void>
}

describe('an outside edit made right after a write-back (#5605)', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let logged: string[]
  const keepLog = (message: LogMessage): LogMessage => {
    logged.push(message.data.map(String).join(' '))
    return message
  }

  beforeEach(() => {
    vault = createTestVault('outside-edit-after-writeback')
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
    logged = []
    log.hooks.push(keepLog)
  })

  afterEach(async () => {
    log.hooks.splice(log.hooks.indexOf(keepLog), 1)
    afterNextWrite.run = null
    docs.clear()
    await stopWatcher()
    await stopProjectionRuntime({ drain: true })
    clearIngestBackfill()
    resetWritebackState()
    index.close()
    data.close()
    vault.cleanup()
    vi.clearAllMocks()
  })

  function textNode(doc: Y.Doc, text: string): Y.XmlText | undefined {
    return [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)].find(
      (node): node is Y.XmlText => node instanceof Y.XmlText && node.toString() === text
    )
  }

  function typeAfter(doc: Y.Doc, text: string, typed: string): void {
    const node = textNode(doc, text)
    if (!node) throw new Error(`no text node "${text}"`)
    node.insert(node.length, typed)
  }

  async function settles(done: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs
    while (Date.now() < until && !(await done())) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /** A note open in the editor, its doc and file saying the same, with the watcher running. */
  async function openNote(): Promise<{ doc: Y.Doc; file: string; docText: () => Promise<string> }> {
    const fields = {
      id: 'plan',
      path: NOTE_PATH,
      title: 'plan',
      fileType: 'markdown' as const,
      localOnly: false,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: '2026-01-12T00:00:00.000Z',
      fileSize: Buffer.byteLength(BODY)
    }
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, { ...fields, contentHash: generateContentHash(BODY) })
    const file = path.join(vault.path, NOTE_PATH)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, BODY)
    const doc = new Y.Doc()
    await markdownToYFragment(BODY, doc.getXmlFragment('prosemirror'), NOTE_PATH)
    docs.set('plan', doc)
    await startWatcher(vault.path)
    const docText = async (): Promise<string> =>
      (await yDocToMarkdown(doc, 'prosemirror', { notePath: NOTE_PATH })) ?? ''
    return { doc, file, docText }
  }

  it('feeds other bytes written right after a write-back and moves the baseline to them', async () => {
    // #given the user typed and the write-back wrote the file
    const { doc, file, docText } = await openNote()
    typeAfter(doc, 'Write the draft.', ' Typed here.')
    await writebackNow('plan', doc)

    // #when another program appends a line within a second of that write
    fs.appendFileSync(file, '\nOutside line.\n')
    const onDisk = fs.readFileSync(file, 'utf8')
    const baseline = (): string | null | undefined =>
      getNoteCacheById(index.db, 'plan')?.contentHash
    await settles(
      async () =>
        (await docText()).includes('Outside line.') && baseline() === generateContentHash(onDisk),
      3000
    )

    // #then the doc holds both, and the index names the outside bytes as read
    expect(await docText()).toContain('Typed here.')
    expect(await docText()).toContain('Outside line.')
    expect(baseline()).toBe(generateContentHash(onDisk))
  }, 30_000)

  it('drops the echo of a write, even one read while the next pass writes', async () => {
    // #given the user typed and the write-back wrote the file
    const { doc, file, docText } = await openNote()
    typeAfter(doc, 'Write the draft.', ' First.')
    await writebackNow('plan', doc)

    // #when the next pass is writing, the user types on, and a late event of
    // the app's own write reads the file
    afterNextWrite.run = async () => {
      typeAfter(doc, 'Write the draft. First. Second.', ' Still typing.')
      await (getWatcher() as unknown as ChangeHandler).handleFileChange(file)
    }
    typeAfter(doc, 'Write the draft. First.', ' Second.')
    await writebackNow('plan', doc)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await flushProjectionEvents()

    // #then nothing was fed back: the typing stands, and the next pass writes
    // it instead of taking the file as an outside edit
    expect(await docText()).toContain('First. Second. Still typing.')
    await writebackNow('plan', doc)
    expect(fs.readFileSync(file, 'utf8')).toContain('First. Second. Still typing.')
    expect(logged.filter((line) => line.includes('Write-back deferred'))).toEqual([])
  }, 30_000)

  it('reaches the doc at once, and a peer edit merged after it is kept', async () => {
    // #given the user typed and the write-back wrote the file
    const { doc, file, docText } = await openNote()
    typeAfter(doc, 'Write the draft.', ' Typed here.')
    await writebackNow('plan', doc)
    expect(fs.readFileSync(file, 'utf8')).toContain('Typed here.')

    // #when another program appends a line within a second of that write
    fs.appendFileSync(file, '\nOutside line.\n')
    await settles(async () => (await docText()).includes('Outside line.'), 3000)
    await flushProjectionEvents()

    // #and a peer's edit of the heading merges, and its pass writes the note
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
    const seen = Y.encodeStateVector(peer)
    typeAfter(peer, 'Plan', ' (peer)')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, seen), 'remote')
    await writebackNow('plan', doc)

    // #then the doc and the file hold the typing, the outside line and the peer's edit
    const body = await docText()
    expect(body).toContain('Typed here.')
    expect(body).toContain('Outside line.')
    expect(body).toContain('Plan (peer)')
    const written = fs.readFileSync(file, 'utf8')
    expect(written).toContain('Outside line.')
    expect(written).toContain('Plan (peer)')
  }, 30_000)
})
