import { and, eq } from 'drizzle-orm'
import { syncUnknownFields } from '@memry/db-schema/data-schema'
import type { SyncItemType } from '@memry/contracts/sync-api'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createLogger } from '../lib/logger'

const log = createLogger('UnknownFields')

/**
 * Keep the payload keys this build's schema does not understand (#2183).
 *
 * `ItemApplier.apply` validates a pulled payload with `handler.schema.parse`,
 * and every handler schema is a plain `z.object`, so Zod drops every key it has
 * no field for. The projection row is what `buildPushPayload` re-serialises, so
 * the next local edit pushes a payload with the newer client's field missing and
 * the server copy loses it permanently. The platform-free engine already avoids
 * this by keeping `payloadJson` verbatim (`packages/sync-client/src/pull/store.ts`).
 *
 * These two functions are that guarantee for desktop: capture the remainder on
 * apply, put it back under the freshly built payload on push.
 *
 * Two kinds of remainder, stored apart because they merge differently:
 * - a top-level key the schema does not know (`fields`): added whole whenever
 *   the push payload lacks it.
 * - a key stripped from inside a known object, e.g. a newer `cover.<field>` on
 *   a note (`nested_fields`): added only into a parent object the push payload
 *   still has, so a cleared or unstated parent never comes back as a partial
 *   object. Arrays are not descended into: their elements have no stable
 *   identity to line a remainder up against.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One key stripped from inside a known object: its full key path and raw value. */
interface NestedUnknownField {
  path: string[]
  value: unknown
}

/**
 * Keys a row-dump push payload carries that no sync schema models: `id` is the
 * envelope id and `syncedAt` is device-local. Keeping them wrote a row for
 * nearly every applied item.
 */
const ENVELOPE_KEYS = new Set(['id', 'syncedAt'])

/** Keys under `raw` that `validated` dropped, below the known object at `path`. */
function collectNestedUnknownFields(
  raw: Record<string, unknown>,
  validated: Record<string, unknown>,
  path: string[],
  out: NestedUnknownField[]
): void {
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in validated)) {
      out.push({ path: [...path, key], value })
      continue
    }
    const known = validated[key]
    if (isPlainObject(value) && isPlainObject(known)) {
      collectNestedUnknownFields(value, known, [...path, key], out)
    }
  }
}

/**
 * Called after a successful `schema.parse`, with both the raw parsed JSON and
 * the validated result. Any key in the former and not the latter was stripped,
 * so it is stored verbatim. An empty remainder clears the row, which is how a
 * field this build later learns about stops being shadowed.
 */
export function recordUnknownPayloadFields(
  db: DrizzleDb,
  type: SyncItemType,
  itemId: string,
  raw: unknown,
  validated: unknown
): void {
  if (!isPlainObject(raw) || !isPlainObject(validated)) return

  const unknown: Record<string, unknown> = {}
  const nested: NestedUnknownField[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (ENVELOPE_KEYS.has(key)) continue
    if (!(key in validated)) {
      unknown[key] = value
      continue
    }
    const known = validated[key]
    if (isPlainObject(value) && isPlainObject(known)) {
      collectNestedUnknownFields(value, known, [key], nested)
    }
  }

  if (Object.keys(unknown).length === 0 && nested.length === 0) {
    clearUnknownPayloadFields(db, type, itemId)
    return
  }

  const fields = JSON.stringify(unknown)
  const nestedFields = nested.length > 0 ? JSON.stringify(nested) : null
  db.insert(syncUnknownFields)
    .values({ type, itemId, fields, nestedFields, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [syncUnknownFields.type, syncUnknownFields.itemId],
      set: { fields, nestedFields, updatedAt: new Date() }
    })
    .run()

  log.debug('Kept payload keys this build does not understand', {
    type,
    itemId,
    keys: Object.keys(unknown),
    nestedKeys: nested.map((field) => field.path.join('.'))
  })
}

/**
 * Put one nested remainder back. Every parent on the path must still be a plain
 * object in `body`, and the key itself must be absent: a locally built value,
 * `null` included, always wins.
 */
function mergeNestedUnknownField(body: Record<string, unknown>, field: NestedUnknownField): void {
  let parent = body
  for (const key of field.path.slice(0, -1)) {
    const child = parent[key]
    if (!isPlainObject(child)) return
    parent = child
  }
  const leaf = field.path[field.path.length - 1]
  if (leaf !== undefined && !(leaf in parent)) parent[leaf] = field.value
}

function isNestedUnknownField(value: unknown): value is NestedUnknownField {
  return (
    isPlainObject(value) &&
    Array.isArray(value.path) &&
    value.path.length > 0 &&
    value.path.every((key) => typeof key === 'string') &&
    'value' in value
  )
}

/**
 * Merge the stored remainder under a freshly built push payload. Locally built
 * keys always win, so a field this build owns is never overwritten by a stale
 * capture; only keys the payload does not mention ride along.
 */
export function mergeUnknownPayloadFields(
  db: DrizzleDb,
  type: string,
  itemId: string,
  payload: string
): string {
  const row = db
    .select({ fields: syncUnknownFields.fields, nestedFields: syncUnknownFields.nestedFields })
    .from(syncUnknownFields)
    .where(and(eq(syncUnknownFields.type, type), eq(syncUnknownFields.itemId, itemId)))
    .get()
  if (!row) return payload

  try {
    const extra: unknown = JSON.parse(row.fields)
    const nested: unknown = row.nestedFields ? JSON.parse(row.nestedFields) : []
    const body: unknown = JSON.parse(payload)
    if (!isPlainObject(extra) || !isPlainObject(body)) return payload
    const merged = { ...extra, ...body }
    if (Array.isArray(nested)) {
      for (const field of nested) {
        if (isNestedUnknownField(field)) mergeNestedUnknownField(merged, field)
      }
    }
    return JSON.stringify(merged)
  } catch (err) {
    log.warn('Failed to merge kept payload keys; pushing without them', { type, itemId, err })
    return payload
  }
}
export function clearUnknownPayloadFields(db: DrizzleDb, type: string, itemId: string): void {
  db.delete(syncUnknownFields)
    .where(and(eq(syncUnknownFields.type, type), eq(syncUnknownFields.itemId, itemId)))
    .run()
}
