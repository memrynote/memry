/**
 * Cross-type search orchestrator.
 *
 * Runs parallel FTS5 queries across index.db (notes/journals)
 * and data.db (tasks/inbox), normalizes scores, and merges
 * into grouped results.
 *
 * @module db/queries/search
 */

import { sql } from 'drizzle-orm'
import type { DataDb, IndexDb } from '../types'
import type {
  ContentType,
  SearchResultItem,
  SearchResultGroup,
  SearchResponse,
  QuickSearchResponse,
  SearchStats,
  SearchQuery,
  NoteResultMetadata,
  JournalResultMetadata,
  TaskResultMetadata,
  InboxResultMetadata
} from '@memry/contracts/search-api'
import {
  normalizeScores,
  buildPrefixQuery,
  parseSearchQuery,
  truncateQuery
} from '../../lib/search-utils'
import { fuzzySearchTitles } from '../../lib/fuzzysort-search'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Search')

// ============================================================================
// Raw FTS result types
// ============================================================================

interface FtsNoteRow {
  id: string
  title: string
  path: string
  date: string | null
  emoji: string | null
  wordCount: number | null
  modifiedAt: string
  rank: number
  snippet: string
}

interface FtsTaskRow {
  id: string
  title: string
  projectId: string
  projectName: string
  projectColor: string
  statusId: string | null
  statusName: string | null
  dueDate: string | null
  priority: number
  completedAt: string | null
  modifiedAt: string
  rank: number
  snippet: string
}

interface FtsInboxRow {
  id: string
  title: string
  type: string
  sourceUrl: string | null
  sourceTitle: string | null
  filedAt: string | null
  modifiedAt: string
  rank: number
  snippet: string
}

// ============================================================================
// Per-type FTS queries
// ============================================================================

function searchNotes(indexDb: IndexDb, ftsQuery: string, limit: number): SearchResultItem[] {
  if (!ftsQuery) return []

  const rows = indexDb.all<FtsNoteRow>(sql`
    SELECT
      nc.id,
      nc.title,
      nc.path,
      nc.date,
      nc.emoji,
      nc.word_count as wordCount,
      nc.modified_at as modifiedAt,
      bm25(fts_notes, 0.0, 2.0, 1.0, 1.0) as rank,
      snippet(fts_notes, 2, '<mark>', '</mark>', '...', 20) as snippet
    FROM fts_notes
    JOIN note_cache nc ON nc.id = fts_notes.id
    WHERE fts_notes MATCH ${ftsQuery}
      AND nc.date IS NULL
    ORDER BY rank
    LIMIT ${limit}
  `)

  return rows.map((row) => {
    const metadata: NoteResultMetadata = {
      type: 'note',
      path: row.path,
      tags: [],
      emoji: row.emoji,
      wordCount: row.wordCount
    }
    return {
      id: row.id,
      type: 'note' as ContentType,
      title: row.title,
      snippet: row.snippet,
      score: Math.abs(row.rank),
      normalizedScore: 0,
      matchType: 'exact' as const,
      modifiedAt: row.modifiedAt,
      metadata
    }
  })
}

function searchJournals(indexDb: IndexDb, ftsQuery: string, limit: number): SearchResultItem[] {
  if (!ftsQuery) return []

  const rows = indexDb.all<FtsNoteRow>(sql`
    SELECT
      nc.id,
      nc.title,
      nc.path,
      nc.date,
      nc.emoji,
      nc.word_count as wordCount,
      nc.modified_at as modifiedAt,
      bm25(fts_notes, 0.0, 2.0, 1.0, 1.0) as rank,
      snippet(fts_notes, 2, '<mark>', '</mark>', '...', 20) as snippet
    FROM fts_notes
    JOIN note_cache nc ON nc.id = fts_notes.id
    WHERE fts_notes MATCH ${ftsQuery}
      AND nc.date IS NOT NULL
    ORDER BY rank
    LIMIT ${limit}
  `)

  return rows.map((row) => {
    const metadata: JournalResultMetadata = {
      type: 'journal',
      date: row.date!,
      path: row.path,
      tags: [],
      wordCount: row.wordCount
    }
    return {
      id: row.id,
      type: 'journal' as ContentType,
      title: row.title,
      snippet: row.snippet,
      score: Math.abs(row.rank),
      normalizedScore: 0,
      matchType: 'exact' as const,
      modifiedAt: row.modifiedAt,
      metadata
    }
  })
}

function searchTasks(dataDb: DataDb, ftsQuery: string, limit: number): SearchResultItem[] {
  if (!ftsQuery) return []

  const rows = dataDb.all<FtsTaskRow>(sql`
    SELECT
      t.id,
      t.title,
      t.project_id as projectId,
      p.name as projectName,
      p.color as projectColor,
      t.status_id as statusId,
      s.name as statusName,
      t.due_date as dueDate,
      t.priority,
      t.completed_at as completedAt,
      t.modified_at as modifiedAt,
      bm25(fts_tasks, 0.0, 2.0, 1.0, 1.0) as rank,
      snippet(fts_tasks, 1, '<mark>', '</mark>', '...', 20) as snippet
    FROM fts_tasks
    JOIN tasks t ON t.id = fts_tasks.id
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN statuses s ON s.id = t.status_id
    WHERE fts_tasks MATCH ${ftsQuery}
    ORDER BY rank
    LIMIT ${limit}
  `)

  return rows.map((row) => {
    const metadata: TaskResultMetadata = {
      type: 'task',
      projectId: row.projectId,
      projectName: row.projectName,
      projectColor: row.projectColor,
      statusId: row.statusId,
      statusName: row.statusName,
      dueDate: row.dueDate,
      priority: row.priority,
      completedAt: row.completedAt
    }
    return {
      id: row.id,
      type: 'task' as ContentType,
      title: row.title,
      snippet: row.snippet,
      score: Math.abs(row.rank),
      normalizedScore: 0,
      matchType: 'exact' as const,
      modifiedAt: row.modifiedAt,
      metadata
    }
  })
}

function searchInbox(dataDb: DataDb, ftsQuery: string, limit: number): SearchResultItem[] {
  if (!ftsQuery) return []

  const rows = dataDb.all<FtsInboxRow>(sql`
    SELECT
      i.id,
      i.title,
      i.type,
      i.source_url as sourceUrl,
      i.source_title as sourceTitle,
      i.filed_at as filedAt,
      i.modified_at as modifiedAt,
      bm25(fts_inbox, 0.0, 3.0, 1.0, 1.0, 0.5) as rank,
      snippet(fts_inbox, 2, '<mark>', '</mark>', '...', 20) as snippet
    FROM fts_inbox
    JOIN inbox_items i ON i.id = fts_inbox.id
    WHERE fts_inbox MATCH ${ftsQuery}
    ORDER BY rank
    LIMIT ${limit}
  `)

  return rows.map((row) => {
    const metadata: InboxResultMetadata = {
      type: 'inbox',
      itemType: row.type as InboxResultMetadata['itemType'],
      sourceUrl: row.sourceUrl,
      sourceTitle: row.sourceTitle,
      filedAt: row.filedAt
    }
    return {
      id: row.id,
      type: 'inbox' as ContentType,
      title: row.title,
      snippet: row.snippet,
      score: Math.abs(row.rank),
      normalizedScore: 0,
      matchType: 'exact' as const,
      modifiedAt: row.modifiedAt,
      metadata
    }
  })
}

// ============================================================================
// Fuzzy fallback candidate loaders
// ============================================================================

const FUZZY_FALLBACK_THRESHOLD = 3

interface TitleRow {
  id: string
  title: string
  modifiedAt: string
}

function getNoteTitles(
  indexDb: IndexDb
): Array<TitleRow & { type: ContentType; metadata: NoteResultMetadata }> {
  const rows = indexDb.all<TitleRow & { path: string; emoji: string | null }>(
    sql`SELECT id, title, path, emoji, modified_at as modifiedAt FROM note_cache WHERE date IS NULL`
  )
  return rows.map((r) => ({
    ...r,
    type: 'note' as ContentType,
    metadata: { type: 'note' as const, path: r.path, tags: [], emoji: r.emoji }
  }))
}

function getJournalTitles(
  indexDb: IndexDb
): Array<TitleRow & { type: ContentType; metadata: JournalResultMetadata }> {
  const rows = indexDb.all<TitleRow & { path: string; date: string }>(
    sql`SELECT id, title, path, date, modified_at as modifiedAt FROM note_cache WHERE date IS NOT NULL`
  )
  return rows.map((r) => ({
    ...r,
    type: 'journal' as ContentType,
    metadata: { type: 'journal' as const, date: r.date, path: r.path, tags: [] }
  }))
}

function getTaskTitles(
  dataDb: DataDb
): Array<TitleRow & { type: ContentType; metadata: TaskResultMetadata }> {
  const rows = dataDb.all<
    TitleRow & {
      projectId: string
      projectName: string
      projectColor: string
      statusId: string | null
      statusName: string | null
      dueDate: string | null
      priority: number
      completedAt: string | null
    }
  >(sql`
    SELECT t.id, t.title, t.modified_at as modifiedAt,
      t.project_id as projectId, p.name as projectName, p.color as projectColor,
      t.status_id as statusId, s.name as statusName,
      t.due_date as dueDate, t.priority, t.completed_at as completedAt
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN statuses s ON s.id = t.status_id
  `)
  return rows.map((r) => ({
    ...r,
    type: 'task' as ContentType,
    metadata: {
      type: 'task' as const,
      projectId: r.projectId,
      projectName: r.projectName,
      projectColor: r.projectColor,
      statusId: r.statusId,
      statusName: r.statusName,
      dueDate: r.dueDate,
      priority: r.priority,
      completedAt: r.completedAt
    }
  }))
}

function getInboxTitles(
  dataDb: DataDb
): Array<TitleRow & { type: ContentType; metadata: InboxResultMetadata }> {
  const rows = dataDb.all<
    TitleRow & {
      itemType: string
      sourceUrl: string | null
      sourceTitle: string | null
      filedAt: string | null
    }
  >(sql`
    SELECT id, title, modified_at as modifiedAt,
      type as itemType, source_url as sourceUrl, source_title as sourceTitle, filed_at as filedAt
    FROM inbox_items
  `)
  return rows.map((r) => ({
    ...r,
    type: 'inbox' as ContentType,
    metadata: {
      type: 'inbox' as const,
      itemType: r.itemType as InboxResultMetadata['itemType'],
      sourceUrl: r.sourceUrl,
      sourceTitle: r.sourceTitle,
      filedAt: r.filedAt
    }
  }))
}

function getItemTagIds(
  indexDb: IndexDb,
  dataDb: DataDb,
  type: ContentType,
  tags: string[]
): Set<string> {
  if (tags.length === 0) return new Set()

  const tagList = sql.join(
    tags.map((t) => sql`${t}`),
    sql`, `
  )

  let rows: Array<{ id: string }> = []

  switch (type) {
    case 'note':
    case 'journal':
      rows = indexDb.all<{ id: string }>(
        sql`SELECT DISTINCT note_id as id FROM note_tags WHERE tag IN (${tagList})`
      )
      break
    case 'task':
      rows = dataDb.all<{ id: string }>(
        sql`SELECT DISTINCT task_id as id FROM task_tags WHERE tag IN (${tagList})`
      )
      break
    case 'inbox':
      rows = dataDb.all<{ id: string }>(
        sql`SELECT DISTINCT inbox_item_id as id FROM inbox_item_tags WHERE tag IN (${tagList})`
      )
      break
  }

  return new Set(rows.map((r) => r.id))
}

function applyPostFilters(
  results: SearchResultItem[],
  query: SearchQuery,
  taggedIds: Set<string> | null
): SearchResultItem[] {
  let filtered = results

  if (taggedIds && taggedIds.size > 0) {
    filtered = filtered.filter((r) => taggedIds.has(r.id))
  }

  if (query.dateRange) {
    const { from, to } = query.dateRange
    filtered = filtered.filter((r) => r.modifiedAt >= from && r.modifiedAt <= to)
  }

  if (query.projectId) {
    filtered = filtered.filter(
      (r) => r.metadata.type === 'task' && r.metadata.projectId === query.projectId
    )
  }

  if (query.folderPath) {
    const prefix = query.folderPath
    filtered = filtered.filter(
      (r) =>
        (r.metadata.type === 'note' || r.metadata.type === 'journal') &&
        r.metadata.path.startsWith(prefix)
    )
  }

  return filtered
}

function loadFuzzyCandidates(indexDb: IndexDb, dataDb: DataDb, type: ContentType) {
  switch (type) {
    case 'note':
      return getNoteTitles(indexDb)
    case 'journal':
      return getJournalTitles(indexDb)
    case 'task':
      return getTaskTitles(dataDb)
    case 'inbox':
      return getInboxTitles(dataDb)
  }
}

// ============================================================================
// Orchestrator
// ============================================================================

export function searchAll(indexDb: IndexDb, dataDb: DataDb, query: SearchQuery): SearchResponse {
  const startTime = performance.now()
  const truncated = truncateQuery(query.text)
  const hasOperators = /\b(AND|OR|NOT)\b/.test(truncated) || /"[^"]+"/.test(truncated)
  const ftsQuery = hasOperators ? parseSearchQuery(truncated) : buildPrefixQuery(truncated)

  if (!ftsQuery) {
    return { groups: [], totalCount: 0, queryTimeMs: 0 }
  }

  const activeTypes =
    query.types.length > 0 ? query.types : (['note', 'journal', 'task', 'inbox'] as ContentType[])

  const hasFilters = query.tags.length > 0 || query.dateRange !== null
  const fetchLimit = hasFilters ? query.limit * 5 : query.limit

  const groups: SearchResultGroup[] = []
  let totalCount = 0

  for (const type of activeTypes) {
    let results: SearchResultItem[] = []

    try {
      switch (type) {
        case 'note':
          results = searchNotes(indexDb, ftsQuery, fetchLimit)
          break
        case 'journal':
          results = searchJournals(indexDb, ftsQuery, fetchLimit)
          break
        case 'task':
          results = searchTasks(dataDb, ftsQuery, fetchLimit)
          break
        case 'inbox':
          results = searchInbox(dataDb, ftsQuery, fetchLimit)
          break
      }
    } catch (error) {
      logger.warn(`Search failed for type ${type}:`, error)
      continue
    }

    if (hasFilters) {
      const taggedIds =
        query.tags.length > 0 ? getItemTagIds(indexDb, dataDb, type, query.tags) : null
      results = applyPostFilters(results, query, taggedIds).slice(0, query.limit)
    }

    const normalized = normalizeScores(results)

    if (normalized.length < FUZZY_FALLBACK_THRESHOLD) {
      try {
        const candidates = loadFuzzyCandidates(indexDb, dataDb, type)
        const existingIds = new Set(normalized.map((r) => r.id))
        const fuzzyResults = fuzzySearchTitles(candidates, query.text, query.limit).filter(
          (r) => !existingIds.has(r.id)
        )

        const merged = [...normalized, ...fuzzyResults].slice(0, query.limit)
        if (merged.length > 0) {
          groups.push({ type, results: merged, totalInGroup: merged.length })
          totalCount += merged.length
        }
      } catch (error) {
        logger.warn(`Fuzzy fallback failed for type ${type}:`, error)
        if (normalized.length > 0) {
          groups.push({ type, results: normalized, totalInGroup: normalized.length })
          totalCount += normalized.length
        }
      }
    } else {
      groups.push({ type, results: normalized, totalInGroup: normalized.length })
      totalCount += normalized.length
    }
  }

  const queryTimeMs = Math.round(performance.now() - startTime)
  return { groups, totalCount, queryTimeMs }
}

export function quickSearch(indexDb: IndexDb, dataDb: DataDb, text: string): QuickSearchResponse {
  const startTime = performance.now()
  const query: SearchQuery = {
    text,
    types: [],
    tags: [],
    dateRange: null,
    projectId: null,
    folderPath: null,
    limit: 5,
    offset: 0
  }

  const response = searchAll(indexDb, dataDb, query)

  const allResults = response.groups
    .flatMap((g) => g.results)
    .sort((a, b) => b.normalizedScore - a.normalizedScore)
    .slice(0, 20)

  const queryTimeMs = Math.round(performance.now() - startTime)
  return { results: allResults, queryTimeMs }
}

export function getSearchStats(indexDb: IndexDb, dataDb: DataDb): SearchStats {
  const notesResult = indexDb.get<{ count: number }>(
    sql`SELECT COUNT(*) as count FROM note_cache WHERE date IS NULL`
  )
  const journalsResult = indexDb.get<{ count: number }>(
    sql`SELECT COUNT(*) as count FROM note_cache WHERE date IS NOT NULL`
  )
  const tasksResult = dataDb.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM tasks`)
  const inboxResult = dataDb.get<{ count: number }>(sql`SELECT COUNT(*) as count FROM inbox_items`)

  const totalNotes = notesResult?.count ?? 0
  const totalJournals = journalsResult?.count ?? 0
  const totalTasks = tasksResult?.count ?? 0
  const totalInboxItems = inboxResult?.count ?? 0

  return {
    totalNotes,
    totalJournals,
    totalTasks,
    totalInboxItems,
    totalIndexed: totalNotes + totalJournals + totalTasks + totalInboxItems,
    lastIndexedAt: null
  }
}
