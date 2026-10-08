/**
 * Chapter 06 §6.11.
 *
 * The version lives inside the value because three shipped peers can hand back
 * an old value under a newer document clock. Desktops before #2265 strip the
 * key. Desktops since #2265 echo the remainder captured from the last pulled
 * payload, which is captured before the clock gate and so can be a skipped,
 * stale one. The Rust core keeps its local copy of an unmodelled key on a
 * concurrent task merge. A version carried by the value travels through all
 * three, so a stale echo loses on `t` whatever clock carried it.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type VersionedObject = Readonly<{ [key: string]: JsonValue }>

/** §13.7.3.1: a field name to its entry `{ v, t }`, where `v: null` is a removal. */
export type VersionedMap = Readonly<Record<string, VersionedObject>>

export interface JoinResult<T> {
  readonly value: T | undefined
  readonly remoteBehind: boolean
  readonly localChanged: boolean
}

export type ApplyBranch = 'insert' | 'skip' | 'apply' | 'merge'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function versionOf(value: unknown): number {
  if (!isPlainObject(value)) return 0
  const { t } = value
  return typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 ? t : 0
}

/**
 * JavaScript's `String(n)` switches to an exponent from `1e21` up and below
 * `1e-6`. The §6.4.2 form, like the Rust core's `f64` display, never does.
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

/** §6.4.2. */
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

export function compareVersioned(a: unknown, b: unknown): number {
  const byVersion = versionOf(a) - versionOf(b)
  if (byVersion !== 0) return byVersion
  const left = canonicalJson(a)
  const right = canonicalJson(b)
  return left === right ? 0 : left > right ? 1 : -1
}

/** Payloads and columns are parsed JSON, so an object read from one holds JSON values. */
export function readVersionedObject(value: unknown): VersionedObject | undefined {
  return isPlainObject(value) ? (value as VersionedObject) : undefined
}

export function readVersionedMap(value: unknown): VersionedMap | undefined {
  const map = readVersionedObject(value)
  if (!map) return undefined
  const entries: Record<string, VersionedObject> = {}
  for (const [name, entry] of Object.entries(map)) {
    const object = readVersionedObject(entry)
    if (object) entries[name] = object
  }
  return entries
}

function entryValue(entry: VersionedObject | undefined): JsonValue {
  return entry?.v ?? null
}

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
 * §6.11.3: every key the edit changes is stamped once, above both the task's
 * document clock total before this edit ticks it and the highest `t` in the
 * map. A key whose value does not change keeps its entry, and an entry keeps the
 * keys a newer build added.
 */
export function stampVersionedMapPatch(
  stored: unknown,
  patch: Readonly<Record<string, JsonValue>>,
  clockTotalBeforeEdit: number
): VersionedMap {
  const base = readVersionedMap(stored) ?? {}
  const stamp = Math.max(clockTotalBeforeEdit, 0, ...Object.values(base).map(versionOf)) + 1
  const next: Record<string, VersionedObject> = { ...base }
  for (const [name, value] of Object.entries(patch)) {
    if (canonicalJson(entryValue(base[name])) === canonicalJson(value)) continue
    next[name] = { ...base[name], v: value, t: stamp }
  }
  return next
}

/**
 * No clock floor, unlike a field edit: a device that never learned a newer
 * value must not outrank it with one edit. An edit that changes nothing
 * returns `previous`.
 */
export function stampVersionedValue(previous: unknown, edited: VersionedObject): VersionedObject {
  const before = readVersionedObject(previous)
  const version = versionOf(before)
  const { t: _replaced, ...content } = edited
  if (before && canonicalJson({ ...content, t: version }) === canonicalJson(before)) return before
  return { ...content, t: version + 1 }
}

export function plainVersionedMap(stored: unknown): Record<string, Exclude<JsonValue, null>> {
  const plain: Record<string, Exclude<JsonValue, null>> = {}
  for (const [name, entry] of Object.entries(readVersionedMap(stored) ?? {})) {
    const value = entryValue(entry)
    if (value !== null) plain[name] = value
  }
  return plain
}

/** §6.11.4. */
export function owesHeal(
  branch: ApplyBranch,
  joined: Pick<JoinResult<unknown>, 'remoteBehind'>,
  requeuedAsConflict: boolean
): boolean {
  return (branch === 'apply' || branch === 'merge') && joined.remoteBehind && !requeuedAsConflict
}
