import { splitByCodeFences } from './empty-lines.ts'

/**
 * The token a hard break wears across BlockNote's markdown parser.
 *
 * Up to BlockNote 0.50 the parser kept the two spellings apart on its own: a
 * soft break arrived as one newline inside the text node and a hard break as
 * two, which is the distinction `normalizeSerializedMarkdown` reads back on
 * the way out. 0.51 replaced that parser, and the new one emits a single
 * `<br>` for both — so `Line one  \nLine two` and `Line one\nLine two` became
 * byte-identical documents and every hard break in a foreign vault file
 * quietly became a soft one, which other markdown tools render as a space
 * rather than a line break.
 *
 * The distinction is still in the source text, so it is carried across the
 * parser rather than recovered after it. Same shape as the inline-colour
 * masking in `inline-colors.ts`: swap the construct for a token before the
 * parse, put it back after.
 *
 * The token is ASCII, so it cannot be mistaken for content the parser will
 * transform, and no restore leaves one behind: `unmaskHardBreaks` deletes any
 * occurrence it cannot pair with a newline. That fallback is the safety
 * property: the worst case is a hard break that stays soft — what happens
 * today — and never a token written into the user's file.
 *
 * The token is INDEXED, and the spelling it replaced is kept beside it, for
 * the same reason `maskInlineTokens` keeps its payloads: where the masked run
 * lands decides what it has to turn back into. In prose it means a break, and
 * `unmaskHardBreaks` writes the document's spelling of one. In a code block it
 * means nothing at all — the bytes are literal there — so
 * `restoreHardBreakSpelling` puts back exactly what was taken, which is the
 * difference between a `cmd \` line continuation surviving a `<pre>` block and
 * being silently replaced by two spaces.
 */
const HARD_BREAK_TOKEN_PREFIX = 'MEMRYHBK'

/** `MEMRYHBK<index>;`, as written by `maskHardBreaks`. */
const HARD_BREAK_TOKEN = /MEMRYHBK(\d+);/g

/**
 * The same token, with the spaces before it and the newline it marks when it
 * still has one. Spaces before a break are part of its spelling, never text.
 */
const HARD_BREAK_TOKEN_WITH_NEWLINE = /([^\S\n]*)MEMRYHBK\d+;(\n?)/g

// A hard break is a line ending in two or more spaces, or in a single
// backslash. Both only count when a non-blank line follows: otherwise the line
// ends the paragraph and the parser produces no break at all.
const HARD_BREAK_LINE = /(?:[ \t]{2,}|\\)$/

// An author's `<br>` with more text after it on the same line (BBF-85). The
// parser turns the tag into the same newline a soft break gives, so the token
// goes in front of the tag and lands against that newline. A `<br>` that ends
// its line already parses as two newlines, and two tags in a row already give
// a hard break, so neither is marked.
const HTML_BREAK_MID_LINE = /(?<!<br\s*\/?>[^\S\n]*)<br\s*\/?>(?![^\S\n]*<br\b)(?=[^\S\n]*\S)/gi

// Only a plain paragraph line. A table row is one line by grammar (a line with
// a pipe may be one), and a heading is one line too. In a quote or list item
// the tag keeps the soft break it parsed to before BBF-85. A lazy line
// continues the block above it.
const NOT_PARAGRAPH_LINE = /^(?:[ \t]|[>#]|[-*+][ \t]|\d+[.)][ \t])|\|/

const LINK_SYNTAX = /[[\]]|<a\b/i

const LIST_ITEM_START = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/

// A line that opens a block of its own rather than continuing a paragraph.
const BLOCK_START =
  /^[ \t]*(?:[-*+][ \t]|\d+[.)][ \t]|>|#{1,6}(?:[ \t]|$)|\||```|~~~|(?:[-*_=][ \t]*){3,}$)/

export interface MaskedHardBreaks {
  markdown: string
  /** The spelling each token replaced, by index. Empty when nothing was masked. */
  breaks: string[]
}

/**
 * Mark every hard line break in `markdown` so it survives the parse.
 *
 * Code fences are skipped: a line ending in two spaces inside a fence is the
 * author's content, not a break. A raw `<pre>` block is NOT skipped — it is
 * prose as far as this scan is concerned — which is why the spelling has to
 * travel with the token: BlockNote turns that `<pre>` into a code block, and
 * `restoreHardBreakSpelling` is what puts the author's bytes back there.
 */
export function maskHardBreaks(markdown: string): MaskedHardBreaks {
  if (!markdown) return { markdown, breaks: [] }

  const regions = splitByCodeFences(markdown)
  const breaks: string[] = []
  let out = ''
  for (const region of regions) {
    out += region.isCode ? region.text : maskProseHardBreaks(region.text, breaks)
  }
  return breaks.length === 0 ? { markdown, breaks: [] } : { markdown: out, breaks }
}

function maskProseHardBreaks(text: string, breaks: string[]): string {
  // Cheap reject on the characters a hard break is spelled with. `$` in
  // `HARD_BREAK_LINE` anchors to the end of the whole string, so it is only
  // meaningful once the text is split into lines.
  const hasBr = /<br/i.test(text)
  if (!hasBr && !text.includes('  ') && !text.includes('\t') && !text.includes('\\')) return text

  const lines = text.split('\n')
  let inOtherBlock = false
  let inListItem = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === '') inOtherBlock = false
    else if (NOT_PARAGRAPH_LINE.test(line)) inOtherBlock = true
    if (line.trim() === '') inListItem = false
    else if (LIST_ITEM_START.test(line)) inListItem = true
    else if (BLOCK_START.test(line)) inListItem = false
    // Link and image text and URLs never reach the unmask, so a line with any
    // link syntax keeps its tags as they were rather than risk a token in the file.
    if (hasBr && !inOtherBlock && !LINK_SYNTAX.test(line)) {
      // The tag stays for the parser to break on. Its spelling is empty: in a
      // `<pre>` block the tag's own newline is all it ever meant.
      lines[index] = line.replace(HTML_BREAK_MID_LINE, (tag) => {
        breaks.push('')
        return `${HARD_BREAK_TOKEN_PREFIX}${breaks.length - 1};${tag}`
      })
    }
    if (index === lines.length - 1) continue
    if (lines[index + 1].trim() === '') continue
    if (line.trim() === '' || !HARD_BREAK_LINE.test(line)) continue
    // The marker replaces the spelling rather than joining it: leaving the two
    // trailing spaces in place would hand the parser a break it already knows
    // how to drop, and leaving the backslash would escape the token's first
    // character.
    lines[index] = lines[index].replace(HARD_BREAK_LINE, (spelling) => {
      breaks.push(spelling)
      return `${HARD_BREAK_TOKEN_PREFIX}${breaks.length - 1};`
    })
    // BlockNote's parser turns a list item's continuation line into a child
    // paragraph, or ends the list on a lazy one, so the break is lost (BBF-99).
    // Joined with the `<br>` the item parses to instead, the token lands
    // against that newline; the joined line is scanned again for its own break.
    if (inListItem && !BLOCK_START.test(lines[index + 1])) {
      lines[index] += `<br>${lines[index + 1].trimStart()}`
      lines.splice(index + 1, 1)
      index--
    }
  }
  return lines.join('\n')
}

/**
 * Turn each surviving token back into the second newline that spells a hard
 * break in the document, and delete any that lost its newline.
 *
 * Applied to one inline text run of PROSE, after the parse. A run that became
 * a code block goes through `restoreHardBreakSpelling` instead.
 */
export function unmaskHardBreaks(text: string): string {
  if (!text.includes(HARD_BREAK_TOKEN_PREFIX)) return text
  return text.replace(HARD_BREAK_TOKEN_WITH_NEWLINE, (_whole, spaces: string, newline: string) =>
    newline ? '\n\n' : spaces
  )
}

/**
 * Put back the exact spelling each token replaced, for one inline text run of
 * a CODE BLOCK.
 *
 * A code block holds literal bytes, so the two trailing spaces or the trailing
 * backslash that a token stands for mean nothing there beyond themselves and
 * have to come back as themselves. A token with no recorded spelling is
 * deleted rather than left: the one thing that must never reach the user's
 * file is the token.
 */
export function restoreHardBreakSpelling(text: string, breaks: string[]): string {
  if (!text.includes(HARD_BREAK_TOKEN_PREFIX)) return text
  return text.replace(HARD_BREAK_TOKEN, (_whole, index: string) => breaks[Number(index)] ?? '')
}

/** True when the text still carries a token, so callers can skip the walk. */
export function hasHardBreakToken(text: string): boolean {
  return text.includes(HARD_BREAK_TOKEN_PREFIX)
}
