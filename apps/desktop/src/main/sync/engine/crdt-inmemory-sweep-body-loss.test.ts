import * as Y from 'yjs'
import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import type { SyncContext } from './sync-context'
import type { CrdtSnapshotMeta } from '../http-client'

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  row: null as null | Record<string, unknown>,
  server: null as null | {
    snapshot: { bytes: Uint8Array; sequenceNum: number; revision: string }
    updates: Array<{ sequenceNum: number; data: string; signerDeviceId: string; createdAt: number }>
  },
  contentHash: (_raw: string): string => ''
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
  BrowserWindow: { fromId: () => null, getAllWindows: () => [] }
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../http-client', () => ({
  fetchCrdtSnapshot: async () => {
    const snapshot = h.server?.snapshot
    if (!snapshot) return null
    return {
      snapshot: snapshot.bytes,
      sequenceNum: snapshot.sequenceNum,
      signerDeviceId: 'device-b',
      revision: snapshot.revision
    }
  },
  getFromServer: async () => {
    throw new Error('the sweep never takes the single-note path')
  },
  postToServer: async (_path: string, body: unknown) => {
    const request = body as { notes: Array<{ noteId: string; since: number }>; limit: number }
    const notes: Record<string, { updates: unknown[]; hasMore: boolean }> = {}
    const snapshotMeta: Record<string, CrdtSnapshotMeta> = {}
    for (const { noteId, since } of request.notes) {
      const above = (h.server?.updates ?? []).filter((u) => u.sequenceNum > since)
      notes[noteId] = {
        updates: above.slice(0, request.limit),
        hasMore: above.length > request.limit
      }
      const snapshot = h.server?.snapshot
      if (snapshot) {
        snapshotMeta[noteId] = {
          sequenceNum: snapshot.sequenceNum,
          revision: snapshot.revision,
          signerDeviceId: 'device-b'
        }
      }
    }
    return { notes, snapshotMeta }
  }
}))

vi.mock('@memry/sync-client/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@memry/sync-client/retry')>()),
  withRetry: async (fn: () => Promise<unknown>) => ({ value: await fn() })
}))
vi.mock('../crdt-encrypt', () => ({ decryptCrdtUpdate: (packed: Uint8Array) => packed }))
vi.mock('../../crypto/index', () => ({ secureCleanup: vi.fn() }))
vi.mock('../../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../../telemetry/track', () => ({ trackMainEvent: vi.fn() }))

vi.mock('../crdt-persistence', () => ({ openCrdtPersistence: async () => null }))
vi.mock('../crdt-store-path', () => ({
  prepareVaultCrdtStore: async () => ({ storagePath: '/tmp/crdt', vaultUuid: 'vault-1' })
}))
vi.mock('../../store', () => ({ recordCrdtPersistenceOutcome: () => 0 }))
vi.mock('../../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: () => 'vault-1' }))
vi.mock('../../database/client', () => ({
  getDatabase: () => ({}),
  getIndexDatabase: () => ({}),
  isDatabaseInitialized: () => true
}))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (_db: unknown, noteId: string) => (h.row?.id === noteId ? h.row : undefined),
  updateNoteCache: vi.fn()
}))
vi.mock('@memry/storage-data', () => ({ getNoteMetadataById: () => undefined }))

vi.mock('../../vault/notes', () => ({
  getVaultRoot: () => '/vault',
  toAbsolutePath: (relative: string) => `/vault/${relative}`,
  maybeCreateSignificantSnapshot: () => null
}))
vi.mock('../../vault/file-ops', () => ({
  safeRead: async (absolute: string) => h.files.get(absolute) ?? null,
  atomicWrite: async (absolute: string, content: string) => {
    h.files.set(absolute, content)
  },
  ensureDirectory: vi.fn(),
  deleteFile: vi.fn()
}))
vi.mock('../../vault/journal', () => ({ getJournalPath: vi.fn() }))
vi.mock('../../vault/note-sync', () => ({
  syncNoteToCache: (_db: unknown, input: { fileContent: string }) => {
    if (h.row) h.row = { ...h.row, contentHash: h.contentHash(input.fileContent) }
  },
  deleteNoteFromCache: vi.fn()
}))
vi.mock('../../vault/attachment-rename-reconcile', () => ({ reconcileRenamedAttachments: vi.fn() }))
vi.mock('../../projections', () => ({ flushProjectionEvents: vi.fn() }))
vi.mock('../../notes/note-date-reminders', () => ({
  syncNoteDateReminders: vi.fn(),
  clearNoteDateReminders: vi.fn()
}))
vi.mock('@memry/app-core/reminders', () => ({ createRemindersService: vi.fn() }))
vi.mock('../local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

import { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import { getCrdtProvider } from '../crdt-provider'
import { hasPendingWriteback } from '../crdt-writeback'
import { markdownToYFragment, yDocToMarkdown } from '../blocknote-converter'
import { generateContentHash } from '../../vault/frontmatter'

const NOTE = 'c8c29h5sqvgt'
const NOTE_PATH = 'notes/Trip.md'
const FILE = `/vault/${NOTE_PATH}`

const ORIGINAL = [
  '# Trip',
  '',
  'Pack for the [lake](https://example.com/lake).',
  '',
  '![](attachments/x/img.png)'
].join('\n')

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

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

describe('CRDT sweep in in-memory mode (#2511)', () => {
  beforeAll(async () => {
    await sodium.ready
    h.contentHash = generateContentHash
  })

  it('a second sweep pass in the same session keeps the note body and every peer edit', async () => {
    const author = new Y.Doc()
    await markdownToYFragment(ORIGINAL, author.getXmlFragment(CRDT_FRAGMENT_NAME), NOTE_PATH)

    const deviceB = new Y.Doc()
    Y.applyUpdate(deviceB, Y.encodeStateAsUpdate(author))
    const edit = (typed: string): string => {
      const before = Y.encodeStateVector(deviceB)
      const text = findText(deviceB.getXmlFragment(CRDT_FRAGMENT_NAME), 'Pack for the')
      text.insert(text.length, typed)
      return toBase64(Y.encodeStateAsUpdate(deviceB, before))
    }

    h.server = {
      snapshot: { bytes: Y.encodeStateAsUpdate(author), sequenceNum: 5, revision: 'rev-1' },
      updates: [
        { sequenceNum: 6, data: edit(' Tent packed.'), signerDeviceId: 'device-b', createdAt: 1 }
      ]
    }
    const fileBefore = `---\nid: ${NOTE}\ntitle: Trip\n---\n${(await yDocToMarkdown(author, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH }))!}`
    h.files.set(FILE, fileBefore)
    h.row = {
      id: NOTE,
      path: NOTE_PATH,
      title: 'Trip',
      fileType: 'markdown',
      localOnly: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      contentHash: generateContentHash(fileBefore)
    }

    const provider = getCrdtProvider()
    await provider.initPersistence()
    expect(provider.storeId).toBeNull()

    const ctx = {
      deps: {
        crdtProvider: provider,
        getAccessToken: async () => 'token',
        getVaultKey: async () => new Uint8Array(32)
      },
      abortController: new AbortController()
    } as unknown as SyncContext
    const coordinator = new CrdtSyncCoordinator(ctx, async () => new Uint8Array(32))

    await coordinator.pullCrdtForNotes([NOTE])
    await vi.waitFor(() => expect(hasPendingWriteback(NOTE)).toBe(false), { timeout: 5000 })

    h.server.updates.push({
      sequenceNum: 7,
      data: edit(' Fuel bought.'),
      signerDeviceId: 'device-b',
      createdAt: 2
    })

    await coordinator.pullCrdtForNotes([NOTE])
    await vi.waitFor(() => expect(hasPendingWriteback(NOTE)).toBe(false), { timeout: 5000 })

    expect(h.files.get(FILE)).toBe(
      [
        '---',
        `id: ${NOTE}`,
        'title: Trip',
        '---',
        '# Trip',
        '',
        'Pack for the [lake](https://example.com/lake). Tent packed. Fuel bought.',
        '',
        '![](attachments/x/img.png)'
      ].join('\n')
    )
  })
})
