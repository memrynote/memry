/**
 * One pulling device (#1417, D8), end to end: two devices on one account, each
 * with its own data DB and keychain, sharing the vault the way memry sync does.
 * The run engine, the note writer, the claim, the gate and the takeover are
 * real; the network (a stateful readwise.io, the image download, memry sync's
 * transport) is stubbed. Memry sync is a stand-in whose only observable is
 * whether a pull completed and whether the claim left the queue.
 */

import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { book, highlight } from '@memry/importers/readwise/fixtures'
import type { ReadwiseBook } from '@memry/importers/readwise'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { initSettingsSyncManager, resetSettingsSyncManager } from '@memry/sync-client/settings-sync'
import {
  markPullCompleted,
  markSyncEligible,
  markSyncIneligible,
  resetSyncDecision
} from '@memry/sync-client/sync-eligibility'
import { ReadwiseStub, type StubBook } from '@tests/utils/readwise-stub'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultConfig, VaultStatus } from '@memry/contracts/vault-api'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import type * as RuntimeEffectsModule from '../notes/runtime-effects'
import type * as DomainModule from '../notes/domain'
import type * as ImportedNoteModule from '../import/_shared/imported-note'
import type * as SyncServiceModule from './sync-service'
import type * as NotesModule from '../vault/notes'
import type * as SyncStateModule from './sync-state'
import type * as LinksRepositoryModule from './links-repository'
import type * as SecretsModule from './secrets'
import type * as ClaimModule from './claim'
import type * as SettingsModule from './settings'
import type * as ConnectionModule from './connection'
import type * as PullGateModule from './pull-gate'
import type { BookEvent } from './sync-service'

const mocks = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  imageFetch: vi.fn(),
  /** Memry sync's transport as the gate sees it. */
  syncEngine: null as null | {
    isCaughtUpWithServer: () => boolean
    requestPush: () => void
    hasQueuedItem: (id: string) => boolean
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  net: { fetch: mocks.imageFetch }
}))
vi.mock('../secrets/secret-storage', () => ({
  setSecret: async (service: string, account: string, value: string) => {
    mocks.secrets.set(`${service}/${account}`, value)
  },
  getSecret: async (service: string, account: string) =>
    mocks.secrets.get(`${service}/${account}`) ?? null,
  deleteSecret: async (service: string, account: string) => {
    mocks.secrets.delete(`${service}/${account}`)
  }
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn(() => Promise.resolve()) }))
vi.mock('../notes/runtime-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEffectsModule>()),
  syncNoteCreate: vi.fn(),
  syncNoteUpdate: vi.fn(),
  queueEmbeddedVaultFiles: vi.fn(),
  emitNoteAttachmentSaved: vi.fn()
}))
vi.mock('../sync/crdt-external-feed', () => ({
  feedExternalEditToCrdt: vi.fn(async () => true)
}))
vi.mock('../sync/runtime', () => ({ getSyncEngine: () => mocks.syncEngine }))
vi.mock('../notes/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>()
  return { ...actual, updateNoteCommand: vi.fn(actual.updateNoteCommand) }
})
vi.mock('../import/_shared/imported-note', async (importOriginal) => {
  const actual = await importOriginal<typeof ImportedNoteModule>()
  return { ...actual, createImportedNote: vi.fn(actual.createImportedNote) }
})
vi.mock('../vault/activity-log', () => ({ recordActivity: vi.fn() }))
vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainLog: vi.fn(), trackMainError: vi.fn() }))

const TOKEN = 'rw-test-token'
const PNG = new Uint8Array([137, 80, 78, 71]).buffer

const t = (day: number, hour = 10) =>
  `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`
const hl = (id: number, location: number, day: number) =>
  highlight(id, {
    text: `Highlight ${id}`,
    location,
    created_at: t(day),
    updated_at: t(day)
  })
const stubBook = (id: number, over: Partial<ReadwiseBook> = {}) =>
  ({ ...book(id, over), highlights: over.highlights ?? [] }) as StubBook

interface Device {
  id: string
  name: string
  result: TestDatabaseResult
  queue: SyncQueueManager
}

describe('one pulling device', () => {
  let vault: TestVaultResult
  let indexDb: TestDatabaseResult
  let readwise: ReadwiseStub
  let deviceA: Device
  let deviceB: Device
  let current: Device
  let engine: typeof SyncServiceModule
  let domain: typeof DomainModule
  let notes: typeof NotesModule
  let imported: typeof ImportedNoteModule
  let state: typeof SyncStateModule
  let links: typeof LinksRepositoryModule
  let secrets: typeof SecretsModule
  let claim: typeof ClaimModule
  let settings: typeof SettingsModule
  let connection: typeof ConnectionModule
  let gate: typeof PullGateModule

  const db = () => asClientDb(current.result.db)
  const writes = () =>
    vi.mocked(domain.updateNoteCommand).mock.calls.length +
    vi.mocked(imported.createImportedNote).mock.calls.length
  const resetWrites = () => {
    vi.mocked(domain.updateNoteCommand).mockClear()
    vi.mocked(imported.createImportedNote).mockClear()
  }
  const noteFiles = () =>
    (fs.readdirSync(vault.path, { recursive: true }) as string[]).filter((file) =>
      file.endsWith('.md')
    )
  const noteFor = async (bookId: number) =>
    (await notes.getNoteById(links.getLinkByBookId(db(), bookId)!.noteId))!

  /** Makes `device` the running app: its data DB, its settings sync, its sync identity. */
  async function switchDevice(device: Device) {
    current = device
    const database = await import('../database')
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(device.result.db))
    initSettingsSyncManager({
      db: asSyncDb(device.result.db),
      queue: device.queue,
      getDeviceId: () => device.id
    })
  }

  function createDevice(id: string, name: string): Device {
    const result = createTestDataDb()
    result.db
      .insert(syncDevices)
      .values({
        id,
        name,
        platform: 'macos',
        appVersion: '1.0.0',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'key'
      })
      .run()
    return { id, name, result, queue: new SyncQueueManager(asClientDb(result.db)) }
  }

  /** Memry sync is on, and a pull has completed since launch. */
  function syncOn(pulled = true) {
    markSyncEligible()
    if (pulled) markPullCompleted()
    mocks.syncEngine = {
      isCaughtUpWithServer: () => true,
      // The push delivers the settings row, so it leaves the queue.
      requestPush: () => setTimeout(() => current.queue.removeByItemId('synced_settings'), 50),
      hasQueuedItem: (id) => current.queue.hasPendingItem(id)
    }
  }

  beforeEach(async () => {
    vault = createTestVault('readwise-takeover')
    indexDb = createTestIndexDb()
    mocks.secrets.clear()
    mocks.syncEngine = null
    mocks.imageFetch.mockReset()
    mocks.imageFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'Content-Type' ? 'image/png' : null) },
      arrayBuffer: async () => PNG
    }))
    readwise = new ReadwiseStub()
    vi.stubGlobal('fetch', vi.fn(readwise.handle))

    const vaultIndex = await import('../vault/index')
    const database = await import('../database')
    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: vault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    } satisfies VaultStatus)
    vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
      excludePatterns: ['.git', 'node_modules', '.trash'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments',
      journalDateFormat: 'yyyy-MM-dd'
    } satisfies VaultConfig)
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])

    engine = await import('./sync-service')
    domain = await import('../notes/domain')
    notes = await import('../vault/notes')
    imported = await import('../import/_shared/imported-note')
    state = await import('./sync-state')
    links = await import('./links-repository')
    secrets = await import('./secrets')
    claim = await import('./claim')
    settings = await import('./settings')
    connection = await import('./connection')
    gate = await import('./pull-gate')

    deviceA = createDevice('dev-a', 'Desk Mac')
    deviceB = createDevice('dev-b', 'Laptop')
    await switchDevice(deviceA)
    resetWrites()
    await secrets.setReadwiseToken(vault.path, TOKEN)
    markSyncIneligible()
  })

  afterEach(async () => {
    resetSyncDecision()
    resetSettingsSyncManager()
    await stopProjectionRuntime()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    indexDb.close()
    deviceA.result.close()
    deviceB.result.close()
    vault.cleanup()
  })

  async function sync(over: { onBook?: () => void } = {}) {
    const events: BookEvent[] = []
    const result = await engine.getReadwiseSyncService().run(TOKEN, {
      signal: new AbortController().signal,
      book: (event) => {
        events.push(event)
        over.onBook?.()
      }
    })
    return { result, events }
  }

  function library() {
    readwise.books = [
      stubBook(1, {
        title: 'Deep Work',
        readable_title: 'Deep Work',
        highlights: [hl(11, 10, 1), hl(12, 20, 2)]
      }),
      stubBook(2, {
        title: 'Atomic Habits',
        readable_title: 'Atomic Habits',
        highlights: [hl(21, 10, 1)]
      }),
      stubBook(3, { title: 'Walden', readable_title: 'Walden', highlights: [hl(31, 10, 1)] })
    ]
  }

  describe('adoption on takeover (D8)', () => {
    it('a note device A created and memry sync delivered is adopted by readwise_url, not duplicated, when B runs', async () => {
      library()
      await sync()
      await flushProjectionEvents()
      const filesAfterA = noteFiles().toSorted()
      const noteIds = [1, 2, 3].map((id) => links.getLinkByBookId(db(), id)!.noteId)
      expect(filesAfterA).toHaveLength(3)

      // B: its own data DB, so no links, no cursor and no retry list. The vault is the one memry sync delivered.
      await switchDevice(deviceB)
      expect(state.getCursor(db())).toBeNull()
      resetWrites()

      const { result, events } = await sync()

      expect(noteFiles().toSorted()).toEqual(filesAfterA)
      expect(writes()).toBe(0)
      expect(result).toMatchObject({ added: 0, updated: 0, appended: 0, failed: 0 })
      expect(events.map((e) => e.result)).toEqual(['unchanged', 'unchanged', 'unchanged'])
      expect([1, 2, 3].map((id) => links.getLinkByBookId(db(), id)!.noteId)).toEqual(noteIds)
      // The takeover's first run was a full export, with no window.
      expect(readwise.requests.every((u) => !u.searchParams.has('updatedAfter'))).toBe(true)
    })

    it('a section the user edited gets only the highlights after `last`, and the edit stays', async () => {
      library()
      await sync()
      const note = await noteFor(1)
      await notes.updateNote({
        id: note.id,
        content: note.content.replace('Highlight 11', 'Highlight 11 — my own thought')
      })
      await flushProjectionEvents()
      readwise.books[0].highlights.push(hl(13, 30, 5))

      await switchDevice(deviceB)
      resetWrites()
      await sync()

      const body = (await noteFor(1)).content
      expect(body).toContain('my own thought')
      expect(body.match(/Highlight 13/g)).toHaveLength(1)
      expect(body.match(/Highlight 11/g)).toHaveLength(1)
      expect(noteFiles()).toHaveLength(3)
    })
  })

  describe('the pull gate', () => {
    it('the laptop morning: B starts as the pulling device and reads nothing until memry sync has pulled', async () => {
      library()
      await sync()
      await flushProjectionEvents()
      await switchDevice(deviceB)
      syncOn(false)
      claim.writeClaim(db(), { deviceId: 'dev-b', deviceName: 'Laptop' })
      resetWrites()

      const before = readwise.requests.length
      const run = sync()
      await new Promise((resolve) => setTimeout(resolve, 900))
      expect(readwise.requests).toHaveLength(before)
      expect(writes()).toBe(0)

      // A's new books arrive with the pull, then the run reads Readwise.
      markPullCompleted()
      const { result } = await run

      expect(readwise.requests.length).toBeGreaterThan(before)
      expect(result).toMatchObject({ added: 0, updated: 0, appended: 0 })
      expect(noteFiles()).toHaveLength(3)
      expect(writes()).toBe(0)
    }, 15_000)

    it('a device another device claimed never reads Readwise', async () => {
      library()
      await switchDevice(deviceB)
      syncOn()
      claim.writeClaim(db(), { deviceId: 'dev-a', deviceName: 'Desk Mac' })
      const before = readwise.requests.length

      await expect(sync()).rejects.toMatchObject({ code: 'elsewhere', deviceName: 'Desk Mac' })

      expect(readwise.requests).toHaveLength(before)
      expect(noteFiles()).toHaveLength(0)
      expect(gate.canPull()).toBe(false)
    })

    it('with sync on and no claim the first run claims it, and waits until the claim is pushed', async () => {
      library()
      syncOn()
      expect(claim.readClaim(db()).deviceId).toBeNull()
      expect(gate.canPull()).toBe(true)
      // Read at the first Readwise request: the claim must have left the queue by then.
      let pendingAtFirstRequest: boolean | null = null
      readwise.failWhen = () => {
        pendingAtFirstRequest ??= current.queue.hasPendingItem('synced_settings')
        return null
      }

      await sync()

      expect(claim.readClaim(db())).toEqual({ deviceId: 'dev-a', deviceName: 'Desk Mac' })
      expect(pendingAtFirstRequest).toBe(false)
      // The run changed three notes, so its status is queued after the claim (#3477).
      expect(current.queue.hasPendingItem('synced_settings')).toBe(true)
      expect(noteFiles()).toHaveLength(3)
    })

    it('a claim written here but not yet pushed holds the run back, as after a timed-out takeover', async () => {
      library()
      syncOn()
      // Let the previous test's simulated push timer fire before this claim is queued.
      await new Promise((resolve) => setTimeout(resolve, 100))
      claim.writeClaim(db(), { deviceId: 'dev-a', deviceName: 'Desk Mac' })
      expect(current.queue.hasPendingItem('synced_settings')).toBe(true)
      mocks.syncEngine!.requestPush = () => undefined

      const before = readwise.requests.length
      const run = sync()
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(readwise.requests).toHaveLength(before)

      current.queue.removeByItemId('synced_settings')
      await run
      expect(noteFiles()).toHaveLength(3)
    })

    it('with sync off there is no claim and the device pulls', async () => {
      library()
      markSyncIneligible()
      await sync()
      expect(claim.readClaim(db())).toEqual({ deviceId: null, deviceName: null })
      expect(noteFiles()).toHaveLength(3)
    })
  })

  describe('the old device', () => {
    it('stops at the next book once the claim changes, keeps what it wrote, and drops its token', async () => {
      library()
      syncOn()
      claim.writeClaim(db(), { deviceId: 'dev-a', deviceName: 'Desk Mac' })
      let books = 0

      const { result } = await sync({
        onBook: () => {
          // After the first book, the takeover's claim arrives through memry sync.
          if (++books === 1) {
            settings.applyMergedReadwiseSettings(db(), {
              syncDeviceId: 'dev-b',
              syncDeviceName: 'Laptop'
            })
          }
        }
      })

      expect(result).toMatchObject({ cancelled: true, claimLost: true, added: 1 })
      expect(noteFiles()).toHaveLength(1)
      // The cursor never moved, so a later takeover back reads everything.
      expect(state.getCursor(db())).toBeNull()
      await vi.waitFor(async () => expect(await secrets.getReadwiseToken(vault.path)).toBeNull())
      expect(state.getRetryList(db())).toEqual([])
    })

    it('drops its token when the claim arrives while it is idle', async () => {
      syncOn()
      claim.writeClaim(db(), { deviceId: 'dev-a', deviceName: 'Desk Mac' })
      settings.applyMergedReadwiseSettings(db(), {
        syncDeviceId: 'dev-b',
        syncDeviceName: 'Laptop'
      })
      state.setCursor(db(), '2026-10-03T09:59:59.000Z')

      const { releaseTokenIfClaimedElsewhere } = await import('./release')
      expect(await releaseTokenIfClaimedElsewhere()).toBe(true)

      expect(await secrets.getReadwiseToken(vault.path)).toBeNull()
      expect(state.getCursor(db())).toBeNull()
      expect(await releaseTokenIfClaimedElsewhere()).toBe(false)
    })

    it('keeps its token while it holds the claim', async () => {
      syncOn()
      claim.writeClaim(db(), { deviceId: 'dev-a', deviceName: 'Desk Mac' })
      const { releaseTokenIfClaimedElsewhere } = await import('./release')
      expect(await releaseTokenIfClaimedElsewhere()).toBe(false)
      expect(await secrets.getReadwiseToken(vault.path)).toBe(TOKEN)
    })
  })

  describe('takeover', () => {
    async function deviceBSeesClaimOnA() {
      await switchDevice(deviceB)
      claim.writeClaim(db(), { deviceId: 'dev-a', deviceName: 'Desk Mac' })
      // Written by memry sync's apply, not by this device's own edit.
      current.queue.removeByItemId('synced_settings')
      await secrets.deleteReadwiseToken(vault.path)
    }

    it('shows where Readwise syncs, and the takeover claims, stores the token, and resets the run state once the claim is pushed', async () => {
      await deviceBSeesClaimOnA()
      syncOn()
      state.setCursor(db(), '2026-10-01T00:00:00.000Z')
      expect(await connection.getReadwiseStatus()).toMatchObject({
        connected: false,
        thisDevicePulls: false,
        pullingDeviceName: 'Desk Mac'
      })

      const status = await connection.takeOverReadwise(TOKEN)

      expect(claim.readClaim(db())).toEqual({ deviceId: 'dev-b', deviceName: 'Laptop' })
      // Returned only after the push: the claim has left the queue.
      expect(current.queue.hasPendingItem('synced_settings')).toBe(false)
      expect(await secrets.getReadwiseToken(vault.path)).toBe(TOKEN)
      expect(state.getCursor(db())).toBeNull()
      expect(status).toMatchObject({ connected: true, thisDevicePulls: true, hasImported: false })
    })

    it('writes nothing while memry sync has not pulled, or is off', async () => {
      await deviceBSeesClaimOnA()
      syncOn(false)
      await expect(connection.takeOverReadwise(TOKEN)).rejects.toMatchObject({ code: 'not-ready' })
      expect(claim.readClaim(db()).deviceId).toBe('dev-a')
      expect(await secrets.getReadwiseToken(vault.path)).toBeNull()

      resetSyncDecision()
      markSyncIneligible()
      await expect(connection.takeOverReadwise(TOKEN)).rejects.toMatchObject({ code: 'needs-sync' })
      expect(claim.readClaim(db()).deviceId).toBe('dev-a')
    })

    it('rejects a token Readwise refuses before it touches the claim', async () => {
      await deviceBSeesClaimOnA()
      syncOn()
      readwise.failWhen = () => 401
      await expect(connection.takeOverReadwise('bad')).rejects.toThrow(/did not accept this token/)
      expect(claim.readClaim(db()).deviceId).toBe('dev-a')
    })

    it('connect does not run beside the pulling device, and disconnect frees Readwise', async () => {
      await deviceBSeesClaimOnA()
      syncOn()
      await expect(connection.connectReadwise(TOKEN)).rejects.toMatchObject({ code: 'elsewhere' })

      await connection.takeOverReadwise(TOKEN)
      await connection.disconnectReadwise()
      expect(claim.readClaim(db())).toEqual({ deviceId: null, deviceName: null })
      // Explicit null in the row, never a removed key (§13.4).
      expect(settings.readReadwiseGroup(db())).toHaveProperty('syncDeviceId', null)
    })

    it('a device that is not the claimant leaves the claim alone when it disconnects', async () => {
      await switchDevice(deviceB)
      syncOn()
      claim.writeClaim(db(), { deviceId: 'dev-a', deviceName: 'Desk Mac' })
      await connection.disconnectReadwise()
      expect(claim.readClaim(db()).deviceId).toBe('dev-a')
    })

    it('connecting with sync on and nobody holding Readwise claims it', async () => {
      syncOn()
      await secrets.deleteReadwiseToken(vault.path)
      await connection.connectReadwise(TOKEN)
      expect(claim.readClaim(db()).deviceId).toBe('dev-a')
    })
  })
})
