import { NoteSyncPayloadSchema } from '@memry/contracts/sync-payloads'

import type { VaultDb } from '@/db/index'

const DEFAULT_RESULT_LIMIT = 8

export interface QuickNoteRow {
  id: string
  payload: string | null
  updated_at: number
}

interface QuickNoteSearchRow {
  id: string
  title: unknown
  folder_path: unknown
  updated_at: number
}

export interface QuickNote {
  id: string
  title: string
  folderPath: string | null
  updatedAt: number
  exactTitle: boolean
}

export interface QuickNoteRepo {
  search(query: string, limit?: number): Promise<QuickNote[]>
}

const RECENT_SQL = `SELECT id, payload, updated_at
FROM sync_items
WHERE type = 'note'
  AND deleted_at IS NULL
  AND payload_state = 'full'
ORDER BY updated_at DESC
LIMIT ?`

const SEARCH_METADATA_SQL = `SELECT
  id,
  CASE WHEN json_valid(payload) THEN json_extract(payload, '$.title') END AS title,
  CASE WHEN json_valid(payload) THEN json_extract(payload, '$.folderPath') END AS folder_path,
  updated_at
FROM sync_items
WHERE type = 'note'
  AND deleted_at IS NULL
  AND payload_state = 'full'
ORDER BY updated_at DESC`

interface RankedQuickNote {
  note: QuickNote
  rank: 0 | 1 | 2
}

function parsePayload(raw: string | null): { title: string; folderPath: string | null } | null {
  if (!raw) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = NoteSyncPayloadSchema.safeParse(decoded)
  if (!parsed.success) return null
  const title = parsed.data.title?.trim() || 'Untitled'
  return { title, folderPath: parsed.data.folderPath || null }
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/\p{Mark}/gu, '')
}

/** Pure projection and ranking shared by the SQLite adapter and focused tests. */
export function quickNotesFromRows(
  rows: readonly QuickNoteRow[],
  query: string,
  limit = DEFAULT_RESULT_LIMIT
): QuickNote[] {
  const parsedRows = []
  for (const row of rows) {
    const payload = parsePayload(row.payload)
    if (!payload) continue
    parsedRows.push({
      id: row.id,
      title: payload.title,
      folderPath: payload.folderPath,
      updatedAt: row.updated_at
    })
  }
  return rankQuickNotes(parsedRows, query, limit)
}

function quickNotesFromSearchRows(
  rows: readonly QuickNoteSearchRow[],
  query: string,
  limit = DEFAULT_RESULT_LIMIT
): QuickNote[] {
  return rankQuickNotes(
    rows.map((row) => ({
      id: row.id,
      title: typeof row.title === 'string' ? row.title.trim() || 'Untitled' : 'Untitled',
      folderPath: typeof row.folder_path === 'string' ? row.folder_path : null,
      updatedAt: row.updated_at
    })),
    query,
    limit
  )
}

function rankQuickNotes(
  rows: readonly {
    id: string
    title: string
    folderPath: string | null
    updatedAt: number
  }[],
  query: string,
  limit: number
): QuickNote[] {
  const safeLimit = Math.max(0, Math.floor(limit))
  if (safeLimit === 0) return []

  const needle = normalizeSearchText(query.trim())
  const ranked: RankedQuickNote[] = []
  for (const row of rows) {
    const normalizedTitle = normalizeSearchText(row.title)
    const exactTitle = needle.length > 0 && normalizedTitle === needle
    const rank: 0 | 1 | 2 = exactTitle ? 0 : normalizedTitle.startsWith(needle) ? 1 : 2
    if (needle.length > 0 && rank === 2 && !normalizedTitle.includes(needle)) continue
    ranked.push({
      rank,
      note: {
        id: row.id,
        title: row.title,
        folderPath: row.folderPath,
        updatedAt: row.updatedAt,
        exactTitle
      }
    })
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank || b.note.updatedAt - a.note.updatedAt || compareIds(a.note.id, b.note.id)
  )
  return ranked.slice(0, safeLimit).map((entry) => entry.note)
}

export function createQuickNoteRepo(db: VaultDb): QuickNoteRepo {
  return {
    async search(query, limit = DEFAULT_RESULT_LIMIT) {
      const safeLimit = Math.max(0, Math.floor(limit))
      if (safeLimit === 0) return []
      const trimmed = query.trim()
      if (trimmed) {
        const rows = await db.getAllAsync<QuickNoteSearchRow>(SEARCH_METADATA_SQL)
        return quickNotesFromSearchRows(rows, trimmed, safeLimit)
      }
      const rows = await db.getAllAsync<QuickNoteRow>(RECENT_SQL, [safeLimit])
      return quickNotesFromRows(rows, trimmed, safeLimit)
    }
  }
}
