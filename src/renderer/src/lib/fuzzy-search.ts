/**
 * Fuzzy Search Utility
 * Provides fuzzy matching for wiki-link and tag autocomplete
 */

export interface FuzzyMatch<T> {
  item: T
  score: number
  matches: number[] // indices of matched characters
}

/**
 * Fuzzy search through items matching non-consecutive characters
 * @param items - Array of items to search
 * @param query - Search query string
 * @param keys - Object keys to search within
 * @returns Filtered and sorted array of items
 */
export function fuzzySearch<T>(items: T[], query: string, keys: (keyof T)[]): T[] {
  if (!query || query.trim() === '') {
    return items
  }

  const matches: FuzzyMatch<T>[] = []

  for (const item of items) {
    let bestScore = 0
    let bestMatches: number[] = []

    // Try matching against each key
    for (const key of keys) {
      const value = String(item[key] ?? '').toLowerCase()
      const searchQuery = query.toLowerCase()

      const result = fuzzyMatch(value, searchQuery)
      if (result.score > bestScore) {
        bestScore = result.score
        bestMatches = result.matches
      }
    }

    if (bestScore > 0) {
      matches.push({
        item,
        score: bestScore,
        matches: bestMatches
      })
    }
  }

  // Sort by score (higher is better)
  return matches.sort((a, b) => b.score - a.score).map((m) => m.item)
}

/**
 * Match a query string against text using fuzzy matching
 * @param text - Text to search in
 * @param query - Query to search for
 * @returns Match score and character indices
 */
function fuzzyMatch(text: string, query: string): { score: number; matches: number[] } {
  let score = 0
  const matches: number[] = []
  let queryIndex = 0
  let consecutiveMatches = 0

  for (let i = 0; i < text.length && queryIndex < query.length; i++) {
    if (text[i] === query[queryIndex]) {
      matches.push(i)

      // Scoring system:
      // - Earlier matches score higher (100 - position)
      // - Consecutive matches get bonus
      // - Start-of-word matches get bonus

      const positionScore = 100 - i
      const consecutiveBonus = consecutiveMatches * 10
      const startOfWordBonus = isStartOfWord(text, i) ? 20 : 0

      score += positionScore + consecutiveBonus + startOfWordBonus
      consecutiveMatches++
      queryIndex++
    } else {
      consecutiveMatches = 0
    }
  }

  // If not all characters matched, return 0 score
  if (queryIndex !== query.length) {
    return { score: 0, matches: [] }
  }

  return { score, matches }
}

/**
 * Check if character at index is start of a word
 * @param text - Text string
 * @param index - Character index
 * @returns true if start of word
 */
function isStartOfWord(text: string, index: number): boolean {
  if (index === 0) return true

  const prevChar = text[index - 1]
  const isAfterSpace = prevChar === ' '
  const isAfterHyphen = prevChar === '-'
  const isAfterUnderscore = prevChar === '_'
  const isAfterCapital = /[A-Z]/.test(text[index]) && /[a-z]/.test(prevChar)

  return isAfterSpace || isAfterHyphen || isAfterUnderscore || isAfterCapital
}

/**
 * Get highlighted version of text with matched characters
 * Useful for rendering search results
 * @param text - Original text
 * @param matches - Array of matched character indices
 * @returns Text with match markers
 */
export function highlightMatches(text: string, matches: number[]): string {
  if (!matches || matches.length === 0) return text

  let result = ''
  let lastIndex = 0

  for (const matchIndex of matches) {
    result += text.slice(lastIndex, matchIndex)
    result += `<mark>${text[matchIndex]}</mark>`
    lastIndex = matchIndex + 1
  }

  result += text.slice(lastIndex)
  return result
}
