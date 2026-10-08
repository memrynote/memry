/**
 * Versioned values, protocol chapter 06 §6.11: the merge rule for the two keys
 * that ride inside shipped payloads, `tag_definition.schema` (one versioned
 * object) and `task.fields` (a map of versioned entries `{ v, t }`).
 *
 * The version lives inside the value because three shipped peers can hand back
 * an old value under a newer document clock. Desktops before #2265 strip the
 * key. Desktops since #2265 echo the remainder captured from the last pulled
 * payload, which is captured before the clock gate and so can be a skipped,
 * stale one. The Rust core keeps its local copy of an unmodelled key on a
 * concurrent task merge. A version carried by the value travels through all
 * three, so a stale echo loses on `t` whatever clock carried it.
 *
 * `t` is a Lamport counter, not a vector clock. Stamping needs no device id, so
 * `_offline` never enters a value, and "higher `t`, then larger canonical JSON"
 * is a total order, so every join here is commutative, associative and
 * idempotent.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Any JSON object; its version is `versionOf(value)`. Values come from peers,
 * so nothing about their keys is trusted, and keys a newer build adds are
 * carried whole.
 */
export type VersionedObject = Readonly<Record<string, unknown>>

/** A field name to its entry `{ v, t }`, where `v: null` is a removal. */
export type VersionedMap = Readonly<Record<string, VersionedObject>>

export interface JoinResult<T> {
  /** The value to store; `undefined` only when neither side holds one. */
  readonly value: T | undefined
  /**
   * The joined value differs from what the remote carried (the key was
   * absent, older, or missing entries), so the remote needs a re-push. Never
   * true for a remote `null`, which carries no information (§6.11.2).
   */
  readonly remoteBehind: boolean
  /** The joined value differs from the local one, so it has to be written. */
  readonly localChanged: boolean
}

export type ApplyBranch = 'insert' | 'skip' | 'apply' | 'merge'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `t` when it is a safe integer `>= 0`, else 0: a broken version loses every tie it can. */
export function versionOf(value: unknown): number {
  if (!isPlainObject(value)) return 0
  const { t } = value
  return typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 ? t : 0
}

/**
 * §6.4.2's number form, which is Rust's `f64` display: the shortest digits
 * that round-trip, never an exponent, and `-0` as `0`. JavaScript's own
 * `String(n)` switches to an exponent from `1e21` up and below `1e-6`, so
 * those are expanded here.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) return 'null'
  if (value === 0) return '0'
  const text = String(value)
  const exponentAt = text.indexOf('e')
  if (exponentAt === -1) return text
  const sign = text.startsWith('-') ? '-' : ''
  const mantissa = text.slice(sign.length, exponentAt)
  const exponent = Number(text.slice(exponentAt + 1))
  const pointAt = mantissa.indexOf('.')
  const digits = mantissa.replace('.', '')
  const point = (pointAt === -1 ? mantissa.length : pointAt) + exponent
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

/**
 * The canonical form of chapter 06 §6.4.2, used for every equality and
 * tie-break here: object keys sorted by UTF-16 code units at every depth,
 * arrays in order, no whitespace, `undefined` members dropped, `null` kept.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'number') return canonicalNumber(value)
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** `> 0` when `a` wins, `< 0` when `b` wins, `0` when they are the same value. */
export function compareVersioned(a: unknown, b: unknown): number {
  const byVersion = versionOf(a) - versionOf(b)
  if (byVersion !== 0) return byVersion
  const left = canonicalJson(a)
  const right = canonicalJson(b)
  return left === right ? 0 : left > right ? 1 : -1
}

/** A payload or column value as a versioned object; anything else reads as absent. */
export function readVersionedObject(value: unknown): VersionedObject | undefined {
  return isPlainObject(value) ? value : undefined
}

/**
 * A payload or column value as a versioned map; a non-object reads as absent
 * and a non-object entry is dropped, never stored.
 */
export function readVersionedMap(value: unknown): VersionedMap | undefined {
  if (!isPlainObject(value)) return undefined
  const entries: Record<string, VersionedObject> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (isPlainObject(entry)) entries[name] = entry
  }
  return entries
}

/**
 * The value an entry holds, `null` for a removal or a missing entry. Entries
 * are parsed from JSON text (a column or a payload) or stamped from a
 * `JsonValue`, so `v` is JSON.
 */
function entryValue(entry: VersionedObject | undefined): JsonValue {
  return entry?.v === undefined ? null : (entry.v as JsonValue)
}

/** `tag_definition.schema`: the winner of the two whole values. */
export function joinVersionedValue(local: unknown, remote: unknown): JoinResult<VersionedObject> {
  const mine = readVersionedObject(local)
  if (remote === null) return { value: mine, remoteBehind: false, localChanged: false }
  const theirs = readVersionedObject(remote)
  if (!theirs) return { value: mine, remoteBehind: mine !== undefined, localChanged: false }
  if (!mine) return { value: theirs, remoteBehind: false, localChanged: true }
  const order = compareVersioned(mine, theirs)
  return order >= 0
    ? { value: mine, remoteBehind: order > 0, localChanged: false }
    : { value: theirs, remoteBehind: false, localChanged: true }
}

/**
 * `task.fields`: the winner per field name. An entry present on one side only
 * is taken from that side, and a removal is an entry like any other.
 */
export function joinVersionedMap(local: unknown, remote: unknown): JoinResult<VersionedMap> {
  const mine = readVersionedMap(local)
  if (remote === null) return { value: mine, remoteBehind: false, localChanged: false }
  const theirs = readVersionedMap(remote)
  if (!mine && !theirs) return { value: undefined, remoteBehind: false, localChanged: false }

  const joined: Record<string, VersionedObject> = {}
  let remoteBehind = false
  let localChanged = mine === undefined
  for (const name of new Set([...Object.keys(mine ?? {}), ...Object.keys(theirs ?? {})])) {
    const ours = mine?.[name]
    const other = theirs?.[name]
    const winner =
      ours === undefined || (other !== undefined && compareVersioned(other, ours) > 0)
        ? (other as VersionedObject)
        : ours
    joined[name] = winner
    if (other === undefined || compareVersioned(winner, other) !== 0) remoteBehind = true
    if (ours === undefined || compareVersioned(winner, ours) !== 0) localChanged = true
  }
  return { value: joined, remoteBehind, localChanged }
}

/**
 * A local edit of a task's field map (§6.11.3). `patch[name] === null`
 * removes, any other value sets. Every key the edit changes gets one stamp,
 * `max(clockTotal, highest t in the map) + 1`, where `clockTotal` is the sum of
 * the task's document clock before this edit ticks it: an edit made after
 * seeing more history outranks one made before it. A key whose value does not
 * change keeps its entry, and an entry keeps the keys a newer build added.
 */
export function stampVersionedMapPatch(
  stored: unknown,
  patch: Readonly<Record<string, JsonValue>>,
  clockTotal: number
): VersionedMap {
  const base = readVersionedMap(stored) ?? {}
  const stamp = Math.max(clockTotal, 0, ...Object.values(base).map(versionOf)) + 1
  const next: Record<string, VersionedObject> = { ...base }
  for (const [name, value] of Object.entries(patch)) {
    if (canonicalJson(entryValue(base[name])) === canonicalJson(value)) continue
    next[name] = { ...base[name], v: value, t: stamp }
  }
  return next
}

/**
 * A local edit of a whole versioned object: `t` becomes `version(previous) + 1`
 * with no clock floor, so a device that never learned a newer value cannot
 * outrank it with one edit. An edit that changes nothing returns `previous`.
 */
export function stampVersionedValue(previous: unknown, edited: VersionedObject): VersionedObject {
  const before = readVersionedObject(previous)
  const version = versionOf(before)
  const { t: _replaced, ...content } = edited
  if (before && canonicalJson({ ...content, t: version }) === canonicalJson(before)) return before
  return { ...content, t: version + 1 }
}

/** What every non-sync reader sees: `{ name: v }`, removals and broken entries left out. */
export function plainVersionedMap(stored: unknown): Record<string, JsonValue> {
  const plain: Record<string, JsonValue> = {}
  for (const [name, entry] of Object.entries(readVersionedMap(stored) ?? {})) {
    const value = entryValue(entry)
    if (value !== null) plain[name] = value
  }
  return plain
}

/**
 * The heal rule of §6.11.3, one copy for every handler: re-push after an
 * apply or a merge whose join left the remote behind, unless the merge already
 * re-queues the item as a conflict. A skip and an insert never heal.
 */
export function owesHeal(
  branch: ApplyBranch,
  joined: Pick<JoinResult<unknown>, 'remoteBehind'>,
  requeuedAsConflict: boolean
): boolean {
  return (branch === 'apply' || branch === 'merge') && joined.remoteBehind && !requeuedAsConflict
}
