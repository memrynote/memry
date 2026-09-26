import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import {
  SettingsSyncPayloadSchema,
  type FieldClockMap,
  type SettingsSyncPayload,
  type SyncedSettings
} from '@memry/contracts/settings-sync'
import type { VectorClock } from '@memry/contracts/sync-api'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { SettingsSyncManager } from '@memry/sync-client/settings-sync'
import { compare, merge } from '@memry/sync-client/vector-clock'

// #2383: settings mergeRemote arbitrates each clocked path by chapter 06
// §6.3's rule (tick sum, remote wins a tie, asymmetric `_offline` test). A
// winner with no value at the path leaves the local value alone (§6.9.0: the
// removal half waits for #2183, see settings-merge.ts).

const PATH = 'general.accentColor'

interface Device {
  manager: SettingsSyncManager
  queue: SyncQueueManager
  lastCursor: number
}

interface Server {
  row: { payload: SettingsSyncPayload; cursor: number } | null
  cursor: number
}

const openDbs: TestDatabaseResult[] = []

function createDevice(deviceId: string): Device {
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

/** A device holding `value` under `clock` at PATH, with nothing queued. */
function deviceHolding(value: string | undefined, clock: VectorClock): Device {
  const device = createDevice('dev-local')
  device.manager.mergeRemote({
    settings: value === undefined ? {} : { general: { accentColor: value } },
    fieldClocks: { [PATH]: clock }
  })
  for (const item of device.queue.dequeue(10)) device.queue.markSuccess(item.id, item.payload)
  return device
}

function accent(settings: SyncedSettings): string | undefined {
  return settings.general?.accentColor
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

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
})

describe('settings mergeRemote — §6.3.2 rows on a settings path (#2383)', () => {
  // Row 10: the remote wins with no value, so the local value stays.
  const rows: Array<{
    row: number
    local: VectorClock
    remote: VectorClock
    localValue: string
    remoteValue: string | undefined
    winner: string
  }> = [
    {
      row: 1,
      local: { A: 2, B: 1 },
      remote: { C: 5 },
      localValue: 'x',
      remoteValue: 'y',
      winner: 'y'
    },
    { row: 2, local: { A: 1 }, remote: { B: 1 }, localValue: 'x', remoteValue: 'y', winner: 'y' },
    {
      row: 3,
      local: { A: 3, B: 1 },
      remote: { A: 3, B: 1 },
      localValue: 'x',
      remoteValue: 'y',
      winner: 'y'
    },
    {
      row: 4,
      local: { A: 1, _offline: 1 },
      remote: { B: 2 },
      localValue: 'x',
      remoteValue: 'y',
      winner: 'x'
    },
    {
      row: 5,
      local: { A: 1, _offline: 1 },
      remote: { B: 1, _offline: 1 },
      localValue: 'x',
      remoteValue: 'y',
      winner: 'y'
    },
    {
      row: 6,
      local: { A: 1, _offline: 1 },
      remote: { B: 2 },
      localValue: 'x',
      remoteValue: 'x',
      winner: 'x'
    },
    { row: 7, local: {}, remote: {}, localValue: 'x', remoteValue: 'y', winner: 'y' },
    {
      row: 8,
      local: { A: 4 },
      remote: { A: 1, B: 1, C: 1 },
      localValue: 'x',
      remoteValue: 'y',
      winner: 'x'
    },
    { row: 9, local: { A: 2 }, remote: { A: 1 }, localValue: 'x', remoteValue: 'y', winner: 'x' },
    {
      row: 10,
      local: { A: 1 },
      remote: { A: 2 },
      localValue: 'x',
      remoteValue: undefined,
      winner: 'x'
    }
  ]

  it.each(rows)(
    '#given row $row #then the winner is $winner and the clock is the union',
    ({ local, remote, localValue, remoteValue, winner }) => {
      // #2383
      const device = deviceHolding(localValue, local)

      device.manager.mergeRemote({
        settings:
          remoteValue === undefined ? { general: {} } : { general: { accentColor: remoteValue } },
        fieldClocks: { [PATH]: remote }
      })

      const payload = device.manager.getPayload()
      expect(accent(payload.settings)).toBe(winner)
      expect(payload.fieldClocks[PATH]).toEqual(merge(local, remote))
      // §6.9.0: a concurrent path re-queues the merged settings (#2287).
      expect(device.queue.getSize()).toBe(compare(local, remote) === 'concurrent' ? 1 : 0)
    }
  )

  it('#given a clock key that is not an addressable path #then it rides along and arbitrates nothing', () => {
    // #2383
    const device = deviceHolding('x', { A: 1 })

    device.manager.mergeRemote({
      settings: { general: { accentColor: 'x' } },
      fieldClocks: { [PATH]: { A: 1 }, 'general.': { B: 1 } }
    })

    const payload = device.manager.getPayload()
    expect(payload.settings).toEqual({ general: { accentColor: 'x' } })
    expect(payload.fieldClocks['general.']).toEqual({ B: 1 })
  })
})

describe('settings removal is not propagated yet (#2383)', () => {
  it('#given device A clears a ticked path B still holds #then B keeps its value and takes the clock', () => {
    // #2383: §6.9.0's removal half is deferred. An absent value from a peer is
    // indistinguishable from a build whose schema stripped it (#16), so the
    // receiver keeps what it has.
    const server: Server = { row: null, cursor: 0 }
    const a = createDevice('dev-a')
    const b = createDevice('dev-b')
    a.manager.updateField(PATH, 'kept')
    push(a, server)
    pull(a, server)
    pull(b, server)

    a.manager.updateField(PATH, undefined)
    push(a, server)
    pull(a, server)
    pull(b, server)

    expect(a.manager.getSettings().general).toEqual({})
    expect(b.manager.getSettings().general).toEqual({ accentColor: 'kept' })
    expect(b.manager.getPayload().fieldClocks[PATH]).toEqual({ 'dev-a': 2 })

    // B's next push ties A's clock at the path, and the remote wins the tie.
    b.manager.updateField('general.fontFamily', 'serif')
    push(b, server)
    pull(a, server)
    expect(accent(a.manager.getSettings())).toBe('kept')
  })

  it('#given one device clears while the other edits concurrently #then both end on one state', () => {
    // #2383
    const server: Server = { row: null, cursor: 0 }
    const a = createDevice('dev-a')
    const b = createDevice('dev-b')
    a.manager.updateField(PATH, 'shared')
    push(a, server)
    pull(a, server)
    pull(b, server)

    a.manager.updateField(PATH, undefined)
    b.manager.updateField(PATH, 'edited')
    for (let round = 0; round < 5; round++) {
      for (const device of [a, b]) {
        push(device, server)
        pull(device, server)
      }
    }

    expect(accent(a.manager.getSettings())).toBe('edited')
    expect(accent(b.manager.getSettings())).toBe('edited')
    expect(a.manager.getPayload().fieldClocks).toEqual(b.manager.getPayload().fieldClocks)
    expect(a.queue.getSize()).toBe(0)
    expect(b.queue.getSize()).toBe(0)
  })
})

/**
 * The #2287 build's merge, verbatim in behaviour: the winner of a concurrent
 * path is the larger single tick (not the sum), local keeps a tie, a winner
 * with no value never removes, and any concurrent path re-queues.
 */
class OldRuleDevice {
  settings: Record<string, unknown> = {}
  clocks: FieldClockMap = {}
  queued = false
  lastCursor = 0

  constructor(private readonly deviceId: string) {}

  private general(): Record<string, unknown> {
    this.settings.general ??= {}
    return this.settings.general as Record<string, unknown>
  }

  write(path: string, value: string): void {
    this.general()[path.split('.')[1]] = value
    const clock = this.clocks[path] ?? {}
    this.clocks[path] = { ...clock, [this.deviceId]: (clock[this.deviceId] ?? 0) + 1 }
    this.queued = true
  }

  mergeRemote(remote: SettingsSyncPayload): void {
    const maxTick = (clock: VectorClock): number => Math.max(0, ...Object.values(clock))
    for (const path of new Set([...Object.keys(this.clocks), ...Object.keys(remote.fieldClocks)])) {
      const local = this.clocks[path] ?? {}
      const remoteClock = remote.fieldClocks[path] ?? {}
      const order = compare(local, remoteClock)
      const key = path.split('.')[1]
      const remoteValue = (remote.settings.general as Record<string, unknown> | undefined)?.[key]
      const take = (): void => {
        if (remoteValue !== undefined) this.general()[key] = remoteValue
      }
      if (order === 'before' || order === 'equal') {
        take()
        this.clocks[path] = remoteClock
      } else if (order === 'concurrent') {
        if (maxTick(remoteClock) > maxTick(local)) take()
        this.clocks[path] = merge(local, remoteClock)
        this.queued = true
      }
    }
  }

  push(server: Server): void {
    if (!this.queued) return
    server.cursor += 1
    server.row = {
      payload: SettingsSyncPayloadSchema.parse({
        settings: structuredClone(this.settings),
        fieldClocks: structuredClone(this.clocks)
      }),
      cursor: server.cursor
    }
    this.queued = false
  }

  pull(server: Server): void {
    if (!server.row || server.row.cursor <= this.lastCursor) return
    this.mergeRemote(server.row.payload)
    this.lastCursor = server.row.cursor
  }
}

describe('settings merge — a mixed pair with a #2287 (tick-max) peer (#2383)', () => {
  // {dev-x: 1, dev-y: 1, dev-new: 1} against {dev-old: 2}: the sum picks the
  // new device's value (3 beats 2) and the max picks the old one's (2 beats
  // 1), from either seat. Whichever device merges, the two rules disagree.
  function divergentStart(): { fresh: Device; old: OldRuleDevice; server: Server } {
    const server: Server = { row: null, cursor: 0 }
    const fresh = createDevice('dev-new')
    fresh.manager.mergeRemote({
      settings: { general: { accentColor: 'base' } },
      fieldClocks: { [PATH]: { 'dev-x': 1, 'dev-y': 1 } }
    })
    const old = new OldRuleDevice('dev-old')
    fresh.manager.updateField(PATH, 'new-value')
    old.write(PATH, 'old-1')
    old.write(PATH, 'old-value')
    return { fresh, old, server }
  }

  function settle(fresh: Device, old: OldRuleDevice, server: Server, oldFirst: boolean): void {
    for (let round = 0; round < 5; round++) {
      if (oldFirst) {
        old.push(server)
        old.pull(server)
      }
      push(fresh, server)
      pull(fresh, server)
      if (!oldFirst) {
        old.push(server)
        old.pull(server)
      }
    }
  }

  it.each([{ oldFirst: true }, { oldFirst: false }])(
    '#given concurrent edits the two rules resolve differently (old pushes first: $oldFirst) #then the re-queue converges both',
    ({ oldFirst }) => {
      // #2383: the merging device re-pushes the union clock, which dominates
      // the other side's clock, so whichever rule the other side runs it
      // takes that row as `before` and applies it.
      const { fresh, old, server } = divergentStart()

      settle(fresh, old, server, oldFirst)

      expect(accent(fresh.manager.getSettings())).toBe(accent(old.settings as SyncedSettings))
      expect(fresh.manager.getPayload().fieldClocks[PATH]).toEqual(old.clocks[PATH])
      expect(fresh.queue.getSize()).toBe(0)
      expect(old.queued).toBe(false)
    }
  )
})
