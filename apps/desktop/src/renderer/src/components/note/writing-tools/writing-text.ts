/**
 * Pure text logic behind the writing tools: the a/an fix after an inline
 * alternative swap and the word count that leaves ghosted ranges out.
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
