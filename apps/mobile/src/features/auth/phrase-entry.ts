export const PHRASE_LENGTH = 24
const MAX_SUGGESTIONS = 3
const MIN_PREFIX = 2

export const emptyPhrase = (): string[] => Array.from({ length: PHRASE_LENGTH }, () => '')

export interface SpillResult {
  words: string[]
  /** Where the caret belongs afterwards. */
  landing: number
}

/**
 * Apply typed or pasted text to one slot.
 *
 * A single token replaces the slot. Anything with whitespace in it is a pasted
 * phrase, and spills forward from the edited slot rather than cramming into
 * it, which is what lets a whole phrase land from one paste anywhere in the
 * grid. Extra words past the end are dropped instead of wrapping around.
 */
export function spill(words: string[], index: number, text: string): SpillResult {
  const parts = text.toLowerCase().split(/\s+/).filter(Boolean)
  const next = [...words]
  if (parts.length <= 1) {
    next[index] = parts[0] ?? ''
    return { words: next, landing: index }
  }
  for (let offset = 0; offset < parts.length && index + offset < next.length; offset += 1) {
    next[index + offset] = parts[offset]
  }
  return { words: next, landing: Math.min(index + parts.length, next.length - 1) }
}

/**
 * Word-list completions for a prefix. Nothing is offered under two characters
 * (the list would be a wall), and an exact sole match is suppressed because
 * the word is already typed.
 */
export function suggest(prefix: string, words: readonly string[]): string[] {
  if (prefix.length < MIN_PREFIX) return []
  const matches: string[] = []
  for (const candidate of words) {
    if (!candidate.startsWith(prefix)) continue
    matches.push(candidate)
    if (matches.length > MAX_SUGGESTIONS) break
  }
  if (matches.length === 1 && matches[0] === prefix) return []
  return matches.slice(0, MAX_SUGGESTIONS)
}
