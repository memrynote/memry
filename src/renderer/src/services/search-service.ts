import type {
  SearchClientAPI,
  SearchQueryInput,
  SearchResponse,
  QuickSearchResponse,
  SuggestionsResponse,
  SearchResultNote,
  SearchStats,
  IndexRebuildProgressEvent,
  IndexRebuildCompletedEvent
} from '../../../preload/index.d'

/**
 * Search service - thin wrapper around window.api.search
 * Provides a typed interface for search operations in the renderer process.
 */
export const searchService: SearchClientAPI = {
  /**
   * Full search with all options.
   * Returns results sorted by relevance with snippets and timing.
   */
  query: (input: SearchQueryInput): Promise<SearchResponse> => {
    return window.api.search.query(input)
  },

  /**
   * Quick search for command palette / omnibar.
   * Faster search with fewer results.
   */
  quick: (input: { query: string; limit?: number }): Promise<QuickSearchResponse> => {
    return window.api.search.quick(input)
  },

  /**
   * Get search suggestions as user types.
   * Returns tags, titles, and completions.
   */
  suggestions: (input: { prefix: string; limit?: number }): Promise<SuggestionsResponse> => {
    return window.api.search.suggestions(input)
  },

  /**
   * Get recent searches.
   */
  getRecent: (): Promise<string[]> => {
    return window.api.search.getRecent()
  },

  /**
   * Clear recent searches.
   */
  clearRecent: (): Promise<void> => {
    return window.api.search.clearRecent()
  },

  /**
   * Add to recent searches.
   */
  addRecent: (query: string): Promise<void> => {
    return window.api.search.addRecent(query)
  },

  /**
   * Get search index stats.
   */
  getStats: (): Promise<SearchStats> => {
    return window.api.search.getStats()
  },

  /**
   * Force rebuild search index.
   */
  rebuildIndex: (): Promise<void> => {
    return window.api.search.rebuildIndex()
  },

  /**
   * Search notes only (optimized).
   */
  searchNotes: (
    query: string,
    options?: { tags?: string[]; limit?: number }
  ): Promise<SearchResultNote[]> => {
    return window.api.search.searchNotes(query, options)
  },

  /**
   * Find notes by tag.
   */
  findByTag: (tag: string): Promise<SearchResultNote[]> => {
    return window.api.search.findByTag(tag)
  },

  /**
   * Find notes linking to a note (backlinks).
   */
  findBacklinks: (noteId: string): Promise<SearchResultNote[]> => {
    return window.api.search.findBacklinks(noteId)
  }
}

// ============================================================================
// Event Subscription Helpers
// ============================================================================

/**
 * Subscribe to index rebuild started events.
 * @returns Unsubscribe function
 */
export function onSearchIndexRebuildStarted(callback: () => void): () => void {
  return window.api.onSearchIndexRebuildStarted(callback)
}

/**
 * Subscribe to index rebuild progress events.
 * @returns Unsubscribe function
 */
export function onSearchIndexRebuildProgress(
  callback: (progress: IndexRebuildProgressEvent) => void
): () => void {
  return window.api.onSearchIndexRebuildProgress(callback)
}

/**
 * Subscribe to index rebuild completed events.
 * @returns Unsubscribe function
 */
export function onSearchIndexRebuildCompleted(
  callback: (result: IndexRebuildCompletedEvent) => void
): () => void {
  return window.api.onSearchIndexRebuildCompleted(callback)
}

/**
 * Subscribe to index corrupt events.
 * @returns Unsubscribe function
 */
export function onSearchIndexCorrupt(callback: () => void): () => void {
  return window.api.onSearchIndexCorrupt(callback)
}

// ============================================================================
// Highlighting Utilities (Client-side)
// ============================================================================

/**
 * Highlights search terms in text using <mark> tags.
 * Useful for highlighting matches in titles, tags, etc.
 *
 * @param text - Text to highlight
 * @param query - Search query (will be split into terms)
 * @param tag - HTML tag to use (default: 'mark')
 * @returns Text with highlighted matches
 *
 * @example
 * ```tsx
 * <span dangerouslySetInnerHTML={{
 *   __html: highlightTerms(note.title, searchQuery)
 * }} />
 * ```
 */
export function highlightTerms(text: string, query: string, tag: string = 'mark'): string {
  if (!text || !query) return text

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  if (terms.length === 0) return text

  const pattern = new RegExp(`(${terms.join('|')})`, 'gi')
  return text.replace(pattern, `<${tag}>$1</${tag}>`)
}

/**
 * Escapes HTML special characters to prevent XSS.
 * Use before highlightTerms when displaying user content.
 *
 * @param text - Text to escape
 * @returns HTML-safe text
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

/**
 * Safely highlights text by escaping HTML first.
 * Prevents XSS while allowing highlight tags.
 *
 * @param text - Text to highlight (will be HTML escaped)
 * @param query - Search query
 * @returns Safe HTML with highlighted terms
 */
export function safeHighlight(text: string, query: string): string {
  return highlightTerms(escapeHtml(text), query)
}

// ============================================================================
// Type Re-exports
// ============================================================================

export type {
  SearchQueryInput,
  SearchResponse,
  QuickSearchResponse,
  SuggestionsResponse,
  SearchResultNote,
  SearchResultTask,
  SearchResult,
  SearchSuggestion,
  SearchStats,
  IndexRebuildProgressEvent,
  IndexRebuildCompletedEvent
} from '../../../preload/index.d'
