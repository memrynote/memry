import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sodium from 'libsodium-wrappers-sumo'
import * as Y from 'yjs'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { encryptCrdtUpdate } from '../crdt-encrypt'
import type { PackBootstrapDeps } from '../packs/pack-bootstrap'
import { generateUniquePathSync } from '../../vault/file-ops'
import { generateContentHash, parseNote, serializeNote } from '../../vault/frontmatter'
import {
  cancelPendingWritebacks,
  flushPendingWritebacks,
  resetWritebackState,
  scheduleWriteback
} from '../crdt-writeback'
import { FullSyncRunner, type FullSyncActions } from './full-sync-runner'
import type { SyncContext } from './sync-context'
import type { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import type { PushCoordinator } from './push-coordinator'
import type { SyncStateManager } from './sync-state-manager'

/**
 * Pack bootstrap (#1840) seeds note bodies before the first record pull, so a
 * packed body can belong to a note the pull is about to tombstone. Everything
 * between the packed snapshot and the vault file runs for real here: the
 * snapshot applier, the markdown write-back and the vault's file ops on a temp
 * dir. The record pull is a stand-in that applies records the way the note
 * and journal handlers do: a create writes the record's content at a unique
 * path, a delete removes the row and its file.
 */

interface Row {
  id: string
  path: string
  title: string
  contentHash: string
  journalDate: string | null
  createdAt: string
}

const mocks = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  vaultRoot: '',
  rows: new Map<string, Row>(),
  reminders: new Map<string, { synced: boolean }>(),
  sent: [] as string[],
  runPackBootstrap: vi.fn()
}))

vi.mock('../../lib/logger', () => ({ createLogger: () => mocks.log }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/memry-test-userdata' } }))
vi.mock('../../lib/window-broadcast', () => ({
  broadcastToAllWindows: (channel: string) => mocks.sent.push(channel)
}))
vi.mock('../../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../manifest-check', () => ({
  checkManifestIntegrity: async () => ({
    performed: false,
    checkedAt: 0,
    rePullNeeded: false,
    serverOnlyCount: 0
  })
}))
vi.mock('../initial-seed', () => ({ runInitialSeed: vi.fn() }))
vi.mock('../bootstrap-metrics', () => ({
  beginBootstrap: vi.fn(),
  markBootstrapFullText: vi.fn(),
  abandonBootstrap: vi.fn()
}))
vi.mock('../bootstrap-session', () => ({
  openBootstrapSession: vi.fn(async () => {}),
  closeBootstrapSession: vi.fn(async () => {})
}))
vi.mock('../packs/pack-bootstrap', () => ({
  runPackBootstrap: (...args: unknown[]) => mocks.runPackBootstrap(...args)
}))
vi.mock('../device-keys', () => ({ fetchAndCacheDeviceKeys: vi.fn() }))
vi.mock('../bulk-apply', () => ({ beginPageApply: vi.fn() }))
vi.mock('../local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

// Write-back asks the provider only for a newer doc of the same note.
vi.mock('../crdt-provider', () => ({
  getCrdtProvider: () => ({ getDoc: () => undefined, close: vi.fn(), purge: vi.fn() })
}))

// The body under test is plain text; the BlockNote schema is not what this
// file is about.
vi.mock('../blocknote-converter', () => ({
  yDocToMarkdown: async (doc: Y.Doc) => doc.getText('body').toString(),
  findUnrepresentableNodes: () => []
}))

vi.mock('../../database/client', () => ({
  getDatabase: () => ({ kind: 'data-db' }),
  getIndexDatabase: () => ({ kind: 'index-db' }),
  isIndexDatabaseInitialized: () => false
}))
vi.mock('../../database/queries/notes', () => ({
  getAllCrdtNoteIds: () => [],
  getAllSyncableNoteMetadataIds: () => [],
  getNoteCacheById: (_db: unknown, id: string) => mocks.rows.get(id),
  getNoteCacheByPath: (_db: unknown, rel: string) =>
    [...mocks.rows.values()].find((row) => row.path === rel)
}))
vi.mock('@memry/storage-data', () => ({
  getNoteMetadataById: (_db: unknown, id: string) => mocks.rows.get(id)
}))

// Same UNIQUE(path) constraint as note_metadata.
vi.mock('../../vault/note-sync', () => ({
  syncNoteToCache: (
    _db: unknown,
    note: { id: string; path: string; title: string; fileContent: string; createdAt: string },
    options: { isNew: boolean }
  ) => {
    const taken = [...mocks.rows.values()].some(
      (row) => row.path === note.path && row.id !== note.id
    )
    if (options.isNew && taken) throw new Error('UNIQUE constraint failed: note_metadata.path')
    const existing = mocks.rows.get(note.id)
    mocks.rows.set(note.id, {
      id: note.id,
      path: note.path,
      title: note.title,
      contentHash: generateContentHash(note.fileContent),
      journalDate: existing?.journalDate ?? null,
      createdAt: note.createdAt
    })
  },
  deleteNoteFromCache: (_db: unknown, id: string) => mocks.rows.delete(id)
}))
vi.mock('../../vault/notes', () => ({
  getVaultRoot: () => mocks.vaultRoot,
  getDefaultNoteDir: () => mocks.vaultRoot,
  toRelativePath: (absolute: string) => path.relative(mocks.vaultRoot, absolute),
  toAbsolutePath: (relative: string) => path.join(mocks.vaultRoot, relative),
  maybeCreateSignificantSnapshot: () => null
}))
vi.mock('../../vault/journal', () => ({
  getJournalPath: (date: string) => path.join(mocks.vaultRoot, 'journal', `${date}.md`)
}))
vi.mock('../../vault/attachment-rename-reconcile', () => ({
  reconcileRenamedAttachments: () => []
}))
vi.mock('../../projections', () => ({ flushProjectionEvents: vi.fn(async () => {}) }))
vi.mock('@memry/app-core/reminders', () => ({
  createRemindersService: (_db: unknown, hooks?: unknown) => ({ synced: hooks !== undefined })
}))
vi.mock('../../notes/note-date-reminders', () => ({
  syncNoteDateReminders: async (
    noteId: string,
    _markdown: string,
    service: { synced: boolean }
  ) => {
    mocks.reminders.set(`rem_nd_${noteId}`, { synced: service.synced })
  },
  clearNoteDateReminders: async (noteId: string) => {
    mocks.reminders.delete(`rem_nd_${noteId}`)
  }
}))

type PulledRecord =
  | { op: 'upsert'; type: 'note'; id: string; title: string; content: string }
  | { op: 'upsert'; type: 'journal'; id: string; date: string; content: string }
  | { op: 'delete'; id: string }

interface Scenario {
  packed: Array<{ id: string; body: string }>
  pulled: PulledRecord[]
}

interface Outcome {
  files: Record<string, string>
  rows: Record<string, string>
  reminders: string[]
  docs: string[]
  createdEvents: string[]
}

let vaultKey: Uint8Array
let peer: { publicKey: Uint8Array; privateKey: Uint8Array }

function packedUpdate(noteId: string, body: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('body').insert(0, body)
  return encryptCrdtUpdate(Y.encodeStateAsUpdate(doc), vaultKey, noteId, peer.privateKey)
}

function readVault(dir: string, prefix = ''): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name)
    if (entry.isDirectory()) Object.assign(files, readVault(path.join(dir, entry.name), rel))
    else if (entry.name.endsWith('.md')) {
      files[rel] = parseNote(fs.readFileSync(path.join(dir, entry.name), 'utf-8')).content.trim()
    }
  }
  return files
}

/** The record half of a pull, applied the way the note and journal handlers do. */
function applyRecord(record: PulledRecord, docs: Map<string, Y.Doc>): void {
  if (record.op === 'delete') {
    const row = mocks.rows.get(record.id)
    if (!row) return
    mocks.rows.delete(record.id)
    fs.rmSync(path.join(mocks.vaultRoot, row.path), { force: true })
    docs.delete(record.id)
    return
  }
  if (mocks.rows.has(record.id)) return
  const rel =
    record.type === 'journal'
      ? path.join('journal', `${record.date}.md`)
      : path.relative(
          mocks.vaultRoot,
          generateUniquePathSync(path.join(mocks.vaultRoot, `${record.title}.md`), (p) =>
            [...mocks.rows.values()].some((row) => row.path === path.relative(mocks.vaultRoot, p))
          )
        )
  const fileContent = serializeNote({}, record.content)
  fs.mkdirSync(path.dirname(path.join(mocks.vaultRoot, rel)), { recursive: true })
  fs.writeFileSync(path.join(mocks.vaultRoot, rel), fileContent)
  mocks.rows.set(record.id, {
    id: record.id,
    path: rel,
    title: record.type === 'journal' ? record.date : record.title,
    contentHash: generateContentHash(fileContent),
    journalDate: record.type === 'journal' ? record.date : null,
    createdAt: '2026-09-26T00:00:00.000Z'
  })
}

async function runFreshDeviceSync(scenario: Scenario): Promise<Outcome> {
  const docs = new Map<string, Y.Doc>()
  const docFor = (noteId: string): Y.Doc => {
    const doc = docs.get(noteId) ?? new Y.Doc()
    docs.set(noteId, doc)
    return doc
  }
  const provider = {
    storeId: 'store-1',
    inactiveDocCapacity: 32,
    getSnapshotWatermark: async () => null,
    putSnapshotWatermark: async () => {},
    open: async (noteId: string) => docFor(noteId),
    // What `CrdtProvider.onDocUpdate` does with a network-origin update.
    applyRemoteUpdate: (noteId: string, update: Uint8Array) => {
      const doc = docFor(noteId)
      Y.applyUpdate(doc, update, 'network')
      scheduleWriteback(noteId, doc)
      return true
    },
    getStateVector: (noteId: string) => {
      const doc = docs.get(noteId)
      return doc ? Y.encodeStateVector(doc) : null
    },
    closeIfInactive: async () => true,
    getOpenNoteIds: () => [],
    purge: async (noteId: string) => {
      docs.delete(noteId)
    }
  }

  mocks.runPackBootstrap.mockImplementation(async (deps: PackBootstrapDeps) => {
    for (const [index, { id, body }] of scenario.packed.entries()) {
      const meta = { sequenceNum: index + 1, revision: `r${index + 1}` }
      if (await deps.snapshots.shouldApply(id, meta)) {
        await deps.snapshots.apply(id, packedUpdate(id, body), meta)
      }
    }
    return {
      usedPacks: true,
      packsApplied: 1,
      entriesApplied: scenario.packed.length,
      entriesSkipped: 0,
      entriesFailed: 0,
      appliedThroughCursor: 100
    }
  })

  const signingKey = sodium.to_base64(peer.publicKey, sodium.base64_variants.ORIGINAL)
  const ctx = {
    deps: {
      db: { select: () => ({ from: () => ({ all: () => [{ key: signingKey }] }) }) },
      queue: { getPendingCount: () => 0, purgeOldErrors: vi.fn() },
      network: { online: true },
      ws: { connected: true, connectionGeneration: 1 },
      getAccessToken: async () => 'token',
      getVaultKey: async () => new Uint8Array(vaultKey),
      getSigningKeys: async () => null,
      emitToRenderer: vi.fn(),
      crdtProvider: provider
    },
    applier: { changedCount: 0 },
    acquireLock: async () => () => {},
    releaseLock: vi.fn(),
    fullSyncActive: false
  } as unknown as SyncContext

  const actions: FullSyncActions = {
    pull: async () => {
      // The pack phase takes seconds on a real vault, so the write-backs its
      // applies armed (500ms debounce) fire before the first record page.
      await flushPendingWritebacks()
      for (const record of scenario.pulled) applyRecord(record, docs)
      return true
    },
    push: async () => {},
    scheduleSync: vi.fn()
  }

  const runner = new FullSyncRunner(
    ctx,
    {
      getStateValue: () => undefined,
      setStateValue: vi.fn(),
      isPaused: () => false,
      recordHistory: vi.fn(),
      updateLastSyncAt: vi.fn()
    } as unknown as SyncStateManager,
    { clearPendingAfterFullSync: vi.fn() } as unknown as PushCoordinator,
    {
      addPendingPull: vi.fn(),
      drainPendingPulls: () => [],
      pendingPullCount: 0,
      nextDeferredPullAt: () => null
    } as unknown as CrdtSyncCoordinator,
    actions
  )

  await runner.run()
  await flushPendingWritebacks()

  return {
    files: readVault(mocks.vaultRoot),
    rows: Object.fromEntries([...mocks.rows.values()].map((row) => [row.id, row.path])),
    reminders: [...mocks.reminders.keys()].sort(),
    docs: [...docs.keys()].sort(),
    createdEvents: mocks.sent.filter((channel) => channel.endsWith('created'))
  }
}

describe('FullSyncRunner pack bootstrap and the markdown write-back', () => {
  beforeAll(async () => {
    await sodium.ready
    vaultKey = new Uint8Array(32)
    peer = sodium.crypto_sign_keypair('uint8array')
  })

  beforeEach(() => {
    mocks.vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-pack-writeback-'))
    mocks.rows.clear()
    mocks.reminders.clear()
    mocks.sent = []
    resetWritebackState()
  })

  afterEach(() => {
    cancelPendingWritebacks()
    fs.rmSync(mocks.vaultRoot, { recursive: true, force: true })
  })

  it('leaves nothing behind for packed notes and journals the pull tombstones', async () => {
    const outcome = await runFreshDeviceSync({
      packed: [
        { id: 'deletednote1', body: 'Deleted note body' },
        { id: 'j2099-06-03', body: 'Deleted journal body' },
        { id: 'livenote0001', body: 'Live note body' }
      ],
      pulled: [
        { op: 'delete', id: 'deletednote1' },
        { op: 'delete', id: 'j2099-06-03' },
        { op: 'upsert', type: 'note', id: 'livenote0001', title: 'Plans', content: '' }
      ]
    })

    expect(outcome).toEqual({
      files: { 'Plans.md': 'Live note body' },
      rows: { livenote0001: 'Plans.md' },
      reminders: ['rem_nd_livenote0001'],
      docs: ['livenote0001'],
      createdEvents: []
    })
  })

  it('gives two packed notes with the same title each their own file and body', async () => {
    const outcome = await runFreshDeviceSync({
      packed: [
        { id: 'untitled0001', body: 'First body' },
        { id: 'untitled0002', body: 'Second body' },
        { id: 'untitled0003', body: 'Third body' }
      ],
      pulled: [
        { op: 'upsert', type: 'note', id: 'untitled0001', title: 'Untitled', content: '' },
        { op: 'upsert', type: 'note', id: 'untitled0002', title: 'Untitled', content: '' },
        { op: 'upsert', type: 'note', id: 'untitled0003', title: 'Untitled', content: '' }
      ]
    })

    expect(outcome.files).toEqual({
      'Untitled.md': 'First body',
      'Untitled 1.md': 'Second body',
      'Untitled 2.md': 'Third body'
    })
    expect(outcome.rows).toEqual({
      untitled0001: 'Untitled.md',
      untitled0002: 'Untitled 1.md',
      untitled0003: 'Untitled 2.md'
    })
  })

  it('materializes a packed live journal from its doc once its record lands', async () => {
    const outcome = await runFreshDeviceSync({
      packed: [{ id: 'j2026-09-08', body: 'Journal body' }],
      pulled: [
        { op: 'upsert', type: 'journal', id: 'j2026-09-08', date: '2026-09-08', content: '' }
      ]
    })

    expect(outcome.files).toEqual({ [path.join('journal', '2026-09-08.md')]: 'Journal body' })
    expect(outcome.createdEvents).toEqual([])
  })
})
