import { sql, type SQL } from 'drizzle-orm'
import type {
  ContentType,
  InboxResultMetadata,
  JournalResultMetadata,
  NoteResultMetadata,
  SearchResultGroup,
  SearchResultItem
} from '@memry/contracts/search-api'
import { EMBEDDING_QUERY_SIMILARITY_FLOOR } from '../../lib/embeddings-constants'
import type { DataDb, IndexDb } from '../types'

/**
 * A note, journal entry or voice memo whose stored vector is near the typed
 * query. Note and inbox ids never collide, so one list carries both.
 */
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

interface InboxRow {
  id: string
  title: string
  type: string
  sourceUrl: string | null
  sourceTitle: string | null
  filedAt: string | null
  modifiedAt: string
}

/** Voice memos the vectors found: the only inbox items that have vectors. */
function loadInboxItems(dataDb: DataDb, hits: SemanticHit[]): SearchResultItem[] {
  const byId = new Map(hits.map((hit) => [hit.id, hit]))
  const rows = dataDb.all<InboxRow>(sql`
    SELECT id, title, type, source_url as sourceUrl, source_title as sourceTitle,
      filed_at as filedAt, modified_at as modifiedAt
    FROM inbox_items
    WHERE id IN (${sql.join(
      hits.map((hit) => sql`${hit.id}`),
      sql`, `
    )})
  `)
  return rows
    .map((row): SearchResultItem => {
      const cosine = byId.get(row.id)!.cosine
      const metadata: InboxResultMetadata = {
        type: 'inbox',
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- string DB/wire column narrowed to the union its writers constrain
        itemType: row.type as InboxResultMetadata['itemType'],
        sourceUrl: row.sourceUrl,
        sourceTitle: row.sourceTitle,
        filedAt: row.filedAt
      }
      return {
        id: row.id,
        type: 'inbox',
        title: row.title,
        snippet: '',
        score: cosine,
        normalizedScore: closeness(cosine) * SEMANTIC_ONLY_MAX_SCORE,
        matchType: 'fuzzy',
        modifiedAt: row.modifiedAt,
        metadata
      }
    })
    .toSorted((a, b) => b.score - a.score)
}

function closeness(cosine: number): number {
  const scaled =
    (cosine - EMBEDDING_QUERY_SIMILARITY_FLOOR) / (1 - EMBEDDING_QUERY_SIMILARITY_FLOOR)
  return Math.min(1, Math.max(0, scaled))
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
    const item: SearchResultItem = {
      id: row.id,
      type,
      title: row.title,
      snippet: '',
      score: cosine,
      normalizedScore: closeness(cosine) * SEMANTIC_ONLY_MAX_SCORE,
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
 * Fuse semantic hits into the note, journal and inbox groups by Reciprocal Rank
 * Fusion. An item found by both legs keeps its FTS item (snippet, score) and
 * rises; an item only the vectors found is appended with an empty snippet. The
 * task group is untouched. Returns the new groups and the change in result count.
 */
export function fuseSemanticHits(args: {
  indexDb: IndexDb
  dataDb: DataDb
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
  const inbox = loadInboxItems(args.dataDb, hits)
  if (inbox.length > 0) semantic.set('inbox', inbox)
  const groups = [...args.groups]
  let added = 0

  for (const type of ['note', 'journal', 'inbox'] as const) {
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
      .toSorted((a, b) => b.rrf - a.rrf || a.order - b.order)
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
