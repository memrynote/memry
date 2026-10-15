import { sql, type SQL } from 'drizzle-orm'
import { nameKey } from '@memry/shared/note-names'
import type {
  JournalResultMetadata,
  NoteResultMetadata,
  SearchResultItem
} from '@memry/contracts/search-api'
import type { IndexDb } from '../types'

interface NameHitRow {
  id: string
  title: string
  path: string
  date: string | null
  emoji: string | null
  fileType: NoteResultMetadata['fileType'] | null
  wordCount: number | null
  createdAt: string
  modifiedAt: string
  display: string
  exact: number
}

const EXACT_SCORE = 1
const PREFIX_SCORE = 0.9

export function searchNoteNames(
  indexDb: IndexDb,
  text: string,
  type: 'note' | 'journal',
  limit: number,
  fileTypeFilter: SQL
): SearchResultItem[] {
  const key = nameKey(text)
  if (key === null) return []
  const prefix = `${key.replace(/[\\%_]/g, '\\$&')}%`

  const rows = indexDb.all<NameHitRow>(sql`
    SELECT
      nc.id,
      nc.title,
      nc.path,
      nc.date,
      nc.emoji,
      nc.file_type as fileType,
      nc.word_count as wordCount,
      nc.created_at as createdAt,
      nc.modified_at as modifiedAt,
      nn.display,
      nn.key = ${key} as exact
    FROM note_names nn
    JOIN note_cache nc ON nc.id = nn.note_id
    WHERE nn.kind = 'alias'
      AND nn.key LIKE ${prefix} ESCAPE '\\'
      AND ${type === 'journal' ? sql`nc.date IS NOT NULL` : sql`nc.date IS NULL`}
      AND ${fileTypeFilter}
    ORDER BY exact DESC, length(nn.key), nc.id
    LIMIT ${limit}
  `)

  const seen = new Set<string>()
  const hits: SearchResultItem[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const metadata: NoteResultMetadata | JournalResultMetadata =
      type === 'journal'
        ? {
            type: 'journal',
            date: row.date ?? '',
            path: row.path,
            tags: [],
            wordCount: row.wordCount,
            matchedName: row.display
          }
        : {
            type: 'note',
            path: row.path,
            tags: [],
            emoji: row.emoji,
            fileType: row.fileType ?? undefined,
            wordCount: row.wordCount,
            createdAt: row.createdAt,
            matchedName: row.display
          }
    const score = row.exact ? EXACT_SCORE : PREFIX_SCORE
    hits.push({
      id: row.id,
      type,
      title: row.title,
      snippet: '',
      score,
      normalizedScore: score,
      matchType: 'exact',
      modifiedAt: row.modifiedAt,
      metadata
    })
  }
  return hits
}

export function mergeNameHits(
  text: string,
  results: SearchResultItem[],
  hits: SearchResultItem[]
): SearchResultItem[] {
  const key = nameKey(text)
  const hitById = new Map(hits.map((hit) => [hit.id, hit]))
  const annotated = (result: SearchResultItem): SearchResultItem => {
    const hit = hitById.get(result.id)
    const meta = result.metadata
    if (!hit || (meta.type !== 'note' && meta.type !== 'journal')) return result
    if (key !== null && nameKey(result.title)?.includes(key)) return result
    const matchedName = 'matchedName' in hit.metadata ? hit.metadata.matchedName : undefined
    return { ...result, metadata: { ...meta, matchedName } }
  }
  const found = new Map(results.map((result) => [result.id, annotated(result)]))
  const exact = hits.filter((hit) => hit.score === EXACT_SCORE)
  const exactIds = new Set(exact.map((hit) => hit.id))
  return [
    ...exact.map((hit) => found.get(hit.id) ?? hit),
    ...[...found.values()].filter((result) => !exactIds.has(result.id)),
    ...hits.filter((hit) => !exactIds.has(hit.id) && !found.has(hit.id))
  ]
}
