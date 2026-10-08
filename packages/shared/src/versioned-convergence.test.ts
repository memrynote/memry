import { describe, expect, it } from 'vitest'

import {
  canonicalJson,
  joinVersionedMap,
  joinVersionedValue,
  owesHeal,
  stampVersionedMapPatch,
  stampVersionedValue,
  type ApplyBranch,
  type JoinResult
} from './versioned'

type Clock = Readonly<Record<string, number>>

function compareClocks(a: Clock, b: Clock): 'before' | 'after' | 'equal' | 'concurrent' {
  let behind = false
  let ahead = false
  for (const device of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[device] ?? 0) < (b[device] ?? 0)) behind = true
    if ((a[device] ?? 0) > (b[device] ?? 0)) ahead = true
  }
  return behind && ahead ? 'concurrent' : behind ? 'before' : ahead ? 'after' : 'equal'
}

function unionClock(a: Clock, b: Clock): Clock {
  const union: Record<string, number> = { ...a }
  for (const [device, ticks] of Object.entries(b))
    union[device] = Math.max(union[device] ?? 0, ticks)
  return union
}

const tick = (clock: Clock, device: string): Clock => ({
  ...clock,
  [device]: (clock[device] ?? 0) + 1
})
const clockTotal = (clock: Clock): number => Object.values(clock).reduce((sum, n) => sum + n, 0)

function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

interface Scenario {
  join(local: unknown, remote: unknown): JoinResult<unknown>
  edit(stored: unknown, clock: Clock, random: () => number): { stored: unknown; created: unknown }
  mergeRequeues: boolean
  rustConcurrent: 'keep-local' | 'take-remote'
  /** Orders entries without the production code, so a broken join cannot confirm itself. */
  oracle(created: unknown[]): unknown
  empty: unknown
}

interface Entry {
  v: string | null
  t: number
}

const taskFields: Scenario = {
  join: joinVersionedMap,
  edit(stored, clock, random) {
    const name = `K${Math.floor(random() * 3)}`
    const value = random() < 0.15 ? null : `v${Math.floor(random() * 1000)}`
    const next = stampVersionedMapPatch(stored, { [name]: value }, clockTotal(clock))
    return { stored: next, created: next[name] === undefined ? [] : [[name, next[name]]] }
  },
  mergeRequeues: false,
  rustConcurrent: 'keep-local',
  oracle(created) {
    const best: Record<string, Entry> = {}
    for (const [name, entry] of (created as Array<Array<[string, Entry]>>).flat()) {
      const current = best[name]
      const wins =
        !current ||
        entry.t > current.t ||
        (entry.t === current.t && JSON.stringify(entry.v) > JSON.stringify(current.v))
      if (wins) best[name] = entry
    }
    return best
  },
  empty: {}
}

interface Schema {
  fields: string[]
  t: number
}

const tagSchema: Scenario = {
  join: joinVersionedValue,
  edit(stored, _clock, random) {
    const next = stampVersionedValue(stored, { fields: [`F${Math.floor(random() * 5)}`] })
    return { stored: next, created: next }
  },
  mergeRequeues: true,
  rustConcurrent: 'take-remote',
  oracle(created) {
    let best: Schema | undefined
    for (const value of created as Schema[]) {
      const wins =
        !best ||
        value.t > best.t ||
        (value.t === best.t && JSON.stringify(value.fields) > JSON.stringify(best.fields))
      if (wins) best = value
    }
    return best
  },
  empty: null
}

interface Rules {
  heal: typeof owesHeal
  joinOnApply: boolean
}

const PRODUCTION: Rules = { heal: owesHeal, joinOnApply: true }

interface Device {
  readonly kind: 'thisBuild' | 'stripsUnknownKeys' | 'echoesLastCapture' | 'rustCore'
  readonly id: string
  clock: Clock
  stored: unknown
  capturedFromLastPull: unknown
  dirty: boolean
}

interface Server {
  row?: { clock: Clock; value: unknown }
}

function run(seed: number, scenario: Scenario, rules: Rules): boolean {
  const random = seededRandom(seed)
  const same = (a: unknown, b: unknown): boolean =>
    canonicalJson(a ?? scenario.empty) === canonicalJson(b ?? scenario.empty)
  const kinds = [
    'thisBuild',
    'thisBuild',
    'stripsUnknownKeys',
    'echoesLastCapture',
    'rustCore'
  ] as const
  const devices: Device[] = kinds.map((kind, index) => ({
    kind,
    id: `${kind}${index}`,
    clock: {},
    stored: undefined,
    capturedFromLastPull: undefined,
    dirty: false
  }))
  const server: Server = {}
  const created: unknown[] = []

  function applyThisBuild(device: Device, row: NonNullable<Server['row']>): void {
    const order = compareClocks(device.clock, row.clock)
    const identical = order === 'equal' && same(device.stored, row.value)
    const branch: ApplyBranch =
      order === 'after' || identical ? 'skip' : order === 'concurrent' ? 'merge' : 'apply'
    const joined =
      branch === 'apply' && !rules.joinOnApply
        ? { value: row.value, remoteBehind: false, localChanged: true }
        : scenario.join(device.stored, row.value)
    if (joined.localChanged) device.stored = joined.value
    if (branch === 'merge') device.clock = unionClock(device.clock, row.clock)
    if (branch === 'apply') device.clock = row.clock
    const requeued = branch === 'merge' && scenario.mergeRequeues
    if (requeued) device.dirty = true
    if (rules.heal(branch, joined, requeued)) {
      device.clock = tick(device.clock, device.id)
      device.dirty = true
    }
  }

  function pull(device: Device): void {
    const row = server.row
    if (!row) return
    if (device.kind === 'echoesLastCapture') device.capturedFromLastPull = row.value
    if (device.kind === 'thisBuild') return applyThisBuild(device, row)
    const order = compareClocks(device.clock, row.clock)
    if (order === 'after') return
    if (order === 'concurrent') {
      device.clock = unionClock(device.clock, row.clock)
      if (device.kind === 'rustCore') {
        if (scenario.rustConcurrent === 'take-remote') device.stored = row.value
        return
      }
      const listedFieldConflicted = random() < 0.5
      if (scenario.mergeRequeues || listedFieldConflicted) device.dirty = true
      return
    }
    device.clock = row.clock
    if (device.kind === 'rustCore') device.stored = row.value
  }

  function push(device: Device): void {
    if (!device.dirty) return
    device.dirty = false
    const stored = server.row?.clock
    const ahead = !stored || Object.entries(device.clock).some(([id, n]) => n > (stored[id] ?? 0))
    if (!ahead) return
    const value =
      device.kind === 'stripsUnknownKeys'
        ? undefined
        : device.kind === 'echoesLastCapture'
          ? device.capturedFromLastPull
          : device.stored
    server.row = { clock: device.clock, value }
  }

  function edit(device: Device): void {
    if (device.kind === 'thisBuild' && random() < 0.8) {
      const next = scenario.edit(device.stored, device.clock, random)
      device.stored = next.stored
      created.push(next.created)
    }
    device.clock = tick(device.clock, device.id)
    device.dirty = true
  }

  const steps = 40 + Math.floor(random() * 60)
  for (let step = 0; step < steps; step++) {
    const device = devices[Math.floor(random() * devices.length)]
    const action = random()
    if (action < 0.35) edit(device)
    else if (action < 0.7) pull(device)
    else push(device)
  }

  const snapshot = (): string => JSON.stringify([devices, server.row ?? null])
  for (let round = 0; round < 60; round++) {
    const before = snapshot()
    for (const device of devices) {
      pull(device)
      push(device)
    }
    for (const device of devices) push(device)
    if (snapshot() === before) break
  }

  const expected = scenario.oracle(created)
  return (
    devices.filter((d) => d.kind === 'thisBuild').every((d) => same(d.stored, expected)) &&
    same(server.row?.value, expected)
  )
}

function failingSeeds(scenario: Scenario, rules: Rules, schedules: number): number[] {
  const failing: number[] = []
  for (let seed = 1; seed <= schedules; seed++) {
    if (!run(seed, scenario, rules)) failing.push(seed)
  }
  return failing
}

describe('versioned keys converge against every shipped peer', () => {
  it('task fields: 5,000 seeded schedules', () => {
    expect(failingSeeds(taskFields, PRODUCTION, 5000)).toEqual([])
  })

  it('tag schema: 5,000 seeded schedules', () => {
    expect(failingSeeds(tagSchema, PRODUCTION, 5000)).toEqual([])
  })

  it('fails without the heal: the server row stays behind the joined value', () => {
    expect(
      failingSeeds(taskFields, { ...PRODUCTION, heal: () => false }, 500).length
    ).toBeGreaterThan(0)
  })

  it('fails when an apply takes the remote map verbatim instead of joining', () => {
    expect(
      failingSeeds(taskFields, { ...PRODUCTION, joinOnApply: false }, 500).length
    ).toBeGreaterThan(0)
  })
})
