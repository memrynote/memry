/**
 * Pure logic for the inline `@`-date ghost-text autocomplete, kept free of any
 * ProseMirror/DOM dependency so it can be unit-tested directly. The plugin in
 * `date-mention-ghost-plugin.ts` wires these into editor decorations + keymap.
 */

import { predictDateCompletion, buildDateSuggestions, isTimeInProgress } from './date-suggestions'
import type { DateMentionValue } from './date-mention-popover'

// BlockNote serializes inline atoms (existing pills) to the object-replacement
// character in `textBetween`; we treat it as a hard boundary.
const ATOM = '￼'

export interface ActiveDateQuery {
  /** Index of the `@` within the scanned text. */
  atIndex: number
  /** Raw text typed after the `@`, up to the cursor. */
  query: string
  /**
   * Canonical full completion (a case-insensitive superstring of `query`), or
   * null when the query already parses as a date with nothing left to complete
   * (e.g. "today 12:00") — the highlight stays, but there is no ghost remainder.
   */
  prediction: string | null
}

/**
 * Find the date mention currently being typed at the cursor. Scans the text from
 * the block start up to the cursor and returns the rightmost `@`-token that (a)
 * starts a mention (preceded by start-of-block, whitespace, or an inline atom)
 * and (b) reads as a date. Returns null otherwise — including when the rightmost
 * mention is a non-date query like `@meeting`, so note mentions stay untouched.
 */
export function findActiveDateQuery(
  textBeforeCursor: string,
  now: Date = new Date()
): ActiveDateQuery | null {
  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    if (textBeforeCursor[i] !== '@') continue
    const prev = i === 0 ? '' : textBeforeCursor[i - 1]
    const validStart = i === 0 || /\s/.test(prev) || prev === ATOM
    if (!validStart) continue
    const query = textBeforeCursor.slice(i + 1)
    if (query.includes(ATOM) || query.includes('\n')) return null
    const prediction = predictDateCompletion(query, now)
    // Active when there is a completion to preview, the query already parses as a
    // date (a complete "today 12:00" keeps the highlight, sans ghost), or a time
    // is mid-entry ("today at", "today 23:3") with nothing confident to ghost.
    if (
      prediction === null &&
      buildDateSuggestions(query, now) === null &&
      !isTimeInProgress(query)
    )
      return null
    return { atIndex: i, query, prediction }
  }
  return null
}

export type TabAction = { kind: 'fill'; text: string } | { kind: 'pill'; value: DateMentionValue }

/**
 * What Tab should do for the given query: fill the remaining ghost text when the
 * prediction extends what's typed, otherwise commit a date pill once the phrase
 * is complete. Null when there is neither a completion nor a parseable date.
 */
export function resolveTabAction(query: string, now: Date = new Date()): TabAction | null {
  const prediction = predictDateCompletion(query, now)
  if (prediction !== null && prediction.slice(query.length).length > 0) {
    return { kind: 'fill', text: prediction }
  }
  const suggestion = buildDateSuggestions(query, now)
  return suggestion ? { kind: 'pill', value: suggestion.dateValue } : null
}
