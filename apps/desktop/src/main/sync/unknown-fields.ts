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
 * ponytail: top-level keys only. An unknown key nested inside a known object is
 * still stripped by that object's schema; store the whole verbatim payload and
 * deep-merge if a real nested case shows up.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Called after a successful `schema.parse`, with both the raw parsed JSON and
 * the validated result. Any top-level key in the former and not the latter was
 * stripped, so it is stored verbatim. An empty remainder clears the row, which
 * is how a field this build later learns about stops being shadowed.
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
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in validated)) unknown[key] = value
  }

  if (Object.keys(unknown).length === 0) {
    clearUnknownPayloadFields(db, type, itemId)
    return
  }

  db.insert(syncUnknownFields)
    .values({ type, itemId, fields: JSON.stringify(unknown), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [syncUnknownFields.type, syncUnknownFields.itemId],
      set: { fields: JSON.stringify(unknown), updatedAt: new Date() }
    })
    .run()

  log.debug('Kept payload keys this build does not understand', {
    type,
    itemId,
    keys: Object.keys(unknown)
  })
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
    .select({ fields: syncUnknownFields.fields })
    .from(syncUnknownFields)
    .where(and(eq(syncUnknownFields.type, type), eq(syncUnknownFields.itemId, itemId)))
    .get()
  if (!row) return payload

  try {
    const extra: unknown = JSON.parse(row.fields)
    const body: unknown = JSON.parse(payload)
    if (!isPlainObject(extra) || !isPlainObject(body)) return payload
    return JSON.stringify({ ...extra, ...body })
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
