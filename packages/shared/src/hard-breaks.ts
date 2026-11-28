import { splitByCodeFences } from './empty-lines.ts'
import { MASK_WORD } from './mask-word.ts'

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
 * The token carries `MASK_WORD`, so no text an author wrote spells one. It is
 * ASCII, so it cannot be mistaken for content the parser will
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
const HARD_BREAK_TOKEN_PREFIX = `MEMRYHBK${MASK_WORD}`

/** `MEMRYHBK<word><index>;`, as written by `maskHardBreaks`. */
const HARD_BREAK_TOKEN = new RegExp(`${HARD_BREAK_TOKEN_PREFIX}(\\d+);`, 'g')

/**
 * The same token, then the newline it marks when it still has one. The spaces
 * before it are not part of the pattern: `unmaskHardBreaks` looks back for them,
 * because a pattern opening with a run of blanks reads the run again from every
 * start in it.
 */
const HARD_BREAK_TOKEN_THEN_NEWLINE = new RegExp(`${HARD_BREAK_TOKEN_PREFIX}\\d+;(\\n?)`, 'g')

/**
 * What makes `line` a hard break: its two or more trailing spaces or tabs, or
 * its single trailing backslash. Empty when it is not one. Both only count when
 * a non-blank line follows: otherwise the line ends the paragraph and the
 * parser produces no break at all.
 */
function hardBreakSpelling(line: string): string {
  if (line.endsWith('\\')) return '\\'
  let start = line.length
  while (start > 0 && (line[start - 1] === ' ' || line[start - 1] === '\t')) start--
  return line.length - start >= 2 ? line.slice(start) : ''
}

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

const INLINE_SPAN_SYNTAX = /[`[\]<]/

/** A break an earlier join wrote: a token, then the `<br>` it marks. */
const JOINED_BREAK = new RegExp(`${HARD_BREAK_TOKEN_PREFIX}\\d+;<br>`, 'g')

/** A task item's `[ ]` / `[x]`, which is not link syntax. */
const TASK_ITEM_BOX = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[[ xX]\]/

const LIST_ITEM_START = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/

// A table's delimiter row, which makes the pipe line above it a header. No two
// quantifiers take the same whitespace, so a long line of tabs cannot backtrack.
const TABLE_DELIMITER_ROW = /^\s*(?:\|\s*)?:?-+:?\s*(?:\|\s*:?-+:?\s*)*(?:\|\s*)?$/

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
  return { markdown: out, breaks }
}

function maskProseHardBreaks(text: string, breaks: string[]): string {
  // Cheap reject on the characters a hard break or a link is spelled with. A hard
  // break is a line's own ending, so it is only meaningful once the text is split
  // into lines.
  const hasBr = /<br/i.test(text)
  if (
    !hasBr &&
    !text.includes('  ') &&
    !text.includes('\t') &&
    !text.includes('\\') &&
    !text.includes('](')
  ) {
    return text
  }

  const lines = text.split('\n')
  const kept: string[] = []
  const restClosesLink = linkParagraphReader(lines)
  // `current` is the line being masked, which a join may have grown; `lines[at]` is the line after it.
  let current = lines[0]
  let at = 1
  let inOtherBlock = false
  let inListItem = false
  let inTable = false
  const tokenFor = (spelling: string): string => {
    breaks.push(spelling)
    return `${HARD_BREAK_TOKEN_PREFIX}${breaks.length - 1};`
  }
  for (;;) {
    for (;;) {
      const line = current
      // A table row is one line, so its trailing `\` is the last cell's text:
      // masked as a break, `| a \` lost the backslash.
      const next = lines[at] ?? ''
      if (!line.includes('|')) inTable = false
      else if (next.includes('|') && TABLE_DELIMITER_ROW.test(next)) inTable = true
      // BlockNote ends a list item at a lazy line and opens a paragraph on it,
      // so a `<br>` opening that line is one opening a paragraph: a hard break.
      // Read as the soft break it parsed to, it had no spelling and was dropped
      // on the next write (`- [a\n<br>b](u)`). Link syntax later in the line
      // cannot hold the token, which sits before the tag at the line's start.
      if (hasBr && inListItem && !NOT_PARAGRAPH_LINE.test(line) && !BLOCK_START.test(line)) {
        current = line.replace(
          /^<br\s*\/?>(?![^\S\n]*<br\b)(?=[^\S\n]*\S)/i,
          (tag) => `${tokenFor('')}${tag}`
        )
      }
      if (line.trim() === '') inOtherBlock = false
      else if (NOT_PARAGRAPH_LINE.test(line)) inOtherBlock = true
      if (line.trim() === '') inListItem = false
      else if (LIST_ITEM_START.test(line)) inListItem = true
      else if (BLOCK_START.test(line)) inListItem = false
      // Link and image URLs never reach the unmask, so a line with any link
      // syntax keeps its tags as they were rather than risk a token in the file.
      if (hasBr && !inOtherBlock && !LINK_SYNTAX.test(line)) {
        // The tag stays for the parser to break on. Its spelling is empty: in a
        // `<pre>` block the tag's own newline is all it ever meant.
        current = line.replace(HTML_BREAK_MID_LINE, (tag) => `${tokenFor('')}${tag}`)
      }
      if (at === lines.length) return [...kept, current].join('\n')
      if (next.trim() === '') break
      // The parser ends a list item at a soft break inside link text too, so
      // `- [a\nb](u)` lost its link and gained a blank line (BBF-106). Joined
      // with a `<br>`, the item keeps one link with a soft break in it.
      if (
        inListItem &&
        !hardBreakSpelling(line) &&
        !BLOCK_START.test(next) &&
        endsInsideLinkText(line) &&
        restClosesLink(at)
      ) {
        // The joined line is read again from the top, and joins the next line while its link text
        // stays open. For a joined line that read changes only `inTable`, so it runs here on the
        // line joined in: read whole, a link text over n lines cost n reads of it.
        let depth = linkTextDepth(line.replace(TASK_ITEM_BOX, '$1'), 0)
        let pipe = current.includes('|')
        for (let joining = next; ; joining = lines[at]) {
          current += `<br>${joining.trimStart()}`
          at++
          depth = linkTextDepth(joining, depth)
          pipe ||= joining.includes('|')
          const after = lines[at] ?? ''
          if (
            at === lines.length ||
            after.trim() === '' ||
            hardBreakSpelling(joining) ||
            BLOCK_START.test(after) ||
            depth === 0 ||
            !restClosesLink(at)
          ) {
            break
          }
          if (!pipe) inTable = false
          else if (after.includes('|') && TABLE_DELIMITER_ROW.test(after)) inTable = true
        }
        continue
      }
      if (inTable || line.trim() === '' || !hardBreakSpelling(line)) break
      // The marker replaces the spelling rather than joining it: leaving the two
      // trailing spaces in place would hand the parser a break it already knows
      // how to drop, and leaving the backslash would escape the token's first
      // character.
      const spelling = hardBreakSpelling(current)
      current = `${current.slice(0, -spelling.length)}${tokenFor(spelling)}`
      // BlockNote's parser turns a list item's continuation line into a child
      // paragraph, or ends the list on a lazy one, so the break is lost (BBF-99).
      // Joined with the `<br>` the item parses to instead, the token lands
      // against that newline; the joined line is scanned again for its own break.
      // A code span, link or tag that the join would carry across keeps the
      // old split rather than risk a `<br>` or token written into the file.
      const joined = `${current.replace(TASK_ITEM_BOX, '').replace(JOINED_BREAK, '')}${next}`
      if (!inListItem || BLOCK_START.test(next) || INLINE_SPAN_SYNTAX.test(joined)) break
      // As above, the joined line is read again for its own break, here on the line joined in. The
      // part before it already passed the check for a code span, link or tag.
      let pipe = current.includes('|')
      for (let joining = next; ; joining = lines[at]) {
        at++
        pipe ||= joining.includes('|')
        const after = lines[at] ?? ''
        const joiningSpelling = hardBreakSpelling(joining)
        // `inTable` is false here, or the first break would not have been masked, and a read that
        // would set it masks nothing.
        if (
          at === lines.length ||
          after.trim() === '' ||
          !joiningSpelling ||
          (pipe && after.includes('|') && TABLE_DELIMITER_ROW.test(after)) ||
          BLOCK_START.test(after) ||
          INLINE_SPAN_SYNTAX.test(after)
        ) {
          current += `<br>${joining.trimStart()}`
          break
        }
        const trimmed = joining.trimStart()
        current += `<br>${trimmed.slice(0, -joiningSpelling.length)}${tokenFor(joiningSpelling)}`
      }
    }
    kept.push(current)
    current = lines[at++]
  }
}

/** The bracket depth after `text`, starting at `depth`. A `]` with no `[` open is skipped. */
function linkTextDepth(text: string, depth: number): number {
  for (const [bracket] of text.matchAll(/[[\]]/g)) {
    depth = Math.max(0, depth + (bracket === '[' ? 1 : -1))
  }
  return depth
}

/**
 * True when `line` ends inside link text, holds no image, code span, escaped
 * bracket, tag other than `<br>`, or `<br>` against its line end, and every
 * address in it closes on the line with nothing `addressKeepsSplit` rejects.
 * `linkParagraphReader` checks the lines after it.
 */
function endsInsideLinkText(line: string): boolean {
  return (
    linkTextDepth(line.replace(TASK_ITEM_BOX, '$1'), 0) > 0 &&
    !/`|<(?!br>)|!\[|\\[[\]]|<br>[^\S\n]*$/i.test(line) &&
    !addressKeepsSplit(line, false)
  )
}

/**
 * Reads, for a line that ends inside link text, whether the rest of its
 * paragraph lets the join go ahead: the last line closes the link, and no line
 * holds an image, a code span, an escaped bracket, a tag, a title or address
 * the writer cannot spell back, or (before the last line) a hard break.
 *
 * Each line is read once per paragraph: the answer for a later line of the same
 * paragraph is whether the last line that keeps the split comes before it.
 */
function linkParagraphReader(lines: string[]): (at: number) => boolean {
  let end = 0
  let closes = false
  let lastKeepingSplit = -1
  return (at) => {
    if (at >= end) {
      end = at
      while (end < lines.length && lines[end].trim() !== '' && !BLOCK_START.test(lines[end])) end++
      closes = end > at && lines[end - 1].includes('](')
      lastKeepingSplit = -1
      for (let index = at; index < end; index++) {
        const last = index === end - 1
        if (
          /`|<(?!br>)|!\[|\\[[\]]|<br/i.test(lines[index]) ||
          addressKeepsSplit(lines[index], last) ||
          (!last && hardBreakSpelling(lines[index]))
        ) {
          lastKeepingSplit = index
        }
      }
    }
    return closes && lastKeepingSplit < at
  }
}

/**
 * True when an address in `line` holds a title or a space, or holds a
 * parenthesis that is unbalanced or next to a backslash, which the writer
 * escapes again on every save (BBF-107). Unless `last` ends the paragraph, the
 * line ends in a newline, which no address can hold.
 *
 * An address that starts inside one already read and closed is not read: it
 * closes inside that one, so whatever it holds the outer one holds too.
 */
function addressKeepsSplit(line: string, last: boolean): boolean {
  let read = 0
  for (const open of line.matchAll(/\]\(/g)) {
    if (open.index + 1 < read) continue
    let depth = 0
    let paren = false
    let backslash = false
    let at = open.index + 2
    for (; at < line.length; at++) {
      const char = line[at]
      if (/\s/.test(char)) return true
      if (char === '\\') backslash = true
      else if (char === '(') {
        paren = true
        depth++
      } else if (char === ')' && depth-- === 0) break
    }
    if (at === line.length) {
      if (!last || paren) return true
    } else if (paren && backslash) return true
    read = at
  }
  return false
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
  let out = ''
  let copied = 0
  for (const { index, 0: token, 1: newline } of text.matchAll(HARD_BREAK_TOKEN_THEN_NEWLINE)) {
    let end = index
    if (newline) while (end > copied && /[^\S\n]/.test(text[end - 1])) end--
    out += text.slice(copied, end) + (newline ? '\n\n' : '')
    copied = index + token.length
  }
  return out + text.slice(copied)
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
