// Mirrors desktop's cross-type FTS search (apps/desktop/src/main/database/queries/search.ts):
// the same FTS5 queries, bm25 weights, exact-phrase-first ordering, alias-name hits and
// post-filters. Desktop's fuzzy title fallback and semantic fusion are not mirrored: the first
// needs fuzzysort and the second needs the Electron-hosted embedder. `memry-app.ts` keeps its
// substring scan as the fallback for items the FTS index has not caught up with yet.
// Desktop owns the FTS tables; the CLI only reads them (`vault reindex` rebuilds them).
import { sql } from 'drizzle-orm'
import { nameKey } from '@memry/shared/note-names'
import type { DataDb, IndexDb } from './database.ts'

export const SEARCH_CONTENT_KINDS = ['note', 'journal', 'task', 'inbox'] as const
export type SearchContentKind = (typeof SEARCH_CONTENT_KINDS)[number]

export interface FtsHit {
  kind: SearchContentKind
  id: string
  title: string
  path?: string
  snippet: string
  modifiedAt: string
  projectId?: string
}

export interface FtsSearch {
  search(text: string, kind: SearchContentKind, limit: number): FtsHit[]
  taggedIds(kind: SearchContentKind, tags: string[]): Set<string>
}

const FTS5_SPECIAL_CHARS = /[*"(){}[\]:^~\\]/g

function escapeSearchQuery(query: string): string {
  return query.replace(FTS5_SPECIAL_CHARS, ' ').trim()
}

function buildPrefixQuery(query: string): string {
  const escaped = escapeSearchQuery(query)
  if (!escaped) return ''
  return escaped
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(' ')
}

function buildPhraseQuery(query: string): string {
  const terms = escapeSearchQuery(query).split(/\s+/).filter(Boolean)
  return terms.length < 2 ? '' : `"${terms.join(' ')}"*`
}

function parseOperatorQuery(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''

  const tokens: string[] = []
  const phrases = [...trimmed.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  const words = trimmed
    .replace(/"[^"]*"/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  for (const phrase of phrases) {
    const escaped = escapeSearchQuery(phrase)
    if (escaped) tokens.push(`"${escaped}"`)
  }

  let index = 0
  while (index < words.length) {
    const word = words[index].toUpperCase()
    if (word === 'NOT' && index + 1 < words.length) {
      const next = escapeSearchQuery(words[index + 1])
      if (next) tokens.push(`NOT "${next}"*`)
      index += 2
      continue
    }
    if (word === 'AND' || word === 'OR') {
      if (tokens.length > 0 && index + 1 < words.length) {
        const next = escapeSearchQuery(words[index + 1])
        if (next) {
          tokens.push(word, `"${next}"*`)
          index += 2
          continue
        }
      }
      index += 1
      continue
    }
    const escaped = escapeSearchQuery(words[index])
    if (escaped) tokens.push(`"${escaped}"*`)
    index += 1
  }
  return tokens.join(' ')
}

function tableExists(db: IndexDb | DataDb, name: string): boolean {
  return (
    db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE name = ${name}`).length > 0
  )
}

function stripMarks(snippet: string): string {
  return snippet.replaceAll('<mark>', '').replaceAll('</mark>', '')
}

// Sort key that puts rows holding the typed words side by side ahead of rows that merely
// contain each word somewhere. Empty for single-word and operator queries (plain bm25).
function phraseFirst(phraseQuery: string) {
  if (!phraseQuery) return sql`1 = 0`
  return sql`nc.id NOT IN (SELECT id FROM fts_notes WHERE fts_notes MATCH ${phraseQuery})`
}

interface NoteRow {
  id: string
  title: string
  path: string
  modifiedAt: string
  snippet: string
}

interface NameRow {
  id: string
  title: string
  path: string
  modifiedAt: string
  exact: number
}

export function createFtsSearch({
  indexDb,
  dataDb
}: {
  indexDb: IndexDb
  dataDb: DataDb
}): FtsSearch {
  // Checked per search, not at creation: `vault reindex` creates these tables.
  const available = {
    get notes() {
      return tableExists(indexDb, 'fts_notes')
    },
    get tasks() {
      return tableExists(dataDb, 'fts_tasks')
    },
    get inbox() {
      return tableExists(dataDb, 'fts_inbox')
    }
  }

  const searchNotes = (
    kind: 'note' | 'journal',
    ftsQuery: string,
    phraseQuery: string,
    limit: number
  ): FtsHit[] => {
    if (!available.notes) return []
    const rows = indexDb.all<NoteRow>(sql`
      SELECT nc.id, nc.title, nc.path, nc.modified_at as modifiedAt,
        snippet(fts_notes, 2, '<mark>', '</mark>', '...', 20) as snippet
      FROM fts_notes
      JOIN note_cache nc ON nc.id = fts_notes.id
      WHERE fts_notes MATCH ${ftsQuery}
        AND ${kind === 'journal' ? sql`nc.date IS NOT NULL` : sql`nc.date IS NULL`}
        ${kind === 'note' ? sql`AND COALESCE(nc.file_type, 'markdown') = 'markdown'` : sql``}
      ORDER BY ${
        kind === 'note' ? sql`COALESCE(nc.file_type, 'markdown') <> 'markdown',` : sql``
      } ${phraseFirst(phraseQuery)}, bm25(fts_notes, 0.0, 2.0, 1.0, 1.0)
      LIMIT ${limit}
    `)
    return rows.map((row) => ({ kind, ...row, snippet: stripMarks(row.snippet) }))
  }

  const searchNames = (kind: 'note' | 'journal', text: string, limit: number): NameRow[] => {
    const key = nameKey(text)
    if (key === null) return []
    const prefix = `${key.replace(/[\\%_]/g, '\\$&')}%`
    return indexDb.all<NameRow>(sql`
      SELECT nc.id, nc.title, nc.path, nc.modified_at as modifiedAt, nn.key = ${key} as exact
      FROM note_names nn
      JOIN note_cache nc ON nc.id = nn.note_id
      WHERE nn.kind = 'alias'
        AND nn.key LIKE ${prefix} ESCAPE '\\'
        AND ${kind === 'journal' ? sql`nc.date IS NOT NULL` : sql`nc.date IS NULL`}
      ORDER BY exact DESC, length(nn.key), nc.id
      LIMIT ${limit}
    `)
  }

  const searchTasks = (ftsQuery: string, limit: number): FtsHit[] => {
    if (!available.tasks) return []
    return dataDb
      .all<{
        id: string
        title: string
        projectId: string
        modifiedAt: string
        snippet: string
      }>(
        sql`
      SELECT t.id, t.title, t.project_id as projectId, t.modified_at as modifiedAt,
        snippet(fts_tasks, 1, '<mark>', '</mark>', '...', 20) as snippet
      FROM fts_tasks
      JOIN tasks t ON t.id = fts_tasks.id
      WHERE fts_tasks MATCH ${ftsQuery}
      ORDER BY bm25(fts_tasks, 0.0, 2.0, 1.0, 1.0)
      LIMIT ${limit}
    `
      )
      .map((row) => ({ kind: 'task', ...row, snippet: stripMarks(row.snippet) }))
  }

  const searchInbox = (ftsQuery: string, limit: number): FtsHit[] => {
    if (!available.inbox) return []
    return dataDb
      .all<{ id: string; title: string; modifiedAt: string; snippet: string }>(
        sql`
      SELECT i.id, i.title, i.modified_at as modifiedAt,
        snippet(fts_inbox, 2, '<mark>', '</mark>', '...', 20) as snippet
      FROM fts_inbox
      JOIN inbox_items i ON i.id = fts_inbox.id
      WHERE fts_inbox MATCH ${ftsQuery}
      ORDER BY bm25(fts_inbox, 0.0, 3.0, 1.0, 1.0, 0.5)
      LIMIT ${limit}
    `
      )
      .map((row) => ({ kind: 'inbox', ...row, snippet: stripMarks(row.snippet) }))
  }

  return {
    search(rawText, kind, limit) {
      const text = rawText.slice(0, 500)
      const hasOperators = /\b(AND|OR|NOT)\b/.test(text) || /"[^"]+"/.test(text)
      const ftsQuery = hasOperators ? parseOperatorQuery(text) : buildPrefixQuery(text)
      if (!ftsQuery) return []
      const phraseQuery = hasOperators ? '' : buildPhraseQuery(text)

      let hits: FtsHit[]
      try {
        if (kind === 'note' || kind === 'journal')
          hits = searchNotes(kind, ftsQuery, phraseQuery, limit)
        else if (kind === 'task') hits = searchTasks(ftsQuery, limit)
        else hits = searchInbox(ftsQuery, limit)
      } catch {
        // An operator query FTS5 cannot parse, or an index being rebuilt by desktop: this
        // kind has no FTS hits, and the caller's substring scan still answers it.
        return []
      }

      if (kind !== 'note' && kind !== 'journal') return hits
      let names: NameRow[] = []
      try {
        names = searchNames(kind, text, limit)
      } catch {
        // note_names is derived data that may not exist yet; same fallback as above.
      }
      const exactIds = new Set(names.filter((name) => name.exact).map((name) => name.id))
      const byId = new Map(hits.map((hit) => [hit.id, hit]))
      const nameHit = (row: NameRow): FtsHit =>
        byId.get(row.id) ?? {
          kind,
          id: row.id,
          title: row.title,
          path: row.path,
          snippet: '',
          modifiedAt: row.modifiedAt
        }
      // Same order as desktop's mergeNameHits: exact alias hits, FTS hits, prefix alias hits.
      const merged = [
        ...names.filter((name) => name.exact).map(nameHit),
        ...hits.filter((hit) => !exactIds.has(hit.id)),
        ...names.filter((name) => !name.exact && !byId.has(name.id)).map(nameHit)
      ]
      return [...new Map(merged.map((hit) => [hit.id, hit])).values()]
    },

    taggedIds(kind, tags) {
      if (tags.length === 0) return new Set()
      const tagList = sql.join(
        tags.map((tag) => sql`${tag}`),
        sql`, `
      )
      const rows =
        kind === 'note' || kind === 'journal'
          ? indexDb.all<{ id: string }>(
              sql`SELECT DISTINCT note_id as id FROM note_tags WHERE tag IN (${tagList})`
            )
          : kind === 'task'
            ? dataDb.all<{ id: string }>(
                sql`SELECT DISTINCT task_id as id FROM task_tags WHERE tag IN (${tagList})`
              )
            : dataDb.all<{ id: string }>(
                sql`SELECT DISTINCT inbox_item_id as id FROM inbox_item_tags WHERE tag IN (${tagList})`
              )
      return new Set(rows.map((row) => row.id))
    }
  }
}
