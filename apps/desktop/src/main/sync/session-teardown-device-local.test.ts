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
 * made before the sign-out as an older build's.
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

  it('keeps the pack settle markers and the journal clock era, and wipes the rest', async () => {
    const now = new Date()
    dataDb.db
      .insert(syncState)
      .values([
        { key: 'lastCursor', value: '500', updatedAt: now },
        { key: 'packsAppliedThroughCursor', value: '400', updatedAt: now },
        { key: 'packSeedSettlePending', value: '1', updatedAt: now },
        { key: 'packSeeded:livenote0001', value: '1', updatedAt: now },
        { key: 'packSeeded:j2026-09-26', value: '1', updatedAt: now },
        { key: 'journalClockEra', value: '2026-01-01T12:00:00.000Z', updatedAt: now }
      ])
      .run()

    await teardownSession('logout')

    const keys = dataDb.db
      .select({ key: syncState.key })
      .from(syncState)
      .all()
      .map((row) => row.key)
      .toSorted()
    expect(keys).toEqual([
      'journalClockEra',
      'packSeedSettlePending',
      'packSeeded:j2026-09-26',
      'packSeeded:livenote0001'
    ])
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
