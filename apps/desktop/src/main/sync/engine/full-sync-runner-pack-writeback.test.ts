import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sodium from 'libsodium-wrappers-sumo'
import * as Y from 'yjs'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { eq } from 'drizzle-orm'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { encryptCrdtUpdate } from '../crdt-encrypt'
import type { PackBootstrapDeps } from '../packs/pack-bootstrap'
import { generateUniquePathSync } from '../../vault/file-ops'
import { generateContentHash, parseNote, serializeNote } from '../../vault/frontmatter'
import {
  cancelPendingWritebacks,
  flushPendingWritebacks,
  resetWritebackState,
  scheduleWriteback,
  writebackNow
} from '../crdt-writeback'
import { FullSyncRunner, type FullSyncActions } from './full-sync-runner'
import { SYNC_STATE_KEYS, type SyncContext } from './sync-context'
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

/** The server's state for a note: one update per note, so a re-merge is a no-op. */
const serverStates = new Map<string, Uint8Array>()
function serverUpdate(noteId: string, body: string): Uint8Array {
  const known = serverStates.get(noteId)
  if (known) return known
  const doc = new Y.Doc()
  doc.getText('body').insert(0, body)
  const update = Y.encodeStateAsUpdate(doc)
  serverStates.set(noteId, update)
  return update
}

function packedUpdate(noteId: string, body: string): Uint8Array {
  return encryptCrdtUpdate(serverUpdate(noteId, body), vaultKey, noteId, peer.privateKey)
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

/**
 * One device's durable state: its data DB, its CRDT store (docs and snapshot
 * watermarks) and its vault. A crash is a run whose pull throws; the next run
 * starts from whatever the previous one left here.
 */
interface Device {
  db: TestDatabaseResult
  docs: Map<string, Y.Doc>
  watermarks: Map<string, { appliedSequence: number; snapshotRevision?: string }>
  /** Notes the settle owed a whole-body walk. */
  owed: string[]
  provider: {
    /** `null`: the store failed to open and the provider runs in memory. */
    storeId: string | null
    materialize: (noteId: string) => Promise<boolean>
    applyRemoteUpdate: (noteId: string, update: Uint8Array) => boolean
  }
  /** Whether `oweWholeBody` manages to persist its debt. */
  debtDurable: boolean
  abortController: AbortController
}

const devices: Device[] = []

function makeDevice(
  options: {
    materializeFails?: (noteId: string) => boolean
    onMaterialize?: (noteId: string) => void
  } = {}
): Device {
  const db = createTestDataDb()
  db.db
    .insert(syncDevices)
    .values({
      id: 'peer',
      name: 'peer',
      platform: 'macos',
      appVersion: '1',
      linkedAt: new Date(),
      signingPublicKey: sodium.to_base64(peer.publicKey, sodium.base64_variants.ORIGINAL)
    })
    .run()
  const docs = new Map<string, Y.Doc>()
  const watermarks: Device['watermarks'] = new Map()
  const docFor = (noteId: string): Y.Doc => {
    const existing = docs.get(noteId)
    if (existing) return existing
    const doc = new Y.Doc()
    // What `CrdtProvider.onDocUpdate` does with a network-origin update.
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === 'network') scheduleWriteback(noteId, doc, 'remote')
    })
    docs.set(noteId, doc)
    return doc
  }
  const provider = {
    storeId: 'store-1' as string | null,
    inactiveDocCapacity: 32,
    getSnapshotWatermark: async (noteId: string) => watermarks.get(noteId) ?? null,
    putSnapshotWatermark: async (
      noteId: string,
      watermark: { appliedSequence: number; snapshotRevision?: string }
    ) => {
      watermarks.set(noteId, watermark)
    },
    open: async (noteId: string) => docFor(noteId),
    applyRemoteUpdate: (noteId: string, update: Uint8Array) => {
      Y.applyUpdate(docFor(noteId), update, 'network')
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
      watermarks.delete(noteId)
    },
    // `CrdtProvider.materialize`: open the doc, write it back now.
    materialize: async (noteId: string) => {
      if (options.materializeFails?.(noteId)) throw new Error('process killed mid-settle')
      options.onMaterialize?.(noteId)
      const doc = docFor(noteId)
      if (Y.encodeStateVector(doc).length <= 2) return false
      await writebackNow(noteId, doc)
      return true
    }
  }
  const device = {
    db,
    docs,
    watermarks,
    owed: [] as string[],
    provider,
    debtDurable: true,
    abortController: new AbortController()
  }
  devices.push(device)
  return device
}

async function runSync(
  device: Device,
  options: {
    fresh: boolean
    packed: Array<{ id: string; body: string }>
    pull: () => Promise<boolean>
    /** The process dies at the end of the run: armed write-backs die with it. */
    killed?: boolean
  }
): Promise<void> {
  mocks.runPackBootstrap.mockImplementation(async (deps: PackBootstrapDeps) => {
    for (const [index, { id, body }] of options.packed.entries()) {
      const meta = { sequenceNum: index + 1, revision: `r${index + 1}` }
      if (await deps.snapshots.shouldApply(id, meta)) {
        await deps.snapshots.apply(id, packedUpdate(id, body), meta)
      }
    }
    return {
      usedPacks: true,
      packsApplied: 1,
      entriesApplied: options.packed.length,
      entriesSkipped: 0,
      entriesFailed: 0,
      appliedThroughCursor: 100
    }
  })

  const ctx = {
    deps: {
      db: device.db.db,
      queue: { getPendingCount: () => 0, purgeOldErrors: vi.fn() },
      network: { online: true },
      ws: { connected: true, connectionGeneration: 1 },
      getAccessToken: async () => 'token',
      getVaultKey: async () => new Uint8Array(vaultKey),
      getSigningKeys: async () => null,
      emitToRenderer: vi.fn(),
      crdtProvider: device.provider
    },
    applier: { changedCount: 0 },
    acquireLock: async () => () => {},
    releaseLock: vi.fn(),
    fullSyncActive: false,
    abortController: device.abortController
  } as unknown as SyncContext

  const runner = new FullSyncRunner(
    ctx,
    {
      // The device's own sync_state, so what one run writes the next one reads.
      getStateValue: (key: string) => {
        if (key === SYNC_STATE_KEYS.LAST_CURSOR) return options.fresh ? undefined : '500'
        return device.db.db.select().from(syncState).where(eq(syncState.key, key)).get()?.value
      },
      setStateValue: (key: string, value: string) => {
        device.db.db
          .insert(syncState)
          .values({ key, value, updatedAt: new Date() })
          .onConflictDoUpdate({ target: syncState.key, set: { value } })
          .run()
      },
      deleteStateValue: (key: string) => {
        device.db.db.delete(syncState).where(eq(syncState.key, key)).run()
      },
      isPaused: () => false,
      recordHistory: vi.fn(),
      updateLastSyncAt: vi.fn()
    } as unknown as SyncStateManager,
    { clearPendingAfterFullSync: vi.fn() } as unknown as PushCoordinator,
    {
      addPendingPull: vi.fn(),
      drainPendingPulls: () => [],
      pendingPullCount: 0,
      nextDeferredPullAt: () => null,
      oweWholeBody: (noteId: string) => {
        device.owed.push(noteId)
        return device.debtDurable
      }
    } as unknown as CrdtSyncCoordinator,
    { pull: options.pull, push: async () => {}, scheduleSync: vi.fn() } satisfies FullSyncActions
  )

  await runner.run().catch(() => {})
  if (options.killed) cancelPendingWritebacks()
  else await flushPendingWritebacks()
}

async function runFreshDeviceSync(scenario: Scenario): Promise<Outcome> {
  const device = makeDevice()
  await runSync(device, {
    fresh: true,
    packed: scenario.packed,
    pull: async () => {
      // The pack phase takes seconds on a real vault, so the write-backs its
      // applies armed (500ms debounce) fire before the first record page.
      await flushPendingWritebacks()
      for (const record of scenario.pulled) applyRecord(record, device.docs)
      return true
    }
  })

  return {
    files: readVault(mocks.vaultRoot),
    rows: Object.fromEntries([...mocks.rows.values()].map((row) => [row.id, row.path])),
    reminders: [...mocks.reminders.keys()].sort(),
    docs: [...device.docs.keys()].sort(),
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
    serverStates.clear()
    resetWritebackState()
  })

  afterEach(() => {
    cancelPendingWritebacks()
    fs.rmSync(mocks.vaultRoot, { recursive: true, force: true })
    for (const device of devices.splice(0)) device.db.close()
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

  // A crash or kill between pack apply and the end of the settle must not
  // strand a live note: its record walk merges nothing the doc lacks, so no
  // write-back is ever armed for it again.
  describe('when the run that applied the packs dies before its settle finishes', () => {
    const live = { id: 'livenote0001', body: 'Live note body' }
    const dead = { id: 'deletednote1', body: 'Deleted note body' }

    it('settles the packed docs on the next run that delivers a pull', async () => {
      const device = makeDevice()

      await runSync(device, {
        fresh: true,
        packed: [live, dead],
        pull: async () => {
          applyRecord(
            { op: 'upsert', type: 'note', id: live.id, title: 'Plans', content: '' },
            device.docs
          )
          device.provider.applyRemoteUpdate(live.id, serverUpdate(live.id, live.body))
          throw new Error('process killed after the record pages committed')
        },
        killed: true
      })
      await runSync(device, {
        fresh: false,
        packed: [],
        pull: async () => {
          device.provider.applyRemoteUpdate(live.id, serverUpdate(live.id, live.body))
          return true
        }
      })

      expect({
        files: readVault(mocks.vaultRoot),
        docs: [...device.docs.keys()],
        watermarks: [...device.watermarks.keys()]
      }).toEqual({
        files: { 'Plans.md': 'Live note body' },
        docs: [live.id],
        watermarks: [live.id]
      })
    })

    it('finishes a settle the previous run left half done', async () => {
      const second = { id: 'livenote0002', body: 'Second body' }
      let killed = true
      const device = makeDevice({ materializeFails: (id) => killed && id === second.id })
      const pullRecords = async (): Promise<boolean> => {
        for (const note of [live, second]) {
          applyRecord(
            { op: 'upsert', type: 'note', id: note.id, title: note.id, content: '' },
            device.docs
          )
        }
        return true
      }

      await runSync(device, {
        fresh: true,
        packed: [live, second, dead],
        pull: pullRecords,
        killed: true
      })
      killed = false
      await runSync(device, { fresh: false, packed: [], pull: async () => true })

      expect(readVault(mocks.vaultRoot)).toEqual({
        'livenote0001.md': 'Live note body',
        'livenote0002.md': 'Second body'
      })
      expect([...device.docs.keys()].sort()).toEqual([live.id, second.id])
    })

    it('keeps the packed docs through a pull that does not deliver', async () => {
      const device = makeDevice()

      await runSync(device, { fresh: true, packed: [live], pull: async () => false })
      const kept = { docs: [...device.docs.keys()], watermarks: [...device.watermarks.keys()] }
      await runSync(device, {
        fresh: false,
        packed: [],
        pull: async () => {
          applyRecord(
            { op: 'upsert', type: 'note', id: live.id, title: 'Plans', content: '' },
            device.docs
          )
          return true
        }
      })

      expect(kept).toEqual({ docs: [live.id], watermarks: [live.id] })
      expect(readVault(mocks.vaultRoot)).toEqual({ 'Plans.md': 'Live note body' })
    })

    it('never writes a doc that lost its packed state, and owes it a whole-body walk', async () => {
      const device = makeDevice()

      await runSync(device, {
        fresh: true,
        packed: [live],
        pull: async () => {
          await flushPendingWritebacks()
          applyRecord(
            { op: 'upsert', type: 'note', id: live.id, title: 'Plans', content: 'Record body' },
            device.docs
          )
          // The store answers with nothing for the doc on reopen.
          device.docs.delete(live.id)
          return true
        }
      })

      expect({ files: readVault(mocks.vaultRoot), owed: device.owed }).toEqual({
        files: { 'Plans.md': 'Record body' },
        owed: [live.id]
      })
    })
  })

  describe('a settle that cannot finish keeps its markers', () => {
    const live = { id: 'livenote0001', body: 'Live note body' }
    const second = { id: 'livenote0002', body: 'Second body' }

    const markers = (device: Device): string[] =>
      device.db.db
        .select({ key: syncState.key })
        .from(syncState)
        .all()
        .map((row) => row.key)
        .filter((key) => key.startsWith('packSeed'))
        .sort()

    const packThenDie = async (device: Device, packed: Array<typeof live>): Promise<void> => {
      await runSync(device, {
        fresh: true,
        packed,
        pull: async () => {
          for (const note of packed) {
            applyRecord(
              { op: 'upsert', type: 'note', id: note.id, title: note.id, content: '' },
              device.docs
            )
          }
          throw new Error('process killed after the record pages committed')
        },
        killed: true
      })
    }

    it('does not settle against an in-memory store, and settles once the real one is back', async () => {
      const device = makeDevice()
      await packThenDie(device, [live])
      const realDocs = new Map(device.docs)

      device.provider.storeId = null
      device.docs.clear()
      await runSync(device, { fresh: false, packed: [], pull: async () => true })
      const inMemory = { owed: [...device.owed], markers: markers(device) }

      device.provider.storeId = 'store-1'
      for (const [id, doc] of realDocs) device.docs.set(id, doc)
      await runSync(device, { fresh: false, packed: [], pull: async () => true })

      expect(inMemory).toEqual({
        owed: [],
        markers: ['packSeedSettlePending', 'packSeeded:livenote0001']
      })
      expect(readVault(mocks.vaultRoot)).toEqual({ 'livenote0001.md': 'Live note body' })
      expect(markers(device)).toEqual([])
    })

    it('stops at the next doc once the run is aborted, and the next run settles the rest', async () => {
      let abortAfterFirst = true
      const device = makeDevice({
        onMaterialize: () => {
          if (abortAfterFirst) device.abortController.abort()
        }
      })
      await packThenDie(device, [live, second])

      await runSync(device, { fresh: false, packed: [], pull: async () => true })
      const afterAbort = markers(device)
      abortAfterFirst = false
      device.abortController = new AbortController()
      await runSync(device, { fresh: false, packed: [], pull: async () => true })

      expect(afterAbort).toEqual(['packSeedSettlePending', 'packSeeded:livenote0002'])
      expect(readVault(mocks.vaultRoot)).toEqual({
        'livenote0001.md': 'Live note body',
        'livenote0002.md': 'Second body'
      })
      expect(markers(device)).toEqual([])
    })

    it('keeps the marker when the whole-body debt could not be persisted', async () => {
      const device = makeDevice()
      await packThenDie(device, [live])
      device.docs.delete(live.id)
      device.debtDurable = false

      await runSync(device, { fresh: false, packed: [], pull: async () => true })

      expect(markers(device)).toEqual(['packSeedSettlePending', 'packSeeded:livenote0001'])
    })
  })
})
