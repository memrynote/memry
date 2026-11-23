/**
 * A deterministic multi-device run of one journal day, its oracle, and a
 * seeded scenario generator (chapter 06 §6.12, #5508).
 *
 * Each run is checked three ways:
 * - (a) every unit's final value is one of the latest concurrent writes to it:
 *   a write no other write to the unit causally follows;
 * - (b) no unit that the document rule (§6.3.1, every device on the build
 *   before #5508) leaves on a latest write ends anywhere else: a loss;
 * - (c) every device and the server row hold the same tags and properties.
 */
import type { VectorClock } from '@memry/contracts/sync-api'
import { journalFieldClocksForWholesale } from '../journal-merge'
import { compare } from '../vector-clock'
import {
  INITIAL,
  localEdit,
  makeDevice,
  pull,
  push,
  upgrade,
  type Change,
  type Device,
  type Init,
  type Kind,
  type Payload,
  type Rule,
  type Server
} from './fleet'

export type Config =
  | 'trusted'
  | 'newUntrusted'
  | 'oldPlusTrusted'
  | 'deskOnly'
  | 'coreOnly'
  | 'mixed'
export type ServerMode = 'legacy' | 'stamped'

export type Step =
  | { op: 'edit'; dev: string; change: Change }
  | { op: 'body' | 'push' | 'pull' | 'upgrade'; dev: string }

export interface Scenario {
  seed: number
  server: ServerMode
  devices: { id: string; kind: Kind; init: Init }[]
  steps: Step[]
}

interface Write {
  unit: string
  value: string
  clock: VectorClock
}

export interface View {
  id: string
  kind: Kind
  tags: string[]
  properties: Record<string, unknown>
  clock: VectorClock
}

export interface Outcome {
  views: View[]
  server: Payload
  writes: Write[]
  livelock: boolean
  log: string[]
}

/** JSON with object keys sorted, so equal values print alike. */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b)))
      : inner
  )
}

const TAGS = ['a', 'b', 'c', 'd', 'e']
const PROPS = ['p', 'q', 'r']
export const UNITS = [...TAGS.map((t) => `tags.${t}`), ...PROPS.map((p) => `properties.${p}`)]
const ABSENT = '<absent>'
const MAX_ROUNDS = 40

function valueOf(held: { tags: string[]; properties: Record<string, unknown> }, unit: string) {
  if (unit.startsWith('tags.')) {
    const tag = unit.slice('tags.'.length)
    return held.tags.includes(tag) ? tag : ABSENT
  }
  const key = unit.slice('properties.'.length)
  return key in held.properties ? canonicalStringify(held.properties[key]) : ABSENT
}

function unitOf(change: Change): string {
  if ('addTag' in change) return `tags.${change.addTag}`
  if ('removeTag' in change) return `tags.${change.removeTag}`
  if ('setProp' in change) return `properties.${change.setProp[0]}`
  return `properties.${change.delProp}`
}

const OLDER: Record<Kind, Kind> = {
  newDesk: 'oldDesk',
  newCore: 'oldCore',
  oldDesk: 'oldDesk',
  oldCore: 'oldCore'
}

/** The server's starting row: an older build's record, or one a newer build stamped. */
export function serverRow(mode: ServerMode): Payload {
  if (mode === 'legacy') return structuredClone(INITIAL)
  return { ...structuredClone(INITIAL), ...journalFieldClocksForWholesale(INITIAL) }
}

const brief = (payload: Payload): string => {
  const { tags, properties, clock, ...stamp } = payload
  return JSON.stringify({ tags, properties, clock, ...stamp })
}

/** Runs `scenario`, then syncs every device until nothing moves. `reference`: the document rule. */
export function run(scenario: Scenario, rule: Rule, reference = false): Outcome {
  const row = serverRow(scenario.server)
  const server: Server = { row: structuredClone(row), version: 0 }
  const devices = new Map<string, Device>()
  for (const spec of scenario.devices) {
    const kind = reference ? OLDER[spec.kind] : spec.kind
    devices.set(spec.id, makeDevice(spec.id, kind, reference ? 'legacy' : spec.init, row))
  }
  const writes: Write[] = UNITS.map((unit) => ({
    unit,
    value: valueOf(INITIAL, unit),
    clock: { ...INITIAL.clock }
  }))
  const log: string[] = []
  const doPull = (device: Device): boolean => {
    const action = pull(device, rule, server)
    if (action === 'none') return false
    log.push(`${device.id} pull ${action} -> ${brief(view(device))}`)
    return true
  }
  const doPush = (device: Device): boolean => {
    const payload = push(device, rule, server)
    if (payload !== null) log.push(`${device.id} push ${brief(payload)}`)
    return payload !== null
  }

  for (const step of scenario.steps) {
    const device = devices.get(step.dev)
    if (!device) continue
    if (step.op === 'edit') {
      if (localEdit(device, rule, step.change)) {
        const unit = unitOf(step.change)
        writes.push({ unit, value: valueOf(device, unit), clock: { ...device.clock } })
      }
    } else if (step.op === 'body') localEdit(device, rule, null)
    else if (step.op === 'push') doPush(device)
    else if (step.op === 'pull') doPull(device)
    else if (!reference) upgrade(device)
  }

  let livelock = true
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let moved = false
    for (const device of devices.values()) {
      moved = doPull(device) || moved
      moved = doPush(device) || moved
    }
    if (!moved) {
      livelock = false
      break
    }
  }
  return { views: [...devices.values()].map(view), server: server.row, writes, livelock, log }
}

function view(device: Device | View): View & Payload {
  return {
    id: device.id,
    kind: device.kind,
    tags: [...device.tags],
    properties: { ...device.properties },
    clock: { ...device.clock }
  }
}

export interface Violation {
  unit: string
  device: string
  actual: string
  allowed: string[]
}

/** (a): units whose final value on some device is no latest write. */
export function violations(outcome: Outcome): Violation[] {
  const out: Violation[] = []
  for (const unit of UNITS) {
    const writes = outcome.writes.filter((write) => write.unit === unit)
    const latest = writes.filter(
      (write) => !writes.some((other) => compare(write.clock, other.clock) === 'before')
    )
    const allowed = [...new Set(latest.map((write) => write.value))]
    for (const device of outcome.views) {
      const actual = valueOf(device, unit)
      if (!allowed.includes(actual)) out.push({ unit, device: device.id, actual, allowed })
    }
  }
  return out
}

/** (c): every device and the server row hold the same values; `setLevel` ignores tag order. */
export function converged(outcome: Outcome, setLevel = false): boolean {
  const key = (v: { tags: string[]; properties: Record<string, unknown> }): string =>
    canonicalStringify({
      tags: setLevel ? [...v.tags].toSorted() : v.tags,
      properties: v.properties
    })
  const server = key(outcome.server)
  return outcome.views.every((device) => key(device) === server)
}

export interface Verdict {
  losses: Violation[]
  diverged: boolean
  divergedSet: boolean
  livelock: boolean
  violated: boolean
  refViolated: boolean
  refDiverged: boolean
}

/** All three checks for one scenario, against the document rule replayed on it. */
export function judge(scenario: Scenario, rule: Rule, reference: Rule): Verdict {
  const outcome = run(scenario, rule)
  const ref = run(scenario, reference, true)
  const bad = violations(outcome)
  const refBad = new Set(violations(ref).map((violation) => violation.unit))
  return {
    losses: bad.filter((violation) => !refBad.has(violation.unit)),
    diverged: !converged(outcome),
    divergedSet: !converged(outcome, true),
    livelock: outcome.livelock,
    violated: bad.length > 0,
    refViolated: refBad.size > 0,
    refDiverged: !converged(ref) || ref.livelock
  }
}

/** Mulberry32: a small seeded generator, so every run replays from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const POOLS: Record<Config, [Kind, Init][]> = {
  trusted: [
    ['newDesk', 'stamped'],
    ['newCore', 'stamped']
  ],
  newUntrusted: [
    ['newDesk', 'stamped'],
    ['newDesk', 'nobase'],
    ['newCore', 'stamped'],
    ['newCore', 'legacy']
  ],
  oldPlusTrusted: [
    ['oldDesk', 'legacy'],
    ['oldCore', 'legacy'],
    ['newDesk', 'stamped'],
    ['newCore', 'stamped']
  ],
  deskOnly: [
    ['newDesk', 'stamped'],
    ['newDesk', 'nobase'],
    ['oldDesk', 'legacy']
  ],
  coreOnly: [
    ['newCore', 'stamped'],
    ['newCore', 'legacy'],
    ['oldCore', 'legacy']
  ],
  mixed: [
    ['newDesk', 'stamped'],
    ['newDesk', 'nobase'],
    ['newCore', 'stamped'],
    ['newCore', 'legacy'],
    ['oldDesk', 'legacy'],
    ['oldCore', 'legacy']
  ]
}

export const CONFIGS = Object.keys(POOLS) as Config[]

export function generate(config: Config, server: ServerMode, seed: number): Scenario {
  const next = random(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]
  const count = 2 + Math.floor(next() * 4)
  const devices = Array.from({ length: count }, (_, i) => {
    const [kind, init] = pick(POOLS[config])
    return { id: `D${i}`, kind, init }
  })
  const steps: Step[] = []
  const length = 6 + Math.floor(next() * 35)
  for (let i = 0; i < length; i++) {
    const dev = pick(devices).id
    const roll = next()
    if (roll < 0.4) {
      const prop = next() < 0.4
      const change: Change = prop
        ? next() < 0.7
          ? { setProp: [pick(PROPS), `${dev}-${i}`] }
          : { delProp: pick(PROPS) }
        : next() < 0.5
          ? { addTag: pick(TAGS) }
          : { removeTag: pick(TAGS) }
      steps.push({ op: 'edit', dev, change })
    } else if (roll < 0.5) steps.push({ op: 'body', dev })
    else if (roll < 0.72) steps.push({ op: 'push', dev })
    else if (roll < 0.94) steps.push({ op: 'pull', dev })
    else steps.push({ op: 'upgrade', dev })
  }
  return { seed, server, devices, steps }
}

/** Drops steps and devices while `fails` still holds: a minimal trace to read. */
export function shrink(scenario: Scenario, fails: (s: Scenario) => boolean): Scenario {
  let current = scenario
  let progress = true
  while (progress) {
    progress = false
    for (let i = current.steps.length - 1; i >= 0; i--) {
      const candidate = { ...current, steps: current.steps.toSpliced(i, 1) }
      if (fails(candidate)) {
        current = candidate
        progress = true
      }
    }
    for (const device of current.devices) {
      const candidate = {
        ...current,
        devices: current.devices.filter((d) => d.id !== device.id),
        steps: current.steps.filter((step) => step.dev !== device.id)
      }
      if (candidate.devices.length > 0 && fails(candidate)) {
        current = candidate
        progress = true
      }
    }
  }
  return current
}
