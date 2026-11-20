import * as Y from 'yjs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import type * as PathsModule from '../lib/paths'
import type * as FeedModule from './crdt-external-feed'
import { createTestIndexDb } from '@tests/utils/test-db'

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  /** Set to make the next file write land and then stop the process before it returns. */
  crashAfterWrite: false,
  /** Set to stop the process after a writer's file write, before its feed reaches the doc. */
  crashBeforeFeed: false,
  indexDb: null as unknown,
  store: new Map<string, Uint8Array[]>(),
  contentHash: (_raw: string): string => ''
}))

// A real, empty folder: the outside-vault check resolves every read against it.
const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-writeback-vault-'))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
  BrowserWindow: { fromId: () => null, getAllWindows: () => [] }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('./crdt-persistence', async () => {
  const Yjs = await import('yjs')
  return {
    openCrdtPersistence: async () => ({
      getYDoc: async (noteId: string) => {
        const doc = new Yjs.Doc()
        for (const update of h.store.get(noteId) ?? []) Yjs.applyUpdate(doc, update)
        return doc
      },
      storeUpdate: async (noteId: string, update: Uint8Array) => {
        h.store.set(noteId, [...(h.store.get(noteId) ?? []), update])
      },
      flushDocument: async () => {},
      clearDocument: async (noteId: string) => {
        h.store.delete(noteId)
      },
      destroy: () => {},
      getMeta: async () => undefined,
      setMeta: async () => {}
    })
  }
})
vi.mock('./crdt-store-epoch', () => ({ reconcileCrdtStoreEpoch: async () => {} }))
vi.mock('./crdt-store-path', () => ({
  prepareVaultCrdtStore: async () => ({ storagePath: '/tmp/crdt', vaultUuid: 'vault-1' })
}))
vi.mock('../store', () => ({ recordCrdtPersistenceOutcome: () => 0 }))
vi.mock('../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: () => 'vault-1' }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../database/client', () => ({
  getDatabase: () => ({}),
  getIndexDatabase: () => h.indexDb,
  isDatabaseInitialized: () => true
}))
vi.mock('../database', () => ({ getDatabase: () => ({}), getIndexDatabase: () => h.indexDb }))
vi.mock('@memry/storage-data', () => ({ getNoteMetadataById: () => undefined }))

vi.mock('../vault/note-snapshots', async () => await import('../vault/notes'))
vi.mock('../vault/notes-versions', async () => await import('../vault/notes'))
vi.mock('../vault/notes-crud', async () => await import('../vault/notes'))
vi.mock('../vault/notes-io', async () => await import('../vault/notes'))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => VAULT_ROOT,
  toAbsolutePath: (relative: string) => `/vault/${relative}`,
  maybeCreateSignificantSnapshot: () => null,
  emitNoteEvent: vi.fn()
}))
vi.mock('../lib/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof PathsModule>()),
  readVaultFile: async (_vault: string, relative: string) =>
    h.files.get(`/vault/${relative}`) ?? null
}))
vi.mock('../vault/file-ops', () => ({
  safeRead: async (absolute: string) => h.files.get(absolute) ?? null,
  atomicWrite: async (absolute: string, content: string) => {
    h.files.set(absolute, content)
    if (h.crashAfterWrite) {
      h.crashAfterWrite = false
      throw new Error('crashed after the write landed')
    }
  },
  ensureDirectory: vi.fn(),
  deleteFile: vi.fn()
}))
vi.mock('../vault/journal', () => ({ getJournalPath: vi.fn() }))
vi.mock('../vault/note-sync', async () => {
  const q = await import('@main/database/queries/notes')
  return {
    // The projector's update of a row the real index holds (note-derived-state-projector.ts).
    syncNoteToCache: (
      db: never,
      input: { id: string; fileContent: string; contentHash?: string }
    ) => {
      if (q.getNoteCacheById(db, input.id)) {
        q.updateNoteCache(db, input.id, {
          contentHash: input.contentHash ?? h.contentHash(input.fileContent)
        })
      }
      return { wordCount: 0 }
    },
    deleteNoteFromCache: vi.fn()
  }
})
vi.mock('./crdt-external-feed', async (importOriginal) => {
  const actual = await importOriginal<typeof FeedModule>()
  return {
    ...actual,
    feedExternalEditToCrdt: (...args: Parameters<typeof actual.feedExternalEditToCrdt>) => {
      if (!h.crashBeforeFeed) return actual.feedExternalEditToCrdt(...args)
      h.crashBeforeFeed = false
      return Promise.reject(new Error('crashed before the feed'))
    }
  }
})
vi.mock('../vault/attachment-rename-reconcile', () => ({ reconcileRenamedAttachments: vi.fn() }))
vi.mock('../projections', () => ({ flushProjectionEvents: vi.fn() }))
vi.mock('../notes/note-date-reminders', () => ({
  syncNoteDateReminders: vi.fn(),
  clearNoteDateReminders: vi.fn()
}))
vi.mock('@memry/app-core/reminders', () => ({ createRemindersService: vi.fn() }))
vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

import { getCrdtProvider } from './crdt-provider'
import { hasPendingWriteback, resetWritebackState } from './crdt-writeback'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'
import { generateContentHash } from '../vault/frontmatter'
import { feedExternalEditToCrdt } from './crdt-external-feed'
import { syncNoteToCache } from '../vault/note-sync'
import { appendBlocksToNote } from '../vault/append-blocks'
import { insertNoteCache } from '@main/database/queries/notes'
import type { NewNoteCache } from '@memry/db-schema/schema/notes-cache'

beforeAll(() => {
  h.indexDb = createTestIndexDb().db
})

const NOTE = 'lsk8vi9izpep'
const NOTE_PATH = 'Baseline/Daily Routine.md'
const FILE = `/vault/${NOTE_PATH}`
const FRONTMATTER = `---\nid: ${NOTE}\ntitle: Daily Routine\n---\n`

function findText(fragment: Y.XmlFragment, needle: string): Y.XmlText {
  const stack: Array<Y.XmlElement | Y.XmlFragment | Y.XmlText> = [fragment]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node instanceof Y.XmlText) {
      if (node.toString().includes(needle)) return node
      continue
    }
    stack.push(...(node.toArray() as Array<Y.XmlElement | Y.XmlText>))
  }
  throw new Error(`no text holding ${needle}`)
}

/** Puts the note's row in the real index the write-back reads. */
function seedRow(row: Record<string, unknown>): void {
  insertNoteCache(h.indexDb as never, row as NewNoteCache)
}

async function settleWriteback(noteId = NOTE): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
  await vi.waitFor(() => expect(hasPendingWriteback(noteId)).toBe(false), { timeout: 5000 })
}

function rowFor(id: string, notePath: string, indexedRaw: string): Record<string, unknown> {
  return {
    id,
    path: notePath,
    title: path.basename(notePath, '.md'),
    fileType: 'markdown',
    localOnly: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    contentHash: generateContentHash(indexedRaw),
    pendingWriteHash: null
  }
}

/** An edit from another device or the editor, made on a copy of `doc`. */
function editOf(doc: Y.Doc, find: string, insert: string): Uint8Array {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  const seen = Y.encodeStateVector(copy)
  const text = findText(copy.getXmlFragment(CRDT_FRAGMENT_NAME), find)
  text.insert(text.length, insert)
  return Y.encodeStateAsUpdate(copy, seen)
}

describe('write-back after the file changed while the app was closed (#2539)', () => {
  beforeAll(() => {
    h.contentHash = generateContentHash
  })

  it('ingests the changed file on launch and writes later edits to it', async () => {
    const author = new Y.Doc()
    await markdownToYFragment(
      '# Morning\n\nMake coffee.',
      author.getXmlFragment(CRDT_FRAGMENT_NAME),
      NOTE_PATH
    )
    const lastSession = `${FRONTMATTER}${(await yDocToMarkdown(author, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH }))!}`
    h.store.set(NOTE, [Y.encodeStateAsUpdate(author)])
    seedRow({
      id: NOTE,
      path: NOTE_PATH,
      title: 'Daily Routine',
      fileType: 'markdown',
      localOnly: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      contentHash: generateContentHash(lastSession)
    })
    h.files.set(FILE, `${lastSession}\n\nStretch for ten minutes.`)

    const provider = getCrdtProvider()
    await provider.initPersistence()
    expect(provider.hasPersistence()).toBe(true)

    const doc = await provider.open(NOTE, 1)

    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(author))
    const before = Y.encodeStateVector(peer)
    const heading = findText(peer.getXmlFragment(CRDT_FRAGMENT_NAME), 'Morning')
    heading.insert(heading.length, ' routine')
    provider.applyRemoteUpdate(NOTE, Y.encodeStateAsUpdate(peer, before))
    await settleWriteback()

    const editor = new Y.Doc()
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(doc))
    const seen = Y.encodeStateVector(editor)
    const text = findText(editor.getXmlFragment(CRDT_FRAGMENT_NAME), 'Stretch')
    text.insert(text.length, ' Then shower.')
    provider.applyIpcUpdate(NOTE, Y.encodeStateAsUpdate(editor, seen), 1)
    await settleWriteback()

    expect(h.files.get(FILE)).toBe(
      `${FRONTMATTER}# Morning\n\nMake coffee.\n\nStretch for ten minutes. Then shower.`
    )
  })
})

describe('the write-back never reads bytes Memry wrote or read as an outside edit (#5296)', () => {
  beforeAll(() => {
    h.contentHash = generateContentHash
  })

  it('keeps the first keystroke into a note seeded from a file edited while the app was closed', async () => {
    // #given the index measured the file, then it was edited outside while the
    // app was closed, and the store holds no doc for it (probe I4)
    const id = 'seeded-after-outside-edit'
    const notePath = 'Seeded/Plan.md'
    const indexed = '# Plan\n\nWrite the draft.'
    const edited = '# Plan\n\nWrite the draft. Edited outside.'
    seedRow(rowFor(id, notePath, indexed))
    h.files.set(`/vault/${notePath}`, edited)
    fs.mkdirSync(path.join(VAULT_ROOT, 'Seeded'), { recursive: true })
    fs.writeFileSync(path.join(VAULT_ROOT, notePath), edited)
    const provider = getCrdtProvider()
    await provider.initPersistence()

    // #when the note opens, which seeds its doc from the file, and the user types
    const doc = await provider.open(id, 1)
    provider.applyIpcUpdate(id, editOf(doc, 'Edited outside.', ' Typed.'), 1)
    await settleWriteback(id)

    // #then the keystroke reaches the file and stays in the doc
    expect(h.files.get(`/vault/${notePath}`)).toContain('Edited outside. Typed.')
    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath })).toContain('Typed.')
  })

  it('keeps a remote edit that follows a crash between the file write and its hash', async () => {
    // #given a note whose last write-back landed on disk and crashed before
    // the index recorded it (probe I2a)
    const id = 'crashed-mid-writeback'
    const notePath = 'Crash/Log.md'
    const author = new Y.Doc()
    await markdownToYFragment(
      '# Log\n\nFirst line.',
      author.getXmlFragment(CRDT_FRAGMENT_NAME),
      notePath
    )
    const indexed = (await yDocToMarkdown(author, CRDT_FRAGMENT_NAME, { notePath }))!
    h.store.set(id, [Y.encodeStateAsUpdate(author)])
    seedRow(rowFor(id, notePath, indexed))
    h.files.set(`/vault/${notePath}`, indexed)
    const provider = getCrdtProvider()
    await provider.initPersistence()
    const doc = await provider.open(id, 1)

    h.crashAfterWrite = true
    provider.applyRemoteUpdate(id, editOf(doc, 'First line.', ' Second.'))
    await settleWriteback(id)
    expect(h.files.get(`/vault/${notePath}`)).toContain('First line. Second.')
    resetWritebackState()

    // #when the next remote edit writes back
    provider.applyRemoteUpdate(id, editOf(doc, 'First line. Second.', ' Third.'))
    await settleWriteback(id)

    // #then the file and the doc keep it: Memry's own bytes were not fed back
    expect(h.files.get(`/vault/${notePath}`)).toContain('First line. Second. Third.')
    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath })).toContain('Third.')
  })

  it('keeps an outside revert to the bytes a crashed write left, once a later edit moved the hash', async () => {
    // #given a write-back that crashed after its write landed: disk B, hash A, pending B
    const id = 'stale-pending-revert'
    const notePath = 'Crash/Revert.md'
    const author = new Y.Doc()
    await markdownToYFragment(
      '# Log\n\nFirst line.',
      author.getXmlFragment(CRDT_FRAGMENT_NAME),
      notePath
    )
    const indexed = (await yDocToMarkdown(author, CRDT_FRAGMENT_NAME, { notePath }))!
    const file = `/vault/${notePath}`
    h.store.set(id, [Y.encodeStateAsUpdate(author)])
    seedRow(rowFor(id, notePath, indexed))
    h.files.set(file, indexed)
    const provider = getCrdtProvider()
    await provider.initPersistence()
    const doc = await provider.open(id, 1)
    h.crashAfterWrite = true
    provider.applyRemoteUpdate(id, editOf(doc, 'First line.', ' Second.'))
    await settleWriteback(id)
    resetWritebackState()
    await provider.close(id, 1)
    const reopened = await provider.open(id, 1)
    const crashed = h.files.get(file)!

    // #and the user adds a paragraph in another editor, which the watcher
    // indexes and then feeds, then removes it again while the app is closed
    const added = `${crashed}\n\nDraft paragraph.`
    h.files.set(file, added)
    syncNoteToCache(h.indexDb as never, { id, fileContent: added } as never, { isNew: false })
    await feedExternalEditToCrdt(
      id,
      `${crashed.replace(/^---[\s\S]*?---\n/, '')}\n\nDraft paragraph.`
    )
    await settleWriteback(id)
    h.files.set(file, crashed)

    // #when a remote edit writes the note back
    provider.applyRemoteUpdate(id, editOf(reopened, 'First line. Second.', ' Third.'))
    await settleWriteback(id)

    // #then the revert is an outside edit the doc takes, not Memry's own bytes
    expect(h.files.get(file)).toBe(crashed)
    expect(await yDocToMarkdown(reopened, CRDT_FRAGMENT_NAME, { notePath })).not.toContain(
      'Draft paragraph.'
    )
  })
})

describe("Memry's own writers feed the doc before the baseline names their bytes (#5304)", () => {
  beforeAll(() => {
    h.contentHash = generateContentHash
  })

  it('keeps blocks appended to an open note when the process stops before the feed', async () => {
    // #given an open note whose file and baseline hold its doc's body
    const id = 'append-target'
    const notePath = 'Append/Inbox.md'
    const file = `/vault/${notePath}`
    const author = new Y.Doc()
    await markdownToYFragment(
      '# Inbox\n\nFirst line.',
      author.getXmlFragment(CRDT_FRAGMENT_NAME),
      notePath
    )
    const indexed = (await yDocToMarkdown(author, CRDT_FRAGMENT_NAME, { notePath }))!
    h.store.set(id, [Y.encodeStateAsUpdate(author)])
    seedRow(rowFor(id, notePath, indexed))
    seedRow(rowFor('append-source', 'Append/Source.md', ''))
    h.files.set(file, indexed)
    const provider = getCrdtProvider()
    await provider.initPersistence()
    const doc = await provider.open(id, 1)

    // #when "Move to" appends a block and the process stops after the file
    // write, before the feed reaches the doc
    h.crashBeforeFeed = true
    await expect(
      appendBlocksToNote({ sourceNoteId: 'append-source', targetNoteId: id, markdown: 'Moved.' })
    ).rejects.toThrow('crashed before the feed')
    expect(h.files.get(file)).toContain('Moved.')
    resetWritebackState()

    // #and a remote edit then writes the note back
    provider.applyRemoteUpdate(id, editOf(doc, 'First line.', ' Remote.'))
    await settleWriteback(id)

    // #then the appended block is in the file and in the doc
    expect(h.files.get(file)).toContain('Moved.')
    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath })).toContain('Moved.')
  })
})
