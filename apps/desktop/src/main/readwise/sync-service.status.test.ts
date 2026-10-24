/**
 * The run status the pulling device writes for the other devices (#3477, D18),
 * through the real run engine and real databases. Only the network is stubbed.
 * The status leaves go out only when a run changed something or the error
 * state changed, so an unchanged hourly run sends nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { book, highlight } from '@memry/importers/readwise/fixtures'
import type { ReadwiseBook } from '@memry/importers/readwise'
import { markSyncIneligible, resetSyncDecision } from '@memry/sync-client/sync-eligibility'
import { ReadwiseStub, type StubBook } from '@tests/utils/readwise-stub'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultConfig, VaultStatus } from '@memry/contracts/vault-api'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import type * as RuntimeEffectsModule from '../notes/runtime-effects'
import type * as DomainModule from '../notes/domain'
import type * as ImportedNoteModule from '../import/_shared/imported-note'
import type * as UpdateEntryModule from '../journal/update-entry'
import type * as RuntimeEffectsModule2 from '../settings/runtime-effects'
import type * as SyncServiceModule from '../readwise/sync-service'
import type * as SecretsModule from '../readwise/secrets'
import type * as SettingsModule from '../readwise/settings'
import type * as RegistryModule from '../import/registry'

const mocks = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  imageFetch: vi.fn(),
  recordActivity: vi.fn(),
  fieldUpdates: [] as [string, unknown][]
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
vi.mock('../notes/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>()
  return { ...actual, updateNoteCommand: vi.fn(actual.updateNoteCommand) }
})
vi.mock('../import/_shared/imported-note', async (importOriginal) => {
  const actual = await importOriginal<typeof ImportedNoteModule>()
  return { ...actual, createImportedNote: vi.fn(actual.createImportedNote) }
})
vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  enqueueJournalUpdate: vi.fn(),
  enqueueJournalDelete: vi.fn(),
  initializeJournalCrdt: vi.fn(async () => {}),
  feedJournalBodyToCrdt: vi.fn(async () => {})
}))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('../journal/update-entry', async (importOriginal) => {
  const actual = await importOriginal<typeof UpdateEntryModule>()
  return {
    ...actual,
    updateJournalEntry: vi.fn(actual.updateJournalEntry),
    appendToJournalEntry: vi.fn(actual.appendToJournalEntry)
  }
})
vi.mock('../settings/runtime-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEffectsModule2>()),
  syncSettingsFieldUpdate: (path: string, value: unknown) => {
    mocks.fieldUpdates.push([path, value])
  }
}))
vi.mock('../vault/activity-log', () => ({ recordActivity: mocks.recordActivity }))
vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainLog: vi.fn(), trackMainError: vi.fn() }))

const TOKEN = 'rw-test-token'

const stubBook = (id: number, over: Partial<ReadwiseBook> = {}) =>
  ({ ...book(id, over), highlights: over.highlights ?? [] }) as StubBook
const PNG = new Uint8Array([137, 80, 78, 71]).buffer

/** Readwise server times. `t(1)` is the first of October 2026, 10:00 UTC. */
const t = (day: number, hour = 10) =>
  `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`

/** A highlight made on `day` (October 2026) at `hour` UTC, that Readwise updated on `updatedDay`. */
function hl(id: number, location: number, day: number, updatedDay = day, hour = 12) {
  return highlight(id, {
    text: `Highlight ${id}`,
    location,
    highlighted_at: t(day, hour),
    created_at: t(day, hour),
    updated_at: t(updatedDay)
  })
}

describe('Readwise run status for other devices', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let engine: typeof SyncServiceModule
  let domain: typeof DomainModule
  let secrets: typeof SecretsModule
  let settings: typeof SettingsModule
  let imported: typeof ImportedNoteModule
  let registry: typeof RegistryModule
  let readwise: ReadwiseStub

  const db = () => asClientDb(dataDb.db)
  const resetWrites = () => {
    vi.mocked(domain.updateNoteCommand).mockClear()
    vi.mocked(imported.createImportedNote).mockClear()
  }

  beforeEach(async () => {
    vault = createTestVault('readwise-sync')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    mocks.secrets.clear()
    // Sync off: no claim, this device pulls (D8). The gate itself is tested in pull-gate.test.ts.
    markSyncIneligible()
    mocks.recordActivity.mockClear()
    mocks.fieldUpdates.length = 0
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
      journalDateFormat: 'YYYY-MM-DD'
    } satisfies VaultConfig)
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])

    engine = await import('../readwise/sync-service')
    domain = await import('../notes/domain')
    secrets = await import('../readwise/secrets')
    settings = await import('../readwise/settings')
    imported = await import('../import/_shared/imported-note')
    registry = await import('../import/registry')
    const { readwiseImporter } = await import('../import/readwise/readwise-importer')
    registry.__resetRegistry()
    registry.registerImporter(readwiseImporter)
    resetWrites()
    await secrets.setReadwiseToken(vault.path, TOKEN)
  })

  afterEach(async () => {
    resetSyncDecision()
    await stopProjectionRuntime()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  /** One run of the shared engine, as the dialog and the scheduler start it. */
  async function sync(service?: InstanceType<typeof engine.ReadwiseSyncService>) {
    return (service ?? engine.getReadwiseSyncService()).run(TOKEN, {
      signal: new AbortController().signal,
      book: () => {}
    })
  }

  const statusWrites = () =>
    mocks.fieldUpdates.filter(([path]) => path.startsWith('readwise.status.'))
  const status = () => (settings.readReadwiseGroup(db()).status ?? {}) as Record<string, unknown>

  it('writes lastChangeAt when a run changed something, and nothing when the next run changes nothing', async () => {
    readwise.books = [
      stubBook(1, { title: 'Deep Work', readable_title: 'Deep Work', highlights: [hl(11, 10, 1)] })
    ]
    await sync()
    expect(statusWrites().map(([path]) => path)).toEqual(['readwise.status.lastChangeAt'])
    const first = status().lastChangeAt
    expect(typeof first).toBe('string')

    mocks.fieldUpdates.length = 0
    await sync()
    expect(statusWrites()).toEqual([])
    expect(status().lastChangeAt).toBe(first)
  })

  it('writes the error code once when the token is rejected, then null once it works again', async () => {
    readwise.books = [stubBook(1, { highlights: [hl(11, 10, 1)] })]
    await sync()
    mocks.fieldUpdates.length = 0

    readwise.failWhen = () => 401
    await expect(sync()).rejects.toBeDefined()
    expect(statusWrites()).toEqual([['readwise.status.error', 'invalid-token']])

    mocks.fieldUpdates.length = 0
    await expect(sync()).rejects.toBeDefined()
    expect(statusWrites()).toEqual([])

    readwise.failWhen = null
    await sync()
    expect(statusWrites()).toEqual([['readwise.status.error', null]])
    expect(status().error).toBeNull()
  })
})
