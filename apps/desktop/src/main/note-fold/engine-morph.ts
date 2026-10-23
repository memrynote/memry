/**
 * Word maps for the Brief -> Key -> Takeaway -> Topic morph: every token of an
 * AI line that also occurs in the source paragraph points at its source token,
 * so the renderer can slide that word from where it sat. Matching is the
 * in-order longest common subsequence over normalized words, after the word
 * alignment in github.com/chenxiachan/textfold (textfold/tokens.py `norm`,
 * `lcs_pairs`; Apache-2.0). Tokens come from Intl.Segmenter, not a regex.
 */
import type { FoldMorph, FoldToken } from '@memry/contracts/note-fold'

import { segmenter } from './segmenter'

/** Above this many dp cells a paragraph is not mapped; lines then fade instead of slide. */
const MAX_LCS_CELLS = 4_000_000

interface Segment {
  text: string
  wordLike: boolean
  offset: number
}

function segmentWords(text: string, language: string): Segment[] {
  const out: Segment[] = []
  for (const s of segmenter(language, 'word').segment(text)) {
    out.push({ text: s.segment, wordLike: s.isWordLike === true, offset: s.index })
  }
  return out
}

/** What two tokens must share to count as the same word; '' never matches. */
export function normalizeToken(text: string, language: string): string {
  let w = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
  if (language === 'en' && w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  return w
}

/** In-order common subsequence of two normalized word lists, as index pairs; '' never matches. */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_LCS_CELLS) return []
  const w = m + 1
  const dp = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] !== '' && a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] !== '' && a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++
    else j++
  }
  return out
}

export interface MorphSource {
  srcTokens: string[]
  /** Token index where each sentence starts; a sentence ends where the next starts. */
  srcSentenceStart: number[]
  morph: FoldMorph
}

export interface MorphLines {
  keyTakeaway: string | null
  keyReason: string | null
  takeaway: string | null
  topic: string | null
}

export function buildMorph(
  text: string,
  sentences: string[],
  lines: MorphLines,
  language: string
): MorphSource {
  const src = segmentWords(text, language)
  const srcNorm = src.map((s) => (s.wordLike ? normalizeToken(s.text, language) : ''))

  const srcSentenceStart: number[] = []
  let cursor = 0
  let tokenIdx = 0
  for (const s of sentences) {
    const at = text.indexOf(s, cursor)
    const offset = at < 0 ? cursor : at
    while (tokenIdx < src.length - 1 && src[tokenIdx].offset < offset) tokenIdx++
    srcSentenceStart.push(tokenIdx)
    cursor = offset + s.length
  }

  const map = (line: string | null): FoldToken[] | null => {
    if (line === null) return null
    const toks = segmentWords(line, language)
    const norm = toks.map((t) => (t.wordLike ? normalizeToken(t.text, language) : ''))
    const out: FoldToken[] = toks.map((t) => ({ text: t.text, src: null }))
    for (const [li, si] of lcsPairs(norm, srcNorm)) out[li].src = si
    return out
  }

  return {
    srcTokens: src.map((s) => s.text),
    srcSentenceStart,
    morph: {
      keyTakeaway: map(lines.keyTakeaway),
      keyReason: map(lines.keyReason),
      takeaway: map(lines.takeaway),
      topic: map(lines.topic)
    }
  }
}
