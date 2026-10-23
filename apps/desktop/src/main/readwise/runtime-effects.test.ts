/**
 * The Readwise scheduler (#1416): the real shared minute tick on a fake clock,
 * the real run engine, a real data DB, and a stubbed readwise.io. The account is
 * empty (no highlights), so a run reads the export and writes nothing; the
 * scheduler's decisions show up as requests to the stub.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { ReadwiseStub } from '@tests/utils/readwise-stub'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb } from '../database/types'

let currentDb: DataDb | null = null
vi.mock('../database', () => ({ getDatabase: () => currentDb }))
vi.mock('../vault', () => ({ getStatus: () => ({ path: '/vaults/a' }) }))
vi.mock('electron', () => ({ net: { isOnline: () => true } }))
vi.mock('../sync/runtime', () => ({ getSyncEngine: () => ({ currentState: 'idle' }) }))
vi.mock('../vault/activity-log', () => ({ recordActivity: vi.fn() }))

const secrets = new Map<string, string>()
vi.mock('../secrets/secret-storage', () => ({
  setSecret: vi.fn(async (s: string, a: string, v: string) => void secrets.set(`${s}/${a}`, v)),
  getSecret: vi.fn(async (s: string, a: string) => secrets.get(`${s}/${a}`) ?? null),
  deleteSecret: vi.fn(async (s: string, a: string) => void secrets.delete(`${s}/${a}`))
}))

import { getMinuteTickIds, isMinuteTickRunning, MINUTE_TICK_INTERVAL_MS } from '../lib/minute-tick'
import { setSetting } from '../database/queries/settings'
import { ReadwiseSyncService } from './sync-service'
import { setReadwiseToken } from './secrets'
import { clearCursor, getCursor, getLastRun, setCursor } from './sync-state'
import {
  BACKOFF_BASE_MS,
  canPull,
  getReadwiseScheduler,
  READWISE_TICK_ID,
  startReadwiseScheduler,
  stopReadwiseScheduler,
  ReadwiseRunInProgressError,
  ReadwiseScheduler,
  ReadwiseUnavailableError
} from './runtime-effects'
import { connectReadwise, syncReadwiseNow } from './connection'

const MINUTE = MINUTE_TICK_INTERVAL_MS
const HOUR = 60 * MINUTE
const TOKEN = 'tok-schedule'

beforeAll(async () => {
  await sodium.ready
})

describe('ReadwiseScheduler', () => {
  let result: TestDatabaseResult
  let readwise: ReadwiseStub
  let scheduler: ReadwiseScheduler
  let online: boolean
  let pulls: boolean
  const db = () => currentDb as DataDb

  const makeScheduler = () =>
    new ReadwiseScheduler({
      now: () => Date.now(),
      isOnline: () => online,
      canPull: () => pulls,
      getService: () => service
    })
  let service: ReadwiseSyncService

  /** Export requests so far: one per run on an empty account. */
  const runs = () => readwise.requests.filter((u) => u.pathname === '/api/v2/export/').length
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
  const setCadence = (cadence: string) => setSetting(db(), 'readwise', JSON.stringify({ cadence }))

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T10:00:00Z'))
    result = createTestDataDb()
    currentDb = asClientDb(result.db)
    secrets.clear()
    online = true
    pulls = true
    readwise = new ReadwiseStub()
    vi.stubGlobal('fetch', vi.fn(readwise.handle))
    service = new ReadwiseSyncService()
    await setReadwiseToken('/vaults/a', TOKEN)
    // Imported once already: the scheduler never starts the first import.
    setCursor(db(), '2026-10-22T09:00:00.000Z')
    scheduler = makeScheduler()
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    currentDb = null
    result.close()
  })

  it('registers on the shared minute tick and adds no timer of its own', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    scheduler.start()

    expect(getMinuteTickIds()).toContain(READWISE_TICK_ID)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MINUTE_TICK_INTERVAL_MS)

    scheduler.stop()
    expect(getMinuteTickIds()).not.toContain(READWISE_TICK_ID)
    expect(isMinuteTickRunning()).toBe(false)
  })

  it('Hourly: syncs on launch, then not on the ticks in between, then each hour', async () => {
    scheduler.start()
    await advance(0)
    expect(runs()).toBe(1)

    await advance(30 * MINUTE)
    expect(runs()).toBe(1)
    await advance(30 * MINUTE)
    expect(runs()).toBe(2)
    await advance(HOUR)
    expect(runs()).toBe(3)
  })

  it('Daily: waits a day between runs, and the cadence is read from the stored setting', async () => {
    setCadence('daily')
    // A new scheduler, as after an app restart: the cadence comes from the database.
    scheduler = makeScheduler()
    scheduler.start()
    await advance(0)
    expect(runs()).toBe(1)

    await advance(23 * HOUR)
    expect(runs()).toBe(1)
    await advance(HOUR)
    expect(runs()).toBe(2)
  })

  it('Manual never starts a run on its own, not even at launch', async () => {
    setCadence('manual')
    scheduler.start()
    await advance(0)
    await advance(48 * HOUR)
    expect(runs()).toBe(0)
  })

  it('does not start the first import, which the dialog previews first', async () => {
    clearCursor(db())
    expect(getCursor(db())).toBeNull()
    scheduler.start()
    await advance(2 * HOUR)
    expect(runs()).toBe(0)
  })

  it('never runs without a token', async () => {
    secrets.clear()
    scheduler.start()
    await advance(2 * HOUR)
    expect(runs()).toBe(0)
  })

  it('never runs on a device that is not the pulling device', async () => {
    pulls = false
    scheduler.start()
    await advance(2 * HOUR)
    expect(runs()).toBe(0)

    pulls = true
    await advance(MINUTE)
    expect(runs()).toBe(1)
  })

  it('skips runs while offline and catches up when the network is back', async () => {
    online = false
    scheduler.start()
    await advance(3 * MINUTE)
    expect(runs()).toBe(0)

    online = true
    await advance(MINUTE)
    expect(runs()).toBe(1)
  })

  it('a 401 parks the schedule as needs-attention, and connecting again resumes it', async () => {
    readwise.failWhen = () => 401
    scheduler.start()
    await advance(0)
    expect(runs()).toBe(1)
    expect(getLastRun(db())?.needsAttention).toBe(true)

    await advance(6 * HOUR)
    expect(runs()).toBe(1)

    readwise.failWhen = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).pathname === '/api/v2/auth/'
          ? new Response(null, { status: 204 })
          : readwise.handle(input)
      )
    )
    await connectReadwise('fresh-token')
    expect(getLastRun(db())?.needsAttention).toBe(false)
    await advance(MINUTE)
    expect(runs()).toBe(2)
  })

  it('a network failure backs off, doubling, and never moves the cursor', async () => {
    const cursor = getCursor(db())
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: Parameters<typeof readwise.handle>) => {
        readwise.requests.push(new URL(args[0]))
        throw new TypeError('offline')
      })
    )
    scheduler.start()
    await advance(0)
    expect(runs()).toBe(1)

    await advance(BACKOFF_BASE_MS - MINUTE)
    expect(runs()).toBe(1)
    await advance(MINUTE)
    expect(runs()).toBe(2)

    // The second failure waits twice as long.
    await advance(2 * BACKOFF_BASE_MS - MINUTE)
    expect(runs()).toBe(2)
    await advance(MINUTE)
    expect(runs()).toBe(3)
    expect(getCursor(db())).toBe(cursor)
  })

  it('Sync now joins a run in progress instead of starting a second one', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        await gate
        return readwise.handle(input)
      })
    )

    const first = scheduler.syncNow()
    const second = scheduler.syncNow()
    await advance(10 * MINUTE)
    // A tick during the run starts nothing either.
    expect(scheduler.isRunning).toBe(true)
    release()
    const [a, b] = await Promise.all([first, second])

    expect(runs()).toBe(1)
    expect(a).toBe(b)
    expect(scheduler.isRunning).toBe(false)
  })

  it('Sync now runs at once on an empty account and writes nothing', async () => {
    setCadence('manual')
    const run = await scheduler.syncNow()

    expect(run).toMatchObject({ cancelled: false, books: 0, added: 0, updated: 0 })
    expect(runs()).toBe(1)
    expect(getLastRun(db())).toMatchObject({ needsAttention: false })
  })

  it('Sync now refuses without a token, off the pulling device, and beside a dialog run', async () => {
    secrets.clear()
    await expect(scheduler.syncNow()).rejects.toMatchObject({ reason: 'not-connected' })

    await setReadwiseToken('/vaults/a', TOKEN)
    pulls = false
    await expect(scheduler.syncNow()).rejects.toBeInstanceOf(ReadwiseUnavailableError)

    pulls = true
    vi.spyOn(service, 'isRunning', 'get').mockReturnValue(true)
    await expect(scheduler.syncNow()).rejects.toBeInstanceOf(ReadwiseRunInProgressError)
    expect(runs()).toBe(0)
  })

  it('until #1417 claims devices, the token holder pulls', () => {
    expect(canPull()).toBe(true)
  })

  it('the process scheduler starts on the shared tick, runs at launch, and stops', async () => {
    startReadwiseScheduler()
    expect(getMinuteTickIds()).toContain(READWISE_TICK_ID)
    const same = getReadwiseScheduler()
    expect(getReadwiseScheduler()).toBe(same)
    await advance(0)
    expect(runs()).toBe(1)

    stopReadwiseScheduler()
    expect(getMinuteTickIds()).not.toContain(READWISE_TICK_ID)
    expect(getReadwiseScheduler()).not.toBe(same)
    stopReadwiseScheduler()
  })

  it('a tick whose schedule check throws logs and starts nothing, then recovers', async () => {
    const original = currentDb
    currentDb = null
    scheduler.start()
    await advance(0)
    expect(runs()).toBe(0)

    currentDb = original
    await advance(MINUTE)
    expect(runs()).toBe(1)
  })

  describe('syncReadwiseNow (the sync-now IPC body)', () => {
    afterEach(() => stopReadwiseScheduler())

    it('answers a readable error for a revoked token, and marks needs-attention', async () => {
      readwise.failWhen = () => 401
      await expect(syncReadwiseNow()).rejects.toThrow(/did not accept this token/)
      expect(getLastRun(db())?.needsAttention).toBe(true)
    })

    it('answers the not-connected error without a token', async () => {
      secrets.clear()
      await expect(syncReadwiseNow()).rejects.toThrow(/not connected/)
    })

    it('answers the unavailable error on a device that does not pull', async () => {
      const sched = getReadwiseScheduler()
      vi.spyOn(sched, 'syncNow').mockRejectedValue(new ReadwiseUnavailableError('other-device'))
      await expect(syncReadwiseNow()).rejects.toThrow(/does not sync on this device/)
    })

    it('answers the in-progress error beside a dialog run', async () => {
      const sched = getReadwiseScheduler()
      vi.spyOn(sched, 'syncNow').mockRejectedValue(new ReadwiseRunInProgressError())
      await expect(syncReadwiseNow()).rejects.toThrow(/already running/)
    })

    it('rethrows an error that is not Readwise', async () => {
      const sched = getReadwiseScheduler()
      vi.spyOn(sched, 'syncNow').mockRejectedValue(new Error('disk gone'))
      await expect(syncReadwiseNow()).rejects.toThrow('disk gone')
    })
  })
})
