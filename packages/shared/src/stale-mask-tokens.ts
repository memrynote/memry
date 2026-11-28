/**
 * The mask tokens an older build left in a stored document, dropped on write.
 *
 * The read path hides a construct behind a placeholder that carries a word
 * drawn once per process (`mask-word.ts`) and swaps it back in every string a
 * block holds. A build that missed a string (a link's address, a prop, the text
 * of a tag-soup note) stored the placeholder in the document, and no later
 * process can decode it: its word is gone with the process that drew it. A
 * note that falls back to house style writes it into the vault on the next
 * edit, so write-back drops every placeholder of a shape a build could have
 * left. The seed never reads a token back out of text, so a note that spells
 * one is still seeded as text; only the writer drops them.
 *
 * A token is `MEMRY`, a kind, a word of twelve capitals, an optional payload
 * and an end mark, in the forms of `STALE_MASKS`. Text that spells the kind
 * without a word, as `MEMRYHBK0;` does, is the author's and stays. A
 * `<details>` tag hidden behind a token is the one whose bytes are known, so it
 * comes back as the `<` it stood for; every other token is dropped.
 *
 * Linear: each `MEMRY` is tried once, and a try reads at most the token.
 */

const PREFIX = 'MEMRY'
const KIND_LENGTH = 3
const WORD_LENGTH = 12

type Payload = 'digits' | 'hex' | 'blank' | 'none'

interface StaleMask {
  kind: string
  /** What follows the word: digits, lowercase hex (digits or letters, maybe none), one `S` or `T`, or nothing. */
  payload: Payload
  /** The characters that close the token. */
  end: string
  /** The token's own first character, in front of `MEMRY`. */
  lead?: string
  /** What the token stood for, where the bytes are known; dropped otherwise. */
  becomes?: string
}

/**
 * Every mask a build before this one could have left a token of in a string
 * the read path misses (or in a file, which a seed reads as text), by the
 * producer's own form: `shared/hard-breaks.ts`, `shared/html-comments.ts`,
 * `shared/inline-colors.ts`, `editor-schema/src/blocks/markdown.ts`,
 * `empty-blocks.ts`, `inline/emphasis-runs.ts`, `inline/link-destinations.ts`,
 * `inline/token-masking.ts` and `inline/cell-code-spans.ts`, and the core's
 * `markdown_seed` (`SX` and `TX`, and a mention's bytes in hex). The table
 * probe's markers (`MEMRYTBL`) and the link card's (`MEMRYLINKCARD`) are put
 * back by the call that made them and never leave it.
 */
const STALE_MASKS: readonly StaleMask[] = [
  { kind: 'HBK', payload: 'digits', end: ';' },
  { kind: 'DLT', payload: 'none', end: ';', becomes: '<' },
  { kind: 'CSP', payload: 'digits', end: 'X' },
  { kind: 'CSP', payload: 'blank', end: 'X' },
  { kind: 'TKN', payload: 'hex', end: 'X' },
  { kind: 'ICO', payload: 'digits', end: ':' },
  { kind: 'ICC', payload: 'none', end: ';', lead: ':' },
  { kind: 'EMO', payload: 'digits', end: ';' },
  { kind: 'EMC', payload: 'digits', end: ';' },
  { kind: 'EMK', payload: 'digits', end: ';' },
  { kind: 'EMU', payload: 'digits', end: ';' },
  { kind: 'LNK', payload: 'digits', end: 'X' },
  { kind: 'CMT', payload: 'hex', end: 'X' },
  { kind: 'EMB', payload: 'none', end: '' }
]

const BY_KIND: ReadonlyMap<string, StaleMask[]> = STALE_MASKS.reduce((kinds, mask) => {
  kinds.set(mask.kind, [...(kinds.get(mask.kind) ?? []), mask])
  return kinds
}, new Map<string, StaleMask[]>())

const isCapital = (code: number): boolean => code >= 65 && code <= 90
const isDigit = (code: number): boolean => code >= 48 && code <= 57
const isHex = (code: number): boolean => isDigit(code) || (code >= 97 && code <= 102)

/** Where the payload that starts at `at` ends, or -1 when the payload is not of this form. */
function payloadEnd(text: string, at: number, payload: Payload): number {
  if (payload === 'none') return at
  if (payload === 'blank') return text[at] === 'S' || text[at] === 'T' ? at + 1 : -1
  const isMember = payload === 'digits' ? isDigit : isHex
  let end = at
  while (isMember(text.charCodeAt(end))) end++
  return end > at || payload === 'hex' ? end : -1
}

/** The token that starts at the `MEMRY` at `at`: where it ends and what it stood for, or null. */
function readToken(text: string, at: number): { end: number; mask: StaleMask } | null {
  const kindStart = at + PREFIX.length
  const masks = BY_KIND.get(text.slice(kindStart, kindStart + KIND_LENGTH))
  if (!masks) return null
  const wordStart = kindStart + KIND_LENGTH
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (!isCapital(text.charCodeAt(wordStart + i))) return null
  }
  const afterWord = wordStart + WORD_LENGTH
  for (const mask of masks) {
    const end = payloadEnd(text, afterWord, mask.payload)
    if (end >= 0 && text.startsWith(mask.end, end)) return { end: end + mask.end.length, mask }
  }
  return null
}

/** `text` without the stale mask tokens it holds. */
export function dropStaleMaskTokens(text: string): string {
  let at = text.indexOf(PREFIX)
  if (at === -1) return text
  let out = ''
  let copied = 0
  while (at !== -1) {
    const token = readToken(text, at)
    if (token === null) {
      at = text.indexOf(PREFIX, at + PREFIX.length)
      continue
    }
    const { end, mask } = token
    const lead = mask.lead !== undefined && at > copied && text.startsWith(mask.lead, at - 1)
    out += text.slice(copied, lead ? at - 1 : at) + (mask.becomes ?? '')
    copied = end
    at = text.indexOf(PREFIX, end)
  }
  return out + text.slice(copied)
}

/**
 * `value` with the stale mask tokens dropped from every string in it, keys
 * aside: a run's text, a link's address, a prop. A value that holds none is
 * returned as it is, and so is each part of one that holds none.
 */
export function withoutStaleMaskTokens<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the walk returns the same shape it was given, with strings replaced by strings
  return withoutTokens(value) as T
}

function withoutTokens(value: unknown): unknown {
  if (typeof value === 'string') return dropStaleMaskTokens(value)
  if (Array.isArray(value)) {
    let out: unknown[] | null = null
    for (const [index, item] of value.entries()) {
      const next = withoutTokens(item)
      if (next === item) continue
      out ??= value.slice()
      out[index] = next
    }
    return out ?? value
  }
  if (typeof value !== 'object' || value === null) return value
  let out: Record<string, unknown> | null = null
  for (const [key, item] of Object.entries(value)) {
    const next = withoutTokens(item)
    if (next === item) continue
    out ??= { ...value }
    out[key] = next
  }
  return out ?? value
}
