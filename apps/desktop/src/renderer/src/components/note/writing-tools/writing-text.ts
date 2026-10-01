/**
 * Pure text logic behind the writing tools: the a/an fix after an inline
 * alternative swap, matching the model's quotes back to editor ranges, and the
 * word count that leaves ghosted ranges out.
 *
 * A "text block" here is one ProseMirror textblock flattened to a string,
 * where every character (and every inline atom, as one placeholder character)
 * occupies exactly one document position starting at `from`.
 */

export interface WritingTextBlock {
  /** Document position of the block's first character */
  from: number
  text: string
}

export interface WritingTextRange {
  from: number
  to: number
}

// ---------------------------------------------------------------------------
// a / an
// ---------------------------------------------------------------------------

const ARTICLE_BEFORE_RANGE = /(?:^|[^\p{L}\p{N}])(an|a)(\s+)$/iu
const VOWEL_START = /^[\s"'“‘(]*[aeiou]/i

/**
 * The article a word needs: "an" before a vowel letter, "a" otherwise.
 * Spelling-based on purpose ("an hour" and "a unit" are not handled).
 */
export function articleFor(text: string): 'a' | 'an' {
  return VOWEL_START.test(text) ? 'an' : 'a'
}

function matchCase(article: 'a' | 'an', original: string): string {
  if (original === original.toLowerCase()) return article
  // "AN" is shouting; a single capital "A" is sentence case.
  if (original.length > 1 && original === original.toUpperCase()) return article.toUpperCase()
  return article.charAt(0).toUpperCase() + article.slice(1)
}

/**
 * When the word right before a swapped range is "a"/"an", the fix that makes
 * it agree with the newly shown text, as an offset into `textBefore` plus the
 * replacement. Null when there is no article there or it already agrees.
 */
export function articleFixBefore(
  textBefore: string,
  nextText: string
): { start: number; end: number; replacement: string } | null {
  const match = ARTICLE_BEFORE_RANGE.exec(textBefore)
  if (!match || !nextText.trim()) return null
  const current = match[1]
  const replacement = matchCase(articleFor(nextText), current)
  if (replacement === current) return null
  const end = textBefore.length - match[2].length
  return { start: end - current.length, end, replacement }
}

// ---------------------------------------------------------------------------
// Quotes -> ranges
// ---------------------------------------------------------------------------

/** Typographic punctuation models like to "fix" in a quote. */
function foldPunctuation(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
}

function stripWrappingQuotes(quote: string): string {
  return quote
    .trim()
    .replace(/^["“'‘]+(?=\S)/, '')
    .replace(/(?<=\S)["”'’]+$/, '')
    .trim()
}

/**
 * Ranges for the model's quotes, in quote order. A quote is matched as an
 * exact substring of one text block, first verbatim and then with typographic
 * punctuation folded on both sides. Each quote takes the first occurrence not
 * already taken by an earlier quote, so repeated phrases map to distinct
 * spans. Quotes that match nowhere are dropped, never guessed at.
 */
export function findQuoteRanges(
  blocks: WritingTextBlock[],
  quotes: string[]
): Array<WritingTextRange & { index: number }> {
  const taken: WritingTextRange[] = []
  const results: Array<WritingTextRange & { index: number }> = []
  const folded = blocks.map((block) => foldPunctuation(block.text))

  quotes.forEach((rawQuote, index) => {
    const candidates = [rawQuote.trim(), stripWrappingQuotes(rawQuote)].filter(
      (value, position, all) => value.length > 0 && all.indexOf(value) === position
    )
    for (const quote of candidates) {
      const range =
        findUntaken(blocks, (block) => block.text, quote, taken) ??
        findUntaken(
          blocks,
          (_block, blockIndex) => folded[blockIndex],
          foldPunctuation(quote),
          taken
        )
      if (range) {
        taken.push(range)
        results.push({ ...range, index })
        return
      }
    }
  })

  return results
}

function findUntaken(
  blocks: WritingTextBlock[],
  textOf: (block: WritingTextBlock, blockIndex: number) => string,
  quote: string,
  taken: WritingTextRange[]
): WritingTextRange | null {
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex]
    const text = textOf(block, blockIndex)
    let searchFrom = 0
    while (searchFrom <= text.length - quote.length) {
      const offset = text.indexOf(quote, searchFrom)
      if (offset === -1) break
      const range = { from: block.from + offset, to: block.from + offset + quote.length }
      if (!taken.some((other) => other.from < range.to && range.from < other.to)) return range
      searchFrom = offset + 1
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Cut spacing
// ---------------------------------------------------------------------------

const CLOSES_PHRASE = /[\s.,;:!?)\]”’"']/
const OPENS_PHRASE = /[\s([“‘"']/

/**
 * Which neighbouring space a cut should take with it so the text left behind
 * reads normally: "a very good" minus "very" is "a good", not "a  good".
 * `charBefore`/`charAfter` are '' at a block edge.
 */
export function cutSpacing(charBefore: string, charAfter: string): 'before' | 'after' | null {
  if (charBefore === ' ' && (charAfter === '' || CLOSES_PHRASE.test(charAfter))) return 'before'
  if (charAfter === ' ' && (charBefore === '' || OPENS_PHRASE.test(charBefore))) return 'after'
  return null
}

// ---------------------------------------------------------------------------
// Word count
// ---------------------------------------------------------------------------

const WORD = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0
}

/**
 * Words in the document, leaving out every character inside an excluded
 * (ghosted) range. Excluded characters become spaces, so a ghost that ends
 * mid-word splits the word rather than merging its halves with a neighbour.
 */
export function countWordsExcluding(
  blocks: WritingTextBlock[],
  excluded: WritingTextRange[]
): number {
  let total = 0
  for (const block of blocks) {
    const blockEnd = block.from + block.text.length
    const overlapping = excluded.filter((range) => range.from < blockEnd && block.from < range.to)
    if (overlapping.length === 0) {
      total += countWords(block.text)
      continue
    }
    const chars = [...block.text]
    // `[...text]` splits astral characters into one element each, but document
    // positions count UTF-16 units; walk both in step.
    let position = block.from
    const visible = chars.map((char) => {
      const start = position
      position += char.length
      return overlapping.some((range) => range.from <= start && start < range.to) ? ' ' : char
    })
    total += countWords(visible.join(''))
  }
  return total
}
