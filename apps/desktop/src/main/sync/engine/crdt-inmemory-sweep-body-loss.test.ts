import * as Y from 'yjs'
import sodium from 'libsodium-wrappers-sumo'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import type { SyncContext } from './sync-context'
import type { CrdtSnapshotMeta } from '../http-client'

const EDITOR_WINDOW = vi.hoisted(() => 7)
const AUTHOR_CLIENT = 0xffffffff

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  row: null as null | Record<string, unknown>,
  server: null as null | {
    snapshot: { bytes: Uint8Array; sequenceNum: number; revision: string } | null
    updates: Array<{ sequenceNum: number; data: string; signerDeviceId: string; createdAt: number }>
  },
  contentHash: (_raw: string): string => ''
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
  BrowserWindow: {
    fromId: (id: number) =>
      id === EDITOR_WINDOW ? { isDestroyed: () => false, webContents: { send: () => {} } } : null,
    getAllWindows: () => []
  }
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
  getFromServer: async (path: string) => {
    const since = Number(new URL(path, 'http://server').searchParams.get('since'))
    return {
      updates: (h.server?.updates ?? []).filter((u) => u.sequenceNum > since),
      hasMore: false
    }
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
import { getCrdtProvider, resetCrdtProvider, type SnapshotPushFn } from '../crdt-provider'
import type { NoteBodyOutbox } from '../note-body-outbox'
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

describe('CrdtProvider with no store (#2536)', () => {
  const EXPECTED_BODY = [
    '# Trip',
    '',
    'Pack for the [lake](https://example.com/lake). Tent packed.',
    '',
    '![](attachments/x/img.png)'
  ].join('\n')

  beforeAll(async () => {
    await sodium.ready
    h.contentHash = generateContentHash
  })

  afterEach(async () => {
    await getCrdtProvider().destroy()
    resetCrdtProvider()
  })

  function putNoteInVault(body: string): void {
    const file = `---\nid: ${NOTE}\ntitle: Trip\n---\n${body}`
    h.files.set(FILE, file)
    h.row = {
      id: NOTE,
      path: NOTE_PATH,
      title: 'Trip',
      fileType: 'markdown',
      localOnly: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      contentHash: generateContentHash(file)
    }
  }

  /**
   * The vault file lags the peer edit. Two block groups in one fragment render
   * as whichever Yjs orders first, so the author's client id is pinned to lose
   * that race: a markdown seed merged with the server body then hides it on
   * every run.
   */
  async function serveNoteWithPeerEdit(): Promise<Y.Doc> {
    const author = new Y.Doc()
    author.clientID = AUTHOR_CLIENT
    await markdownToYFragment(ORIGINAL, author.getXmlFragment(CRDT_FRAGMENT_NAME), NOTE_PATH)
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(author))
    const before = Y.encodeStateVector(peer)
    const text = findText(peer.getXmlFragment(CRDT_FRAGMENT_NAME), 'Pack for the')
    text.insert(text.length, ' Tent packed.')

    h.server = {
      snapshot: { bytes: Y.encodeStateAsUpdate(author), sequenceNum: 5, revision: 'rev-1' },
      updates: [
        {
          sequenceNum: 6,
          data: toBase64(Y.encodeStateAsUpdate(peer, before)),
          signerDeviceId: 'device-b',
          createdAt: 1
        }
      ]
    }
    putNoteInVault(ORIGINAL)
    return peer
  }

  /** The body a device shows once it merges everything the server holds. */
  async function bodyAfterPull(doc: Y.Doc = new Y.Doc()): Promise<string | null> {
    const server = h.server!
    if (server.snapshot) Y.applyUpdate(doc, server.snapshot.bytes)
    for (const update of server.updates) Y.applyUpdate(doc, Buffer.from(update.data, 'base64'))
    return yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })
  }

  /**
   * The provider wired the way `startSyncRuntime` wires it: local updates go
   * to `/sync/crdt/updates`, and a snapshot push takes the snapshot route
   * unless the note is flagged. That route replaces the stored snapshot and
   * prunes every update at or below its watermark, the newest update when
   * there was no snapshot.
   */
  async function startRuntime(): Promise<{
    provider: ReturnType<typeof getCrdtProvider>
    coordinator: CrdtSyncCoordinator
    pushUpdate: (state: Uint8Array) => void
  }> {
    const provider = getCrdtProvider()
    const ctx = {
      deps: {
        crdtProvider: provider,
        getAccessToken: async () => 'token',
        getVaultKey: async () => new Uint8Array(32)
      },
      abortController: new AbortController()
    } as unknown as SyncContext
    const coordinator = new CrdtSyncCoordinator(ctx, async () => new Uint8Array(32))

    const pushUpdate = (state: Uint8Array): void => {
      const server = h.server!
      const top = Math.max(
        server.snapshot?.sequenceNum ?? 0,
        ...server.updates.map((u) => u.sequenceNum)
      )
      server.updates.push({
        sequenceNum: top + 1,
        data: toBase64(state),
        signerDeviceId: 'device-a',
        createdAt: 3
      })
    }
    const outbox = {
      enqueue: (_noteId: string, update: Uint8Array) => pushUpdate(update),
      enqueueFullState: () => {},
      dropNote: () => {}
    } as unknown as NoteBodyOutbox
    const pushSnapshot: SnapshotPushFn = async (noteId, state, coverage) => {
      if (coverage.unmerged || coordinator.hasUnmergedRemoteState(noteId)) {
        pushUpdate(state)
        return
      }
      const server = h.server!
      const watermark =
        server.snapshot?.sequenceNum ?? Math.max(0, ...server.updates.map((u) => u.sequenceNum))
      server.snapshot = { bytes: state, sequenceNum: watermark, revision: 'rev-pushed' }
      server.updates = server.updates.filter((u) => u.sequenceNum > watermark)
    }
    await provider.init(outbox, pushSnapshot)
    expect(provider.storeId).toBeNull()
    return { provider, coordinator, pushUpdate }
  }

  it.fails(
    'hazard 1: a sweep over a note open in the editor shows the server body (#2544)',
    async () => {
      await serveNoteWithPeerEdit()
      const { provider, coordinator } = await startRuntime()

      const doc = await provider.open(NOTE, EDITOR_WINDOW)
      await coordinator.pullCrdtForNotes([NOTE])

      expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
        EXPECTED_BODY
      )
    }
  )

  it('hazard 2: a scheduled snapshot push of a closed note keeps the server body', async () => {
    const peer = await serveNoteWithPeerEdit()
    const { provider } = await startRuntime()

    await provider.pushSnapshotsForNotes([NOTE], { skipSeed: true })

    expect([await bodyAfterPull(), await bodyAfterPull(peer)]).toEqual([
      EXPECTED_BODY,
      EXPECTED_BODY
    ])
  })

  it('hazard 2: a full-state outbox flush keeps the server body', async () => {
    const peer = await serveNoteWithPeerEdit()
    const { provider, coordinator, pushUpdate } = await startRuntime()

    expect(await coordinator.pullCrdtForNote(NOTE)).toBe(true)
    const state = await provider.readSyncableState(NOTE)
    if (state) pushUpdate(state)

    expect([await bodyAfterPull(), await bodyAfterPull(peer)]).toEqual([
      EXPECTED_BODY,
      EXPECTED_BODY
    ])
  })

  it('hazard 3: the launch seed pass keeps the server body', async () => {
    const peer = await serveNoteWithPeerEdit()
    const { provider } = await startRuntime()

    await provider.seedExistingDocs([{ id: NOTE, title: 'Trip' }])

    expect([await bodyAfterPull(), await bodyAfterPull(peer)]).toEqual([
      EXPECTED_BODY,
      EXPECTED_BODY
    ])
  })

  it('a note the server has never seen reaches it through its create push', async () => {
    h.server = { snapshot: null, updates: [] }
    putNoteInVault(ORIGINAL)
    const { provider } = await startRuntime()

    await provider.pushSnapshotsForNotes([NOTE], { concurrency: 1 })

    expect(await bodyAfterPull()).toBe(ORIGINAL)
  })

  it('a note the server has never seen reaches it through its first edit', async () => {
    h.server = { snapshot: null, updates: [] }
    putNoteInVault(ORIGINAL)
    const { provider } = await startRuntime()

    const doc = await provider.open(NOTE, EDITOR_WINDOW)
    const editor = new Y.Doc()
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(doc))
    const seen = Y.encodeStateVector(editor)
    const text = findText(editor.getXmlFragment(CRDT_FRAGMENT_NAME), 'Pack for the')
    text.insert(text.length, ' Tent packed.')
    provider.applyIpcUpdate(NOTE, Y.encodeStateAsUpdate(editor, seen), EDITOR_WINDOW)
    await provider.close(NOTE, EDITOR_WINDOW)

    expect(await bodyAfterPull()).toBe(EXPECTED_BODY)
  })
})
