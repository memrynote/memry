import { PackKindSchema, type PackListResponse } from '@memry/contracts/sync-api'

import { DEFAULT_PRESIGN_TTL_SECONDS, assertPresignKeyInVault, presignR2Url, type R2PresignConfig } from './r2-presign'

/**
 * Bootstrap-facing pack discovery (#1839): paginated pack list for one vault,
 * newest-first, with presigned GET URLs when the deployment opted into direct
 * R2 transfers.
 *
 * TAIL SEMANTICS (the contract #1840 builds on):
 * - Each pack covers exactly the advertised range of its kind's ordering key
 *   (server_cursor for `record`, created_at seconds for `crdt_snapshot`).
 * - Everything ABOVE the highest covered point is the item-granular tail:
 *   fetch it through the existing per-item endpoints as always.
 * - Coverage is never assumed from ranges alone. The client verifies an item
 *   against a pack's index block (ids + freshness metadata inside the file);
 *   anything not found there — replaced/deleted items are dead bytes in old
 *   packs — falls back to its individual GET, which remains the source of
 *   truth at every cursor value.
 */

// Page size ceiling. Packs are large objects; even 50 rows is far more than a
// client downloads before deciding what to fetch, and small pages keep the
// presign loop (one HMAC chain each) comfortably cheap.
export const MAX_PACK_PAGE_LIMIT = 50

interface PackIndexRow {
  id: string
  item_kind: string
  pack_key: string
  min_cursor: number
  max_cursor: number
  item_count: number
  byte_size: number
  created_at: number
}

export interface ListPacksOptions {
  /** Opaque keyset token from a previous response (`maxCursor:id`). */
  cursor?: string | null
  limit?: number
}

const CURSOR_SEPARATOR = ':'
const encodePageCursor = (row: PackIndexRow): string =>
  `${row.max_cursor}${CURSOR_SEPARATOR}${row.id}`
const decodePageCursor = (
  raw: string
): { maxCursor: number; id: string } | null => {
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

  const statement = pageToken
    ? db
        .prepare(
          `SELECT id, item_kind, pack_key, min_cursor, max_cursor, item_count, byte_size, created_at
           FROM pack_index
           WHERE user_id = ? AND vault_id = ?
             AND (max_cursor < ? OR (max_cursor = ? AND id < ?))
           ORDER BY max_cursor DESC, id DESC
           LIMIT ?`
        )
        .bind(userId, vaultId, pageToken.maxCursor, pageToken.maxCursor, pageToken.id, effectiveLimit + 1)
    : db
        .prepare(
          `SELECT id, item_kind, pack_key, min_cursor, max_cursor, item_count, byte_size, created_at
           FROM pack_index
           WHERE user_id = ? AND vault_id = ?
           ORDER BY max_cursor DESC, id DESC
           LIMIT ?`
        )
        .bind(userId, vaultId, effectiveLimit + 1)

  const rows = (await statement.all<PackIndexRow>()).results ?? []
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
    packs.push(summary)
  }

  const lastRow = pageRows[pageRows.length - 1]
  const result: PackListResponse = { packs, serverTime: Math.floor(Date.now() / 1000) }
  if (hasMore && lastRow) result.nextCursor = encodePageCursor(lastRow)
  return result
}
