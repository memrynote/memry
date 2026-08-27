import {
  JournalSyncPayloadSchema,
  NoteSyncPayloadSchema,
  ProjectSyncPayloadSchema,
  TaskSyncPayloadSchema
} from '@memry/contracts/sync-payloads'
import type { VaultDb } from '@/db/index'
import type { JournalHit, NoteHit, SearchHit, SearchRepo, TaskHit } from './repo'
import { snippetAround } from './subtitle'

/**
 * The LIKE implementation of the `SearchRepo` seam.
 *
 * Phase 10 swaps `createSqliteSearchRepo` for an FTS5-backed one wholesale.
 * `repo.ts` does not change and no caller changes, which is the whole reason
 * the seam is a separate file.
 */

export interface CandidateRow {
  id: string
  type: string
  payload: string | null
  updated_at: number
  markdown: string | null
}

interface RankedMatch {
  hit: SearchHit
  titleMatch: boolean
  updatedAt: number
  id: string
}

const CANDIDATE_SQL = `SELECT s.id, s.type, s.payload, s.updated_at, b.markdown
FROM sync_items s
LEFT JOIN note_bodies b ON b.item_id = s.id
WHERE s.type IN ('note', 'task', 'journal')
  AND s.deleted_at IS NULL
  AND s.payload_state = 'full'
  AND (s.payload LIKE ? ESCAPE '\\' OR b.markdown LIKE ? ESCAPE '\\')
ORDER BY s.updated_at DESC
LIMIT 400`

export function likePattern(query: string): string {
  // The backslash pass runs first, or it re-escapes the backslashes the two
  // wildcard passes just inserted and the pattern stops matching what was typed.
  const escaped = query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
  return `%${escaped}%`
}

export function hitsFromRows(
  rows: CandidateRow[],
  query: string,
  projectNames: Map<string, string>
): SearchHit[] {
  const needle = query.toLowerCase()
  const matches: RankedMatch[] = []
  for (const row of rows) {
    const match = rankRow(row, query, needle, projectNames)
    if (match) matches.push(match)
  }

  matches.sort(
    (a, b) =>
      Number(b.titleMatch) - Number(a.titleMatch) ||
      b.updatedAt - a.updatedAt ||
      compareIds(a.id, b.id)
  )
  return matches.map((match) => match.hit)
}

export function createSqliteSearchRepo(db: VaultDb): SearchRepo {
  async function search(query: string): Promise<SearchHit[]> {
    const trimmed = query.trim()
    if (trimmed.length === 0) return []

    const projectNames = await loadProjectNames(db)
    // Bound twice rather than as a numbered `?1`: expo-sqlite binds an array
    // positionally, and a repeated numbered placeholder is the kind of thing
    // that works on one SQLite build and silently matches nothing on the next.
    const pattern = likePattern(trimmed)
    const rows = await db.getAllAsync<CandidateRow>(CANDIDATE_SQL, [pattern, pattern])
    return hitsFromRows(rows, trimmed, projectNames)
  }

  return {
    search,
    // Here so the entry screen can label a recent search without reaching for
    // `search` itself. A count that does not materialize the hits needs an
    // index to be worth anything, so it arrives with FTS5.
    async countMatches(query: string): Promise<number> {
      return (await search(query)).length
    }
  }
}

// The SQL narrows with a LIKE over the whole payload text, which also matches
// ids, folder paths and tags. Confirming the match field by field here is what
// lets the SQL stay that dumb.
function rankRow(
  row: CandidateRow,
  query: string,
  needle: string,
  projectNames: Map<string, string>
): RankedMatch | null {
  if (!row.payload) return null

  switch (row.type) {
    case 'note': {
      const parsed = NoteSyncPayloadSchema.safeParse(parseJson(row.payload))
      if (!parsed.success) return null
      const payload = parsed.data
      const titleMatch = contains(payload.title, needle)
      if (!titleMatch && !contains(row.markdown, needle) && !contains(payload.content, needle)) {
        return null
      }
      const folderPath = payload.folderPath ?? null
      const hit: NoteHit = {
        kind: 'note',
        id: row.id,
        title: payload.title ?? 'Untitled',
        folderPath: folderPath === '' ? null : folderPath,
        updatedAt: row.updated_at
      }
      return { hit, titleMatch, updatedAt: row.updated_at, id: row.id }
    }
    case 'task': {
      const parsed = TaskSyncPayloadSchema.safeParse(parseJson(row.payload))
      if (!parsed.success) return null
      const payload = parsed.data
      const titleMatch = contains(payload.title, needle)
      if (!titleMatch && !contains(payload.description, needle)) return null
      const hit: TaskHit = {
        kind: 'task',
        id: row.id,
        title: payload.title ?? 'Untitled',
        dueDate: payload.dueDate ?? null,
        completedAt: payload.completedAt ?? null,
        projectName: payload.projectId ? (projectNames.get(payload.projectId) ?? null) : null
      }
      return { hit, titleMatch, updatedAt: row.updated_at, id: row.id }
    }
    case 'journal': {
      const parsed = JournalSyncPayloadSchema.safeParse(parseJson(row.payload))
      if (!parsed.success) return null
      const payload = parsed.data
      // The date IS the row's title, and the schema only makes it optional so a
      // delete tombstone can leave it out. Tombstones never reach here, because
      // the query filters on `deleted_at IS NULL`.
      if (!payload.date) return null
      const titleMatch = contains(payload.date, needle)
      if (!titleMatch && !contains(payload.content, needle)) return null
      const hit: JournalHit = {
        kind: 'journal',
        id: row.id,
        date: payload.date,
        snippet: snippetAround(payload.content ?? '', query),
        updatedAt: row.updated_at
      }
      return { hit, titleMatch, updatedAt: row.updated_at, id: row.id }
    }
    default:
      return null
  }
}

async function loadProjectNames(db: VaultDb): Promise<Map<string, string>> {
  const rows = await db.getAllAsync<{ id: string; payload: string | null }>(
    `SELECT id, payload FROM sync_items WHERE type = 'project' AND deleted_at IS NULL`
  )
  const names = new Map<string, string>()
  for (const row of rows) {
    if (!row.payload) continue
    const parsed = ProjectSyncPayloadSchema.safeParse(parseJson(row.payload))
    if (!parsed.success || !parsed.data.name) continue
    names.set(row.id, parsed.data.name)
  }
  return names
}

function contains(value: string | null | undefined, needle: string): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(needle)
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
