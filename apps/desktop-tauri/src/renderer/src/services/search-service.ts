import type {
  NoteFileType,
  SearchResponse,
  QuickSearchResponse,
  SearchStats,
  SearchReason,
  AddReasonInput
} from '@memry/contracts/search-api'
import { commands, type SearchQueryInput } from '../../../generated/bindings'

/**
 * The palette's search over the `search_*` commands (#3540). The commands answer the contract
 * shapes; the bindings type `fileType` and `itemType` as strings and the scores as nullable, so
 * each answer is narrowed to its contract type here.
 */
export const searchService = {
  async query(params: SearchQueryInput): Promise<SearchResponse> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the command answers the contract's SearchResponse
    return (await commands.searchQuery(params)) as SearchResponse
  },

  async quick(text: string, noteFileTypes?: NoteFileType[]): Promise<QuickSearchResponse> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the command answers the contract's QuickSearchResponse
    return (await commands.searchQuick(text, noteFileTypes ?? null)) as QuickSearchResponse
  },

  getStats(): Promise<SearchStats> {
    return commands.searchGetStats()
  },

  getReasons(): Promise<SearchReason[]> {
    return commands.searchGetReasons()
  },

  addReason(params: AddReasonInput): Promise<SearchReason> {
    return commands.searchAddReason(params)
  },

  async clearReasons(): Promise<{ cleared: true }> {
    await commands.searchClearReasons()
    return { cleared: true }
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
