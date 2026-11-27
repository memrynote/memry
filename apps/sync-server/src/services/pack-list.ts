import {
  PACK_LIST_MAX_PACKS_PER_VAULT,
  PackKindSchema,
  type PackListResponse
} from '@memry/contracts/sync-api'

import {
  DEFAULT_PRESIGN_TTL_SECONDS,
  assertPresignKeyInVault,
  presignR2Url,
  type R2PresignConfig
} from './r2-presign'

/**
 * Pack discovery (#1839): the paginated pack list of one vault, newest first,
 * with presigned GET URLs when the deployment opted into direct R2 transfers,
 * and on the first page the coverage statement of protocol 08 §8.10. `GET
 * /sync/packs` and `POST /sync/bootstrap` both serve this page.
 *
 * Every pack's entries are verified against its own index block, never assumed
 * from a range, and individual items stay the source of truth.
 */

/**
 * The kinds whose coverage the first page states (protocol 08 §8.10). Body
 * packs carry no coverage range yet: snapshot builds still select on
 * `created_at`, and update builds record no range (#5230 follow-up). A kind
 * left out is uncovered, which is always a true statement.
 */
export const COVERED_KINDS = ['record'] as const

// Page size ceiling. Packs are large objects; even 50 rows is far more than a
// client downloads before deciding what to fetch, and small pages keep the
// presign loop (one HMAC chain each) comfortably cheap.
export const MAX_PACK_PAGE_LIMIT = 50

// Fewer listed packs than §8.14's cap, so one more insert keeps the vault at or
// below it. Compaction checks it before a build and again in its commit batch.
export const roomGuard = (scope: {
  userId: string
  vaultId: string
}): { sql: string; bind: unknown[] } => ({
  sql: '(SELECT COUNT(*) FROM pack_index WHERE user_id = ? AND vault_id = ?) < ?',
  bind: [scope.userId, scope.vaultId, PACK_LIST_MAX_PACKS_PER_VAULT]
})

export const roomForPack = async (
  db: D1Database,
  scope: { userId: string; vaultId: string }
): Promise<boolean> => {
  const room = roomGuard(scope)
  const row = await db
    .prepare(`SELECT ${room.sql} AS room`)
    .bind(...room.bind)
    .first<{ room: number }>()
  return Boolean(row?.room)
}

interface PackIndexRow {
  id: string
  item_kind: string
  pack_key: string
  min_cursor: number
  max_cursor: number
  item_count: number
  byte_size: number
  created_at: number
  cover_from: number | null
  cover_through: number | null
}

export interface ListPacksOptions {
  /** Opaque keyset token from a previous response (`maxCursor:id`). */
  cursor?: string | null
  limit?: number
  /** The raw `PACK_COVERAGE_DISABLED` Worker var, see packCoverageDisabled. */
  coverageDisabled?: string
}

/**
 * The step 14 rollback switch (#5392, protocol 08 §8.10): the
 * `PACK_COVERAGE_DISABLED` Worker var, `*` for every vault or a comma-separated
 * list of vault ids. A listed vault is served no packs and no coverage, so every
 * client takes it item by item (§8.0), and a bootstrap starts no backfill
 * chain. It writes nothing: pack rows, watermarks and R2 objects stay as they
 * are, so unsetting it serves the listing again with no rebuild. Unset or
 * empty: no vault is listed.
 */
export const packCoverageDisabled = (value: string | undefined, vaultId: string): boolean =>
  (value ?? '').split(',').some((entry) => {
    const id = entry.trim()
    return id === '*' || id === vaultId
  })

const CURSOR_SEPARATOR = ':'
const encodePageCursor = (row: PackIndexRow): string =>
  `${row.max_cursor}${CURSOR_SEPARATOR}${row.id}`
const decodePageCursor = (raw: string): { maxCursor: number; id: string } | null => {
  const separatorAt = raw.indexOf(CURSOR_SEPARATOR)
  if (separatorAt <= 0) return null
  const maxCursor = Number.parseInt(raw.slice(0, separatorAt), 10)
  const id = raw.slice(separatorAt + 1)
  if (!Number.isFinite(maxCursor) || maxCursor < 0 || id.length === 0) return null
  return { maxCursor, id }
}

export const listPacks = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  options: ListPacksOptions = {},
  presignConfig: R2PresignConfig | null = null
): Promise<PackListResponse> => {
  const effectiveLimit = Math.min(Math.max(options.limit ?? 20, 1), MAX_PACK_PAGE_LIMIT)

  // Keyset pagination on (max_cursor DESC, id DESC). The composite token keeps
  // tie-grouped rows (same max_cursor across kinds or same-second ranges)
  // stable across pages: no row can be skipped or served twice by page churn,
  // which a bare max_cursor < ? filter could not guarantee.
  const pageToken = options.cursor ? decodePageCursor(options.cursor) : null

  if (packCoverageDisabled(options.coverageDisabled, vaultId)) {
    const empty: PackListResponse = { packs: [], serverTime: Math.floor(Date.now() / 1000) }
    if (!pageToken) empty.coverage = []
    return empty
  }

  const statement = pageToken
    ? db
        .prepare(
          `SELECT id, item_kind, pack_key, min_cursor, max_cursor, item_count, byte_size, created_at,
                  cover_from, cover_through
           FROM pack_index
           WHERE user_id = ? AND vault_id = ?
             AND (max_cursor < ? OR (max_cursor = ? AND id < ?))
           ORDER BY max_cursor DESC, id DESC
           LIMIT ?`
        )
        .bind(
          userId,
          vaultId,
          pageToken.maxCursor,
          pageToken.maxCursor,
          pageToken.id,
          effectiveLimit + 1
        )
    : db
        .prepare(
          `SELECT id, item_kind, pack_key, min_cursor, max_cursor, item_count, byte_size, created_at,
                  cover_from, cover_through
           FROM pack_index
           WHERE user_id = ? AND vault_id = ?
           ORDER BY max_cursor DESC, id DESC
           LIMIT ?`
        )
        .bind(userId, vaultId, effectiveLimit + 1)

  // The first page and the coverage statement are one D1 batch, so the
  // statement describes exactly the listing it rides with (§8.10).
  const [page, covered] = pageToken
    ? [await statement.all<PackIndexRow>(), null]
    : await db.batch<PackIndexRow | CoverageRow>([
        statement,
        coverageStatement(db, userId, vaultId)
      ])
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the batch's first statement selects PackIndexRow
  const rows = (page.results ?? []) as PackIndexRow[]
  const hasMore = rows.length > effectiveLimit
  const pageRows = hasMore ? rows.slice(0, effectiveLimit) : rows

  // Presigning reuses the #1836 config: absent → urls omitted and clients use
  // the item-granular endpoints (same graceful degradation as chunk presigns).
  const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_PRESIGN_TTL_SECONDS
  const packs = []
  for (const row of pageRows) {
    // Schema validation doubles as a corruption tripwire: an unknown kind must
    // not silently reach clients that switch on it.
    const kind = PackKindSchema.safeParse(row.item_kind)
    if (!kind.success) continue

    let url: string | undefined
    if (presignConfig) {
      assertPresignKeyInVault(row.pack_key, userId, vaultId)
      url = await presignR2Url(presignConfig, { method: 'GET', key: row.pack_key })
    }

    const summary: PackListResponse['packs'][number] = {
      id: row.id,
      itemKind: kind.data,
      packKey: row.pack_key,
      minCursor: row.min_cursor,
      maxCursor: row.max_cursor,
      itemCount: row.item_count,
      byteSize: row.byte_size,
      createdAt: row.created_at
    }
    if (url) {
      summary.url = url
      summary.expiresAt = expiresAt
    }
    // A pack without both bounds is a cache only (§8.9).
    if (row.cover_from !== null && row.cover_through !== null) {
      summary.coverFrom = row.cover_from
      summary.coverThrough = row.cover_through
    }
    packs.push(summary)
  }

  const lastRow = pageRows[pageRows.length - 1]
  const result: PackListResponse = { packs, serverTime: Math.floor(Date.now() / 1000) }
  if (hasMore && lastRow) result.nextCursor = encodePageCursor(lastRow)
  if (covered) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the batch's second statement selects CoverageRow
    result.coverage = ((covered.results ?? []) as CoverageRow[]).map((row) => ({
      itemKind: row.item_kind,
      packedThrough: row.covered_through,
      coveredThrough: row.covered_through
    }))
  }
  return result
}

interface CoverageRow {
  item_kind: (typeof COVERED_KINDS)[number]
  covered_through: number
}

/**
 * One coverage entry per covered kind whose watermark carries a coverage
 * anchor. `covered_through` is the `coverThrough` of the kind's newest pack:
 * only a build whose `pack_index` insert applied moves it, a rollup or a shed
 * never lowers it, and a reset sets it back with the packs it drops
 * (pack-index-write.ts, pack-replaced-objects.ts), so it is `packedThrough`.
 * `coveredThrough` claims nothing beyond it. A NULL anchor is a chain of
 * cache-only packs, which compaction re-anchors (pack-compaction.ts), so the
 * kind is left out until then.
 */
const coverageStatement = (db: D1Database, userId: string, vaultId: string) =>
  db
    .prepare(
      `SELECT item_kind, covered_through FROM pack_watermarks
       WHERE user_id = ? AND vault_id = ? AND covered_through IS NOT NULL
         AND item_kind IN (${COVERED_KINDS.map(() => '?').join(', ')})
       ORDER BY item_kind`
    )
    .bind(userId, vaultId, ...COVERED_KINDS)
