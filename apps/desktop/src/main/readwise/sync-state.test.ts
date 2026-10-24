import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import sodiumModule from 'libsodium-wrappers-sumo'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { SettingsSyncManager, resetSettingsSyncManager } from '@memry/sync-client/settings-sync'
import type { DataDb } from '../database/types'
import { setSetting } from '../database/queries/settings'
import { upsertLink } from './links-repository'
import {
  addRetry,
  clearRunState,
  getCursor,
  getLastRun,
  getFullPassPending,
  getReaderCursor,
  getRetryList,
  removeRetry,
  setCursor,
  setFullPassPending,
  setLastRun,
  setReaderCursor
} from './sync-state'

// Default import kept: tests mock this module with a default-only factory.
const sodium = sodiumModule

beforeAll(async () => {
  await sodium.ready
})

describe('readwise device-local state', () => {
  let result: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    result = createTestDataDb()
    db = asClientDb(result.db)
  })
  afterEach(() => {
    resetSettingsSyncManager()
    result.close()
  })
  afterAll(() => undefined)

  it('round-trips the cursor, the retry list, and the full-pass flag', () => {
    expect(getCursor(db)).toBeNull()
    expect(getReaderCursor(db)).toBeNull()
    expect(getRetryList(db)).toEqual([])
    expect(getFullPassPending(db)).toBe(false)

    setCursor(db, '2026-10-22T10:00:00.000Z')
    addRetry(db, 4, 'note-open')
    addRetry(db, 5, 'error')
    addRetry(db, 4, 'error')
    setFullPassPending(db, true)

    expect(getCursor(db)).toBe('2026-10-22T10:00:00.000Z')
    expect(getRetryList(db)).toEqual([
      { readwiseBookId: 4, reason: 'error', attempts: 2 },
      { readwiseBookId: 5, reason: 'error', attempts: 1 }
    ])
    expect(getFullPassPending(db)).toBe(true)

    removeRetry(db, 4)
    setFullPassPending(db, false)
    expect(getRetryList(db).map((e) => e.readwiseBookId)).toEqual([5])
    expect(getFullPassPending(db)).toBe(false)
  })

  it('treats an unreadable retry list as empty', () => {
    result.sqlite
      .prepare("INSERT INTO settings (key, value) VALUES ('readwise.retryList', '{bad')")
      .run()
    expect(getRetryList(db)).toEqual([])
  })

  it('keeps cursor, retry list, flag, and links out of the sync payload and queue', () => {
    const queue = new SyncQueueManager(asClientDb(result.db))
    const manager = new SettingsSyncManager({
      db: asSyncDb(result.db),
      queue,
      getDeviceId: () => 'device-A'
    })

    setCursor(db, '2026-10-22T10:00:00.000Z')
    setReaderCursor(db, '2026-10-21T10:00:00.000Z')
    expect(getReaderCursor(db)).toBe('2026-10-21T10:00:00.000Z')
    addRetry(db, 4, 'error')
    setFullPassPending(db, true)
    upsertLink(db, { readwiseBookId: 4, noteId: 'n1' })
    manager.updateField('general.theme', 'dark')

    expect(JSON.stringify(manager.getPayload()).toLowerCase()).not.toContain('readwise')
    const queued = result.sqlite.prepare('SELECT type, item_id FROM sync_queue').all()
    expect(queued).toEqual([expect.objectContaining({ type: 'settings' })])
    expect(JSON.stringify(queued)).not.toContain('readwise')
    expect(RECORD_SYNC_ITEM_TYPES.some((t) => t.includes('readwise'))).toBe(false)
  })
})

describe('readwise last run', () => {
  let result: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    result = createTestDataDb()
    db = asClientDb(result.db)
  })
  afterEach(() => result.close())

  it('round-trips, drops an unreadable value, and clears with the run state', () => {
    expect(getLastRun(db)).toBeNull()
    setLastRun(db, { at: '2026-10-22T10:00:00.000Z', needsAttention: true })
    expect(getLastRun(db)).toEqual({ at: '2026-10-22T10:00:00.000Z', needsAttention: true })

    setCursor(db, '2026-10-22T10:00:00.000Z')
    addRetry(db, 4, 'error')
    setFullPassPending(db, true)
    clearRunState(db)
    expect(getLastRun(db)).toBeNull()
    expect(getCursor(db)).toBeNull()
    expect(getRetryList(db)).toEqual([])
    expect(getFullPassPending(db)).toBe(false)

    setSetting(db, 'readwise.lastRun', '{nope')
    expect(getLastRun(db)).toBeNull()
  })
})
