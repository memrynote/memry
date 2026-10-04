import * as Y from 'yjs'
import fs from 'node:fs'
import path from 'node:path'
import sodium from 'libsodium-wrappers-sumo'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  contentHash: (_raw: string): string => '',
  db: {} as unknown,
  versions: [] as string[],
  persistence: null as unknown,
  updatesDelayMs: 0,
  versionsThrow: false,
  canonical: null as null | Record<string, unknown>
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
  RateLimitError: class extends Error {},
  SyncServerError: class extends Error {},
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
    if (h.updatesDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, h.updatesDelayMs))
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

vi.mock('../crdt-persistence', () => ({ openCrdtPersistence: async () => h.persistence }))
vi.mock('../crdt-store-epoch', () => ({ reconcileCrdtStoreEpoch: async () => {} }))
vi.mock('../crdt-store-path', () => ({
  prepareVaultCrdtStore: async () => ({ storagePath: '/tmp/crdt', vaultUuid: 'vault-1' })
}))
vi.mock('../../store', () => ({ recordCrdtPersistenceOutcome: () => 0 }))
vi.mock('../../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: () => 'vault-1' }))
vi.mock('../../database/client', () => ({
  getDatabase: () => h.db,
  getIndexDatabase: () => ({}),
  isDatabaseInitialized: () => true
}))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (_db: unknown, noteId: string) => (h.row?.id === noteId ? h.row : undefined),
  updateNoteCache: vi.fn()
}))
vi.mock('@memry/storage-data', () => ({
  getNoteMetadataById: (_db: unknown, noteId: string) =>
    h.canonical?.id === noteId ? h.canonical : undefined
}))

vi.mock('../../vault/notes', () => ({
  getVaultRoot: () => '/vault',
  toAbsolutePath: (relative: string) => `/vault/${relative}`,
  maybeCreateSignificantSnapshot: () => null,
  createSnapshot: (_noteId: string, fileContent: string) => {
    if (h.versionsThrow) throw new Error('disk full')
    h.versions.push(fileContent)
    return null
  }
}))
vi.mock('../../vault/file-ops', () => ({
  safeRead: async (absolute: string) => h.files.get(absolute) ?? null,
  atomicWrite: async (absolute: string, content: string) => {
    h.files.set(absolute, content)
  },
  ensureDirectory: vi.fn(),
  deleteFile: vi.fn()
}))
vi.mock('../../vault/journal', () => ({
  getJournalPath: (date: string) => `/vault/journal/${date}.md`
}))
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
import { NoteBodyOutbox } from '../note-body-outbox'
import { SyncQueueManager } from '@memry/sync-client/queue'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createTestDataDb } from '@tests/utils/test-db'
import { hasPendingWriteback } from '../crdt-writeback'
import { feedExternalEditToCrdt } from '../crdt-external-feed'
import { owesFileBody } from '../crdt-owed-file-body'
import { readMergedFullState } from '../full-state-read'
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

/** Every live text node holding `needle`: two block groups both count, rendered or not. */
function countTexts(fragment: Y.XmlFragment, needle: string): number {
  let count = 0
  const stack: Array<Y.XmlElement | Y.XmlFragment | Y.XmlText> = [fragment]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node instanceof Y.XmlText) {
      if (node.toString().includes(needle)) count++
      continue
    }
    stack.push(...(node.toArray() as Array<Y.XmlElement | Y.XmlText>))
  }
  return count
}

const OWED_FILE_BODIES_SQL = fs.readFileSync(
  path.join(__dirname, '../../database/drizzle-data/0065_crdt_owed_file_bodies.sql'),
  'utf8'
)

beforeEach(() => {
  const sqlite = new Database(':memory:')
  sqlite.exec(OWED_FILE_BODIES_SQL)
  h.db = drizzle(sqlite)
  h.versions = []
  h.persistence = null
  h.updatesDelayMs = 0
  h.versionsThrow = false
  h.canonical = null
})

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

  /** The full-state rows queued in the note-body outbox. Durable, so a restart keeps them. */
  const owedFullStates = new Set<string>()

  afterEach(async () => {
    await getCrdtProvider().destroy()
    resetCrdtProvider()
    owedFullStates.clear()
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

  /** `peer` with everything the server holds merged in. */
  async function syncedPeer(peer: Y.Doc): Promise<Y.Doc> {
    await bodyAfterPull(peer)
    return peer
  }

  /** `peer` merges the server, appends `typed` to the line it edited, and pushes the change. */
  async function pushPeerEdit(peer: Y.Doc, typed: string): Promise<void> {
    await syncedPeer(peer)
    const before = Y.encodeStateVector(peer)
    const text = findText(peer.getXmlFragment(CRDT_FRAGMENT_NAME), 'Pack for the')
    text.insert(text.length, typed)
    const server = h.server!
    server.updates.push({
      sequenceNum:
        Math.max(server.snapshot?.sequenceNum ?? 0, ...server.updates.map((u) => u.sequenceNum)) +
        1,
      data: toBase64(Y.encodeStateAsUpdate(peer, before)),
      signerDeviceId: 'device-b',
      createdAt: 9
    })
  }

  /** A CRDT store with nothing in it, for the cases that run with one. */
  function fakeStore(): unknown {
    const updates = new Map<string, Uint8Array[]>()
    return {
      getYDoc: async (noteId: string) => {
        const doc = new Y.Doc()
        for (const update of updates.get(noteId) ?? []) Y.applyUpdate(doc, update)
        return doc
      },
      storeUpdate: async (noteId: string, update: Uint8Array) => {
        updates.set(noteId, [...(updates.get(noteId) ?? []), update])
      },
      flushDocument: async () => {},
      clearDocument: async (noteId: string) => {
        updates.delete(noteId)
      },
      destroy: () => {},
      getMeta: async () => undefined,
      setMeta: async () => {}
    }
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
   * there was no snapshot. A full-state row is pushed when the test flushes
   * it, through the reader the runtime's outbox uses.
   */
  async function startRuntime(): Promise<{
    provider: ReturnType<typeof getCrdtProvider>
    coordinator: CrdtSyncCoordinator
    pushUpdate: (state: Uint8Array) => void
    flushFullStates: () => Promise<void>
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
    const flushFullStates = async (): Promise<void> => {
      for (const noteId of owedFullStates) {
        const state = await readMergedFullState(
          provider,
          noteId,
          (id) => coordinator.pullCrdtForNote(id),
          () => false
        )
        if (state) pushUpdate(state)
      }
      owedFullStates.clear()
    }
    const outbox = {
      enqueue: (_noteId: string, update: Uint8Array) => pushUpdate(update),
      enqueueFullState: (noteId: string) => owedFullStates.add(noteId),
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
    return { provider, coordinator, pushUpdate, flushFullStates }
  }

  it('hazard 1: a sweep over a note open in the editor shows the server body (#2544)', async () => {
    await serveNoteWithPeerEdit()
    const { provider, coordinator } = await startRuntime()

    const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
      coordinator.pullCrdtForNote(id)
    )
    await coordinator.pullCrdtForNotes([NOTE])

    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
      EXPECTED_BODY
    )
  })

  it('an editor open after a sweep of the closed note shows every peer edit', async () => {
    await serveNoteWithPeerEdit()
    putNoteInVault(EXPECTED_BODY)
    const { provider, coordinator } = await startRuntime()
    await coordinator.pullCrdtForNotes([NOTE])
    await vi.waitFor(() => expect(hasPendingWriteback(NOTE)).toBe(false), { timeout: 5000 })

    const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
      coordinator.pullCrdtForNote(id)
    )

    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
      EXPECTED_BODY
    )
  })

  it('hazard 1: a note typed into and closed after an editor open keeps the server body', async () => {
    const peer = await serveNoteWithPeerEdit()
    const { provider, coordinator } = await startRuntime()

    const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
      coordinator.pullCrdtForNote(id)
    )
    const editor = new Y.Doc()
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(doc))
    const seen = Y.encodeStateVector(editor)
    const text = findText(editor.getXmlFragment(CRDT_FRAGMENT_NAME), 'Tent packed.')
    text.insert(text.length, ' Map printed.')
    provider.applyIpcUpdate(NOTE, Y.encodeStateAsUpdate(editor, seen), EDITOR_WINDOW)
    await provider.close(NOTE, EDITOR_WINDOW)

    const typed = EXPECTED_BODY.replace('Tent packed.', 'Tent packed. Map printed.')
    expect([await bodyAfterPull(), await bodyAfterPull(peer)]).toEqual([typed, typed])
  })

  it('an editor open seeds from the vault file when the merge does not finish', async () => {
    await serveNoteWithPeerEdit()
    const { provider } = await startRuntime()

    const doc = await provider.openForEditor(
      NOTE,
      EDITOR_WINDOW,
      () => new Promise<boolean>(() => {}),
      10
    )

    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(ORIGINAL)
  })

  it('an editor open of a note the server has never seen seeds from the vault file', async () => {
    h.server = { snapshot: null, updates: [] }
    putNoteInVault(ORIGINAL)
    const { provider, coordinator } = await startRuntime()

    const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
      coordinator.pullCrdtForNote(id)
    )

    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(ORIGINAL)
  })

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

    const state = await readMergedFullState(
      provider,
      NOTE,
      (id) => coordinator.pullCrdtForNote(id),
      () => false
    )
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

  describe('a main-process edit to a note no editor holds (#2646)', () => {
    const EDITED_BODY = `${EXPECTED_BODY}\n\nAgent line.`

    async function editClosedNote(): Promise<{
      provider: ReturnType<typeof getCrdtProvider>
      coordinator: CrdtSyncCoordinator
      flushFullStates: () => Promise<void>
      peer: Y.Doc
    }> {
      const peer = await serveNoteWithPeerEdit()
      putNoteInVault(EXPECTED_BODY)
      const runtime = await startRuntime()

      // What `updateNote` leaves behind: the new bytes on disk and the index
      // hash moved to them.
      putNoteInVault(EDITED_BODY)
      await feedExternalEditToCrdt(NOTE, EDITED_BODY)
      return { ...runtime, peer }
    }

    async function fileBodyAfterWriteback(): Promise<string | undefined> {
      await vi.waitFor(() => expect(hasPendingWriteback(NOTE)).toBe(false), { timeout: 5000 })
      return h.files.get(FILE)?.split('---\n')[2]
    }

    it('reaches the server', async () => {
      const { peer, flushFullStates } = await editClosedNote()

      await flushFullStates()

      expect([await bodyAfterPull(), await bodyAfterPull(peer)]).toEqual([EDITED_BODY, EDITED_BODY])
    })

    const FUELED_BODY = EDITED_BODY.replace('Tent packed.', 'Tent packed. Fuel bought.')
    /** The server body the file wins over once a peer adds a line the file lacks. */
    const STOVE_VERSION = `---\nid: ${NOTE}\ntitle: Trip\n---\n${EXPECTED_BODY.replace('Tent packed.', 'Tent packed. Stove packed.')}\n`
    /** The edited file, kept when a later peer edit is written over bytes no write-back wrote. */
    const EDITED_VERSION = `---\nid: ${NOTE}\ntitle: Trip\n---\n${EDITED_BODY}`

    it('survives the next pull of the note, the flush after it, and peer edits', async () => {
      const { coordinator, flushFullStates, peer } = await editClosedNote()

      await coordinator.pullCrdtForNotes([NOTE])
      const fileAfterPull = await fileBodyAfterWriteback()
      await pushPeerEdit(peer, ' Stove packed.')
      await flushFullStates()
      await pushPeerEdit(peer, ' Fuel bought.')
      await coordinator.pullCrdtForNotes([NOTE])

      expect({
        fileAfterPull,
        server: await bodyAfterPull(),
        file: await fileBodyAfterWriteback(),
        versions: h.versions
      }).toEqual({
        fileAfterPull: EDITED_BODY,
        server: FUELED_BODY,
        file: FUELED_BODY,
        versions: [STOVE_VERSION, EDITED_VERSION]
      })
    })

    it('survives a restart, a peer edit while closed, the launch sweep, and the flush after it', async () => {
      const { peer } = await editClosedNote()
      await getCrdtProvider().destroy()
      resetCrdtProvider()
      await pushPeerEdit(peer, ' Stove packed.')
      const { coordinator, flushFullStates } = await startRuntime()

      await coordinator.pullCrdtForNotes([NOTE])
      const fileAfterSweep = await fileBodyAfterWriteback()
      await flushFullStates()
      await pushPeerEdit(peer, ' Fuel bought.')
      await coordinator.pullCrdtForNotes([NOTE])

      expect({
        fileAfterSweep,
        server: await bodyAfterPull(),
        file: await fileBodyAfterWriteback(),
        versions: h.versions
      }).toEqual({
        fileAfterSweep: EDITED_BODY,
        server: FUELED_BODY,
        file: FUELED_BODY,
        versions: [STOVE_VERSION, EDITED_VERSION]
      })
    })

    it('survives opening the note in the editor', async () => {
      const { provider, coordinator } = await editClosedNote()

      const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
        coordinator.pullCrdtForNote(id)
      )

      expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
        EDITED_BODY
      )
      expect(await fileBodyAfterWriteback()).toBe(EDITED_BODY)
    })

    it('is taken into the doc an editor holds by the flush after the server body merges', async () => {
      const { provider, coordinator, flushFullStates } = await editClosedNote()
      const doc = await provider.open(NOTE, EDITOR_WINDOW, { skipSeed: true })

      await coordinator.pullCrdtForNote(NOTE)
      const fileAfterPull = await fileBodyAfterWriteback()
      await flushFullStates()

      expect([fileAfterPull, await fileBodyAfterWriteback()]).toEqual([EDITED_BODY, EDITED_BODY])
      expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
        EDITED_BODY
      )
    })

    const LAGGING_EDIT = `${ORIGINAL}\n\nAgent line.`
    const PEER_VERSION = `---\nid: ${NOTE}\ntitle: Trip\n---\n${EXPECTED_BODY}\n`

    // A delay past the write-back debounce lets a pass run while the merge holds the doc.
    it.each([0, 1000])(
      'keeps the server body as a version when a lagging file wins over a peer edit, updates fetched after %i ms',
      async (delayMs) => {
        await serveNoteWithPeerEdit()
        const { flushFullStates } = await startRuntime()
        putNoteInVault(LAGGING_EDIT)
        await feedExternalEditToCrdt(NOTE, LAGGING_EDIT)
        h.updatesDelayMs = delayMs

        await flushFullStates()

        expect({ server: await bodyAfterPull(), versions: h.versions }).toEqual({
          server: LAGGING_EDIT,
          versions: [PEER_VERSION]
        })
      }
    )

    it('reaches the server and stays in the file when the outbox flushes its row at once', async () => {
      await serveNoteWithPeerEdit()
      putNoteInVault(EXPECTED_BODY)
      const testDb = createTestDataDb()
      h.db = testDb.db
      const { provider, coordinator, pushUpdate } = await startRuntime()
      const outbox = new NoteBodyOutbox({
        queue: new SyncQueueManager(testDb.db as unknown as DrizzleDb),
        push: async (_noteId, updates) => updates.forEach(pushUpdate)
      })
      outbox.start()
      outbox.enableFullStateFlush((noteId) =>
        readMergedFullState(
          provider,
          noteId,
          (id) => coordinator.pullCrdtForNote(id),
          () => false
        )
      )
      await provider.init(outbox)

      putNoteInVault(EDITED_BODY)
      await feedExternalEditToCrdt(NOTE, EDITED_BODY)
      await vi.waitFor(() => expect(outbox.getOutstandingCount()).toBe(0), { timeout: 5000 })
      const afterFlush = { owed: owesFileBody(NOTE), versions: [...h.versions] }
      await coordinator.pullCrdtForNotes([NOTE])
      const file = await fileBodyAfterWriteback()
      outbox.stop()

      expect({ afterFlush, server: await bodyAfterPull(), file }).toEqual({
        afterFlush: { owed: false, versions: [PEER_VERSION] },
        server: EDITED_BODY,
        file: EDITED_BODY
      })
    })

    it('a pass that closes the doc during the flush merge leaves it open for the take', async () => {
      await serveNoteWithPeerEdit()
      const { provider, coordinator, pushUpdate } = await startRuntime()
      putNoteInVault(LAGGING_EDIT)
      await feedExternalEditToCrdt(NOTE, LAGGING_EDIT)

      const state = await readMergedFullState(
        provider,
        NOTE,
        async (id) => {
          await provider.closeIfInactive(id)
          return coordinator.pullCrdtForNote(id)
        },
        () => false
      )
      if (state) pushUpdate(state)

      expect({ server: await bodyAfterPull(), versions: h.versions }).toEqual({
        server: LAGGING_EDIT,
        versions: [PEER_VERSION]
      })
    })

    it('a merge that lands after its doc closed leaves the marker and the closed doc alone', async () => {
      await serveNoteWithPeerEdit()
      const { provider } = await startRuntime()
      putNoteInVault(LAGGING_EDIT)
      await feedExternalEditToCrdt(NOTE, LAGGING_EDIT)
      const closed = await provider.open(NOTE, undefined, { skipSeed: true })
      await provider.closeIfInactive(NOTE)

      const took = await provider.takeFileAfterMerge(NOTE, closed)

      expect({
        took,
        owed: owesFileBody(NOTE),
        blocks: closed.getXmlFragment(CRDT_FRAGMENT_NAME).length
      }).toEqual({ took: false, owed: true, blocks: 0 })
    })

    it('an editor open whose server merge outlasts its timeout leaves the file to the flush', async () => {
      await serveNoteWithPeerEdit()
      const { provider, coordinator, flushFullStates } = await startRuntime()
      putNoteInVault(LAGGING_EDIT)
      await feedExternalEditToCrdt(NOTE, LAGGING_EDIT)
      h.updatesDelayMs = 1000
      let merging: Promise<boolean> | undefined

      const doc = await provider.openForEditor(
        NOTE,
        EDITOR_WINDOW,
        (id) => (merging = coordinator.pullCrdtForNote(id)),
        200
      )
      await merging
      const fileAfterMerge = await fileBodyAfterWriteback()
      await flushFullStates()

      expect({
        fileAfterMerge,
        editor: await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH }),
        server: await bodyAfterPull(),
        versions: h.versions
      }).toEqual({
        fileAfterMerge: LAGGING_EDIT,
        editor: LAGGING_EDIT,
        server: LAGGING_EDIT,
        versions: [PEER_VERSION]
      })
    })

    it('a version that cannot be written leaves the server body and the marker to the next flush', async () => {
      await serveNoteWithPeerEdit()
      const { flushFullStates } = await startRuntime()
      putNoteInVault(LAGGING_EDIT)
      await feedExternalEditToCrdt(NOTE, LAGGING_EDIT)
      h.versionsThrow = true

      await flushFullStates()
      const afterFailedFlush = {
        server: await bodyAfterPull(),
        file: await fileBodyAfterWriteback(),
        owed: owesFileBody(NOTE)
      }
      h.versionsThrow = false
      await flushFullStates()

      expect({
        afterFailedFlush,
        server: await bodyAfterPull(),
        versions: h.versions
      }).toEqual({
        afterFailedFlush: { server: EXPECTED_BODY, file: LAGGING_EDIT, owed: true },
        server: LAGGING_EDIT,
        versions: [PEER_VERSION]
      })
    })

    const FUTURE_TEXT = 'Future secret'

    /** A block of a type this build has no schema for, as a peer on a newer build writes it. */
    function pushFutureBlock(group: Y.XmlElement): void {
      const container = new Y.XmlElement('blockContainer')
      group.push([container])
      const widget = new Y.XmlElement('futureWidget')
      container.push([widget])
      widget.push([new Y.XmlText(FUTURE_TEXT)])
    }

    async function serveNoteWithFutureBlock(): Promise<void> {
      const peer = await serveNoteWithPeerEdit()
      const before = Y.encodeStateVector(peer)
      pushFutureBlock(peer.getXmlFragment(CRDT_FRAGMENT_NAME).get(0) as Y.XmlElement)
      h.server!.updates.push({
        sequenceNum: 7,
        data: toBase64(Y.encodeStateAsUpdate(peer, before)),
        signerDeviceId: 'device-b',
        createdAt: 9
      })
    }

    async function serveOnlyFutureBlock(): Promise<void> {
      const author = new Y.Doc()
      author.clientID = AUTHOR_CLIENT
      const group = new Y.XmlElement('blockGroup')
      author.getXmlFragment(CRDT_FRAGMENT_NAME).push([group])
      pushFutureBlock(group)
      h.server = {
        snapshot: { bytes: Y.encodeStateAsUpdate(author), sequenceNum: 5, revision: 'rev-1' },
        updates: []
      }
      putNoteInVault(ORIGINAL)
    }

    it.each([
      { case: 'beside known blocks', serve: serveNoteWithFutureBlock },
      { case: 'alone, so the body does not serialize', serve: serveOnlyFutureBlock }
    ])(
      'a server body with a block type this build lacks, $case, is not replaced by the file',
      async ({ serve }) => {
        await serve()
        const { coordinator, flushFullStates } = await startRuntime()
        putNoteInVault(LAGGING_EDIT)
        await feedExternalEditToCrdt(NOTE, LAGGING_EDIT)

        await flushFullStates()
        await coordinator.pullCrdtForNotes([NOTE])
        const file = await fileBodyAfterWriteback()
        const server = new Y.Doc()
        await bodyAfterPull(server)

        expect({
          futureBlocks: countTexts(server.getXmlFragment(CRDT_FRAGMENT_NAME), FUTURE_TEXT),
          file,
          owed: owesFileBody(NOTE),
          queuedAgain: [...owedFullStates],
          versions: h.versions
        }).toEqual({
          futureBlocks: 1,
          file: LAGGING_EDIT,
          owed: true,
          queuedAgain: [],
          versions: []
        })
      }
    )

    it.each([
      {
        missing: 'its file',
        remove: (): void => void h.files.delete(FILE),
        expected: { pushes: 1, queuedAgain: [], owed: false }
      },
      {
        missing: 'its index row',
        remove: (): void => {
          h.canonical = h.row
          h.row = null
        },
        expected: { pushes: 0, queuedAgain: [], owed: true }
      }
    ])(
      'an owed note missing $missing is not queued again by its flush',
      async ({ remove, expected }) => {
        await serveNoteWithPeerEdit()
        const { flushFullStates } = await startRuntime()
        putNoteInVault(LAGGING_EDIT)
        await feedExternalEditToCrdt(NOTE, LAGGING_EDIT)
        remove()
        const before = h.server!.updates.length

        for (let pass = 0; pass < 3; pass++) {
          await flushFullStates()
          await fileBodyAfterWriteback()
        }

        expect({
          pushes: h.server!.updates.length - before,
          queuedAgain: [...owedFullStates],
          owed: owesFileBody(NOTE)
        }).toEqual(expected)
      }
    )

    it('carries the file tags into the doc with the body', async () => {
      const peer = await serveNoteWithPeerEdit()
      const tagged = new Y.Doc()
      Y.applyUpdate(tagged, h.server!.snapshot!.bytes)
      tagged.getArray('tags').push(['trip'])
      h.server!.snapshot!.bytes = Y.encodeStateAsUpdate(tagged)
      Y.applyUpdate(peer, h.server!.snapshot!.bytes)
      putNoteInVault(EXPECTED_BODY)
      const { coordinator, flushFullStates } = await startRuntime()
      const file = `---\nid: ${NOTE}\ntitle: Trip\ntags:\n  - trip\n  - meeting\n---\n${EDITED_BODY}`
      h.files.set(FILE, file)
      h.row = { ...h.row!, contentHash: generateContentHash(file) }
      await feedExternalEditToCrdt(NOTE, EDITED_BODY)

      await flushFullStates()
      await coordinator.pullCrdtForNotes([NOTE])
      await fileBodyAfterWriteback()

      expect({
        file: h.files.get(FILE),
        peerTags: (await syncedPeer(peer)).getArray('tags').toArray()
      }).toEqual({
        file,
        peerTags: ['trip', 'meeting']
      })
    })

    it('a second edit while the flush waits on the server merge leaves one copy of the body', async () => {
      await serveNoteWithPeerEdit()
      putNoteInVault(EXPECTED_BODY)
      const { provider, coordinator, pushUpdate } = await startRuntime()
      putNoteInVault(EDITED_BODY)
      await feedExternalEditToCrdt(NOTE, EDITED_BODY)
      const SECOND = `${EDITED_BODY}\n\nSecond agent line.`

      const state = await readMergedFullState(
        provider,
        NOTE,
        async (id) => {
          putNoteInVault(SECOND)
          await feedExternalEditToCrdt(NOTE, SECOND)
          return coordinator.pullCrdtForNote(id)
        },
        () => false
      )
      if (state) pushUpdate(state)

      const server = new Y.Doc()
      const body = await bodyAfterPull(server)
      expect({
        body,
        copies: countTexts(server.getXmlFragment(CRDT_FRAGMENT_NAME), 'Pack for the')
      }).toEqual({ body: SECOND, copies: 1 })
    })

    it('a file the doc refuses at the flush is kept as a version, and the note takes the server body', async () => {
      const { coordinator, flushFullStates } = await editClosedNote()
      const LARGE_BODY = `${EXPECTED_BODY}\n\n${'x'.repeat(140 * 1024)}`
      putNoteInVault(LARGE_BODY)
      await feedExternalEditToCrdt(NOTE, LARGE_BODY)

      await flushFullStates()
      const afterFlush = { owed: owesFileBody(NOTE), versions: h.versions }
      await coordinator.pullCrdtForNotes([NOTE])

      expect({
        ...afterFlush,
        server: await bodyAfterPull(),
        file: await fileBodyAfterWriteback()
      }).toEqual({
        owed: false,
        versions: [`---\nid: ${NOTE}\ntitle: Trip\n---\n${LARGE_BODY}`],
        server: EXPECTED_BODY,
        file: EXPECTED_BODY
      })
    })
  })

  it.each([
    { case: 'no store', large: false, expected: { owed: true, fullStates: [NOTE] } },
    { case: 'no store, large-file body', large: true, expected: { owed: false, fullStates: [] } },
    { case: 'a store', large: false, expected: { owed: false, fullStates: [] } }
  ])(
    'an edit to a closed note whose doc is empty, with $case, owes the file body: $expected.owed',
    async ({ case: setup, large, expected }) => {
      h.persistence = setup === 'a store' ? fakeStore() : null
      h.server = { snapshot: null, updates: [] }
      putNoteInVault(ORIGINAL)
      const fullStates: string[] = []
      const outbox = {
        enqueue: () => {},
        enqueueFullState: (noteId: string) => fullStates.push(noteId),
        dropNote: () => {}
      } as unknown as NoteBodyOutbox
      await getCrdtProvider().init(outbox, async () => {})

      await feedExternalEditToCrdt(
        NOTE,
        large ? `${EXPECTED_BODY}\n\n${'x'.repeat(140 * 1024)}` : EXPECTED_BODY
      )

      expect({ owed: owesFileBody(NOTE), fullStates }).toEqual(expected)
    }
  )

  it('a journal edited while closed keeps the edit through the next pull, and the flush pushes it', async () => {
    const JOURNAL = 'j2026-01-01'
    const body = `${EXPECTED_BODY}\n\nAgent line.`
    const file = `---\nid: ${JOURNAL}\ndate: 2026-01-01\n---\n${body}`
    await serveNoteWithPeerEdit()
    const { coordinator, flushFullStates } = await startRuntime()
    h.files.set('/vault/journal/2026-01-01.md', file)
    h.row = { ...h.row!, id: JOURNAL, path: 'journal/2026-01-01.md', title: '2026-01-01' }
    h.row.contentHash = generateContentHash(file)
    await feedExternalEditToCrdt(JOURNAL, body)

    await coordinator.pullCrdtForNotes([JOURNAL])
    await vi.waitFor(() => expect(hasPendingWriteback(JOURNAL)).toBe(false), { timeout: 5000 })
    const fileAfterPull = h.files.get('/vault/journal/2026-01-01.md')
    await flushFullStates()

    expect({ fileAfterPull, server: await bodyAfterPull() }).toEqual({
      fileAfterPull: file,
      server: body
    })
  })

  it('an empty note open in the editor takes an agent edit live', async () => {
    h.server = { snapshot: null, updates: [] }
    putNoteInVault('')
    const { provider, coordinator } = await startRuntime()
    const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
      coordinator.pullCrdtForNote(id)
    )

    putNoteInVault('Agent wrote this.')
    await feedExternalEditToCrdt(NOTE, 'Agent wrote this.')

    expect({
      editor: await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH }),
      owed: owesFileBody(NOTE)
    }).toEqual({ editor: 'Agent wrote this.', owed: false })
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
