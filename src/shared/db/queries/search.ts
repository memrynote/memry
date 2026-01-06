/**
 * Search query functions for FTS5 full-text search.
 * Uses SQLite FTS5 with BM25 ranking for relevance scoring.
 *
 * @module db/queries/search
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ============================================================================
// Types
// ============================================================================

export interface SearchResultNote {
  id: string
  path: string
  title: string
  snippet: string
  score: number
  matchedIn: ('title' | 'content' | 'tags')[]
  createdAt: string
  modifiedAt: string
  tags: string[]
}

export interface SearchOptions {
  limit?: number
  offset?: number
  tags?: string[]
  folder?: string
}

export interface QuickSearchResult {
  notes: SearchResultNote[]
}

export interface SearchSuggestion {
  text: string
  type: 'recent' | 'tag' | 'title' | 'completion'
  count?: number
}

// ============================================================================
// Highlighting Utilities
// ============================================================================

/**
 * Highlights search terms in arbitrary text using <mark> tags.
 * Useful for highlighting matches in titles, tags, etc. that don't
 * come from FTS snippet().
 *
 * @param text - Text to highlight
 * @param query - Search query (will be split into terms)
 * @param tag - HTML tag to use for highlighting (default: 'mark')
 * @returns Text with highlighted matches
 *
 * @example
 * ```typescript
 * highlightTerms('Hello World', 'world')
 * // Returns: 'Hello <mark>World</mark>'
 * ```
 */
export function highlightTerms(text: string, query: string, tag: string = 'mark'): string {
  if (!text || !query) return text

  // Get search terms from query
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) // Escape regex special chars

  if (terms.length === 0) return text

  // Build regex pattern that matches any term (case insensitive)
  const pattern = new RegExp(`(${terms.join('|')})`, 'gi')

  // Replace matches with highlighted version
  return text.replace(pattern, `<${tag}>$1</${tag}>`)
}

/**
 * Extracts a snippet from text around the first match.
 * Useful for creating snippets when FTS snippet() isn't available.
 *
 * @param text - Full text to extract from
 * @param query - Search query to find
 * @param contextChars - Characters of context around match (default: 50)
 * @returns Snippet with highlighted match
 */
export function extractSnippet(
  text: string,
  query: string,
  contextChars: number = 50
): string {
  if (!text || !query) return text.slice(0, contextChars * 2) + '...'

  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (terms.length === 0) return text.slice(0, contextChars * 2) + '...'

  // Find first match position
  const textLower = text.toLowerCase()
  let matchIndex = -1
  let matchTerm = ''

  for (const term of terms) {
    const idx = textLower.indexOf(term)
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
      matchIndex = idx
      matchTerm = term
    }
  }

  if (matchIndex === -1) {
    // No match found, return beginning of text
    return text.slice(0, contextChars * 2) + (text.length > contextChars * 2 ? '...' : '')
  }

  // Calculate start and end positions for snippet
  const start = Math.max(0, matchIndex - contextChars)
  const end = Math.min(text.length, matchIndex + matchTerm.length + contextChars)

  // Build snippet
  let snippet = ''
  if (start > 0) snippet += '...'
  snippet += text.slice(start, end)
  if (end < text.length) snippet += '...'

  // Highlight all terms in snippet
  return highlightTerms(snippet, query)
}

// ============================================================================
// Query Escaping
// ============================================================================

/**
 * Escapes special FTS5 query characters.
 * FTS5 special characters: " * - ( ) : ^
 *
 * @param query - Raw user query string
 * @returns Escaped query safe for FTS5
 */
export function escapeSearchQuery(query: string): string {
  // Remove or escape FTS5 special characters
  let escaped = query
    .replace(/"/g, ' ') // Remove quotes to avoid phrase parsing
    .replace(/\*/g, '') // Remove wildcards (we add our own)
    .replace(/[():\-^]/g, ' ') // Replace operators with spaces
    .trim()

  // Normalize whitespace
  escaped = escaped.replace(/\s+/g, ' ')

  return escaped
}

/**
 * Builds an FTS5 query with prefix matching.
 * Splits query into terms and adds * suffix for prefix matching.
 *
 * @param query - Escaped query string
 * @returns FTS5 query with prefix matching
 */
export function buildPrefixQuery(query: string): string {
  const terms = query.split(/\s+/).filter((t) => t.length > 0)

  if (terms.length === 0) return ''

  // Add * suffix to each term for prefix matching
  // Join with space (implicit AND in FTS5)
  return terms.map((term) => `"${term}"*`).join(' ')
}

// ============================================================================
// Search Functions
// ============================================================================

/**
 * Search notes using FTS5 with BM25 ranking.
 * Returns results sorted by relevance score.
 *
 * @param db - Drizzle database instance
 * @param query - Search query string
 * @param options - Search options (limit, offset, tags, folder)
 * @returns Array of search results with snippets and scores
 */
export function searchNotes(
  db: DrizzleDb,
  query: string,
  options: SearchOptions = {}
): SearchResultNote[] {
  const { limit = 50, offset = 0, tags, folder } = options

  // Escape and build query
  const escapedQuery = escapeSearchQuery(query)
  if (!escapedQuery) return []

  const ftsQuery = buildPrefixQuery(escapedQuery)
  if (!ftsQuery) return []

  // Build the search query with BM25 ranking
  // snippet() extracts context around matches with highlighting
  const results = db.all<{
    id: string
    path: string
    title: string
    snippet: string
    score: number
    fts_title: string
    fts_content: string
    fts_tags: string
    createdAt: string
    modifiedAt: string
  }>(sql`
    SELECT
      nc.id,
      nc.path,
      nc.title,
      snippet(fts_notes, 2, '<mark>', '</mark>', '...', 30) as snippet,
      bm25(fts_notes, 1.0, 2.0, 1.0) as score,
      fts_notes.title as fts_title,
      fts_notes.content as fts_content,
      fts_notes.tags as fts_tags,
      nc.created_at as createdAt,
      nc.modified_at as modifiedAt
    FROM fts_notes
    INNER JOIN note_cache nc ON nc.id = fts_notes.id
    WHERE fts_notes MATCH ${ftsQuery}
    ${folder ? sql`AND nc.path LIKE ${folder + '%'}` : sql``}
    ORDER BY score DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `)

  // Get tags for each result and determine what matched
  return results.map((row) => {
    const noteTags = getTagsForNote(db, row.id)
    const matchedIn = determineMatchedFields(
      escapedQuery,
      row.fts_title,
      row.fts_content,
      row.fts_tags
    )

    // Filter by tags if specified
    if (tags && tags.length > 0) {
      const hasMatchingTag = tags.some((t) => noteTags.includes(t.toLowerCase()))
      if (!hasMatchingTag) return null
    }

    return {
      id: row.id,
      path: row.path,
      title: row.title,
      snippet: row.snippet || '',
      score: Math.abs(row.score), // BM25 returns negative scores
      matchedIn,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt,
      tags: noteTags
    }
  }).filter((r): r is SearchResultNote => r !== null)
}

/**
 * Quick search for command palette / omnibar.
 * Faster search with fewer results and minimal processing.
 *
 * @param db - Drizzle database instance
 * @param query - Search query string
 * @param limit - Maximum number of results (default 5)
 * @returns Quick search results
 */
export function quickSearch(
  db: DrizzleDb,
  query: string,
  limit: number = 5
): QuickSearchResult {
  const escapedQuery = escapeSearchQuery(query)
  if (!escapedQuery) return { notes: [] }

  const ftsQuery = buildPrefixQuery(escapedQuery)
  if (!ftsQuery) return { notes: [] }

  const results = db.all<{
    id: string
    path: string
    title: string
    snippet: string
    score: number
    createdAt: string
    modifiedAt: string
  }>(sql`
    SELECT
      nc.id,
      nc.path,
      nc.title,
      snippet(fts_notes, 2, '<mark>', '</mark>', '...', 20) as snippet,
      bm25(fts_notes) as score,
      nc.created_at as createdAt,
      nc.modified_at as modifiedAt
    FROM fts_notes
    INNER JOIN note_cache nc ON nc.id = fts_notes.id
    WHERE fts_notes MATCH ${ftsQuery}
    ORDER BY score DESC
    LIMIT ${limit}
  `)

  const notes: SearchResultNote[] = results.map((row) => ({
    id: row.id,
    path: row.path,
    title: row.title,
    snippet: row.snippet || '',
    score: Math.abs(row.score),
    matchedIn: ['title', 'content'], // Simplified for quick search
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
    tags: getTagsForNote(db, row.id)
  }))

  return { notes }
}

/**
 * Get search suggestions based on a prefix.
 * Includes tags, recent titles, and completions.
 *
 * @param db - Drizzle database instance
 * @param prefix - Prefix to search for
 * @param limit - Maximum suggestions (default 5)
 * @returns Array of search suggestions
 */
export function getSuggestions(
  db: DrizzleDb,
  prefix: string,
  limit: number = 5
): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = []
  const normalizedPrefix = prefix.toLowerCase().trim()

  if (!normalizedPrefix) return suggestions

  // Get matching tags
  const matchingTags = db.all<{ tag: string; count: number }>(sql`
    SELECT tag, COUNT(*) as count
    FROM note_tags
    WHERE tag LIKE ${normalizedPrefix + '%'}
    GROUP BY tag
    ORDER BY count DESC
    LIMIT ${Math.ceil(limit / 2)}
  `)

  for (const row of matchingTags) {
    suggestions.push({
      text: row.tag,
      type: 'tag',
      count: row.count
    })
  }

  // Get matching note titles
  const matchingTitles = db.all<{ title: string }>(sql`
    SELECT DISTINCT title
    FROM note_cache
    WHERE LOWER(title) LIKE ${normalizedPrefix + '%'}
    ORDER BY modified_at DESC
    LIMIT ${limit - suggestions.length}
  `)

  for (const row of matchingTitles) {
    suggestions.push({
      text: row.title,
      type: 'title'
    })
  }

  return suggestions.slice(0, limit)
}

/**
 * Search for notes containing a specific tag.
 *
 * @param db - Drizzle database instance
 * @param tag - Tag to search for
 * @param limit - Maximum results (default 50)
 * @returns Array of notes with the tag
 */
export function findNotesByTag(
  db: DrizzleDb,
  tag: string,
  limit: number = 50
): SearchResultNote[] {
  const normalizedTag = tag.toLowerCase().trim()

  const results = db.all<{
    id: string
    path: string
    title: string
    createdAt: string
    modifiedAt: string
  }>(sql`
    SELECT
      nc.id,
      nc.path,
      nc.title,
      nc.created_at as createdAt,
      nc.modified_at as modifiedAt
    FROM note_cache nc
    INNER JOIN note_tags nt ON nt.note_id = nc.id
    WHERE nt.tag = ${normalizedTag}
    ORDER BY nc.modified_at DESC
    LIMIT ${limit}
  `)

  return results.map((row) => ({
    id: row.id,
    path: row.path,
    title: row.title,
    snippet: '', // note_cache doesn't store snippets
    score: 1.0,
    matchedIn: ['tags'] as ('title' | 'content' | 'tags')[],
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
    tags: getTagsForNote(db, row.id)
  }))
}

/**
 * Find notes that link to a specific note (backlinks).
 *
 * @param db - Drizzle database instance
 * @param noteId - Target note ID
 * @param limit - Maximum results (default 50)
 * @returns Array of notes linking to the target
 */
export function findBacklinks(
  db: DrizzleDb,
  noteId: string,
  limit: number = 50
): SearchResultNote[] {
  const results = db.all<{
    id: string
    path: string
    title: string
    createdAt: string
    modifiedAt: string
  }>(sql`
    SELECT
      nc.id,
      nc.path,
      nc.title,
      nc.created_at as createdAt,
      nc.modified_at as modifiedAt
    FROM note_cache nc
    INNER JOIN note_links nl ON nl.source_id = nc.id
    WHERE nl.target_id = ${noteId}
    ORDER BY nc.modified_at DESC
    LIMIT ${limit}
  `)

  return results.map((row) => ({
    id: row.id,
    path: row.path,
    title: row.title,
    snippet: '', // note_cache doesn't store snippets
    score: 1.0,
    matchedIn: ['content'] as ('title' | 'content' | 'tags')[],
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
    tags: getTagsForNote(db, row.id)
  }))
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get tags for a specific note.
 */
function getTagsForNote(db: DrizzleDb, noteId: string): string[] {
  const results = db.all<{ tag: string }>(sql`
    SELECT tag FROM note_tags WHERE note_id = ${noteId}
  `)
  return results.map((r) => r.tag)
}

/**
 * Determine which fields matched the search query.
 */
function determineMatchedFields(
  query: string,
  title: string,
  content: string,
  tags: string
): ('title' | 'content' | 'tags')[] {
  const matched: ('title' | 'content' | 'tags')[] = []
  const queryLower = query.toLowerCase()
  const terms = queryLower.split(/\s+/)

  for (const term of terms) {
    if (title && title.toLowerCase().includes(term)) {
      if (!matched.includes('title')) matched.push('title')
    }
    if (content && content.toLowerCase().includes(term)) {
      if (!matched.includes('content')) matched.push('content')
    }
    if (tags && tags.toLowerCase().includes(term)) {
      if (!matched.includes('tags')) matched.push('tags')
    }
  }

  return matched.length > 0 ? matched : ['content']
}

/**
 * Get total count of searchable notes.
 */
export function getSearchableCount(db: DrizzleDb): number {
  const result = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM fts_notes
  `)
  return result?.count ?? 0
}

/**
 * Check if FTS index is healthy (has same count as note_cache).
 */
export function isFtsHealthy(db: DrizzleDb): boolean {
  const ftsCount = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM fts_notes
  `)
  const cacheCount = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM note_cache
  `)

  return (ftsCount?.count ?? 0) === (cacheCount?.count ?? 0)
}
