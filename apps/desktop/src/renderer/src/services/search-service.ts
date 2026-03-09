import type {
  SearchQueryInput,
  SearchResponse,
  QuickSearchResponse,
  SearchStats,
  RecentSearch,
  IndexRebuildProgress
} from '@memry/contracts/search-api'

export const searchService = {
  query(params: SearchQueryInput): Promise<SearchResponse> {
    return window.api.search.query(params)
  },

  quick(text: string): Promise<QuickSearchResponse> {
    return window.api.search.quick(text)
  },

  getStats(): Promise<SearchStats> {
    return window.api.search.getStats()
  },

  rebuildIndex(): Promise<{ started: true }> {
    return window.api.search.rebuildIndex()
  },

  getRecent(): Promise<RecentSearch[]> {
    return window.api.search.getRecent()
  },

  addRecent(params: { query: string; resultCount: number }): Promise<RecentSearch> {
    return window.api.search.addRecent(params)
  },

  clearRecent(): Promise<{ cleared: true }> {
    return window.api.search.clearRecent()
  },

  getAllTags(): Promise<string[]> {
    return window.api.search.getAllTags()
  },

  onIndexRebuildStarted(cb: () => void): () => void {
    return window.api.onSearchIndexRebuildStarted(cb)
  },

  onIndexRebuildProgress(cb: (progress: IndexRebuildProgress) => void): () => void {
    return window.api.onSearchIndexRebuildProgress(cb)
  },

  onIndexRebuildCompleted(cb: () => void): () => void {
    return window.api.onSearchIndexRebuildCompleted(cb)
  },

  onIndexCorrupt(cb: () => void): () => void {
    return window.api.onSearchIndexCorrupt(cb)
  }
}

export function stripMarkTags(text: string): string {
  return text.replace(/<\/?mark>/gi, '')
}

export function highlightTerms(
  text: string,
  query: string
): Array<{ text: string; highlight: boolean }> {
  if (!query.trim()) return [{ text, highlight: false }]

  const terms = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  if (terms.length === 0) return [{ text, highlight: false }]

  const pattern = new RegExp(`(${terms.join('|')})`, 'gi')
  const parts = text.split(pattern)

  return parts
    .filter(Boolean)
    .map((part) => ({
      text: part,
      highlight: pattern.test(part)
    }))
    .map((segment) => {
      pattern.lastIndex = 0
      return { ...segment, highlight: terms.some((t) => new RegExp(t, 'i').test(segment.text)) }
    })
}
