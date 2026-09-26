import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

const state = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('../crypto', () => ({ deleteKey: vi.fn(async () => {}) }))
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
vi.mock('../ipc/sync-core-handlers', () => ({ clearInMemoryAuthState: vi.fn() }))
vi.mock('../database/client', () => ({
  isDatabaseInitialized: () => true,
  getDatabase: () => state.db
}))
vi.mock('../store', () => ({ store: { set: vi.fn() } }))
vi.mock('../calendar/google/oauth', () => ({
  disconnectGoogleCalendar: vi.fn(),
  listGoogleAccountIds: () => []
}))
vi.mock('../calendar/google/sync-service', () => ({ stopGoogleCalendarSyncRunner: vi.fn() }))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { teardownSession } from './session-teardown'

/**
 * Sign-out keeps the per-vault CRDT store, so it must keep the pack settle
 * markers that describe it (#2462 F5). Wiped, a packed body that landed
 * during the first sync is never written to its file: the next sign-in sees
 * a current watermark and does not re-offer the pack.
 */
describe('sign-out and the pack settle markers', () => {
  let dataDb: TestDatabaseResult

  beforeEach(() => {
    dataDb = createTestDataDb()
    state.db = dataDb.db
  })

  afterEach(() => {
    state.db = null
    dataDb.close()
  })

  it('keeps packSeeded markers and the settle flag, and wipes the rest of sync_state', async () => {
    const now = new Date()
    dataDb.db
      .insert(syncState)
      .values([
        { key: 'lastCursor', value: '500', updatedAt: now },
        { key: 'packsAppliedThroughCursor', value: '400', updatedAt: now },
        { key: 'packSeedSettlePending', value: '1', updatedAt: now },
        { key: 'packSeeded:livenote0001', value: '1', updatedAt: now },
        { key: 'packSeeded:j2026-09-26', value: '1', updatedAt: now }
      ])
      .run()

    await teardownSession('logout')

    const keys = dataDb.db
      .select({ key: syncState.key })
      .from(syncState)
      .all()
      .map((row) => row.key)
      .sort()
    expect(keys).toEqual([
      'packSeedSettlePending',
      'packSeeded:j2026-09-26',
      'packSeeded:livenote0001'
    ])
  })
})
