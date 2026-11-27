import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'

const state = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('../crypto', () => ({ deleteKey: vi.fn(async () => {}) }))
vi.mock('./runtime-state', async () => await import('./runtime'))
vi.mock('./runtime', () => ({ stopSyncRuntime: vi.fn(async () => {}) }))
vi.mock('./token-manager', () => ({
  resetTokenManagerState: vi.fn(),
  getValidAccessToken: vi.fn(async () => null)
}))
vi.mock('./linking-service', () => ({
  clearPendingSession: vi.fn(),
  clearPendingLinkCompletion: vi.fn()
}))
vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({ initPersistence: vi.fn(async () => {}) })
}))
vi.mock('../ipc/in-memory-auth-state', () => ({ clearInMemoryAuthState: vi.fn() }))
vi.mock('../database/client', () => ({
  isDatabaseInitialized: () => true,
  getDatabase: () => state.db
}))
vi.mock('../store', () => ({ store: { set: vi.fn() } }))
vi.mock('../calendar/google/oauth', () => ({
  disconnectGoogleCalendar: vi.fn(),
  listGoogleAccountIds: () => []
}))
vi.mock('../calendar/google/google-sync-runner', () => ({
  startGoogleCalendarSyncRunner: vi.fn(async () => {}),
  stopGoogleCalendarSyncRunner: vi.fn()
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { teardownSession } from './session-teardown'
import { recoverDirtyItems } from './dirty-recovery'

/**
 * Sign-out wipes the session's `sync_state` and keeps the device-local facts
 * that outlive it. The pack settle markers describe the per-vault CRDT store,
 * which sign-out keeps (#2462 F5): wiped, a packed body that landed during the
 * first sync is never written to its file. The journal clock era dates this
 * vault's upgrade (#5659): re-dated at the next sign-in, it would read an edit
 * made before the sign-out as an older build's. An owed journal day merge
 * holds a displaced holder's tags and text until its drain (#5699). The CRDT
 * store epoch and its debt flag describe the kept store (#2299), and the case
 * twin holds, cover markers and upload refusals describe this device's files
 * (#5754).
 */
describe('sign-out and the device-local sync state', () => {
  let dataDb: TestDatabaseResult

  beforeEach(() => {
    dataDb = createTestDataDb()
    state.db = dataDb.db
  })

  afterEach(() => {
    state.db = null
    dataDb.close()
  })

  // One row per key: [key, kept]. A kept key describes this device's files or
  // stores; a wiped one describes the server session.
  const rows: readonly (readonly [string, boolean])[] = [
    ['packSeedSettlePending', true],
    ['packSeeded:livenote0001', true],
    ['packSeeded:j2026-09-26', true],
    ['journalClockEra', true],
    ['journalDayMerge:jforeign', true],
    ['crdtStoreEpoch', true],
    ['crdtUnmergedDebt', true],
    ['crdtBodyDebtMirrorAt', true],
    ['caseTwinForeignBytes', true],
    ['caseTwinForeignBytes:twin-a', true],
    ['caseTwinHeldChanges', true],
    ['caseTwinLandedHashes', true],
    ['caseTwinKeptCopies', true],
    ['note-cover:note-1', true],
    ['attachmentUploadRefusals', true],
    ['lastCursor', false],
    ['lastSyncAt', false],
    ['syncPaused', false],
    ['initialSeedDone', false],
    ['bootstrapPending', false],
    ['quarantinedItems', false],
    ['lastManifestCheckAt', false],
    ['packsAppliedThroughCursor', false],
    ['recordPacksApplied', false],
    ['recordPacksUnresolved', false],
    ['cursorSkipRepair', false],
    ['schemaInvalidItems', false],
    ['declinedSyncRefs', false],
    ['noteBodyLegacySweep', false],
    ['noteBodyFeedCursor', false],
    ['binaryNoteTextBlobs', false],
    ['binarySyncedHash:note-1', false],
    ['sync.reviveHeal:note-1', false],
    ['sync.reviveHealTried:note-1', false],
    ['sync.binaryNoteRecordHeal:note-1:[]', false]
  ]

  it.each(rows)('sign-out keeps %s: %s', async (key, kept) => {
    dataDb.db.insert(syncState).values({ key, value: '1', updatedAt: new Date() }).run()

    await teardownSession('logout')

    const left = dataDb.db.select({ key: syncState.key }).from(syncState).all()
    expect(left).toEqual(kept ? [{ key }] : [])
  })

  it('re-clocks at the next sign-in a journal edit made in the era before the sign-out', async () => {
    dataDb.db
      .insert(syncState)
      .values({ key: 'journalClockEra', value: '2026-01-01T12:00:00.000Z', updatedAt: new Date() })
      .run()
    dataDb.db
      .insert(noteMetadata)
      .values({
        id: 'j2026-01-02',
        path: 'journal/2026-01-02.md',
        title: 'A journal',
        journalDate: '2026-01-02',
        createdAt: '2026-01-01T00:00:00Z',
        clock: { 'device-A': 1 },
        syncedAt: '2026-01-01T13:00:00.000Z',
        modifiedAt: '2026-01-01T14:00:00.000Z'
      })
      .run()

    await teardownSession('logout')
    const enqueued: string[] = []
    recoverDirtyItems(asClientDb(dataDb.db), {
      getLocal: (type: string) =>
        type === 'journal'
          ? {
              enqueueUpdate: (id: string) => enqueued.push(`reclock ${id}`),
              enqueueRecoveredUpdate: (id: string) => enqueued.push(`replay ${id}`)
            }
          : undefined
    } as unknown as Parameters<typeof recoverDirtyItems>[1])

    expect(enqueued).toEqual(['reclock j2026-01-02'])
  })
})
