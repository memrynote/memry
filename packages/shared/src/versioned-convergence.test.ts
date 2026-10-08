/**
 * Convergence of the two versioned keys (chapter 06 §6.11) against every
 * peer that ships today, over the production join, stamps and heal rule.
 *
 * One item, five devices and a server:
 *  - N (two of them): this build. It joins on every clock-gate outcome and
 *    heals per `owesHeal`, ticking its own clock entry as `enqueueUpdate` does.
 *  - D1: a desktop before #2265. It strips the key on apply and never sends it.
 *  - D2: a desktop since #2265. It captures the key from every pulled payload
 *    before the clock gate and echoes that capture on its next push, so it can
 *    push a stale value it skipped under a newer clock.
 *  - R: the Rust core. A wholesale apply stores the remote bytes. A concurrent
 *    task merge keeps its local key and re-queues nothing; a concurrent tag
 *    definition takes the remote payload.
 *  - The server keeps one row and refuses a push whose clock exceeds the
 *    stored clock in no component (`detectReplay`).
 *
 * Old desktops re-queue a concurrent task merge only when a listed field
 * conflicted, which this model draws at random, and always re-queue a
 * concurrent tag definition. The oracle is independent of the join: after
 * quiescence both N devices and the server row hold, per key, the greatest
 * entry an N device ever stamped.
 */
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
  /** One local edit of the key; `created` is what the oracle must find afterwards. */
  edit(stored: unknown, clock: Clock, random: () => number): { stored: unknown; created: unknown }
  /** The handler's merge branch returns 'conflict', which re-queues at the union clock. */
  mergeRequeues: boolean
  rustConcurrent: 'keep-local' | 'take-remote'
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
  readonly kind: 'N' | 'D1' | 'D2' | 'R'
  readonly id: string
  clock: Clock
  /** The key as stored; `undefined` is a NULL column, omitted on push. */
  stored: unknown
  /** D2 only: the key captured from the last pulled payload. */
  remainder: unknown
  dirty: boolean
}

interface Server {
  row?: { clock: Clock; value: unknown }
}

function run(seed: number, scenario: Scenario, rules: Rules): boolean {
  const random = seededRandom(seed)
  const same = (a: unknown, b: unknown): boolean =>
    canonicalJson(a ?? scenario.empty) === canonicalJson(b ?? scenario.empty)
  const devices: Device[] = (['N', 'N', 'D1', 'D2', 'R'] as const).map((kind, index) => ({
    kind,
    id: `${kind}${index}`,
    clock: {},
    stored: undefined,
    remainder: undefined,
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
    if (device.kind === 'D2') device.remainder = row.value
    if (device.kind === 'N') return applyThisBuild(device, row)
    const order = compareClocks(device.clock, row.clock)
    if (order === 'after') return
    if (order === 'concurrent') {
      device.clock = unionClock(device.clock, row.clock)
      if (device.kind === 'R') {
        if (scenario.rustConcurrent === 'take-remote') device.stored = row.value
        return
      }
      if (scenario.mergeRequeues || random() < 0.5) device.dirty = true
      return
    }
    device.clock = row.clock
    if (device.kind === 'R') device.stored = row.value
  }

  function push(device: Device): void {
    if (!device.dirty) return
    device.dirty = false
    const stored = server.row?.clock
    const ahead = !stored || Object.entries(device.clock).some(([id, n]) => n > (stored[id] ?? 0))
    if (!ahead) return
    const value =
      device.kind === 'D1' ? undefined : device.kind === 'D2' ? device.remainder : device.stored
    server.row = { clock: device.clock, value }
  }

  function edit(device: Device): void {
    if (device.kind === 'N' && random() < 0.8) {
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
    devices.filter((d) => d.kind === 'N').every((d) => same(d.stored, expected)) &&
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
