/**
 * Models of the four journal sync clients a vault can mix (chapter 06 §6.12),
 * driving the real pure functions of `journal-merge.ts`. Each model mirrors
 * the code that owns the behaviour; keep them in step with it:
 *
 * - `newDesk`: `apps/desktop/src/main/sync/item-handlers/journal-handler.ts`
 *   (the `journal.fields` base, §6.5.2 P4 on fields only, the merge re-queue)
 *   and the push coordinator's unknown-field remainder.
 * - `newCore`: `crates/memry-core/src/sync/journal_merge.rs` (`apply_remote`,
 *   `apply_whole`, `local_edit_changes`) behind `task_merge::document_gate`.
 * - `oldDesk`: desktop v2026-11-20. A concurrent remote applies whole under the
 *   union clock and re-queues; unknown keys ride in the remainder (§13.2.1).
 * - `oldCore`: the core before #5508. The payload is stored verbatim (§13.2), a
 *   concurrent remote applies whole under the union clock, and nothing
 *   re-queues (`apply_document`).
 *
 * The server keeps one row and accepts a push with any component ahead of it
 * (§6.5.2 P1).
 */
import type { VectorClock } from '@memry/contracts/sync-api'
import { valuesEqual } from '../field-merge'
import { resolveClockConflict } from '../item-handlers/types'
import {
  journalFieldClocksForEdit,
  journalFieldClocksForWholesale,
  mergeJournalFields,
  type JournalFields,
  type JournalFieldsMerge,
  type JournalUnitStamp
} from '../journal-merge'
import { compare, increment, merge } from '../vector-clock'

export type Kind = 'newDesk' | 'newCore' | 'oldDesk' | 'oldCore'

export interface Payload extends JournalFields {
  tags: string[]
  properties: Record<string, unknown>
  clock: VectorClock
}

export type Change =
  | { addTag: string }
  | { removeTag: string }
  | { setProp: [string, string] }
  | { delProp: string }

/** One call into the shared rule, recorded for the Rust replay. */
export type RuleCall =
  | { fn: 'edit'; base: JournalFields | null; next: Payload; out: JournalUnitStamp | null }
  | { fn: 'wholesale'; remote: Payload; out: JournalUnitStamp | null }
  | { fn: 'merge'; local: Payload; remote: Payload; device: string; out: JournalFieldsMerge }

const STAMP_KEYS = ['fieldClocks', 'fieldClocksAt', 'fieldClocksFloor', 'fieldFloors'] as const

const clone = <T>(value: T): T => structuredClone(value)

/** The rule as every new build runs it, optionally recording each call. */
export class Rule {
  readonly calls: RuleCall[] | null

  constructor(record = false) {
    this.calls = record ? [] : null
  }

  edit(base: JournalFields | null, next: Payload): JournalUnitStamp | null {
    const out = journalFieldClocksForEdit(base, next)
    this.calls?.push({ fn: 'edit', base: clone(base), next: clone(next), out: clone(out) })
    return out
  }

  wholesale(remote: Payload): JournalUnitStamp | null {
    const out = journalFieldClocksForWholesale(remote)
    this.calls?.push({ fn: 'wholesale', remote: clone(remote), out: clone(out) })
    return out
  }

  merge(local: Payload, remote: Payload, device: string): JournalFieldsMerge {
    const out = mergeJournalFields(local, remote, device)
    this.calls?.push({
      fn: 'merge',
      local: clone(local),
      remote: clone(remote),
      device,
      out: clone(out)
    })
    return out
  }
}

export interface Device {
  readonly id: string
  kind: Kind
  tags: string[]
  properties: Record<string, unknown>
  clock: VectorClock
  /** `newDesk`: the `journal.fields` base in `sync_state`. */
  base: JournalFields | null
  /** Desktop: the unknown-field remainder. Core: the stored stamp keys. */
  extra: Partial<Payload>
  pending: boolean
  cursor: number
}

export interface Server {
  row: Payload
  version: number
}

function stampKeys(payload: Partial<Payload>): Partial<Payload> {
  const out: Partial<Payload> = {}
  for (const key of STAMP_KEYS) {
    if (payload[key] !== undefined) Object.assign(out, { [key]: clone(payload[key]) })
  }
  return out
}

function fields(device: Device): Payload {
  return {
    tags: [...device.tags],
    properties: { ...device.properties },
    clock: { ...device.clock }
  }
}

/** What a core stores: the payload with its stamp keys. */
function stored(device: Device): Payload {
  return { ...fields(device), ...clone(device.extra) }
}

function setStored(device: Device, payload: Payload): void {
  device.tags = [...payload.tags]
  device.properties = { ...payload.properties }
  device.clock = { ...payload.clock }
  device.extra = stampKeys(payload)
}

const isDesk = (kind: Kind): boolean => kind === 'newDesk' || kind === 'oldDesk'

/** Applies `change` to the device's values; `false` when it changes nothing. */
function change(device: Device, edit: Change): boolean {
  if ('addTag' in edit) {
    if (device.tags.includes(edit.addTag)) return false
    device.tags = [...device.tags, edit.addTag]
  } else if ('removeTag' in edit) {
    if (!device.tags.includes(edit.removeTag)) return false
    device.tags = device.tags.filter((tag) => tag !== edit.removeTag)
  } else if ('setProp' in edit) {
    const [key, value] = edit.setProp
    if (device.properties[key] === value) return false
    device.properties = { ...device.properties, [key]: value }
  } else {
    if (!(edit.delProp in device.properties)) return false
    const { [edit.delProp]: _gone, ...rest } = device.properties
    device.properties = rest
  }
  return true
}

/** A local save: `edit` changes tags or properties, `null` is a body-only save. */
export function localEdit(device: Device, rule: Rule, edit: Change | null): boolean {
  const before = stored(device)
  if (edit !== null && !change(device, edit)) return false
  device.clock = increment(device.clock, device.id)
  device.pending = true
  if (device.kind === 'newCore') {
    // `sync_items::apply_local_edit_in` restamps every journal write.
    const next = stored(device)
    device.extra = stampKeys(rule.edit(before, next) ?? {})
  }
  return true
}

/** The payload a push sends, rebuilt from the live row (§6.5.2 P2). */
export function buildPush(device: Device, rule: Rule): Payload {
  if (!isDesk(device.kind)) return stored(device)
  let payload: Payload = fields(device)
  if (device.kind === 'newDesk') {
    const stamp = rule.edit(device.base, payload)
    if (stamp !== null) {
      device.base = { ...fields(device), ...clone(stamp) }
      payload = { ...payload, ...clone(stamp) }
    }
  }
  // `mergeUnknownPayloadFields`: a remainder key the payload lacks rides along.
  for (const [key, value] of Object.entries(device.extra)) {
    if (!(key in payload)) Object.assign(payload, { [key]: clone(value) })
  }
  return payload
}

export type PullAction = 'none' | 'skip' | 'apply' | 'merge'

function applyDesk(device: Device, rule: Rule, remote: Payload): PullAction {
  // `recordUnknownPayloadFields`: an older desktop strips the stamp keys into
  // the remainder; a newer one knows them, so its remainder clears.
  device.extra = device.kind === 'oldDesk' ? stampKeys(remote) : {}
  const identical = (): boolean =>
    valuesEqual(
      { tags: device.tags, properties: device.properties, clock: device.clock },
      { tags: remote.tags, properties: remote.properties, clock: remote.clock }
    )
  const resolution = resolveClockConflict(device.clock, remote.clock, identical)
  if (resolution.action === 'skip') return 'skip'
  if (resolution.action === 'apply') {
    device.tags = [...remote.tags]
    device.properties = { ...remote.properties }
    device.clock = { ...remote.clock }
    if (device.kind === 'newDesk') {
      device.base = {
        ...fields(device),
        ...(rule.wholesale(remote) ?? stampKeys(remote))
      }
    }
    return 'apply'
  }
  if (device.kind === 'oldDesk') {
    device.tags = [...remote.tags]
    device.properties = { ...remote.properties }
    device.clock = { ...resolution.mergedClock }
    // The pull coordinator re-queues a `'conflict'` journal.
    device.pending = true
    return 'merge'
  }
  const local = { ...fields(device), ...rule.edit(device.base, fields(device)) }
  const merged = rule.merge(local, remote, device.id)
  device.tags = [...merged.tags]
  device.properties = { ...merged.properties }
  device.clock = { ...merged.clock }
  device.base = { ...fields(device), ...stampKeys(merged) }
  // `'conflict'` re-queues the journal only when the merge changed its fields.
  if (merged.requeue) device.pending = true
  return 'merge'
}

function applyCore(device: Device, rule: Rule, remote: Payload): PullAction {
  const local = stored(device)
  const order = compare(local.clock, remote.clock)
  if (order === 'after') return 'skip'
  if (order === 'equal' && valuesEqual(local, remote)) return 'skip'
  if (order !== 'concurrent') {
    const stamp = device.kind === 'newCore' ? rule.wholesale(remote) : null
    const next: Payload = stamp === null ? clone(remote) : { ...clone(remote), ...clone(stamp) }
    // §6.5.2 P4 against the stamped payload: a re-pulled record.
    if (valuesEqual(local, next)) return 'skip'
    setStored(device, next)
    return 'apply'
  }
  const union = merge(local.clock, remote.clock)
  if (device.kind === 'oldCore') {
    setStored(device, { ...clone(remote), clock: union })
    return 'merge'
  }
  const merged = rule.merge(local, remote, device.id)
  const {
    fieldClocks: _c,
    fieldClocksAt: _a,
    fieldClocksFloor: _f,
    fieldFloors: _u,
    ...rest
  } = clone(remote)
  setStored(device, {
    ...rest,
    tags: merged.tags,
    properties: merged.properties,
    clock: merged.clock,
    ...stampKeys(merged)
  })
  if (merged.requeue) device.pending = true
  return 'merge'
}

/** A pull of the server row, when it changed since this device last pulled. */
export function pull(device: Device, rule: Rule, server: Server): PullAction {
  if (device.cursor === server.version) return 'none'
  device.cursor = server.version
  const remote = clone(server.row)
  return isDesk(device.kind) ? applyDesk(device, rule, remote) : applyCore(device, rule, remote)
}

/** A queued push; the server takes it when any component is ahead (P1). */
export function push(device: Device, rule: Rule, server: Server): Payload | null {
  if (!device.pending) return null
  device.pending = false
  const payload = buildPush(device, rule)
  const ahead = Object.entries(payload.clock).some(
    ([id, tick]) => tick > (server.row.clock[id] ?? 0)
  )
  if (!ahead) return null
  server.row = payload
  server.version += 1
  return payload
}

/** An older build updated in place: desktop keeps no base, core its payload. */
export function upgrade(device: Device): void {
  if (device.kind === 'oldDesk') {
    device.kind = 'newDesk'
    device.base = null
  } else if (device.kind === 'oldCore') {
    device.kind = 'newCore'
  }
}

export type Init = 'stamped' | 'nobase' | 'legacy'

export const INITIAL: Payload = {
  tags: ['a', 'b'],
  properties: { p: 1, q: 'x' },
  clock: { X: 1 }
}

/** A device holding the initial record as its build and history left it. */
export function makeDevice(id: string, kind: Kind, init: Init, server: Payload): Device {
  const device: Device = {
    id,
    kind,
    tags: [...INITIAL.tags],
    properties: { ...INITIAL.properties },
    clock: { ...INITIAL.clock },
    base: null,
    extra: {},
    pending: false,
    cursor: 0
  }
  const wholesale = journalFieldClocksForWholesale(INITIAL) ?? {}
  if (kind === 'newDesk' && init === 'stamped') device.base = { ...clone(INITIAL), ...wholesale }
  if (kind === 'newCore' && init === 'stamped') device.extra = stampKeys(wholesale)
  // A desktop that pulled a stamped row as an older build keeps its keys.
  if (isDesk(kind) && init !== 'stamped') device.extra = stampKeys(server)
  return device
}
