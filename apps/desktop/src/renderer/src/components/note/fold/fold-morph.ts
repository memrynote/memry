import type { FoldLevel, FoldParagraph, FoldToken } from '@memry/contracts/note-fold'

/**
 * Pure planning for the word-slide between folded levels. A line is a list of
 * tokens; a token that carries a `src` index exists in the paragraph's source
 * text, so a word shared by two levels has the same `src` in both and slides
 * from where it stood to where it lands. The DOM side is `fold-morph.tsx`.
 */

export type MorphToken = FoldToken

/** The slide, matching `--ease-in-out`; WAAPI cannot read the CSS variable. */
export const FOLD_MORPH_MS = 300
export const FOLD_MORPH_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'
/** Outgoing plus incoming tokens above this crossfade instead of sliding. */
export const MORPH_TOKEN_CAP = 600

export type TokenMotion = { kind: 'still' } | { kind: 'in' } | { kind: 'slide'; from: number }
export type OutgoingMotion = 'still' | 'matched' | 'out'

export interface MorphPlan {
  /** `none`: the two lines read the same. `crossfade`: whole lines fade, no per-word motion. */
  mode: 'none' | 'crossfade' | 'morph'
  /** Per incoming token. Empty unless `mode` is `morph`. */
  incoming: readonly TokenMotion[]
  /** Per outgoing token. Empty unless `mode` is `morph`. */
  outgoing: readonly OutgoingMotion[]
}

const CROSSFADE: MorphPlan = { mode: 'crossfade', incoming: [], outgoing: [] }
const NONE: MorphPlan = { mode: 'none', incoming: [], outgoing: [] }

export function isSpace(text: string): boolean {
  return /^\s*$/.test(text)
}

function sameText(a: readonly MorphToken[], b: readonly MorphToken[]): boolean {
  return a.length === b.length && a.every((token, index) => token.text === b[index].text)
}

/**
 * How each token moves from `from` to `to`. A null side has no token data
 * (a line the model has not mapped), and an oversized pair is too much DOM to
 * animate word by word; both crossfade. Whitespace never moves.
 */
export function planMorph(
  from: readonly MorphToken[] | null,
  to: readonly MorphToken[] | null
): MorphPlan {
  if (from === null || to === null) return CROSSFADE
  if (sameText(from, to)) return NONE
  if (from.length + to.length > MORPH_TOKEN_CAP) return CROSSFADE

  const outgoingBySrc = new Map<number, number>()
  from.forEach((token, index) => {
    if (token.src !== null && !isSpace(token.text) && !outgoingBySrc.has(token.src)) {
      outgoingBySrc.set(token.src, index)
    }
  })

  const outgoing: OutgoingMotion[] = from.map((token) => (isSpace(token.text) ? 'still' : 'out'))
  let slides = 0
  const incoming = to.map((token): TokenMotion => {
    if (isSpace(token.text)) return { kind: 'still' }
    const match = token.src === null ? undefined : outgoingBySrc.get(token.src)
    if (match === undefined || outgoing[match] !== 'out') return { kind: 'in' }
    outgoing[match] = 'matched'
    slides += 1
    return { kind: 'slide', from: match }
  })
  // Without a shared word it is a crossfade made of many small ones.
  return slides === 0 ? CROSSFADE : { mode: 'morph', incoming, outgoing }
}

/**
 * Groups of token indices that must stay on one line: a word with the
 * punctuation stuck to it. Whitespace tokens are not in any group. Each token
 * is its own inline-block so it can be transformed, which would otherwise
 * allow a break before a comma.
 */
export function chunkTokens(tokens: readonly MorphToken[]): number[][] {
  const chunks: number[][] = []
  let open: number[] | null = null
  let openIsMarksOnly = false
  tokens.forEach((token, index) => {
    if (isSpace(token.text)) {
      open = null
      return
    }
    const marks = !/[\p{L}\p{N}]/u.test(token.text)
    if (open === null) {
      open = [index]
      openIsMarksOnly = marks
      chunks.push(open)
    } else if (marks || openIsMarksOnly) {
      open.push(index)
      openIsMarksOnly = openIsMarksOnly && marks
    } else {
      // A word right after a word (CJK has no spaces): free to break between.
      open = [index]
      chunks.push(open)
    }
  })
  return chunks
}

function sourceTokens(paragraph: FoldParagraph, start: number, end: number): MorphToken[] {
  const tokens: MorphToken[] = []
  for (let src = start; src < end && src < paragraph.srcTokens.length; src++) {
    tokens.push({ text: paragraph.srcTokens[src], src })
  }
  while (tokens.length > 0 && isSpace(tokens[0].text)) tokens.shift()
  while (tokens.length > 0 && isSpace(tokens[tokens.length - 1].text)) tokens.pop()
  return tokens
}

function joined(parts: readonly (readonly MorphToken[])[], joiner: string): MorphToken[] {
  return parts.flatMap((part, index) =>
    index > 0 && joiner !== '' ? [{ text: joiner, src: null }, ...part] : [...part]
  )
}

/** Brief mirrors `briefLine` in fold-display: the picked source sentences, else the whole paragraph. */
function briefTokens(paragraph: FoldParagraph, joiner: string): MorphToken[] | null {
  const { sentences, srcSentenceStart: starts, srcTokens } = paragraph
  if (srcTokens.length === 0) return null
  const picked = [...new Set(paragraph.briefIdx)]
    .filter((index) => index < sentences.length)
    .sort((a, b) => a - b)
  if (picked.length === 0 || starts.length !== sentences.length) {
    return sourceTokens(paragraph, 0, srcTokens.length)
  }
  return joined(
    picked.map((index) =>
      sourceTokens(paragraph, starts[index], starts[index + 1] ?? srcTokens.length)
    ),
    joiner
  )
}

/**
 * The tokens of the line a paragraph shows at a level, mirroring
 * `paragraphLine`. Null when the model's word map for that line is missing.
 */
export function paragraphTokens(
  paragraph: FoldParagraph,
  level: FoldLevel,
  joiner: string
): MorphToken[] | null {
  if (level === 'key' && paragraph.key) {
    const { takeaway, reason } = paragraph.key
    const parts = [
      ...(takeaway ? [paragraph.morph.keyTakeaway] : []),
      ...(reason ? [paragraph.morph.keyReason] : [])
    ]
    const mapped = parts.flatMap((part) => (part === null ? [] : [part]))
    return parts.length === 0 || mapped.length !== parts.length ? null : joined(mapped, joiner)
  }
  if (level === 'takeaway' && paragraph.takeaway) return paragraph.morph.takeaway
  return briefTokens(paragraph, joiner)
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
