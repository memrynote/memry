/**
 * Search IPC API Contract
 *
 * Handles full-text search across notes and tasks.
 * Uses SQLite FTS5 for fast text search.
 */

import { z } from 'zod'

// ============================================================================
// Types
// ============================================================================

export interface SearchResultNote {
  type: 'note'
  id: string
  path: string
  title: string
  emoji?: string | null
  snippet: string
  score: number
  matchedIn: ('title' | 'content' | 'tags')[]
  created: string
  modified: string
  tags: string[]
}

export interface SearchResultTask {
  type: 'task'
  id: string
  title: string
  snippet: string | null // From description if matched
  score: number
  matchedIn: ('title' | 'description' | 'tags')[]
  projectId: string
  projectName: string
  dueDate: string | null
  priority: 0 | 1 | 2 | 3
  completed: boolean
}

export interface SearchResultJournal {
  type: 'journal'
  id: string
  date: string
  snippet: string
  score: number
}

export type SearchResult = SearchResultNote | SearchResultTask | SearchResultJournal

export interface SearchSuggestion {
  text: string
  type: 'recent' | 'tag' | 'title' | 'completion'
  count?: number
}

export interface SearchStats {
  totalNotes: number
  totalTasks: number
  totalJournals: number
  lastIndexed: string
  indexHealth: 'healthy' | 'rebuilding' | 'corrupt'
}

// ============================================================================
// Request Schemas
// ============================================================================

export const SearchQuerySchema = z.object({
  query: z.string().min(1).max(500),
  types: z.array(z.enum(['note', 'task', 'journal'])).default(['note', 'task', 'journal']),
  tags: z.array(z.string()).optional(),
  projectId: z.string().optional(), // Filter tasks by project
  dateFrom: z.string().optional(), // ISO date
  dateTo: z.string().optional(),
  includeArchived: z.boolean().default(false),
  includeCompleted: z.boolean().default(false),
  sortBy: z.enum(['relevance', 'modified', 'created']).default('relevance'),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0)
})

export const QuickSearchSchema = z.object({
  query: z.string().min(1).max(100),
  limit: z.number().int().min(1).max(10).default(5)
})

export const SuggestionsSchema = z.object({
  prefix: z.string().max(50),
  limit: z.number().int().min(1).max(10).default(5)
})

export const PropertyFilterSchema = z.object({
  name: z.string(),
  value: z.string()
})

export const SearchOperatorsSchema = z.object({
  path: z.string().optional(),
  file: z.string().optional(),
  tags: z.array(z.string()).optional(),
  properties: z.array(PropertyFilterSchema).optional()
})

export const AdvancedSearchSchema = z.object({
  text: z.string().max(500).default(''),
  operators: SearchOperatorsSchema.optional(),
  titleOnly: z.boolean().default(false),
  sortBy: z.enum(['relevance', 'modified', 'created', 'title']).default('modified'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  folder: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0)
})

export type AdvancedSearchInput = z.infer<typeof AdvancedSearchSchema>
export type SearchOperatorsType = z.infer<typeof SearchOperatorsSchema>
export type PropertyFilterType = z.infer<typeof PropertyFilterSchema>

// ============================================================================
// Response Types
// ============================================================================

export interface SearchResponse {
  results: SearchResult[]
  total: number
  hasMore: boolean
  queryTime: number // milliseconds
  suggestions?: string[] // Alternative search suggestions
}

export interface QuickSearchResponse {
  notes: SearchResultNote[]
  tasks: SearchResultTask[]
}

export interface SuggestionsResponse {
  suggestions: SearchSuggestion[]
}

// ============================================================================
// IPC Channel Definitions
// ============================================================================

export const SearchChannels = {
  invoke: {
    /** Full search with all options */
    SEARCH: 'search:query',

    /** Quick search for command palette / omnibar */
    QUICK_SEARCH: 'search:quick',

    /** Get search suggestions as user types */
    SUGGESTIONS: 'search:suggestions',

    /** Get recent searches */
    GET_RECENT: 'search:get-recent',

    /** Clear recent searches */
    CLEAR_RECENT: 'search:clear-recent',

    /** Add to recent searches */
    ADD_RECENT: 'search:add-recent',

    /** Get search index stats */
    GET_STATS: 'search:get-stats',

    /** Force rebuild search index */
    REBUILD_INDEX: 'search:rebuild-index',

    /** Search notes only (optimized) */
    SEARCH_NOTES: 'search:notes',

    /** Search tasks only (optimized) */
    SEARCH_TASKS: 'search:tasks',

    /** Find notes by tag */
    FIND_BY_TAG: 'search:find-by-tag',

    /** Find notes by backlink */
    FIND_BACKLINKS: 'search:find-backlinks',

    /** Advanced search with operators */
    ADVANCED_SEARCH: 'search:advanced'
  },

  events: {
    /** Index rebuild started */
    INDEX_REBUILD_STARTED: 'search:index-rebuild-started',

    /** Index rebuild progress */
    INDEX_REBUILD_PROGRESS: 'search:index-rebuild-progress',

    /** Index rebuild completed */
    INDEX_REBUILD_COMPLETED: 'search:index-rebuild-completed',

    /** Index corrupted, needs rebuild */
    INDEX_CORRUPT: 'search:index-corrupt'
  }
} as const

// ============================================================================
// Handler Signatures
// ============================================================================

export interface SearchHandlers {
  [SearchChannels.invoke.SEARCH]: (
    input: z.infer<typeof SearchQuerySchema>
  ) => Promise<SearchResponse>

  [SearchChannels.invoke.QUICK_SEARCH]: (
    input: z.infer<typeof QuickSearchSchema>
  ) => Promise<QuickSearchResponse>

  [SearchChannels.invoke.SUGGESTIONS]: (
    input: z.infer<typeof SuggestionsSchema>
  ) => Promise<SuggestionsResponse>

  [SearchChannels.invoke.GET_RECENT]: () => Promise<string[]>

  [SearchChannels.invoke.CLEAR_RECENT]: () => Promise<void>

  [SearchChannels.invoke.ADD_RECENT]: (query: string) => Promise<void>

  [SearchChannels.invoke.GET_STATS]: () => Promise<SearchStats>

  [SearchChannels.invoke.REBUILD_INDEX]: () => Promise<void>

  [SearchChannels.invoke.SEARCH_NOTES]: (
    query: string,
    options?: { tags?: string[]; limit?: number }
  ) => Promise<SearchResultNote[]>

  [SearchChannels.invoke.SEARCH_TASKS]: (
    query: string,
    options?: { projectId?: string; limit?: number }
  ) => Promise<SearchResultTask[]>

  [SearchChannels.invoke.FIND_BY_TAG]: (tag: string) => Promise<SearchResultNote[]>

  [SearchChannels.invoke.FIND_BACKLINKS]: (noteId: string) => Promise<SearchResultNote[]>

  [SearchChannels.invoke.ADVANCED_SEARCH]: (
    input: z.infer<typeof AdvancedSearchSchema>
  ) => Promise<SearchResultNote[]>
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface IndexRebuildProgressEvent {
  phase: 'scanning' | 'indexing' | 'optimizing'
  current: number
  total: number
  percentage: number
}

export interface IndexRebuildCompletedEvent {
  duration: number
  notesIndexed: number
  tasksIndexed: number
}

// ============================================================================
// Client API
// ============================================================================

/**
 * Search service client interface for renderer process
 *
 * @example
 * ```typescript
 * const search = window.api.search;
 *
 * // Full search
 * const results = await search.query({
 *   query: 'project meeting notes',
 *   types: ['note', 'task'],
 *   limit: 20
 * });
 *
 * // Quick search for omnibar
 * const { notes, tasks } = await search.quick({
 *   query: 'meeting',
 *   limit: 5
 * });
 *
 * // Get suggestions while typing
 * const { suggestions } = await search.suggestions({
 *   prefix: 'meet',
 *   limit: 5
 * });
 *
 * // Listen for index rebuild progress
 * window.api.on('search:index-rebuild-progress', ({ percentage }) => {
 *   setRebuildProgress(percentage);
 * });
 * ```
 */
export interface SearchClientAPI {
  // Main search
  query(input: z.infer<typeof SearchQuerySchema>): Promise<SearchResponse>
  quick(input: z.infer<typeof QuickSearchSchema>): Promise<QuickSearchResponse>
  suggestions(input: z.infer<typeof SuggestionsSchema>): Promise<SuggestionsResponse>

  // Specialized searches
  searchNotes(
    query: string,
    options?: { tags?: string[]; limit?: number }
  ): Promise<SearchResultNote[]>
  searchTasks(
    query: string,
    options?: { projectId?: string; limit?: number }
  ): Promise<SearchResultTask[]>
  findByTag(tag: string): Promise<SearchResultNote[]>
  findBacklinks(noteId: string): Promise<SearchResultNote[]>
  advancedSearch(input: AdvancedSearchInput): Promise<SearchResultNote[]>

  // Recent searches
  getRecent(): Promise<string[]>
  clearRecent(): Promise<void>
  addRecent(query: string): Promise<void>

  // Index management
  getStats(): Promise<SearchStats>
  rebuildIndex(): Promise<void>
}

// ============================================================================
// Search Query Syntax Reference
// ============================================================================

/**
 * FTS5 Query Syntax (for documentation)
 *
 * Basic:
 *   "meeting notes"    - Exact phrase match
 *   meeting notes      - Both terms must appear (AND)
 *   meeting OR notes   - Either term (OR)
 *   meeting -private   - meeting but not private (NOT)
 *
 * Prefix:
 *   meet*              - Prefix match (meeting, meetings, meet)
 *
 * Field-specific:
 *   title:meeting      - Search only in title
 *   tags:work          - Search only in tags
 *
 * Proximity:
 *   NEAR(meeting notes, 5)  - Terms within 5 words of each other
 *
 * Note: Special characters (* " -) are escaped by the search handler
 * unless explicitly enabled via advanced search mode.
 */
