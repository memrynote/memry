import { sql, type SQL } from 'drizzle-orm'
import type {
  ContentType,
  JournalResultMetadata,
  NoteResultMetadata,
  SearchResultGroup,
  SearchResultItem
} from '@memry/contracts/search-api'
import { EMBEDDING_QUERY_SIMILARITY_FLOOR } from '../../lib/embeddings-constants'
import type { IndexDb } from '../types'

/** A note whose stored vector is near the typed query. */
export interface SemanticHit {
  id: string
  /** Raw query-to-document cosine, at or above the query floor. */
  cosine: number
}

/** Reciprocal Rank Fusion constant from Cormack et al. 2009; ranks, not scores, are merged. */
const RRF_K = 60

/**
 * Semantic-only hits sit in the lower half of the 0..1 score range so that a
 * keyword match outranks them wherever scores are compared across groups.
 */
const SEMANTIC_ONLY_MAX_SCORE = 0.5

interface NoteRow {
  id: string
  title: string
  path: string
  date: string | null
  emoji: string | null
  fileType: NoteResultMetadata['fileType'] | null
  wordCount: number | null
  createdAt: string
  modifiedAt: string
}

function loadSemanticItems(
  indexDb: IndexDb,
  hits: SemanticHit[],
  fileTypeFilter: SQL
): Map<ContentType, SearchResultItem[]> {
  const byId = new Map(hits.map((hit) => [hit.id, hit]))
  const rows = indexDb.all<NoteRow>(sql`
    SELECT nc.id, nc.title, nc.path, nc.date, nc.emoji, nc.file_type as fileType,
      nc.word_count as wordCount, nc.created_at as createdAt, nc.modified_at as modifiedAt
    FROM note_cache nc
    WHERE nc.id IN (${sql.join(
      hits.map((hit) => sql`${hit.id}`),
      sql`, `
    )})
      AND (nc.date IS NOT NULL OR ${fileTypeFilter})
  `)

  const items = new Map<ContentType, SearchResultItem[]>()
  for (const row of rows) {
    const cosine = byId.get(row.id)!.cosine
    const type: ContentType = row.date ? 'journal' : 'note'
    const metadata: NoteResultMetadata | JournalResultMetadata = row.date
      ? { type: 'journal', date: row.date, path: row.path, tags: [], wordCount: row.wordCount }
      : {
          type: 'note',
          path: row.path,
          tags: [],
          emoji: row.emoji,
          fileType: row.fileType ?? undefined,
          wordCount: row.wordCount,
          createdAt: row.createdAt
        }
    const closeness =
      (cosine - EMBEDDING_QUERY_SIMILARITY_FLOOR) / (1 - EMBEDDING_QUERY_SIMILARITY_FLOOR)
    const item: SearchResultItem = {
      id: row.id,
      type,
      title: row.title,
      snippet: '',
      score: cosine,
      normalizedScore: Math.min(1, Math.max(0, closeness)) * SEMANTIC_ONLY_MAX_SCORE,
      matchType: 'fuzzy',
      modifiedAt: row.modifiedAt,
      metadata
    }
    items.set(type, [...(items.get(type) ?? []), item])
  }
  for (const list of items.values()) list.sort((a, b) => b.score - a.score)
  return items
}

/**
 * Fuse semantic hits into the note and journal groups by Reciprocal Rank
 * Fusion. A note found by both legs keeps its FTS item (snippet, score) and
 * rises; a note only the vectors found is appended with an empty snippet. Other
 * groups are untouched. Returns the new groups and the change in result count.
 */
export function fuseSemanticHits(args: {
  indexDb: IndexDb
  groups: SearchResultGroup[]
  hits: SemanticHit[]
  activeTypes: ContentType[]
  limit: number
  fileTypeFilter: SQL
  /** Applies the query's tag, date and folder filters to semantic-only items. */
  filter: (items: SearchResultItem[], type: ContentType) => SearchResultItem[]
}): { groups: SearchResultGroup[]; added: number } {
  const { indexDb, hits, activeTypes, limit } = args
  if (hits.length === 0) return { groups: args.groups, added: 0 }

  const semantic = loadSemanticItems(indexDb, hits, args.fileTypeFilter)
  const groups = [...args.groups]
  let added = 0

  for (const type of ['note', 'journal'] as const) {
    if (!activeTypes.includes(type)) continue
    const semanticItems = args.filter(semantic.get(type) ?? [], type)
    if (semanticItems.length === 0) continue

    const index = groups.findIndex((group) => group.type === type)
    const before = index === -1 ? [] : groups[index].results
    const fused = new Map<string, { item: SearchResultItem; rrf: number; order: number }>()
    before.forEach((item, rank) => {
      fused.set(item.id, { item, rrf: 1 / (RRF_K + rank + 1), order: rank })
    })
    semanticItems.forEach((item, rank) => {
      const entry = fused.get(item.id)
      if (entry) entry.rrf += 1 / (RRF_K + rank + 1)
      else fused.set(item.id, { item, rrf: 1 / (RRF_K + rank + 1), order: before.length + rank })
    })

    const results = [...fused.values()]
      .sort((a, b) => b.rrf - a.rrf || a.order - b.order)
      .slice(0, limit)
      .map((entry) => entry.item)
    const group = { type, results, totalInGroup: results.length }
    added += results.length - before.length
    if (index !== -1) groups[index] = group
    else {
      const rank = (t: ContentType): number => activeTypes.indexOf(t)
      const at = groups.findIndex((other) => rank(other.type) > rank(type))
      groups.splice(at === -1 ? groups.length : at, 0, group)
    }
  }
  return { groups, added }
}
