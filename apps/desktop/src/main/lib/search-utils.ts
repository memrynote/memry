import type { SearchResultItem } from '@memry/contracts/search-api'

/**
 * Search Utilities
 *
 * Score normalization for cross-type ranking and the search query parser.
 *
 * @module lib/search-utils
 */

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

/** The `MATCH` expressions for one query. */
export interface FtsQuery {
  /** Which rows match; empty when the query has no searchable term. */
  match: string
  /**
   * The words of a plain multi-word query as one prefixed phrase
   * (`"this is rough"*`). Rows matching it sort first. Empty for a single word
   * or a query with operators or quotes, which keep plain bm25 order.
   */
  phrase: string
}

type Operator = 'AND' | 'OR' | 'NOT'
type Token =
  | { kind: 'term'; runs: string[] }
  | { kind: 'phrase'; runs: string[] }
  | { kind: 'operator'; operator: Operator }

const OPERATORS: readonly Operator[] = ['AND', 'OR', 'NOT']
// What Rust's `char::is_alphanumeric` keeps, so this and the core's
// `domain/search/query.rs` split a word the same way.
const NON_ALPHANUMERIC = /[^\p{Alphabetic}\p{N}]+/u

function runs(text: string): string[] {
  return text.split(NON_ALPHANUMERIC).filter(Boolean)
}

function pushWords(text: string, tokens: Token[]): void {
  for (const word of text.split(/[\s"]+/u)) {
    const operator = OPERATORS.find((candidate) => candidate === word)
    if (operator) {
      tokens.push({ kind: 'operator', operator })
      continue
    }
    const wordRuns = runs(word)
    if (wordRuns.length > 0) tokens.push({ kind: 'term', runs: wordRuns })
  }
}

/** Splits on `"` pairs first, then on whitespace. A `"` with no partner is a separator. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let rest = input
  for (;;) {
    const open = rest.indexOf('"')
    const close = open === -1 ? -1 : rest.indexOf('"', open + 1)
    if (close === -1) break
    pushWords(rest.slice(0, open), tokens)
    const inner = runs(rest.slice(open + 1, close))
    if (inner.length > 0) tokens.push({ kind: 'phrase', runs: inner })
    rest = rest.slice(close + 1)
  }
  pushWords(rest, tokens)
  return tokens
}

/**
 * Turns the search box text into FTS5 `MATCH` expressions. A plain word is a
 * prefix (`pass` finds "password"), words side by side are AND-ed, `"…"` is an
 * exact phrase, and uppercase `AND`, `OR` and `NOT` are operators kept in the
 * order typed. An operator with nothing before or after it is dropped, and of
 * two in a row the second wins: FTS5 raises a syntax error on each of those.
 *
 * The expression is built from parsed tokens, never from user text: every
 * operand is alphanumeric runs inside double quotes, so no input can close a
 * quote or add syntax. `crates/memry-core/src/domain/search/query.rs` is the
 * same parser, and the two test tables hold the same cases.
 */
export function parseSearchQuery(input: string): FtsQuery {
  const tokens = tokenize(input)

  let match = ''
  let pending: Operator | null = null
  for (const token of tokens) {
    if (token.kind === 'operator') {
      if (match) pending = token.operator
      continue
    }
    const operand =
      token.kind === 'term' ? `"${token.runs.join(' ')}"*` : `"${token.runs.join(' ')}"`
    if (match) {
      match += pending ? ` ${pending} ` : ' '
      pending = null
    }
    match += operand
  }
  if (!match) return { match: '', phrase: '' }

  const plain = tokens.every((token) => token.kind === 'term')
  const phrase =
    plain && tokens.length > 1
      ? `"${tokens.flatMap((token) => (token.kind === 'term' ? token.runs : [])).join(' ')}"*`
      : ''
  return { match, phrase }
}
