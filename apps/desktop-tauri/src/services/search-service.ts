import type {
  SearchQueryInput,
  SearchResponse,
  QuickSearchResponse,
  SearchStats,
  SearchReason,
  AddReasonInput,
  IndexRebuildProgress
} from '@memry/contracts/search-api'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'

export const searchService = {
  query(params: SearchQueryInput): Promise<SearchResponse> {
    return invoke<SearchResponse>('search_query', params)
  },

  quick(text: string): Promise<QuickSearchResponse> {
    return invoke<QuickSearchResponse>('search_quick', { args: [text] })
  },

  getStats(): Promise<SearchStats> {
    return invoke<SearchStats>('search_get_stats')
  },

  rebuildIndex(): Promise<{ started: true }> {
    return invoke<{ started: true }>('search_rebuild_index')
  },

  getReasons(): Promise<SearchReason[]> {
    return invoke<SearchReason[]>('search_get_reasons')
  },

  addReason(params: AddReasonInput): Promise<SearchReason> {
    return invoke<SearchReason>('search_add_reason', params)
  },

  clearReasons(): Promise<{ cleared: true }> {
    return invoke<{ cleared: true }>('search_clear_reasons')
  },

  getAllTags(): Promise<string[]> {
    return invoke<string[]>('search_get_all_tags')
  },

  onIndexRebuildStarted(cb: () => void): () => void {
    return subscribeEvent<void>('search-index-rebuild-started', cb)
  },

  onIndexRebuildProgress(cb: (progress: IndexRebuildProgress) => void): () => void {
    return subscribeEvent<IndexRebuildProgress>('search-index-rebuild-progress', cb)
  },

  onIndexRebuildCompleted(cb: () => void): () => void {
    return subscribeEvent<void>('search-index-rebuild-completed', cb)
  },

  onIndexCorrupt(cb: () => void): () => void {
    return subscribeEvent<void>('search-index-corrupt', cb)
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
