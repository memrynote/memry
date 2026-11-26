import type { VaultScope } from './pack-index-write'
import { REWRITE_PENDING, packKindReset } from './pack-replaced-objects'

/**
 * The `record` half of the scoped purge (protocol 08 §8.13, #5247). A record
 * pack lists the distinct `type:id` of its entries in `pack_index.documents`,
 * so the document body purge and the tombstone shed find the record packs that
 * hold a deleted item. Each such pack leaves the listing at once and waits for
 * its rewrite (pack-purge-rewrite.ts) with its coverage, which the rewrite
 * lists again. A vault that still lists a record pack written before record
 * packs recorded `documents` resets the kind instead: every record pack leaves
 * the listing and compaction rebuilds them from source rows.
 */

/** The `documents` value of a record entry, its pack entry id (protocol 08 §8.4.2). */
export const recordKey = (type: string, id: string): string => `${type}:${id}`

const UNKNOWN = `EXISTS (SELECT 1 FROM pack_index WHERE user_id = ? AND vault_id = ?
  AND item_kind = 'record' AND documents IS NULL)`

const HOLDS_ANY = `documents IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(pack_index.documents) d
  WHERE d.value IN (SELECT value FROM json_each(?)))`

/**
 * Statements that take every listed record pack holding one of `keys` out of
 * the listing as a pending rewrite, removed at `now`. The last returns
 * `rewrite_id` per pack taken out; a reset returns `replaced_key`.
 */
export const unlistRecordPacks = (
  db: D1Database,
  scope: VaultScope,
  keys: readonly string[],
  now: number
): D1PreparedStatement[] => {
  const vault = [scope.userId, scope.vaultId]
  const list = JSON.stringify(keys)
  return [
    ...packKindReset(db, scope, 'record', { sql: UNKNOWN, bind: vault }),
    db
      .prepare(
        `INSERT INTO pack_replaced_objects (pack_key, user_id, vault_id, replaced_by, removed_at, cover_from, cover_through)
         SELECT pack_key, user_id, vault_id, '${REWRITE_PENDING}', ?, cover_from, cover_through FROM pack_index
         WHERE user_id = ? AND vault_id = ? AND item_kind = 'record' AND ${HOLDS_ANY}
         ON CONFLICT (pack_key) DO UPDATE SET replaced_by = excluded.replaced_by,
           removed_at = excluded.removed_at, cover_from = excluded.cover_from,
           cover_through = excluded.cover_through`
      )
      .bind(now, ...vault, list),
    db
      .prepare(
        `DELETE FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = 'record' AND ${HOLDS_ANY}
         RETURNING id AS rewrite_id`
      )
      .bind(...vault, list)
  ]
}

/** Which of `keys` a listed record pack holds, and whether one may (`documents` NULL). */
export const packedRecordKeys = async (
  db: D1Database,
  scope: VaultScope,
  keys: readonly string[]
): Promise<{ held: Set<string>; unknown: boolean }> => {
  const vault = [scope.userId, scope.vaultId]
  const [held, unknown] = await db.batch<{ key?: string; unknown?: number }>([
    db
      .prepare(
        `SELECT DISTINCT d.value AS key FROM pack_index p, json_each(p.documents) d
         WHERE p.user_id = ? AND p.vault_id = ? AND p.item_kind = 'record' AND p.documents IS NOT NULL
           AND d.value IN (SELECT value FROM json_each(?))`
      )
      .bind(...vault, JSON.stringify(keys)),
    db.prepare(`SELECT ${UNKNOWN} AS unknown`).bind(...vault)
  ])
  return {
    held: new Set((held.results ?? []).flatMap((row) => (row.key ? [row.key] : []))),
    unknown: Boolean(unknown.results?.[0]?.unknown)
  }
}

/**
 * True for a `sync_items si` row while no listed record pack whose range spans
 * its cursor holds it, or may hold it. Guards the shed against a build that
 * listed the row's entry after the shed read the listing.
 */
export const NOT_PACKED_AT_CURSOR = `NOT EXISTS (SELECT 1 FROM pack_index p
  WHERE p.user_id = si.user_id AND p.vault_id = si.vault_id AND p.item_kind = 'record'
    AND p.min_cursor <= si.server_cursor AND p.max_cursor >= si.server_cursor
    AND (p.documents IS NULL OR EXISTS (SELECT 1 FROM json_each(p.documents)
      WHERE value = si.item_type || ':' || si.item_id)))`

/**
 * True for a `sync_items si` row while its vault has no record object that may
 * still hold the row's entries (§8.13): a pending rewrite, an object due and
 * not yet deleted, or one a rollup or re-anchor took out of the listing inside
 * the grace, which a reader may still download. Binds the grace cutoff (`now -
 * PACK_REPLACED_GRACE_SECONDS`).
 */
export const RECORD_OBJECTS_SETTLED = `NOT EXISTS (SELECT 1 FROM pack_replaced_objects r
  WHERE r.user_id = si.user_id AND r.vault_id = si.vault_id
    AND instr(r.pack_key, '/packs/record/') > 0 AND r.replaced_by <> 'unlisted'
    AND (r.replaced_by = '${REWRITE_PENDING}' OR r.removed_at = 0 OR r.removed_at > ?))`
