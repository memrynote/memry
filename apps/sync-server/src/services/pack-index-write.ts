import type { PackKindName } from './pack-format'

/**
 * The D1 statements that list a pack and move its kind's watermark, shared by
 * the build (pack-compaction.ts) and the rollup (pack-rollup.ts).
 */

export interface VaultScope {
  userId: string
  vaultId: string
}

/** A SQL condition with its binds, spliced into a guarded statement. */
export interface Guard {
  sql: string
  bind: unknown[]
}

export const ALWAYS: Guard = { sql: '1', bind: [] }

/** True while all `count` entries of a `*Live` join still match their rows. */
export const allLive = (live: Guard, count: number): Guard => ({
  sql: `(SELECT COUNT(*) ${live.sql}) = ?`,
  bind: [...live.bind, count]
})

/** Coverage range `(from, through]` on the server_cursor axis, or none for a cache-only pack. */
export type Coverage = { from: number; through: number } | null

/** Pack object key for one build: its range, then its `pack_index` id. */
export const packObjectKey = (
  scope: VaultScope,
  kind: PackKindName,
  minSortValue: number,
  maxSortValue: number,
  packId: string
): string =>
  // Lives under the vault prefix, so vault deletion's prefix purge reaches it.
  `${scope.userId}/vaults/${scope.vaultId}/packs/${kind}/${minSortValue}_${maxSortValue}_${packId}.pack`

export interface PackIndexRow {
  id: string
  kind: PackKindName
  packKey: string
  minSortValue: number
  maxSortValue: number
  itemCount: number
  byteSize: number
  coverage: Coverage
}

/**
 * Range-level pack_index row, inserted only while `guard` holds. The composite
 * conflict target makes a concurrent or retried duplicate a no-op rather than
 * a constraint error that would poison queue retries.
 */
export const packIndexInsert = (
  db: D1Database,
  scope: VaultScope,
  row: PackIndexRow,
  guard: Guard = ALWAYS
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO pack_index (id, user_id, vault_id, pack_key, item_kind, min_cursor, max_cursor, item_count, byte_size, created_at, cover_from, cover_through)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT (user_id, vault_id, item_kind, min_cursor) DO NOTHING`
    )
    .bind(
      row.id,
      scope.userId,
      scope.vaultId,
      row.packKey,
      row.kind,
      row.minSortValue,
      row.maxSortValue,
      row.itemCount,
      row.byteSize,
      Math.floor(Date.now() / 1000),
      row.coverage?.from ?? null,
      row.coverage?.through ?? null,
      ...guard.bind
    )

/** Exported so tests can drive the INSERT path past compactOneRange's pre-read gate. */
export const insertPackIndexRow = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  packKey: string,
  minSortValue: number,
  maxSortValue: number,
  itemCount: number,
  byteSize: number
): Promise<void> => {
  await packIndexInsert(db, scope, {
    id: crypto.randomUUID(),
    kind,
    packKey,
    minSortValue,
    maxSortValue,
    itemCount,
    byteSize,
    coverage: null
  }).run()
}

/**
 * Upsert the kind's watermark while `guard` holds. `coveredThrough` is set only
 * by a build whose pack row applied (protocol 08 §8.10): `undefined` leaves the
 * stored anchor alone, as a window that built no pack must.
 */
export const watermarkUpsert = (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  sortValue: number,
  tiebreak: string,
  guard: Guard = ALWAYS,
  coveredThrough?: number | null
): D1PreparedStatement => {
  const setsAnchor = coveredThrough !== undefined
  return db
    .prepare(
      `INSERT INTO pack_watermarks (user_id, vault_id, item_kind, last_sort_value, last_sort_tiebreak, updated_at, covered_through)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT (user_id, vault_id, item_kind) DO UPDATE SET
         last_sort_value = excluded.last_sort_value,
         last_sort_tiebreak = excluded.last_sort_tiebreak,
         updated_at = excluded.updated_at${setsAnchor ? ',\n         covered_through = excluded.covered_through' : ''}`
    )
    .bind(
      scope.userId,
      scope.vaultId,
      kind,
      sortValue,
      tiebreak,
      Math.floor(Date.now() / 1000),
      // A new watermark row starts the chain at 0 (nothing below it is packed);
      // an existing row keeps its anchor unless this build listed a pack.
      setsAnchor ? coveredThrough : kind === 'record' ? 0 : null,
      ...guard.bind
    )
}

export const advanceWatermark = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  sortValue: number,
  tiebreak: string,
  guard: Guard = ALWAYS
): Promise<void> => {
  await watermarkUpsert(db, scope, kind, sortValue, tiebreak, guard).run()
}

/**
 * True while the kind's watermark is the one a build selected under, or still
 * absent. `IS` compares a NULL `covered_through` too.
 */
export const watermarkUnchanged = (
  scope: VaultScope,
  kind: PackKindName,
  read: { last_sort_value: number; last_sort_tiebreak: string; covered_through: number | null }
): Guard => ({
  sql: `NOT EXISTS (SELECT 1 FROM pack_watermarks WHERE user_id = ? AND vault_id = ? AND item_kind = ?
    AND NOT (last_sort_value = ? AND last_sort_tiebreak = ? AND covered_through IS ?))`,
  bind: [
    scope.userId,
    scope.vaultId,
    kind,
    read.last_sort_value,
    read.last_sort_tiebreak,
    read.covered_through
  ]
})
