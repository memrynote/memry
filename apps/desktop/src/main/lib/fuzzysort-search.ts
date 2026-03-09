import fuzzysort from 'fuzzysort'
import type {
  SearchResultItem,
  ContentType,
  SearchResultMetadata
} from '@memry/contracts/search-api'

const FUZZYSORT_THRESHOLD = 0.3

interface FuzzyCandidateItem {
  id: string
  title: string
  type: ContentType
  modifiedAt: string
  metadata: SearchResultMetadata
}

export function fuzzySearchTitles(
  candidates: FuzzyCandidateItem[],
  query: string,
  limit: number
): SearchResultItem[] {
  if (!query.trim() || candidates.length === 0) return []

  const results = fuzzysort.go(query, candidates, {
    key: 'title',
    threshold: FUZZYSORT_THRESHOLD,
    limit
  })

  return results.map((r) => ({
    id: r.obj.id,
    type: r.obj.type,
    title: r.obj.title,
    snippet: r.highlight('<mark>', '</mark>') ?? r.obj.title,
    score: r.score,
    normalizedScore: r.score * 0.8,
    matchType: 'fuzzy' as const,
    modifiedAt: r.obj.modifiedAt,
    metadata: r.obj.metadata
  }))
}
