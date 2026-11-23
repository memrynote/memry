import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'
import { tagKey } from '@memry/shared/tag-fold'
import { compare as compareClock, merge as mergeClock } from '@memry/sync-client/vector-clock'
import { mergeFields, valuesEqual } from './field-merge'

/**
 * The journal keys chapter 06 §6.12 merges per unit. `fieldClocks` holds one
 * clock per `tags.<tagKey>` and `properties.<key>` unit: the document clock at
 * which a device last wrote that unit. A unit clocked but absent from the
 * value is a removal. `fieldClocksFloor` covers every unit `fieldClocks` does
 * not name: the payload supersedes every write to it at or before the floor.
 */
export interface JournalFields {
  tags?: string[] | null
  properties?: Record<string, unknown> | null
  clock?: VectorClock
  fieldClocks?: FieldClocks
  fieldClocksAt?: VectorClock
  fieldClocksFloor?: VectorClock
}

/** The unit clock keys a journal payload carries (§6.12). */
export interface JournalUnitStamp {
  fieldClocks: FieldClocks
  fieldClocksAt: VectorClock
  fieldClocksFloor?: VectorClock
}

export interface JournalFieldsMerge {
  tags: string[]
  properties: Record<string, unknown>
  fieldClocks: FieldClocks
  fieldClocksFloor?: VectorClock
  /** Some local unit clock is concurrent with or ahead of the remote's (§6.5.2 P3). */
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

function stamp(fieldClocks: FieldClocks, at: VectorClock, floor?: VectorClock): JournalUnitStamp {
  const out: JournalUnitStamp = { fieldClocks, fieldClocksAt: { ...at } }
  if (floor !== undefined && Object.keys(floor).length > 0) out.fieldClocksFloor = { ...floor }
  return out
}

/**
 * §6.12.2: the unit clocks a local edit pushes. Each unit whose value differs
 * from `base`, the last synced fields, takes `next.clock`; the rest keep
 * theirs, and so does the base's floor. An untrusted base clocks no unit: it
 * was written whole at its clock, which becomes the floor. With no base the
 * writer cannot tell which units it wrote since it last synced, so the edit
 * carries no unit clocks and is read whole at its clock, as an older build's is.
 */
export function journalFieldClocksForEdit(
  base: JournalFields | null,
  next: JournalFields & { clock: VectorClock }
): JournalUnitStamp | null {
  if (base === null) return null
  const clocks: FieldClocks = trusted(base) ? { ...base.fieldClocks } : {}
  const before = units(base)
  const after = units(next)
  for (const unit of new Set([...before.keys(), ...after.keys()])) {
    if (!valuesEqual(before.get(unit), after.get(unit))) clocks[unit] = { ...next.clock }
  }
  return stamp(clocks, next.clock, trusted(base) ? base.fieldClocksFloor : (base.clock ?? {}))
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

/**
 * §6.12.3: a concurrent pair merges per unit by §6.3's rule. A winner with no
 * value removes the unit. Local survivors keep local order and spelling, then
 * remote-only survivors follow in remote order.
 */
export function mergeJournalFields(
  local: JournalFields,
  remote: JournalFields
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
  // §6.12.1: an untrusted local side proves nothing. Its `clock` carries
  // this device's ticks since it last synced, body-only saves included, so
  // the remote wins each unit, as the document rule applies a concurrent
  // remote whole. An untrusted remote reads at its clock on every unit, the
  // document rule it ran.
  const localStamped: FieldClocks = trusted(local) ? local.fieldClocks : {}
  const localFloor = trusted(local) ? local.fieldClocksFloor : undefined
  const remoteStamped: FieldClocks = trusted(remote)
    ? remote.fieldClocks
    : Object.fromEntries(all.map((unit) => [unit, { ...remote.clock }]))
  const remoteFloor = trusted(remote) ? remote.fieldClocksFloor : (remote.clock ?? {})
  const localClocks: FieldClocks = {}
  const remoteClocks: FieldClocks = {}
  // Units a trusted side wrote and no floor superseded: only these keep a
  // clock, so a record's clock never turns into a write.
  const written: string[] = []
  for (const unit of all) {
    const localFloored = localStamped[unit]
      ? undefined
      : floorAgainst(localFloor, remoteStamped[unit] ?? remoteFloor)
    const remoteFloored = remoteStamped[unit]
      ? undefined
      : floorAgainst(remoteFloor, localStamped[unit] ?? localFloor)
    const localClock = localStamped[unit] ?? localFloored
    const remoteClock = remoteStamped[unit] ?? remoteFloored
    if (localClock !== undefined) localClocks[unit] = localClock
    if (remoteClock !== undefined) remoteClocks[unit] = remoteClock
    const wrote =
      localStamped[unit] !== undefined || (trusted(remote) && remoteStamped[unit] !== undefined)
    if (wrote && !localFloored && !remoteFloored) written.push(unit)
  }
  const { merged, mergedFieldClocks } = mergeFields(
    Object.fromEntries(localUnits),
    Object.fromEntries(remoteUnits),
    localClocks,
    remoteClocks,
    all
  )
  const kept = (unit: string): boolean => merged[unit] !== undefined

  const order = [
    ...localUnits.keys(),
    ...[...remoteUnits.keys()].filter((unit) => !localUnits.has(unit))
  ].filter(kept)
  const tags: string[] = []
  const properties: Record<string, unknown> = {}
  for (const unit of order) {
    if (unit.startsWith(TAG)) {
      const tag = localUnits.get(unit) ?? merged[unit]
      if (typeof tag === 'string') tags.push(tag)
    } else {
      properties[unit.slice(PROPERTY.length)] = merged[unit]
    }
  }

  // Every unit neither side names reads as absent on both, so the merged
  // payload supersedes what either floor did.
  const floor = mergeClock(localFloor ?? {}, remoteFloor ?? {})
  const fieldClocks: FieldClocks = {}
  for (const unit of written) fieldClocks[unit] = mergedFieldClocks[unit]
  return {
    tags,
    properties,
    fieldClocks,
    ...(Object.keys(floor).length > 0 ? { fieldClocksFloor: floor } : {}),
    requeue: all.some((unit) => {
      const unitOrder = compareClock(localClocks[unit] ?? {}, remoteClocks[unit] ?? {})
      return unitOrder === 'concurrent' || unitOrder === 'after'
    })
  }
}
