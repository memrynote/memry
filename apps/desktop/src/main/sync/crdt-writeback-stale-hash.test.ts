import * as Y from 'yjs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  row: null as null | Record<string, unknown>,
  store: new Map<string, Uint8Array[]>(),
  contentHash: (_raw: string): string => ''
}))

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
  getIndexDatabase: () => ({}),
  isDatabaseInitialized: () => true
}))
vi.mock('../database', () => ({ getDatabase: () => ({}), getIndexDatabase: () => ({}) }))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (_db: unknown, noteId: string) => (h.row?.id === noteId ? h.row : undefined),
  updateNoteCache: (_db: unknown, noteId: string, patch: Record<string, unknown>) => {
    if (h.row?.id === noteId) h.row = { ...h.row, ...patch }
  }
}))
vi.mock('@memry/storage-data', () => ({ getNoteMetadataById: () => undefined }))

vi.mock('../vault/notes', () => ({
  getVaultRoot: () => '/vault',
  toAbsolutePath: (relative: string) => `/vault/${relative}`,
  maybeCreateSignificantSnapshot: () => null
}))
vi.mock('../vault/file-ops', () => ({
  safeRead: async (absolute: string) => h.files.get(absolute) ?? null,
  atomicWrite: async (absolute: string, content: string) => {
    h.files.set(absolute, content)
  },
  ensureDirectory: vi.fn(),
  deleteFile: vi.fn()
}))
vi.mock('../vault/journal', () => ({ getJournalPath: vi.fn() }))
vi.mock('../vault/note-sync', () => ({
  syncNoteToCache: (_db: unknown, input: { fileContent: string }) => {
    if (h.row) h.row = { ...h.row, contentHash: h.contentHash(input.fileContent) }
  },
  deleteNoteFromCache: vi.fn()
}))
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
import { hasPendingWriteback } from './crdt-writeback'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'
import { generateContentHash } from '../vault/frontmatter'

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

async function settleWriteback(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
  await vi.waitFor(() => expect(hasPendingWriteback(NOTE)).toBe(false), { timeout: 5000 })
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
    h.row = {
      id: NOTE,
      path: NOTE_PATH,
      title: 'Daily Routine',
      fileType: 'markdown',
      localOnly: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      contentHash: generateContentHash(lastSession)
    }
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
