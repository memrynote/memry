import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'
import { tagKey } from '@memry/shared/tag-fold'
import {
  compare as compareClock,
  increment,
  merge as mergeClock
} from '@memry/sync-client/vector-clock'
import { valuesEqual } from './field-merge'

/**
 * The journal keys chapter 06 §6.12 merges per unit. `fieldClocks` holds one
 * clock per `tags.<tagKey>` and `properties.<key>` unit: the document clock at
 * which a device last wrote that unit. A unit clocked but absent from the
 * value is a removal. `fieldClocksFloor` covers every unit `fieldClocks` does
 * not name: the payload supersedes every write to it at or before the floor.
 * `fieldFloors` overrides that floor for the units it names, where a merge
 * kept a value only one side's floor covered. It is an additive key: an older
 * build that pushes it ticks `clock` past `fieldClocksAt`, which makes it
 * untrusted, so it is read only from a writer that knows it.
 */
export interface JournalFields {
  tags?: string[] | null
  properties?: Record<string, unknown> | null
  clock?: VectorClock
  fieldClocks?: FieldClocks
  fieldClocksAt?: VectorClock
  fieldClocksFloor?: VectorClock
  fieldFloors?: FieldClocks
}

/** The unit clock keys a journal payload carries (§6.12). */
export interface JournalUnitStamp {
  fieldClocks: FieldClocks
  fieldClocksAt: VectorClock
  fieldClocksFloor?: VectorClock
  fieldFloors?: FieldClocks
}

/** A merged pair and the clock it is stored and stamped at (§6.12.3). */
export interface JournalFieldsMerge extends JournalUnitStamp {
  tags: string[]
  properties: Record<string, unknown>
  clock: VectorClock
  /** The merged fields differ from the remote's, so the merge is pushed. */
  requeue: boolean
}

const TAG = 'tags.'
const PROPERTY = 'properties.'

/** Units in value order; a case variant of an earlier tag is the same unit (§1.9.1 step 6). */
function units(side: JournalFields): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const tag of side.tags ?? []) {
    const unit = TAG + tagKey(tag)
    if (!out.has(unit)) out.set(unit, tag)
  }
  for (const [key, value] of Object.entries(side.properties ?? {})) {
    if (value !== undefined) out.set(PROPERTY + key, value)
  }
  return out
}

/**
 * §6.12.1: a side's unit clocks are trusted only when a writer that knows them
 * stamped them at the clock it pushed. Not so with no `fieldClocks`, or when
 * an older build ticked `clock` past the stamp.
 */
function trusted(side: JournalFields): side is JournalFields & { fieldClocks: FieldClocks } {
  return (
    side.fieldClocks !== undefined &&
    side.fieldClocksAt !== undefined &&
    valuesEqual(side.fieldClocksAt, side.clock ?? {})
  )
}

function stamp(
  fieldClocks: FieldClocks,
  at: VectorClock,
  floor?: VectorClock,
  floors?: FieldClocks
): JournalUnitStamp {
  const out: JournalUnitStamp = { fieldClocks, fieldClocksAt: { ...at } }
  if (floor !== undefined && Object.keys(floor).length > 0) out.fieldClocksFloor = { ...floor }
  if (floors !== undefined && Object.keys(floors).length > 0) out.fieldFloors = floors
  return out
}

/** §6.12.1: the floor a side reads for `unit`; an untrusted side's is its clock. */
function unitFloor(side: JournalFields, unit: string): VectorClock | undefined {
  if (!trusted(side)) return side.clock ?? {}
  return side.fieldFloors?.[unit] ?? side.fieldClocksFloor
}

/**
 * §6.12.2: the unit clocks a local edit pushes. Each unit whose value differs
 * from `base`, the last synced fields, takes `next.clock`; the rest keep
 * theirs, and so do the base's floor and the unit floors of unchanged
 * units. An untrusted base clocks no unit: it
 * was written whole at its clock, which becomes the floor. With no base the
 * writer cannot tell which units it wrote since it last synced, so the edit
 * carries no unit clocks and is read whole at its clock, as an older build's is.
 */
export function journalFieldClocksForEdit(
  base: JournalFields | null,
  next: JournalFields & { clock: VectorClock }
): JournalUnitStamp | null {
  if (base === null) return null
  if (!trusted(base)) return stamp(edited(base, next, {}), next.clock, base.clock ?? {})
  const clocks = edited(base, next, { ...base.fieldClocks })
  const floors: FieldClocks = {}
  for (const [unit, floor] of Object.entries(base.fieldFloors ?? {})) {
    if (clocks[unit] === undefined) floors[unit] = { ...floor }
  }
  return stamp(clocks, next.clock, base.fieldClocksFloor, floors)
}

/** `clocks` with every unit whose value `next` changed from `base` clocked at `next.clock`. */
function edited(
  base: JournalFields,
  next: JournalFields & { clock: VectorClock },
  clocks: FieldClocks
): FieldClocks {
  const before = units(base)
  const after = units(next)
  for (const unit of new Set([...before.keys(), ...after.keys()])) {
    if (!valuesEqual(before.get(unit), after.get(unit))) clocks[unit] = { ...next.clock }
  }
  return clocks
}

/**
 * §6.12.1: the unit clocks a device keeps with `remote` applied whole
 * (§6.3.1 `before` or `equal`, or a first sighting). A trusted remote keeps
 * its own (`null`). An untrusted one was written whole at its clock, so it
 * clocks no unit and its clock is the floor: the next edit from it carries
 * its removals, and none of its units outranks a concurrent write.
 */
export function journalFieldClocksForWholesale(remote: JournalFields): JournalUnitStamp | null {
  if (trusted(remote)) return null
  return stamp({}, remote.clock ?? {}, remote.clock ?? {})
}

/**
 * §6.12.1: a floor supersedes every write it has seen, so it reads at its
 * clock against the other side's claim on a unit only when it strictly
 * dominates that claim, or there is none. A write concurrent with it is one
 * its writer never saw.
 */
function floorAgainst(
  floor: VectorClock | undefined,
  other: VectorClock | undefined
): VectorClock | undefined {
  if (floor === undefined) return undefined
  return other === undefined || compareClock(other, floor) === 'before' ? floor : undefined
}

function clockTotal(clock: VectorClock): number {
  return Object.values(clock).reduce((sum, tick) => sum + tick, 0)
}

/** JSON with object keys sorted: the order two values tie-break in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        )
      : inner
  )
}

/**
 * §6.12.3: whether the local write beats a concurrent remote one. More ticks
 * win; on a tie a value beats an absence, then the greater canonical value
 * wins. Both sides compute the same winner, so the order is total.
 */
function localWinsTie(
  localClock: VectorClock,
  remoteClock: VectorClock,
  localValue: unknown,
  remoteValue: unknown
): boolean {
  const byTicks = clockTotal(localClock) - clockTotal(remoteClock)
  if (byTicks !== 0) return byTicks > 0
  if (localValue === undefined || remoteValue === undefined) return remoteValue === undefined
  return canonical(localValue) > canonical(remoteValue)
}

/**
 * §6.12.3: a concurrent pair merges per unit. A unit's claim is a trusted
 * side's stamped clock, or its floor where the floor dominates the other
 * side's claim. A claim that dominates the other wins; two concurrent claims
 * tie-break on ticks then value; with no claim on either side the remote's
 * value stands, as the document rule has it. A winner with no value removes
 * the unit. Local survivors keep local order and spelling, then remote-only
 * survivors follow in remote order.
 *
 * A result that holds the remote's fields is the remote's record: it keeps
 * the remote's order, is stored at the union clock and is not pushed. Any
 * other result is stored at the union ticked by `device` and re-queued, so the
 * push dominates both inputs and an older core applies it whole.
 */
export function mergeJournalFields(
  local: JournalFields,
  remote: JournalFields,
  device: string
): JournalFieldsMerge {
  const localUnits = units(local)
  const remoteUnits = units(remote)
  const all = [
    ...new Set([
      ...Object.keys(local.fieldClocks ?? {}),
      ...Object.keys(remote.fieldClocks ?? {}),
      ...localUnits.keys(),
      ...remoteUnits.keys()
    ])
  ].toSorted()
  // §6.12.1: an untrusted side was written whole at its clock, which is its
  // floor: it reads only where it dominates the other side's claim.
  const localStamped: FieldClocks = trusted(local) ? local.fieldClocks : {}
  const remoteStamped: FieldClocks = trusted(remote) ? remote.fieldClocks : {}
  // Every unit neither side names reads as absent on both, so the merged
  // payload supersedes what either record floor did.
  const recordFloor = mergeClock(
    (trusted(local) ? local.fieldClocksFloor : local.clock) ?? {},
    (trusted(remote) ? remote.fieldClocksFloor : remote.clock) ?? {}
  )

  const merged = new Map<string, unknown>()
  const fieldClocks: FieldClocks = {}
  const fieldFloors: FieldClocks = {}
  for (const unit of all) {
    const localValue = localUnits.get(unit)
    const remoteValue = remoteUnits.get(unit)
    const localWrite = localStamped[unit]
    const remoteWrite = remoteStamped[unit]
    const localFloor = unitFloor(local, unit)
    const remoteFloor = unitFloor(remote, unit)
    const localClaim = localWrite ?? floorAgainst(localFloor, remoteWrite ?? remoteFloor)
    const remoteClaim = remoteWrite ?? floorAgainst(remoteFloor, localWrite ?? localFloor)
    let localWins = false
    if (localClaim !== undefined && remoteClaim === undefined) localWins = true
    else if (localClaim !== undefined && remoteClaim !== undefined) {
      const order = compareClock(localClaim, remoteClaim)
      localWins =
        order === 'after' ||
        (order === 'concurrent' && localWinsTie(localClaim, remoteClaim, localValue, remoteValue))
    }
    const value = localWins ? localValue : remoteValue
    if (value !== undefined) merged.set(unit, value)
    // A stamped winner keeps its own write clock: the loser's is no write
    // of this value. Two writes of one value keep both.
    const write = localWins ? localWrite : remoteWrite
    if (write !== undefined) {
      const other = localWins ? remoteWrite : localWrite
      const same = other !== undefined && valuesEqual(localValue, remoteValue)
      fieldClocks[unit] = same ? mergeClock(write, other) : { ...write }
      continue
    }
    // A unit floor claims only the writes its value supersedes: both floors
    // when the sides agree, else the winner's alone. The loser's floor covers
    // its own write of a value the merge dropped, which a later write to the
    // unit concurrent with the winner's floor must still beat (#5508 (a)).
    const winnerFloor = (localWins ? localFloor : remoteFloor) ?? {}
    const floor = valuesEqual(localValue, remoteValue)
      ? mergeClock(localFloor ?? {}, remoteFloor ?? {})
      : winnerFloor
    if (compareClock(floor, recordFloor) !== 'equal') fieldFloors[unit] = { ...floor }
  }

  const order = [
    ...localUnits.keys(),
    ...[...remoteUnits.keys()].filter((unit) => !localUnits.has(unit))
  ].filter((unit) => merged.has(unit))
  let tags: string[] = []
  let properties: Record<string, unknown> = {}
  for (const unit of order) {
    if (unit.startsWith(TAG)) {
      const tag = localUnits.get(unit) ?? merged.get(unit)
      if (typeof tag === 'string') tags.push(tag)
    } else {
      properties[unit.slice(PROPERTY.length)] = merged.get(unit)
    }
  }
  const remoteTags = remote.tags ?? []
  const remoteProperties = remote.properties ?? {}
  const sameTags = valuesEqual(tags.toSorted(), remoteTags.toSorted())
  if (sameTags && valuesEqual(properties, remoteProperties)) {
    tags = [...remoteTags]
    properties = { ...remoteProperties }
  }
  const requeue = !valuesEqual(
    { tags, properties },
    { tags: remoteTags, properties: remoteProperties }
  )
  const union = mergeClock(local.clock ?? {}, remote.clock ?? {})
  const clock = requeue ? increment(union, device) : union

  return {
    tags,
    properties,
    clock,
    requeue,
    ...stamp(fieldClocks, clock, recordFloor, fieldFloors)
  }
}
