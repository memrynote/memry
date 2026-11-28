import * as Y from 'yjs'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { ready as sodiumReady } from 'libsodium-wrappers-sumo'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRDT_CHANNELS, CRDT_EVENTS, CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import type { SyncContext } from './sync-context'
import type { CrdtSnapshotMeta } from '../http-client'
import type * as RetryModule from '@memry/sync-client/retry'
import type * as PathsModule from '../../lib/paths'
import type * as NoteQueriesModule from '@main/database/queries/notes'

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
  canonical: null as null | Record<string, unknown>,
  /** Signer devices whose key does not resolve. */
  unresolvable: new Set<string>(),
  broadcasts: [] as Array<{ channel: string; payload: unknown }>,
  errors: [] as Array<{ message: string; meta: unknown }>
}))

// A real, empty folder: the outside-vault check resolves every read against it.
const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-vault-'))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
  BrowserWindow: {
    fromId: (id: number) =>
      id === EDITOR_WINDOW ? { isDestroyed: () => false, webContents: { send: () => {} } } : null,
    fromWebContents: () => ({ id: EDITOR_WINDOW, once: () => {} }),
    getAllWindows: () => []
  },
  ipcMain: mockIpcMain
}))
vi.mock('../runtime', () => ({ getSyncEngine: () => null }))

vi.mock('../../lib/window-broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => {
    h.broadcasts.push({ channel, payload })
  }
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (message: string, meta?: unknown) => {
      h.errors.push({ message, meta })
    }
  })
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
  getFromServer: async (requestPath: string) => {
    if (h.updatesDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, h.updatesDelayMs))
    const since = Number(new URL(requestPath, 'http://server').searchParams.get('since'))
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
  ...(await importOriginal<typeof RetryModule>()),
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
vi.mock('@main/database/queries/notes', async (importOriginal) => ({
  UNSTORED_FILE: (await importOriginal<typeof NoteQueriesModule>()).UNSTORED_FILE,
  getNoteCacheById: (_db: unknown, noteId: string) => (h.row?.id === noteId ? h.row : undefined),
  updateNoteCache: vi.fn()
}))
vi.mock('@memry/storage-data', () => ({
  getNoteMetadataById: (_db: unknown, noteId: string) =>
    h.canonical?.id === noteId ? h.canonical : undefined
}))

vi.mock('../../vault/note-snapshots', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes-versions', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes-crud', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes-io', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes', () => ({
  getVaultRoot: () => VAULT_ROOT,
  toAbsolutePath: (relative: string) => `/vault/${relative}`,
  maybeCreateSignificantSnapshot: () => null,
  createSnapshot: (_noteId: string, fileContent: string) => {
    if (h.versionsThrow) throw new Error('disk full')
    h.versions.push(fileContent)
    return null
  }
}))
vi.mock('../../lib/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof PathsModule>()),
  readVaultFile: async (_vault: string, relative: string) =>
    h.files.get(`/vault/${relative}`) ?? null,
  openVaultFile: async (_vault: string, relative: string) => {
    const content = h.files.get(`/vault/${relative}`)
    if (content === undefined) return null
    return {
      stat: async () => ({ size: Buffer.byteLength(content) }),
      readFile: async () => content,
      close: async () => undefined
    }
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
  deleteNoteFromCache: vi.fn(),
  refusesCaseTwinFile: () => false
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

import { invokeHandler, mockIpcMain } from '@tests/utils/mock-ipc'
import { _resetCrdtIpcHandlersForTests, registerCrdtIpcHandlers } from '../../ipc/crdt-handlers'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import { getCrdtProvider, resetCrdtProvider, type SnapshotPushFn } from '../crdt-provider'
import { NoteBodyOutbox } from '../note-body-outbox'
import { SyncQueueManager } from '@memry/sync-client/queue'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createTestDataDb } from '@tests/utils/test-db'
import { crdtBodyDebtStore } from './crdt-body-debts'
import { STUCK_BODY_PULL_FAILURES } from './crdt-pull-ledger'
import { hasPendingWriteback } from '../crdt-writeback'
import { feedExternalEditToCrdt } from '../crdt-external-feed'
import { owesFileBody } from '../crdt-owed-file-body'
import { readMergedFullState } from '../full-state-read'
import { markdownToYFragment, yDocToMarkdown } from '../blocknote-converter'
import { generateContentHash, parseNote } from '../../vault/frontmatter'
import { isNeverSyncedLocalNote } from '../note-sync-state'
import { recordNoteBodyPush } from '../note-body-push-record'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import {
  markSyncEligible,
  markSyncIneligible,
  resetSyncDecision
} from '@memry/sync-client/sync-eligibility'
import { notesCreatedHere } from '@memry/db-schema/schema/notes-created-here'
import type { DataDb } from '../../database/client'

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
  h.unresolvable.clear()
  h.broadcasts = []
  h.errors = []
})

describe('CRDT sweep in in-memory mode (#2511)', () => {
  beforeAll(async () => {
    await sodiumReady
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
    await sodiumReady
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

  /** What the token manager and keychain answer: a token, a session that ended, a vault key. */
  interface Session {
    token: boolean
    ended: boolean
    vaultKey: boolean
  }
  const signedIn = (): Session => ({ token: true, ended: false, vaultKey: true })

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
  async function startRuntime(options?: {
    store?: boolean
    durableDebts?: boolean
    session?: Session
    online?: () => boolean
  }): Promise<{
    provider: ReturnType<typeof getCrdtProvider>
    coordinator: CrdtSyncCoordinator
    pushUpdate: (state: Uint8Array) => void
    flushFullStates: () => Promise<void>
  }> {
    const provider = getCrdtProvider()
    const session = options?.session ?? signedIn()
    const ctx = {
      deps: {
        crdtProvider: provider,
        getAccessToken: async () => (session.token ? 'token' : null),
        hasSessionEnded: () => session.ended,
        // `SyncEngine` routes every vault key read to the coordinator.
        getVaultKey: async () =>
          coordinator.recordVaultKeyRead(session.vaultKey ? new Uint8Array(32) : null)
      },
      abortController: new AbortController()
    } as unknown as SyncContext
    const coordinator = new CrdtSyncCoordinator(
      ctx,
      async (deviceId) => (h.unresolvable.has(deviceId) ? null : new Uint8Array(32)),
      () => true,
      options?.durableDebts ? crdtBodyDebtStore(createTestDataDb().db as never) : undefined
    )

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
    // The runtime's snapshot push records `sent` before the request, which
    // fails while offline; the provider must not reach it then (#5371).
    const online = options?.online
    const sendSnapshot: SnapshotPushFn = online
      ? async (noteId, state, coverage) => {
          recordNoteBodyPush(noteId, 'sent', Date.now(), h.db as DataDb)
          if (!online()) throw new Error('fetch failed')
          await pushSnapshot(noteId, state, coverage)
        }
      : pushSnapshot
    await provider.init(outbox, sendSnapshot)
    if (online) provider.setNetworkOnline(online)
    provider.setRemoteMerge((id) => coordinator.pullCrdtForNote(id))
    provider.setRemoteBodyQuery({
      hasUnmerged: (id) => coordinator.hasUnmergedRemoteState(id),
      isStuck: (id) => coordinator.isBodyPullStuck(id),
      signedOut: () => coordinator.isSignedOut(),
      vaultLocked: () => coordinator.isVaultKeyMissing(),
      neverSynced: (id) =>
        !coordinator.knowsServerBody(id) && isNeverSyncedLocalNote(h.db as DataDb, id)
    })
    // oxlint-disable-next-line vitest/no-conditional-expect -- table/vector-driven loop: each case asserts only the properties its row defines
    if (!options?.store) expect(provider.storeId).toBeNull()
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

  it('an editor open waits for the server body when the merge does not finish (#5290)', async () => {
    await serveNoteWithPeerEdit()
    const { provider, coordinator } = await startRuntime()

    const doc = await provider.openForEditor(
      NOTE,
      EDITOR_WINDOW,
      () => new Promise<boolean>(() => {}),
      10
    )
    expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)
    expect(provider.isAwaitingMerge(NOTE)).toBe(true)

    await coordinator.pullCrdtForNotes([NOTE])

    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
      EXPECTED_BODY
    )
    expect(provider.isAwaitingMerge(NOTE)).toBe(false)
    expect(h.broadcasts).toContainEqual({
      channel: CRDT_EVENTS.DOC_LOADED,
      payload: { noteId: NOTE }
    })
  })

  describe('a server body the pull could not merge (#5290)', () => {
    it('an editor open waits instead of seeding, and shows the body once it merges', async () => {
      // #given a server body signed by a device this one cannot resolve yet
      await serveNoteWithPeerEdit()
      h.unresolvable.add('device-b')
      const { provider, coordinator } = await startRuntime()

      // #when the editor opens the note
      const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
        coordinator.pullCrdtForNote(id)
      )

      // #then it opens empty and waiting, with no seed beside the server body
      expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)
      expect(provider.isAwaitingMerge(NOTE)).toBe(true)

      // #when the signer resolves and the owed pull merges
      h.unresolvable.clear()
      await coordinator.pullCrdtForNote(NOTE)

      // #then the editor shows the server body once
      const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
      expect(countTexts(fragment, 'Pack for the')).toBe(1)
      expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
        EXPECTED_BODY
      )
      expect(h.broadcasts).toContainEqual({
        channel: CRDT_EVENTS.DOC_LOADED,
        payload: { noteId: NOTE }
      })
    })

    it.each([
      { pullPath: 'single', durableDebts: true },
      { pullPath: 'batch', durableDebts: true },
      { pullPath: 'single', durableDebts: false }
    ] as const)(
      'a $pullPath pull that is stuck (durable debts: $durableDebts) leaves the doc unseeded, and the body merges once the signer resolves',
      async ({ pullPath, durableDebts }) => {
        // #given a signer that does not resolve
        await serveNoteWithPeerEdit()
        h.unresolvable.add('device-b')
        const { provider, coordinator } = await startRuntime({ durableDebts })
        const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
          coordinator.pullCrdtForNote(id)
        )
        expect(provider.remoteBodyWait(NOTE)).toBe('merging')

        // #when the owed pulls keep meeting it
        for (let pass = 1; pass < STUCK_BODY_PULL_FAILURES; pass++) {
          if (pullPath === 'single') await coordinator.pullCrdtForNote(NOTE)
          else await coordinator.pullCrdtForNotes([NOTE])
        }

        // #then the editor is told to show the file read-only, and the doc stays empty
        expect(provider.remoteBodyWait(NOTE)).toBe('stuck')
        expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)
        expect(h.broadcasts).toContainEqual({
          channel: CRDT_EVENTS.DOC_WAIT,
          payload: { noteId: NOTE, wait: 'stuck' }
        })

        // #when the signer resolves and the next pull merges
        h.unresolvable.clear()
        await coordinator.pullCrdtForNote(NOTE)

        // #then the editor binds the server body, once
        expect(provider.remoteBodyWait(NOTE)).toBeNull()
        expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(1)
        expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
          EXPECTED_BODY
        )
        expect(h.broadcasts).toContainEqual({
          channel: CRDT_EVENTS.DOC_LOADED,
          payload: { noteId: NOTE }
        })
      }
    )

    it('an update parked as pending structs keeps the editor waiting', async () => {
      // #given a server that holds the peer edit but not the base it builds on
      await serveNoteWithPeerEdit()
      const snapshot = h.server!.snapshot!
      h.server!.snapshot = null
      const { provider, coordinator } = await startRuntime()

      // #when the editor opens the note
      const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
        coordinator.pullCrdtForNote(id)
      )

      // #then it keeps waiting instead of binding an empty doc
      expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)
      expect(provider.remoteBodyWait(NOTE)).toBe('merging')
      expect(h.broadcasts.some((b) => b.channel === CRDT_EVENTS.DOC_LOADED)).toBe(false)

      // #when the base arrives
      h.server!.snapshot = snapshot
      await coordinator.pullCrdtForNote(NOTE)

      // #then the editor binds one body
      expect(provider.remoteBodyWait(NOTE)).toBeNull()
      expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(1)
      expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
        EXPECTED_BODY
      )
    })

    it.each([
      { case: 'a note the server never saw', serverHasBody: false },
      { case: 'a note with a server body', serverHasBody: true }
    ])(
      'an editor opened offline waits, and $case loads once back online',
      async ({ serverHasBody }) => {
        // #given the device is offline when the editor opens the note
        if (serverHasBody) await serveNoteWithPeerEdit()
        else {
          h.server = { snapshot: null, updates: [] }
          putNoteInVault(ORIGINAL)
        }
        const { provider } = await startRuntime()
        const offline = async (): Promise<boolean> => {
          throw new TypeError('fetch failed')
        }
        const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, offline)

        // #then the doc waits unseeded and is not stuck
        expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)
        expect(provider.remoteBodyWait(NOTE)).toBe('merging')

        // #when the network is back and the runtime retries the merge
        await provider.resumeWaitingEditorDocs()

        // #then the editor binds the note's body
        expect(provider.remoteBodyWait(NOTE)).toBeNull()
        expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(1)
        expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
          serverHasBody ? EXPECTED_BODY : ORIGINAL
        )
      }
    )

    describe('an editor opened while no pull can run as this user (#5342)', () => {
      async function openWith(session: Session, serverHasBody: boolean) {
        if (serverHasBody) await serveNoteWithPeerEdit()
        else {
          h.server = { snapshot: null, updates: [] }
          putNoteInVault(ORIGINAL)
        }
        const runtime = await startRuntime({ session })
        const doc = await runtime.provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
          runtime.coordinator.pullCrdtForNote(id)
        )
        return { ...runtime, doc }
      }

      it.each([
        { case: 'a note the server never saw', serverHasBody: false },
        { case: 'a note with a server body', serverHasBody: true }
      ])(
        'with the session ended waits signed out, and $case loads once signed in',
        async ({ serverHasBody }) => {
          // #given the session ended before the editor opens the note
          const session: Session = { token: false, ended: true, vaultKey: true }
          const { provider, coordinator, doc } = await openWith(session, serverHasBody)

          // #then the editor is told to show the file read-only, and the doc stays unseeded
          expect(provider.remoteBodyWait(NOTE)).toBe('signed-out')
          expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)

          // #when the user signs in, the reason clears before any pull runs
          Object.assign(session, signedIn())
          expect(provider.remoteBodyWait(NOTE)).toBe('merging')

          // #when the next sync drains the owed pull
          await coordinator.pullCrdtForNotes(coordinator.drainPendingPulls())

          // #then the editor binds the note's body, once
          expect(provider.remoteBodyWait(NOTE)).toBeNull()
          const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
          expect(fragment.length).toBe(1)
          expect(countTexts(fragment, 'Pack for the')).toBe(1)
          expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
            serverHasBody ? EXPECTED_BODY : ORIGINAL
          )
          expect(h.broadcasts).toContainEqual({
            channel: CRDT_EVENTS.DOC_LOADED,
            payload: { noteId: NOTE }
          })
        }
      )

      it('with a failed refresh on a live session waits as merging, not signed out', async () => {
        // #given a refresh that failed (offline, a 5xx) while the session is alive
        const { provider, doc } = await openWith(
          { token: false, ended: false, vaultKey: true },
          true
        )

        // #then the editor keeps its usual wait, with no sign-in notice
        expect(provider.remoteBodyWait(NOTE)).toBe('merging')
        expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)
      })

      it('turns a merging editor signed out once the session ends after the open', async () => {
        // #given an editor that opened waiting while a failed refresh left the session alive
        const session: Session = { token: false, ended: false, vaultKey: true }
        const { provider } = await openWith(session, true)
        expect(provider.remoteBodyWait(NOTE)).toBe('merging')

        // #when the session ends and the runtime reports it
        session.ended = true
        provider.reportEditorWaits()

        // #then the editor is told to show the file read-only, signed out
        expect(h.broadcasts).toContainEqual({
          channel: CRDT_EVENTS.DOC_WAIT,
          payload: { noteId: NOTE, wait: 'signed-out' }
        })
      })

      it('with no vault key waits vault-locked, and loads once the key is back', async () => {
        // #given a signed-in session whose vault key cannot be read
        const session: Session = { token: true, ended: false, vaultKey: false }
        const { provider, coordinator, doc } = await openWith(session, true)

        // #then the editor gets its own reason, and the doc stays unseeded
        expect(provider.remoteBodyWait(NOTE)).toBe('vault-locked')
        expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)

        // #when the key is readable again and the owed pull drains
        session.vaultKey = true
        await coordinator.pullCrdtForNotes(coordinator.drainPendingPulls())

        // #then the editor binds the server body, once
        expect(provider.remoteBodyWait(NOTE)).toBeNull()
        expect(countTexts(doc.getXmlFragment(CRDT_FRAGMENT_NAME), 'Pack for the')).toBe(1)
      })
    })

    it('a seeded push of the closed note pushes no seed beside the server body', async () => {
      const peer = await serveNoteWithPeerEdit()
      h.unresolvable.add('device-b')
      const { provider } = await startRuntime()

      expect(await provider.pushSnapshotForNote(NOTE)).toBe(false)

      h.unresolvable.clear()
      expect([await bodyAfterPull(), await bodyAfterPull(peer)]).toEqual([
        EXPECTED_BODY,
        EXPECTED_BODY
      ])
    })
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

  it('a create push of a vault-copied note the server already has keeps its history (#2594)', async () => {
    const peer = await serveNoteWithPeerEdit()
    const copiedFile = h.files.get(FILE)
    const { provider } = await startRuntime()

    await provider.pushSnapshotsForNotes([NOTE], { concurrency: 1 })
    await vi.waitFor(() => expect(hasPendingWriteback(NOTE)).toBe(false), { timeout: 5000 })

    expect({
      server: await bodyAfterPull(),
      peer: await bodyAfterPull(peer),
      versions: h.versions
    }).toEqual({
      server: EXPECTED_BODY,
      peer: EXPECTED_BODY,
      versions: [copiedFile]
    })
  })

  it('the oversized-update fallback of a closed note keeps the server history (#2594)', async () => {
    const peer = await serveNoteWithPeerEdit()
    const { provider } = await startRuntime()

    await provider.pushSnapshotForNote(NOTE)

    expect([await bodyAfterPull(), await bodyAfterPull(peer)]).toEqual([
      EXPECTED_BODY,
      EXPECTED_BODY
    ])
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

    it('an editor that closes its tab during the flush merge fails that flush, and the next one takes the file', async () => {
      await serveNoteWithPeerEdit()
      const { provider, coordinator, flushFullStates } = await startRuntime()
      putNoteInVault(LAGGING_EDIT)
      await feedExternalEditToCrdt(NOTE, LAGGING_EDIT)
      await provider.open(NOTE, EDITOR_WINDOW, { skipSeed: true })

      const failed = await readMergedFullState(
        provider,
        NOTE,
        async (id) => {
          await provider.close(id, EDITOR_WINDOW)
          return coordinator.pullCrdtForNote(id)
        },
        () => false
      ).catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
      const afterFailedFlush = { failed, owed: owesFileBody(NOTE), server: await bodyAfterPull() }
      await flushFullStates()

      expect({ afterFailedFlush, server: await bodyAfterPull(), versions: h.versions }).toEqual({
        afterFailedFlush: {
          failed: 'Full-state doc was closed during the merge',
          owed: true,
          server: EXPECTED_BODY
        },
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

  it('an edit to a closed note returns while the server keeps refusing snapshots (#2763)', async () => {
    const store = fakeStore() as { storeUpdate: (id: string, u: Uint8Array) => Promise<void> }
    h.persistence = store
    putNoteInVault(ORIGINAL)
    const persisted = new Y.Doc()
    await markdownToYFragment(ORIGINAL, persisted.getXmlFragment(CRDT_FRAGMENT_NAME), NOTE_PATH)
    await store.storeUpdate(NOTE, Y.encodeStateAsUpdate(persisted))
    const queued: Uint8Array[] = []
    const outbox = {
      enqueue: (_noteId: string, update: Uint8Array) => queued.push(update),
      enqueueFullState: () => {},
      dropNote: () => {}
    } as unknown as NoteBodyOutbox
    const provider = getCrdtProvider()
    await provider.init(outbox, () => new Promise<void>(() => {}))
    const deferred: string[] = []
    provider.setSnapshotDeferral((noteId) => deferred.push(noteId))

    const fed = await feedExternalEditToCrdt(NOTE, EXPECTED_BODY)

    for (const update of queued) Y.applyUpdate(persisted, update)
    expect({
      fed,
      deferred,
      queuedBody: await yDocToMarkdown(persisted, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })
    }).toEqual({ fed: true, deferred: [NOTE], queuedBody: EXPECTED_BODY })
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

  describe('a store that never held a note whose file was edited and not yet synced (#3277)', () => {
    const NEWER_BODY = `${ORIGINAL}\n\nWritten by hand after the last sync.`

    async function sweepWithEmptyStore(
      canonical: { modifiedAt: string; syncedAt: string },
      entry: 'sweep' | 'single' = 'sweep'
    ) {
      await serveNoteWithPeerEdit()
      const serverBody = await bodyAfterPull()
      putNoteInVault(NEWER_BODY)
      const fileBefore = h.files.get(FILE)
      h.canonical = { id: NOTE, ...canonical }
      h.persistence = fakeStore()
      const { provider, coordinator, flushFullStates } = await startRuntime({ store: true })
      if (entry === 'sweep') await coordinator.pullCrdtForNotes([NOTE])
      else await coordinator.pullCrdtForNote(NOTE)
      await vi.waitFor(() => expect(hasPendingWriteback(NOTE)).toBe(false), { timeout: 5000 })
      await flushFullStates()
      await provider.close(NOTE)
      return { serverBody, fileBefore }
    }

    it.each(['sweep', 'single'] as const)(
      'a %s pull keeps the newer file text, pushes it, and keeps the server body as a version',
      async (entry) => {
        const { serverBody, fileBefore } = await sweepWithEmptyStore(
          { modifiedAt: '2026-10-14T06:20:00.000Z', syncedAt: '2026-10-09T10:00:00.000Z' },
          entry
        )

        expect({
          file: h.files.get(FILE),
          server: await bodyAfterPull(),
          versionBodies: h.versions.map((v) => parseNote(v).content.trim())
        }).toEqual({
          file: fileBefore,
          server: NEWER_BODY,
          versionBodies: [serverBody!.trim()]
        })
      }
    )

    it('a sweep of a synced note still takes the server body, keeping the file as a version', async () => {
      const { serverBody, fileBefore } = await sweepWithEmptyStore({
        modifiedAt: '2026-10-09T10:00:00.000Z',
        syncedAt: '2026-10-09T10:00:00.000Z'
      })

      expect({
        server: await bodyAfterPull(),
        file: parseNote(h.files.get(FILE)!).content,
        versions: h.versions
      }).toEqual({ server: serverBody, file: serverBody, versions: [fileBefore] })
    })
  })

  describe('a note created here that never synced, opened offline (#5371)', () => {
    const OFFLINE = (): Promise<boolean> => new Promise<boolean>(() => {})
    const TYPED = ORIGINAL.replace('/lake).', '/lake). Map printed.')

    /** A note created on this device: its create is still queued, nothing pushed. */
    function createNoteHere(): void {
      indexNoteFromFile()
      ;(h.db as DataDb).insert(notesCreatedHere).values({ noteId: NOTE, createdAt: 1 }).run()
    }

    /** A note the ingest or the watcher indexed: create queued, no create-command marker. */
    function indexNoteFromFile(): void {
      putNoteInVault(ORIGINAL)
      h.db = createTestDataDb().db
      h.canonical = { id: NOTE, syncedAt: null }
      ;(h.db as DataDb)
        .insert(syncQueue)
        .values({
          id: 'create-row',
          type: 'note',
          itemId: NOTE,
          operation: 'create',
          payload: '{}',
          createdAt: new Date()
        })
        .run()
    }

    function type(provider: ReturnType<typeof getCrdtProvider>, doc: Y.Doc): void {
      const editor = new Y.Doc()
      Y.applyUpdate(editor, Y.encodeStateAsUpdate(doc))
      const seen = Y.encodeStateVector(editor)
      const text = findText(editor.getXmlFragment(CRDT_FRAGMENT_NAME), 'Pack for the')
      text.insert(text.length, ' Map printed.')
      provider.applyIpcUpdate(NOTE, Y.encodeStateAsUpdate(editor, seen), EDITOR_WINDOW)
    }

    it('opens editable, keeps what is typed, and syncs it later as one copy', async () => {
      // #given a note created here while offline; the server holds nothing
      h.server = { snapshot: null, updates: [] }
      createNoteHere()
      const { provider, coordinator } = await startRuntime()

      // #when the editor opens it while the merge cannot reach the server
      const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, OFFLINE, 10)

      // #then it opens with the file body and no wait
      expect(provider.isAwaitingMerge(NOTE)).toBe(false)
      expect(provider.remoteBodyWait(NOTE)).toBeNull()
      expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(ORIGINAL)

      // #when the user types and closes the note
      type(provider, doc)
      await provider.close(NOTE, EDITOR_WINDOW)

      // #then once online the server and a reopen hold the typed body once
      expect(await bodyAfterPull()).toBe(TYPED)
      const reopened = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
        coordinator.pullCrdtForNote(id)
      )
      expect(countTexts(reopened.getXmlFragment(CRDT_FRAGMENT_NAME), 'Pack for the')).toBe(1)
      expect(await yDocToMarkdown(reopened, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
        TYPED
      )
    })

    it('stays editable on an offline reopen after an offline close, and sends nothing while offline', async () => {
      // #given a note created here, and a device with no network
      h.server = { snapshot: null, updates: [] }
      createNoteHere()
      let online = false
      const { provider } = await startRuntime({ online: () => online })

      // #when the user opens it offline, types, closes it, and reopens it offline
      const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, OFFLINE, 10)
      type(provider, doc)
      await provider.close(NOTE, EDITOR_WINDOW)
      expect(isNeverSyncedLocalNote(h.db as DataDb, NOTE)).toBe(true)
      await vi.waitFor(() => expect(hasPendingWriteback(NOTE)).toBe(false), { timeout: 5000 })
      const reopened = await provider.openForEditor(NOTE, EDITOR_WINDOW, OFFLINE, 10)

      // #then it reopens editable with the typed body, and the snapshot stays owed
      expect(provider.isAwaitingMerge(NOTE)).toBe(false)
      expect(await yDocToMarkdown(reopened, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
        TYPED
      )
      expect(h.server.snapshot).toBeNull()

      // #when the network returns
      online = true
      await expect(provider.pushSnapshotForNote(NOTE)).resolves.toBe(true)

      // #then the server holds the typed body once
      expect(await bodyAfterPull()).toBe(TYPED)
    })

    it.each([
      {
        proof: 'a pull or record push stamped the row',
        undo: () => (h.canonical = { id: NOTE, syncedAt: '2026-11-21T00:00:00.000Z' })
      },
      {
        proof: 'the server acknowledged the create',
        undo: () => (h.db as DataDb).delete(syncQueue).run()
      },
      {
        proof: 'a body push started',
        undo: () => recordNoteBodyPush(NOTE, 'sent', 1, h.db as DataDb)
      }
    ])('stays read-only once $proof', async ({ undo }) => {
      h.server = { snapshot: null, updates: [] }
      createNoteHere()
      undo()
      const { provider } = await startRuntime()

      const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, OFFLINE, 10)

      expect(provider.isAwaitingMerge(NOTE)).toBe(true)
      expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)
    })

    it('a note a shared folder brought stays read-only and shows the server body once (#5371)', async () => {
      // #given a file another device already synced, indexed here from a shared folder
      await serveNoteWithPeerEdit()
      indexNoteFromFile()
      const { provider, coordinator } = await startRuntime()

      // #when the editor opens it while the merge cannot reach the server
      const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, OFFLINE, 10)

      // #then it waits instead of seeding beside the server body
      expect(provider.isAwaitingMerge(NOTE)).toBe(true)
      expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)

      // #when the pull merges once online
      await coordinator.pullCrdtForNote(NOTE)

      // #then the body appears once
      expect(countTexts(doc.getXmlFragment(CRDT_FRAGMENT_NAME), 'Pack for the')).toBe(1)
    })

    it('a seeded push of a closed never-synced note whose merge failed keeps the push owed', async () => {
      // #given a note created here, closed, and a merge that cannot finish
      h.server = { snapshot: null, updates: [] }
      createNoteHere()
      const { provider } = await startRuntime()
      provider.setRemoteMerge(async () => false)

      // #when a snapshot push opens it
      const pushed = await provider.pushSnapshotForNote(NOTE)

      // #then nothing is seeded or sent; the push stays owed
      expect(pushed).toBe(false)
      expect(h.server).toEqual({ snapshot: null, updates: [] })
    })

    it('stays read-only when this session already pulled a server body for it', async () => {
      // #given an id the server holds a body for, though the local facts say never synced
      await serveNoteWithPeerEdit()
      createNoteHere()
      const { provider, coordinator } = await startRuntime()
      await coordinator.pullCrdtForNotes([NOTE])
      await vi.waitFor(() => expect(hasPendingWriteback(NOTE)).toBe(false), { timeout: 5000 })

      // #when the editor opens it offline
      const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, OFFLINE, 10)

      // #then it waits for the server body instead of seeding beside it
      expect(provider.isAwaitingMerge(NOTE)).toBe(true)
      expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)
    })
  })

  describe('an editor tab restored before the sync runtime wires its merge', () => {
    afterEach(() => {
      markSyncIneligible()
      resetSyncDecision()
    })

    /** The editor open a launch's restored tab makes while the runtime still starts. */
    async function openRestoredTab(): Promise<Y.Doc> {
      const provider = getCrdtProvider()
      await provider.initPersistence()
      expect(provider.storeId).toBeNull()
      return provider.openForEditor(NOTE, EDITOR_WINDOW, null)
    }

    it('waits unseeded, and shows the server body once after the runtime wires its merge', async () => {
      // #given a note with a server body, and a runtime start past its policy gates
      await serveNoteWithPeerEdit()
      markSyncEligible()

      // #when the tab opens before the start wires its merge
      const doc = await openRestoredTab()

      // #then it waits for the runtime instead of seeding from the file
      expect.soft(getCrdtProvider().remoteBodyWait(NOTE)).toBe('merging')

      // #when the start wires its merge, resumes the waiting docs and runs its first sync
      const { provider, coordinator } = await startRuntime()
      await provider.resumeWaitingEditorDocs()
      await coordinator.pullCrdtForNotes([NOTE])

      // #then the editor binds the server body, once
      const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
      expect(countTexts(fragment, 'Pack for the')).toBe(1)
      expect(fragment.length).toBe(1)
      expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
        EXPECTED_BODY
      )
      expect(h.broadcasts).toContainEqual({
        channel: CRDT_EVENTS.DOC_LOADED,
        payload: { noteId: NOTE }
      })
    })

    it('seeds from the file once the start settles that this install does not sync', async () => {
      // #given a tab restored while the start still decides
      putNoteInVault(ORIGINAL)
      const doc = await openRestoredTab()
      expect.soft(getCrdtProvider().remoteBodyWait(NOTE)).toBe('merging')

      // #when the start settles that this install does not sync
      markSyncIneligible()
      await getCrdtProvider().settleUnwiredEditorDocs()

      // #then the editor binds the file body
      expect(getCrdtProvider().remoteBodyWait(NOTE)).toBeNull()
      expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(ORIGINAL)
      expect(h.broadcasts).toContainEqual({
        channel: CRDT_EVENTS.DOC_LOADED,
        payload: { noteId: NOTE }
      })
    })

    it('seeds at once when the start already settled that this install does not sync', async () => {
      putNoteInVault(ORIGINAL)
      markSyncIneligible()

      const doc = await openRestoredTab()

      expect(getCrdtProvider().remoteBodyWait(NOTE)).toBeNull()
      expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(ORIGINAL)
    })

    it('leaves the seed to the editor open when a handshake creates the doc', async () => {
      // #given a note with a server body, and a launch with no store
      await serveNoteWithPeerEdit()
      markSyncEligible()
      await getCrdtProvider().initPersistence()
      _resetCrdtIpcHandlersForTests()
      registerCrdtIpcHandlers()

      // #when the editor's handshake creates the doc (a reset dropped the one it opened)
      await invokeHandler(CRDT_CHANNELS.SYNC_STEP_1, {
        noteId: NOTE,
        stateVector: Y.encodeStateVector(new Y.Doc())
      })

      // #then nothing is seeded beside the server body
      expect(getCrdtProvider().getDoc(NOTE)?.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)

      // #when the editor opens it once the runtime runs
      const { provider, coordinator } = await startRuntime()
      const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
        coordinator.pullCrdtForNote(id)
      )

      // #then it shows the server body, once
      expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(1)
      expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
        EXPECTED_BODY
      )
    })

    it('keeps waiting read-only when the start fails before it wires the merge', async () => {
      // #given a note with a server body, and a tab restored while the start runs
      await serveNoteWithPeerEdit()
      markSyncEligible()
      const doc = await openRestoredTab()

      // #when the start ends without wiring its merge (a vault key it cannot read)
      await getCrdtProvider().settleUnwiredEditorDocs()

      // #then the doc stays unseeded, and the editor shows the file read-only
      expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(0)
      expect(getCrdtProvider().remoteBodyWait(NOTE)).toBe('stuck')
      expect(h.broadcasts).toContainEqual({
        channel: CRDT_EVENTS.DOC_WAIT,
        payload: { noteId: NOTE, wait: 'stuck' }
      })

      // #when the next start begins, before it wires the merge
      getCrdtProvider().clearSyncStartFailure()

      // #then the editor waits for that start, not on the earlier failure
      expect(getCrdtProvider().remoteBodyWait(NOTE)).toBe('merging')

      // #when that start wires the merge
      const { provider } = await startRuntime()
      await provider.resumeWaitingEditorDocs()

      // #then the editor binds the server body, once
      expect(provider.remoteBodyWait(NOTE)).toBeNull()
      expect(countTexts(doc.getXmlFragment(CRDT_FRAGMENT_NAME), 'Pack for the')).toBe(1)
      expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath: NOTE_PATH })).toBe(
        EXPECTED_BODY
      )
    })
  })

  describe('a forked or replaced root the write-back keeps out of the file', () => {
    const KEPT = 'Write-back kept the file'
    const KINDS = [
      { kind: 'note', id: NOTE, relative: NOTE_PATH },
      { kind: 'journal', id: 'j2026-01-01', relative: 'journal/2026-01-01.md' }
    ]

    function putInVault(id: string, relative: string, body: string): string {
      const file = `---\nid: ${id}\ntitle: Trip\n---\n${body}`
      h.files.set(`/vault/${relative}`, file)
      h.row = {
        id,
        path: relative,
        title: 'Trip',
        fileType: 'markdown',
        localOnly: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        contentHash: generateContentHash(file)
      }
      return file
    }

    async function settledFile(id: string, relative: string): Promise<string | undefined> {
      await vi.waitFor(() => expect(hasPendingWriteback(id)).toBe(false), { timeout: 5000 })
      return h.files.get(`/vault/${relative}`)
    }

    /** `edit` made on a copy of `doc`, as the update that carries it. */
    function editOf(doc: Y.Doc, edit: (copy: Y.Doc) => void): Uint8Array {
      const copy = new Y.Doc()
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
      const before = Y.encodeStateVector(copy)
      edit(copy)
      return Y.encodeStateAsUpdate(copy, before)
    }

    /** The one empty block BlockNote keeps in a body with no text. */
    function emptyBlock(id: string): Y.XmlElement {
      const block = new Y.XmlElement('blockContainer')
      block.setAttribute('id', id)
      block.insert(0, [new Y.XmlElement('paragraph')])
      return block
    }

    /** A store that holds the body the file holds, as a launch with a store loads it. */
    async function openStoredDoc(id: string, relative: string): Promise<Y.Doc> {
      const store = fakeStore() as { storeUpdate: (id: string, u: Uint8Array) => Promise<void> }
      h.persistence = store
      h.server = { snapshot: null, updates: [] }
      const persisted = new Y.Doc()
      await markdownToYFragment(ORIGINAL, persisted.getXmlFragment(CRDT_FRAGMENT_NAME), relative)
      await store.storeUpdate(id, Y.encodeStateAsUpdate(persisted))
      const { provider } = await startRuntime({ store: true })
      return provider.open(id, EDITOR_WINDOW)
    }

    it('keeps the file while the body holds two roots, and logs it once', async () => {
      // #given an editor showing the server body, written to the file
      await serveNoteWithPeerEdit()
      const { provider, coordinator } = await startRuntime()
      const doc = await provider.openForEditor(NOTE, EDITOR_WINDOW, (id) =>
        coordinator.pullCrdtForNote(id)
      )
      const file = await settledFile(NOTE, NOTE_PATH)
      expect(file).toContain('Tent packed.')

      // #when a body seeded elsewhere from the file merges beside it, and a peer edit follows
      const fork = new Y.Doc()
      fork.clientID = 1
      await markdownToYFragment('Forked copy.', fork.getXmlFragment(CRDT_FRAGMENT_NAME), NOTE_PATH)
      provider.applyRemoteUpdate(NOTE, Y.encodeStateAsUpdate(fork))
      expect(await settledFile(NOTE, NOTE_PATH)).toBe(file)
      provider.applyRemoteUpdate(
        NOTE,
        editOf(doc, (copy) => {
          const text = findText(copy.getXmlFragment(CRDT_FRAGMENT_NAME), 'Tent packed.')
          text.insert(text.length, ' Map printed.')
        })
      )

      // #then the file keeps the body it held, and one error names the note
      expect(await settledFile(NOTE, NOTE_PATH)).toBe(file)
      expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).length).toBe(2)
      expect(h.errors.filter((e) => e.message.startsWith(KEPT))).toEqual([
        {
          message: expect.stringContaining('more than one root'),
          meta: {
            noteId: NOTE,
            liveRoots: 2,
            bodyWords: expect.any(Number),
            fileWords: expect.any(Number)
          }
        }
      ])
    })

    it.each(KINDS)(
      'keeps a $kind file that a fresh, empty root would empty',
      async ({ id, relative }) => {
        // #given a launch with a store that holds the body the file holds
        const file = putInVault(id, relative, ORIGINAL)
        const doc = await openStoredDoc(id, relative)
        const provider = getCrdtProvider()

        // #when a peer deletes the root, and the editor makes a fresh, empty one
        provider.applyRemoteUpdate(
          id,
          editOf(doc, (copy) => copy.getXmlFragment(CRDT_FRAGMENT_NAME).delete(0, 1))
        )
        provider.applyIpcUpdate(
          id,
          editOf(doc, (copy) => {
            const root = new Y.XmlElement('blockGroup')
            root.insert(0, [emptyBlock('fresh')])
            copy.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [root])
          }),
          EDITOR_WINDOW
        )

        // #then the file keeps its body, and the error names the note
        expect(await settledFile(id, relative)).toBe(file)
        expect(h.errors.filter((e) => e.message.startsWith(KEPT))).toEqual([
          {
            message: expect.stringContaining('empty body'),
            meta: { noteId: id, liveRoots: 1, bodyWords: 0, fileWords: expect.any(Number) }
          }
        ])
      }
    )

    it.each(KINDS)(
      'writes the empty body of a $kind the user cleared',
      async ({ id, relative }) => {
        // #given a launch with a store that holds the body the file holds
        putInVault(id, relative, ORIGINAL)
        const doc = await openStoredDoc(id, relative)

        // #when the user deletes every block, keeping the note's root
        getCrdtProvider().applyIpcUpdate(
          id,
          editOf(doc, (copy) => {
            const root = copy.getXmlFragment(CRDT_FRAGMENT_NAME).get(0) as Y.XmlElement
            root.delete(0, root.length)
            root.insert(0, [emptyBlock('cleared')])
          }),
          EDITOR_WINDOW
        )

        // #then the file holds the empty body
        const written = await settledFile(id, relative)
        expect(parseNote(written ?? '', relative).content.trim()).toBe('')
        expect(h.errors.filter((e) => e.message.startsWith(KEPT))).toEqual([])
      }
    )
  })
})
