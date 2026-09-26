import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { SettingsSyncPayloadSchema, type SettingsSyncPayload } from '@memry/contracts/settings-sync'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { SettingsSyncManager } from '@memry/sync-client/settings-sync'
import { compare } from '@memry/sync-client/vector-clock'

// #2287: settings field clocks are keyed by the writer's device id, not the
// literal 'local' every device used to share.

interface Device {
  manager: SettingsSyncManager
  queue: SyncQueueManager
  lastCursor: number
}

// One row per item, last push overwrites it, no replay check for `settings`
// (it is not a clock-required type), and every device pulls the row back —
// its own push included — once its cursor is behind.
interface Server {
  row: { payload: SettingsSyncPayload; cursor: number } | null
  cursor: number
}

const openDbs: TestDatabaseResult[] = []

function createDevice(deviceId: string | null): Device {
  const testDb = createTestDataDb()
  openDbs.push(testDb)
  const queue = new SyncQueueManager(asClientDb(testDb.db))
  const manager = new SettingsSyncManager({
    db: asSyncDb(testDb.db),
    queue,
    getDeviceId: () => deviceId
  })
  return { manager, queue, lastCursor: 0 }
}

function push(device: Device, server: Server): void {
  const [item] = device.queue.dequeue(1)
  if (!item) return
  server.cursor += 1
  server.row = {
    payload: SettingsSyncPayloadSchema.parse(JSON.parse(item.payload)),
    cursor: server.cursor
  }
  device.queue.markSuccess(item.id, item.payload)
}

function pull(device: Device, server: Server): void {
  if (!server.row || server.row.cursor <= device.lastCursor) return
  device.manager.mergeRemote(server.row.payload)
  device.lastCursor = server.row.cursor
}

function settle(devices: Device[], server: Server): void {
  for (let round = 0; round < 5; round++) {
    for (const device of devices) {
      push(device, server)
      pull(device, server)
    }
  }
}

function theme(device: Device) {
  return device.manager.getSettings().general?.theme
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
})

describe('settings field clocks — device id keying (#2287)', () => {
  it('#given two devices edit the same setting #then their clocks compare concurrent', () => {
    // #2287
    const a = createDevice('dev-a')
    const b = createDevice('dev-b')

    a.manager.updateField('general.theme', 'dark')
    b.manager.updateField('general.theme', 'light')

    const clockA = a.manager.getPayload().fieldClocks['general.theme']
    const clockB = b.manager.getPayload().fieldClocks['general.theme']
    expect(clockA).toEqual({ 'dev-a': 1 })
    expect(clockB).toEqual({ 'dev-b': 1 })
    expect(compare(clockA, clockB)).toBe('concurrent')
  })

  it('#given both devices push before either pulls #then a round trip leaves both on one value', () => {
    // #2287
    const server: Server = { row: null, cursor: 0 }
    const a = createDevice('dev-a')
    const b = createDevice('dev-b')
    a.manager.updateField('general.theme', 'dark')
    b.manager.updateField('general.theme', 'light')

    push(a, server)
    push(b, server)
    pull(a, server)
    pull(b, server)
    settle([a, b], server)

    expect(theme(a)).toBe(theme(b))
    expect(a.manager.getPayload().fieldClocks['general.theme']).toEqual(
      b.manager.getPayload().fieldClocks['general.theme']
    )
    expect(a.queue.getSize()).toBe(0)
    expect(b.queue.getSize()).toBe(0)
  })

  it('#given one device pulls the other before pushing #then a round trip leaves both on one value', () => {
    // #2287
    const server: Server = { row: null, cursor: 0 }
    const a = createDevice('dev-a')
    const b = createDevice('dev-b')
    a.manager.updateField('general.theme', 'dark')
    b.manager.updateField('general.theme', 'light')

    push(a, server)
    pull(b, server)
    push(b, server)
    pull(a, server)
    settle([a, b], server)

    expect(theme(a)).toBe(theme(b))
    expect(a.queue.getSize()).toBe(0)
    expect(b.queue.getSize()).toBe(0)
  })

  it('#given a concurrent merge #then the merged state is queued for push', () => {
    // #2287: the union clock has to reach the server, or the device that kept
    // its own value on the merge is the only one that ever holds it.
    const a = createDevice('dev-a')
    a.manager.updateField('general.theme', 'dark')
    const [queued] = a.queue.dequeue(1)
    a.queue.markSuccess(queued.id, queued.payload)

    a.manager.mergeRemote({
      settings: { general: { theme: 'light' } },
      fieldClocks: { 'general.theme': { 'dev-b': 1 } }
    })

    const [requeued] = a.queue.dequeue(1)
    expect(requeued?.type).toBe('settings')
    const payload = SettingsSyncPayloadSchema.parse(JSON.parse(requeued.payload))
    expect(payload.fieldClocks['general.theme']).toEqual({ 'dev-a': 1, 'dev-b': 1 })
  })

  it('#given a remote that dominates #then nothing is queued', () => {
    // #2287
    const a = createDevice('dev-a')

    a.manager.mergeRemote({
      settings: { general: { theme: 'light' } },
      fieldClocks: { 'general.theme': { 'dev-b': 1 } }
    })

    expect(a.queue.getSize()).toBe(0)
  })
})

describe('settings field clocks — legacy "local" key (#2287)', () => {
  it('#given a stored {local: n} clock #when the setting is written #then local is kept and the device id is added', () => {
    // #2287: 'local' was shared by every device and already reached peers, so
    // it is a real causal component, unlike `_offline`; it is not rebound.
    const a = createDevice('dev-a')
    a.manager.mergeRemote({
      settings: { general: { theme: 'dark' } },
      fieldClocks: { 'general.theme': { local: 3 } }
    })

    a.manager.updateField('general.theme', 'light')

    expect(a.manager.getPayload().fieldClocks['general.theme']).toEqual({ local: 3, 'dev-a': 1 })
  })

  it('#given a peer still at {local: n} #when it pulls the new clock #then it applies without a merge', () => {
    // #2287
    const server: Server = { row: null, cursor: 0 }
    const legacyState: SettingsSyncPayload = {
      settings: { general: { theme: 'dark' } },
      fieldClocks: { 'general.theme': { local: 3 } }
    }
    const a = createDevice('dev-a')
    const b = createDevice('dev-b')
    a.manager.mergeRemote(legacyState)
    b.manager.mergeRemote(legacyState)

    a.manager.updateField('general.theme', 'light')
    push(a, server)
    pull(b, server)

    expect(theme(b)).toBe('light')
    expect(b.manager.getPayload().fieldClocks['general.theme']).toEqual({ local: 3, 'dev-a': 1 })
    expect(b.queue.getSize()).toBe(0)
  })

  it('#given an old-client clock {local: 3} and a new clock {dev-a: 1} #then both directions merge without throwing', () => {
    // #2287
    const oldClient: SettingsSyncPayload = {
      settings: { general: { theme: 'dark' } },
      fieldClocks: { 'general.theme': { local: 3 } }
    }
    const newClient: SettingsSyncPayload = {
      settings: { general: { theme: 'light' } },
      fieldClocks: { 'general.theme': { 'dev-a': 1 } }
    }
    const holdsOld = createDevice('dev-b')
    const holdsNew = createDevice('dev-a')
    holdsOld.manager.mergeRemote(oldClient)
    holdsNew.manager.updateField('general.theme', 'light')

    expect(() => holdsOld.manager.mergeRemote(newClient)).not.toThrow()
    expect(() => holdsNew.manager.mergeRemote(oldClient)).not.toThrow()

    expect(holdsOld.manager.getPayload().fieldClocks['general.theme']).toEqual({
      local: 3,
      'dev-a': 1
    })
    expect(holdsNew.manager.getPayload().fieldClocks['general.theme']).toEqual({
      local: 3,
      'dev-a': 1
    })
  })
})

describe('settings field clocks — no device id (#2287)', () => {
  it('#given no registered device #when a setting is written #then nothing is stored, clocked or queued', () => {
    // #2287: there is no id to tick. Ticking 'local' again would bring the bug
    // back, and settings have no `_offline` rebind hook.
    const device = createDevice(null)

    const written = device.manager.updateField('general.theme', 'dark')

    expect(written).toBe(false)
    expect(device.manager.getPayload()).toEqual({ settings: {}, fieldClocks: {} })
    expect(device.queue.getSize()).toBe(0)
  })
})
