import type { SearchResultItem } from '@memry/contracts/search-api'

/**
 * Search Utilities
 *
 * Score normalization for cross-type ranking,
 * FTS5 query escaping, and prefix query building.
 *
 * @module lib/search-utils
 */

const FTS5_SPECIAL_CHARS = /[*"(){}[\]:^~\\]/g

export function escapeSearchQuery(query: string): string {
  return query.replace(FTS5_SPECIAL_CHARS, ' ').trim()
}

export function buildPrefixQuery(query: string): string {
  const escaped = escapeSearchQuery(query)
  if (!escaped) return ''

  const terms = escaped.split(/\s+/).filter(Boolean)
  return terms.map((term) => `"${term}"*`).join(' ')
}

export function normalizeScores(results: SearchResultItem[]): SearchResultItem[] {
  if (results.length === 0) return results

  const scores = results.map((r) => r.score)
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min

  if (range === 0) {
    return results.map((r) => ({ ...r, normalizedScore: 1 }))
  }

  return results.map((r) => ({
    ...r,
    normalizedScore: (r.score - min) / range
  }))
}

export function truncateQuery(query: string, maxLength = 500): string {
  return query.length > maxLength ? query.slice(0, maxLength) : query
}

export function parseSearchQuery(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''

  const tokens: string[] = []
  let remaining = trimmed

  const phrasePattern = /"([^"]+)"/g
  let match: RegExpExecArray | null

  const phrases: string[] = []
  while ((match = phrasePattern.exec(remaining)) !== null) {
    phrases.push(match[1])
  }
  remaining = remaining.replace(/"[^"]*"/g, ' ')

  for (const phrase of phrases) {
    const escaped = escapeSearchQuery(phrase)
    if (escaped) tokens.push(`"${escaped}"`)
  }

  const words = remaining.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length) {
    const word = words[i].toUpperCase()

    if (word === 'NOT' && i + 1 < words.length) {
      const next = escapeSearchQuery(words[i + 1])
      if (next) tokens.push(`NOT "${next}"*`)
      i += 2
      continue
    }

    if (word === 'AND' || word === 'OR') {
      if (tokens.length > 0 && i + 1 < words.length) {
        const next = escapeSearchQuery(words[i + 1])
        if (next) {
          tokens.push(word)
          tokens.push(`"${next}"*`)
          i += 2
          continue
        }
      }
      i++
      continue
    }

    const escaped = escapeSearchQuery(words[i])
    if (escaped) tokens.push(`"${escaped}"*`)
    i++
  }

  return tokens.join(' ')
}
