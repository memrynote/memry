import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'
import { tagKey } from '@memry/shared/tag-fold'
import { compare as compareClock } from '@memry/sync-client/vector-clock'
import { mergeFields, valuesEqual } from './field-merge'

/**
 * The journal keys chapter 06 §6.12 merges per unit. `fieldClocks` holds one
 * clock per `tags.<tagKey>` and `properties.<key>` unit: the document clock at
 * which a device last wrote that unit. A unit clocked but absent from the
 * value is a removal.
 */
export interface JournalFields {
  tags?: string[] | null
  properties?: Record<string, unknown> | null
  clock?: VectorClock
  fieldClocks?: FieldClocks
  fieldClocksAt?: VectorClock
}

export interface JournalFieldsMerge {
  tags: string[]
  properties: Record<string, unknown>
  fieldClocks: FieldClocks
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
 * stamped them at the clock it pushed. Otherwise (no `fieldClocks`, or an older
 * build ticked `clock` past the stamp) the side was written whole at its
 * document clock: every unit in `union`, and every unit it names, takes that
 * clock, so a unit it lacks is a removal rather than an unclocked absence.
 */
export function journalUnitClocks(side: JournalFields, union: Iterable<string> = []): FieldClocks {
  const map = side.fieldClocks ?? {}
  const trusted =
    side.fieldClocks !== undefined &&
    side.fieldClocksAt !== undefined &&
    valuesEqual(side.fieldClocksAt, side.clock ?? {})
  if (trusted) return { ...map }
  const clock = side.clock ?? {}
  const seeded: FieldClocks = {}
  for (const unit of [...union, ...Object.keys(map), ...units(side).keys()]) {
    seeded[unit] = { ...clock }
  }
  return seeded
}

/**
 * §6.12.2: the unit clocks a local edit pushes. Each unit whose value differs
 * from `base`, the last synced fields, takes `next.clock`; the rest keep theirs.
 * With no base every unit is seeded at `next.clock`.
 */
export function journalFieldClocksForEdit(
  base: JournalFields | null,
  next: JournalFields & { clock: VectorClock }
): { fieldClocks: FieldClocks; fieldClocksAt: VectorClock } {
  const from = base ?? { tags: next.tags, properties: next.properties, clock: next.clock }
  const clocks = journalUnitClocks(from)
  const before = units(from)
  const after = units(next)
  for (const unit of new Set([...before.keys(), ...after.keys()])) {
    if (!valuesEqual(before.get(unit), after.get(unit))) clocks[unit] = { ...next.clock }
  }
  return { fieldClocks: clocks, fieldClocksAt: { ...next.clock } }
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
  const localClocks = journalUnitClocks(local, all)
  const remoteClocks = journalUnitClocks(remote, all)

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

  return {
    tags,
    properties,
    fieldClocks: mergedFieldClocks,
    requeue: all.some((unit) => {
      const unitOrder = compareClock(localClocks[unit] ?? {}, remoteClocks[unit] ?? {})
      return unitOrder === 'concurrent' || unitOrder === 'after'
    })
  }
}
