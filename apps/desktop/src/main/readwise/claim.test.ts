/**
 * The Readwise claim (#1417, D8) through real settings sync: two devices, each
 * with its own data DB and settings manager, passing payloads the way the sync
 * server does. Only the transport is a function call.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { SyncedSettingsSchema } from '@memry/contracts/settings-sync'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  initSettingsSyncManager,
  resetSettingsSyncManager,
  getSettingsSyncManager
} from '@memry/sync-client/settings-sync'
import { mergeSettingsPayloads } from '@memry/sync-client/settings-merge'
import type { DataDb } from '../database/types'
import { getSetting, setSetting } from '../database/queries/settings'
import { addRetry, setCursor, setFullPassPending, setLastRun } from './sync-state'
import { upsertLink } from './links-repository'

let currentDb: DataDb | null = null
vi.mock('../database', () => ({
  getDatabase: () => {
    if (!currentDb) throw new Error('no vault')
    return currentDb
  }
}))

import { clearClaim, readClaim, writeClaim } from './claim'
import { pullAuthority, type PullEnv } from './pull-gate'
import { READWISE_SETTINGS_KEY, applyMergedReadwiseSettings } from './settings'

beforeAll(async () => {
  await sodium.ready
})

interface Device {
  id: string
  result: TestDatabaseResult
  db: DataDb
  queue: SyncQueueManager
}

describe('the Readwise claim travels with synced settings', () => {
  const devices: Device[] = []

  function createDevice(id: string): Device {
    const result = createTestDataDb()
    const device: Device = {
      id,
      result,
      db: asClientDb(result.db),
      queue: new SyncQueueManager(asClientDb(result.db))
    }
    devices.push(device)
    return device
  }

  /** The app on this device is the one running: its DB and its settings manager. */
  function use(device: Device) {
    currentDb = device.db
    return initSettingsSyncManager({
      db: asSyncDb(device.result.db),
      queue: device.queue,
      getDeviceId: () => device.id
    })
  }

  /** What settings sync does on a pull: merge the payload, then apply the merged group. */
  function receive(device: Device, from: Device): void {
    const payload = use(from).getPayload()
    const manager = use(device)
    manager.mergeRemote(payload)
    const merged = manager.getSettings().readwise
    if (merged) applyMergedReadwiseSettings(device.db, merged as Record<string, unknown>)
  }

  let a: Device
  let b: Device
  beforeEach(() => {
    a = createDevice('dev-a')
    b = createDevice('dev-b')
  })
  afterEach(() => {
    currentDb = null
    resetSettingsSyncManager()
    for (const device of devices.splice(0)) device.result.close()
  })

  it('a claim reaches the other device, and a takeover there supersedes it everywhere', () => {
    use(a)
    writeClaim(a.db, { deviceId: 'dev-a', deviceName: 'Desk Mac' })
    receive(b, a)
    expect(readClaim(b.db)).toEqual({ deviceId: 'dev-a', deviceName: 'Desk Mac' })

    use(b)
    writeClaim(b.db, { deviceId: 'dev-b', deviceName: 'Laptop' })
    receive(a, b)

    // B saw A's claim before it wrote its own, so its clock dominates: A loses.
    expect(readClaim(a.db)).toEqual({ deviceId: 'dev-b', deviceName: 'Laptop' })
    expect(pullAuthority(a.db, env({ deviceId: 'dev-a' }))).toEqual({
      state: 'elsewhere',
      deviceName: 'Laptop'
    })
  })

  it('disconnect clears the claim with an explicit null that reaches the other device', () => {
    use(a)
    writeClaim(a.db, { deviceId: 'dev-a', deviceName: 'Desk Mac' })
    receive(b, a)

    use(a)
    clearClaim(a.db)
    const payload = getSettingsSyncManager()!.getPayload()
    expect(payload.settings.readwise).toMatchObject({ syncDeviceId: null, syncDeviceName: null })
    expect(Object.keys(payload.fieldClocks)).toContain('readwise.syncDeviceId')
    // Cleared with null, never by removing the key (§13.4).
    expect(JSON.parse(getSetting(a.db, READWISE_SETTINGS_KEY)!)).toHaveProperty(
      'syncDeviceId',
      null
    )

    receive(b, a)
    expect(readClaim(b.db)).toEqual({ deviceId: null, deviceName: null })
    expect(JSON.parse(getSetting(b.db, READWISE_SETTINGS_KEY)!)).toHaveProperty(
      'syncDeviceId',
      null
    )
  })

  it('clearing a claim that does not exist sends nothing', () => {
    const manager = use(a)
    clearClaim(a.db)
    expect(manager.getPayload().fieldClocks).toEqual({})
  })

  it('an older build keeps the claim: it strips the group but echoes the clocks', () => {
    use(a)
    writeClaim(a.db, { deviceId: 'dev-a', deviceName: 'Desk Mac' })
    const local = getSettingsSyncManager()!.getPayload()

    // The older build parses with a schema that does not know the group, and
    // pushes its own settings back with every clock it received (§6.9.0).
    const olderBuild = SyncedSettingsSchema.omit({ readwise: true })
    const echoed = {
      settings: olderBuild.parse(local.settings),
      fieldClocks: { ...local.fieldClocks, 'general.theme': { 'dev-old': 1 } }
    }
    expect(echoed.settings).not.toHaveProperty('readwise')

    const merged = mergeSettingsPayloads(local, echoed)
    expect(merged.settings.readwise).toMatchObject({
      syncDeviceId: 'dev-a',
      syncDeviceName: 'Desk Mac'
    })

    // And the group the older build never touched survives its own sync round trip.
    const back = mergeSettingsPayloads(echoed, local)
    expect(back.settings.readwise).toMatchObject({ syncDeviceId: 'dev-a' })
  })

  it('the cursor, the retry list, the run state and the link rows never enter the sync payload', () => {
    const manager = use(a)
    setCursor(a.db, '2026-10-03T09:59:59.000Z')
    addRetry(a.db, 4242, 'rate limited')
    setFullPassPending(a.db, true)
    setLastRun(a.db, { at: '2026-10-03T10:00:00.000Z', needsAttention: false })
    upsertLink(a.db, { readwiseBookId: 777, noteId: 'note-777' })
    writeClaim(a.db, { deviceId: 'dev-a', deviceName: 'Desk Mac' })

    const wire = JSON.stringify(manager.getPayload())
    for (const local of [
      '2026-10-03T09:59:59',
      '4242',
      'rate limited',
      'note-777',
      'retryList',
      'cursor'
    ]) {
      expect(wire).not.toContain(local)
    }
    expect(Object.keys(manager.getPayload().fieldClocks).sort()).toEqual([
      'readwise.syncDeviceId',
      'readwise.syncDeviceName'
    ])
    // Everything the queue would push for settings is that same payload.
    const queued = a.queue.peek(5).map((row) => row.payload)
    expect(queued.join('')).not.toMatch(/note-777|4242|rate limited|retryList/)
    expect(getSetting(a.db, 'readwise.cursor')).toBe('2026-10-03T09:59:59.000Z')
  })

  it('keeps a row a newer build wrote beyond the claim', () => {
    setSetting(
      a.db,
      READWISE_SETTINGS_KEY,
      JSON.stringify({ cadence: 'daily', journalHighlights: true })
    )
    use(a)
    writeClaim(a.db, { deviceId: 'dev-a', deviceName: null })
    expect(JSON.parse(getSetting(a.db, READWISE_SETTINGS_KEY)!)).toEqual({
      cadence: 'daily',
      journalHighlights: true,
      syncDeviceId: 'dev-a',
      syncDeviceName: null
    })
  })
})

function env(over: Partial<PullEnv> = {}): PullEnv {
  return { decided: true, eligible: true, pulled: true, deviceId: 'dev-a', ...over }
}

describe('pullAuthority (D8)', () => {
  let result: TestDatabaseResult
  let db: DataDb
  beforeEach(() => {
    result = createTestDataDb()
    db = asClientDb(result.db)
  })
  afterEach(() => result.close())

  const claim = (deviceId: string | null) =>
    setSetting(db, READWISE_SETTINGS_KEY, JSON.stringify({ syncDeviceId: deviceId }))

  it('waits for sync to decide, so a launch never starts before it knows', () => {
    expect(pullAuthority(db, env({ decided: false }))).toEqual({ state: 'wait' })
  })

  it('pulls with sync off, whatever a stale claim says', () => {
    claim('dev-other')
    expect(pullAuthority(db, env({ eligible: false, deviceId: null }))).toEqual({ state: 'pull' })
  })

  it('names the device that pulls, even before this one has pulled', () => {
    claim('dev-other')
    expect(pullAuthority(db, env({ pulled: false }))).toEqual({
      state: 'elsewhere',
      deviceName: null
    })
  })

  it('the claiming device waits for memry sync to complete a pull since launch', () => {
    claim('dev-a')
    expect(pullAuthority(db, env({ pulled: false }))).toEqual({ state: 'wait' })
    expect(pullAuthority(db, env())).toEqual({ state: 'pull' })
  })

  it('claims only after the first pull, so another device’s claim is seen first', () => {
    expect(pullAuthority(db, env({ pulled: false }))).toEqual({ state: 'wait' })
    expect(pullAuthority(db, env())).toEqual({ state: 'claim-needed' })
    claim(null)
    expect(pullAuthority(db, env())).toEqual({ state: 'claim-needed' })
  })

  it('waits for the device to register before it claims', () => {
    expect(pullAuthority(db, env({ deviceId: null }))).toEqual({ state: 'wait' })
  })
})
