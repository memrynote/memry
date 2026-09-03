import type { VaultDb } from '@/db/index'
import { isUnder } from '@/features/notes/folder-ops'
import { likePattern } from '@/features/search/repo.sqlite'
import { snippetAround } from '@/features/search/subtitle'

/**
 * `Search in folder` (board 26H).
 *
 * Deliberately NOT the global `SearchRepo`. That one spans notes, tasks and
 * journals and ranks across all three; this one answers a different question —
 * "which notes inside this folder say that" — and the folder filter has to run
 * against each note's own `folderPath`, which is inside the payload rather than
 * a column. Reusing the global repo would mean fetching every hit in the vault
 * and throwing most of them away.
 *
 * `likePattern` and `snippetAround` ARE shared, so escaping and the ellipsis
 * rule stay one implementation.
 */

export interface FolderSearchHit {
  id: string
  title: string
  /** `null` when the query matched the title and nothing in the body. */
  snippet: string | null
  updatedAt: number
}

export interface FolderSearchResult {
  hits: FolderSearchHit[]
  /** Notes under the folder, matched or not, so the header can say "4 of 14". */
  total: number
}

interface Row {
  id: string
  payload: string | null
  updated_at: number
  markdown: string | null
}

const SQL = `SELECT s.id, s.payload, s.updated_at, b.markdown
FROM sync_items s
LEFT JOIN note_bodies b ON b.item_id = s.id
WHERE s.type = 'note' AND s.deleted_at IS NULL AND s.payload_state = 'full'
ORDER BY s.updated_at DESC`

const MATCHING_SQL = `SELECT s.id, s.payload, s.updated_at, b.markdown
FROM sync_items s
LEFT JOIN note_bodies b ON b.item_id = s.id
WHERE s.type = 'note' AND s.deleted_at IS NULL AND s.payload_state = 'full'
  AND (s.payload LIKE ? ESCAPE '\\' OR b.markdown LIKE ? ESCAPE '\\')
ORDER BY s.updated_at DESC
LIMIT 200`

function parse(row: Row): { title: string; folderPath: string } | null {
  if (!row.payload) return null
  try {
    const payload = JSON.parse(row.payload) as { title?: unknown; folderPath?: unknown }
    const title =
      typeof payload.title === 'string' && payload.title.trim().length > 0
        ? payload.title
        : 'Untitled'
    return { title, folderPath: typeof payload.folderPath === 'string' ? payload.folderPath : '' }
  } catch {
    return null
  }
}

export async function searchInFolder(
  db: VaultDb,
  path: string,
  query: string
): Promise<FolderSearchResult> {
  const all = await db.getAllAsync<Row>(SQL)
  let total = 0
  for (const row of all) {
    const parsed = parse(row)
    if (parsed && isUnder(parsed.folderPath, path)) total += 1
  }

  const trimmed = query.trim()
  if (trimmed.length === 0) return { hits: [], total }

  const pattern = likePattern(trimmed)
  const rows = await db.getAllAsync<Row>(MATCHING_SQL, [pattern, pattern])
  const hits: FolderSearchHit[] = []
  const needle = trimmed.toLowerCase()

  for (const row of rows) {
    const parsed = parse(row)
    if (!parsed || !isUnder(parsed.folderPath, path)) continue
    // The SQL matched `payload LIKE`, which is true for a hit anywhere in the
    // JSON — a folder name, a tag, an id. Only a title or body match is a
    // result a person would recognise, so the row is re-checked here.
    const inTitle = parsed.title.toLowerCase().includes(needle)
    const snippet = row.markdown ? snippetAround(row.markdown, trimmed) : null
    if (!inTitle && snippet === null) continue
    hits.push({ id: row.id, title: parsed.title, snippet, updatedAt: row.updated_at })
  }

  // Title matches first, then most recently edited; ties broken by id so two
  // renders of the same result set never disagree.
  hits.sort(
    (a, b) =>
      Number(b.title.toLowerCase().includes(needle)) -
        Number(a.title.toLowerCase().includes(needle)) ||
      b.updatedAt - a.updatedAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )

  return { hits, total }
}
