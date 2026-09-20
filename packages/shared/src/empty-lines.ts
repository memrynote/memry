export type MarkdownSegment =
  { type: 'content'; text: string } | { type: 'gap'; extraLines: number }

/**
 * Split markdown into content segments and gap descriptors.
 *
 * Runs of 3+ consecutive newlines (outside code fences) are extracted as
 * `gap` segments whose `extraLines` value equals the number of blank lines
 * beyond the standard 1-blank-line paragraph break.
 *
 * Standard paragraph breaks (\n\n) are left inside content segments for
 * BlockNote's parser to handle normally.
 */
export function splitMarkdownPreservingBlanks(markdown: string): MarkdownSegment[] {
  if (!markdown || !markdown.trim()) return []

  const regions = splitByCodeFences(markdown)
  let assembled = ''

  for (const region of regions) {
    if (region.isCode) {
      assembled += region.text
    } else {
      assembled += region.text.replace(/\n{3,}/g, (match) => {
        const nl = match.length
        return `\n\n\x00GAP:${nl - 2}\x00\n\n`
      })
    }
  }

  const parts = assembled.split(/\x00GAP:(\d+)\x00/)
  const segments: MarkdownSegment[] = []

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const text = trimEdgeNewlines(parts[i])
      if (text) {
        segments.push({ type: 'content', text })
      }
    } else {
      segments.push({ type: 'gap', extraLines: parseInt(parts[i], 10) })
    }
  }

  return segments
}

/**
 * Assemble markdown segments back into a single string.
 *
 * Content segments are joined by `\n\n` (standard paragraph break) plus
 * N extra `\n` characters for each gap between them.
 *
 * Round-trip guarantee: `assemble(split(md)) === md` for all well-formed
 * markdown where extra blank lines only appear outside code fences.
 */
export function assembleMarkdownWithBlanks(segments: MarkdownSegment[]): string {
  if (segments.length === 0) return ''

  let result = ''
  let prevWasContent = false

  for (const seg of segments) {
    if (seg.type === 'content') {
      if (prevWasContent) {
        result += '\n\n'
      }
      result += seg.text
      prevWasContent = true
    } else {
      if (prevWasContent) {
        result += '\n\n' + '\n'.repeat(seg.extraLines)
      } else {
        result += '\n\n' + '\n'.repeat(seg.extraLines)
      }
      prevWasContent = false
    }
  }

  return result
}

/**
 * A standalone image line (`![alt](url)` alone on its line) must be a block-level
 * element for BlockNote to create an image block. When it sits directly under a
 * text line with no blank line between, CommonMark folds it into the preceding
 * paragraph as an *inline* image — and BlockNote has no inline-image node, so the
 * image is silently dropped on parse. Imported notes (Apple Notes, Bear, …) emit
 * images glued to the previous line this way. Insert a blank line before/after
 * each such line so it parses as its own image block. Code fences are left as-is.
 */
const STANDALONE_IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]+\)\s*$/

export function separateBlockImages(markdown: string): string {
  if (!markdown.includes('![')) return markdown

  const regions = splitByCodeFences(markdown)
  let out = ''

  for (const region of regions) {
    if (region.isCode) {
      out += region.text
      continue
    }

    const lines = region.text.split('\n')
    const result: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (STANDALONE_IMAGE_LINE.test(line)) {
        if (result.length > 0 && result[result.length - 1].trim() !== '') result.push('')
        result.push(line)
        if (i + 1 < lines.length && lines[i + 1].trim() !== '') result.push('')
        continue
      }
      result.push(line)
    }
    out += result.join('\n')
  }

  return out
}

/**
 * Obsidian embeds an image as `![[photo.png]]`, optionally with a display size
 * or alias after a pipe (`![[photo.png|300x200]]`). The target stops at `|`;
 * `[`/`]`/`#` are excluded so a run cannot overrun the closing `]]`, and so a
 * heading transclusion (`![[Some Note#Heading]]`) never matches — that is a
 * note embed, not an image.
 *
 * The leading `!` is required: a bare `[[Note]]` is a link between notes and
 * keeps its `wikiLink` atom.
 */
const WIKI_IMAGE_EMBED_RE = /!\[\[([^\][|#]+)(?:\|([^\][]*))?\]\]/g

/**
 * Only real image extensions are treated as embedded images. `![[Some Note]]`
 * and `![[report.pdf]]` are transclusions of other things and keep whatever
 * handling they have today.
 */
const IMAGE_EMBED_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i

function eachWikiImageEmbed(
  markdown: string,
  visit: (match: RegExpExecArray, ref: string) => void
): void {
  for (const region of splitByCodeFences(markdown)) {
    if (region.isCode) continue
    WIKI_IMAGE_EMBED_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = WIKI_IMAGE_EMBED_RE.exec(region.text)) !== null) {
      const ref = match[1].trim()
      if (!ref || !IMAGE_EMBED_EXT_RE.test(ref)) continue
      visit(match, ref)
    }
  }
}

/**
 * Every distinct image target embedded with Obsidian syntax, in first-seen
 * order. Callers resolve these to `memry-file://` URLs and hand the results
 * back to `rewriteWikiImageEmbeds`.
 */
export function extractWikiImageEmbedRefs(markdown: string): string[] {
  if (!markdown.includes('![[')) return []
  const seen = new Set<string>()
  eachWikiImageEmbed(markdown, (_match, ref) => seen.add(ref))
  return Array.from(seen)
}

/**
 * Rewrite `![[photo.png]]` into the CommonMark `![photo.png](url)` form that
 * BlockNote parses into an image block. Without this the `[[…]]` half becomes a
 * wikiLink atom and the `!` is left behind as literal text, so the image never
 * renders.
 *
 * `resolve` maps the embed target to a URL the renderer can actually load —
 * image blocks only resolve absolute `memry-file://` URLs, so an embed whose
 * target is not found is left exactly as it was rather than rewritten into a
 * broken image. The display size (`|300x200`) is dropped: markdown cannot carry
 * it and BlockNote takes its width from the block's `previewWidth` prop.
 */
export function rewriteWikiImageEmbeds(
  markdown: string,
  resolve: (ref: string) => string | undefined
): string {
  if (!markdown.includes('![[')) return markdown

  const regions = splitByCodeFences(markdown)
  let out = ''

  for (const region of regions) {
    if (region.isCode) {
      out += region.text
      continue
    }
    WIKI_IMAGE_EMBED_RE.lastIndex = 0
    out += region.text.replace(WIKI_IMAGE_EMBED_RE, (whole, rawRef: string) => {
      const ref = rawRef.trim()
      if (!ref || !IMAGE_EMBED_EXT_RE.test(ref)) return whole
      const url = resolve(ref)
      if (!url) return whole
      // Strip brackets from the alt text so the filename cannot break `![](…)`.
      const alt = (ref.split('/').pop() ?? ref).replace(/[[\]]/g, '')
      return `![${alt}](${url})`
    })
  }

  return out
}

const LIST_ITEM_LINE = /^[ \t]*(?:[-*+]|\d+[.)])\s/

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
 * transform, and `unmaskHardBreaks` deletes any occurrence it cannot pair with
 * a newline. That fallback is the safety property: the worst case is a hard
 * break that stays soft — what happens today — and never a token written into
 * the user's file.
 */
const HARD_BREAK_TOKEN = 'MEMRYHBK;'

// A hard break is a line ending in two or more spaces, or in a single
// backslash. Both only count when a non-blank line follows: otherwise the line
// ends the paragraph and the parser produces no break at all.
const HARD_BREAK_LINE = /(?:[ \t]{2,}|\\)$/

/**
 * Mark every hard line break in `markdown` so it survives the parse.
 *
 * Code fences are skipped: a line ending in two spaces inside a fence is the
 * author's content, not a break.
 */
export function maskHardBreaks(markdown: string): string {
  if (!markdown) return markdown

  const regions = splitByCodeFences(markdown)
  let out = ''
  for (const region of regions) {
    out += region.isCode ? region.text : maskProseHardBreaks(region.text)
  }
  return out
}

function maskProseHardBreaks(text: string): string {
  // Cheap reject on the characters a hard break is spelled with. `$` in
  // `HARD_BREAK_LINE` anchors to the end of the whole string, so it is only
  // meaningful once the text is split into lines.
  if (!text.includes('  ') && !text.includes('\t') && !text.includes('\\')) return text

  const lines = text.split('\n')
  for (let index = 0; index < lines.length - 1; index++) {
    if (lines[index + 1].trim() === '') continue
    const line = lines[index]
    if (line.trim() === '' || !HARD_BREAK_LINE.test(line)) continue
    // The marker replaces the spelling rather than joining it: leaving the two
    // trailing spaces in place would hand the parser a break it already knows
    // how to drop, and leaving the backslash would escape the token's first
    // character.
    lines[index] = line.replace(HARD_BREAK_LINE, '') + HARD_BREAK_TOKEN
  }
  return lines.join('\n')
}

/**
 * Turn each surviving token back into the second newline that spells a hard
 * break in the document, and delete any that lost its newline.
 *
 * Applied to one inline text run, after the parse.
 */
export function unmaskHardBreaks(text: string): string {
  if (!text.includes(HARD_BREAK_TOKEN)) return text
  return text.split(`${HARD_BREAK_TOKEN}\n`).join('\n\n').split(HARD_BREAK_TOKEN).join('')
}

/** True when the text still carries a token, so callers can skip the walk. */
export function hasHardBreakToken(text: string): boolean {
  return text.includes(HARD_BREAK_TOKEN)
}

/**
 * Normalize BlockNote's markdown serializer output to the CommonMark/Obsidian
 * style vault files actually use. BlockNote serializes via remark-stringify,
 * whose defaults diverge from a hand-authored vault file:
 *
 * - `*` bullets            → `-`
 * - blank line per item    → tight list (dropped only between two list items)
 * - one `\` break          → plain `\n` soft break
 * - two `\` breaks in a row → a two-space hard break
 *
 * Without this, editing one line of a note rewrites every unrelated list line
 * and sprays blank lines / backslashes through the file. Code fences are left
 * byte-for-byte untouched (a `* ` or trailing `\` inside code is real content).
 */
export function normalizeSerializedMarkdown(markdown: string): string {
  if (!markdown) return markdown

  const regions = splitByCodeFences(markdown)
  let out = ''
  for (const region of regions) {
    out += region.isCode ? region.text : normalizeProseMarkdown(region.text)
  }
  return out
}

// Every break inside a paragraph reaches the serializer as remark's backslash
// form, and how many of them sit in a row is the only thing that tells the two
// apart: the editor holds a soft break as one newline inside a text node and a
// hard break as two, so it writes one `\` for a soft break and two for a hard
// one. Collapsing both to a plain newline turned an author's `<br>` into a
// paragraph gap (#1909). Three or more in a row have no spelling inside a
// paragraph — a second blank-ish line ends it — so those keep the old collapse.
const BACKSLASH_BREAK_RUN = /(?:\\\n)+/g
const HARD_BREAK = '  \n'

function normalizeProseMarkdown(text: string): string {
  const lines = text
    .replace(BACKSLASH_BREAK_RUN, (run) =>
      run.length === 4 ? HARD_BREAK : '\n'.repeat(run.length / 2)
    )
    .split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      const prev = out[out.length - 1]
      const next = lines[i + 1]
      // Drop a blank line only between two list items (loose→tight), never a
      // real paragraph gap.
      if (
        prev !== undefined &&
        next !== undefined &&
        LIST_ITEM_LINE.test(prev) &&
        LIST_ITEM_LINE.test(next)
      ) {
        continue
      }
    }
    // `*`/`+` bullet marker → `-` (needs the trailing space, so `*emphasis*` and
    // `***` thematic breaks are untouched).
    out.push(line.replace(/^([ \t]*)[*+](\s)/, '$1-$2'))
  }
  return compactTables(out).join('\n')
}

// ---------------------------------------------------------------------------
// Table column widths
// ---------------------------------------------------------------------------

/**
 * A table row: starts and ends with a pipe once trimmed. Good enough here
 * because this only ever reads the serializer's own output, which always
 * writes both delimiters, and a run is only treated as a table when the second
 * line is a separator.
 */
const TABLE_ROW_LINE = /^\s*\|.*\|\s*$/
const SEPARATOR_CELL = /^:?-+:?$/

/**
 * Escape the `|` inside a `[[target|alias]]` sitting in a table row.
 *
 * Reading fix, not a writing one. BlockNote 0.51's table parser splits a row
 * on every unescaped `|`, so a vault file holding `| [[Roadmap|the plan]] |`
 * — the form every version up to 0.50 wrote — now parses as two cells and the
 * alias is gone: `| [[Roadmap |`. Measured, not inferred; the same file
 * round-tripped intact on 0.47.
 *
 * The serializer already writes the escaped spelling (that is what the
 * `inlineImage` cell case has always expected), so this only has to carry the
 * older bytes across the parse. A note is rewritten once, into the spelling
 * that survives, and is stable from then on.
 */
export function escapeWikiLinkPipesInTableRows(markdown: string): string {
  if (!markdown.includes('[[') || !markdown.includes('|')) return markdown

  const regions = splitByCodeFences(markdown)
  let out = ''
  for (const region of regions) {
    out += region.isCode
      ? region.text
      : region.text
          .split('\n')
          .map((line) => (TABLE_ROW_LINE.test(line) ? escapeWikiLinkPipes(line) : line))
          .join('\n')
  }
  return out
}

function escapeWikiLinkPipes(line: string): string {
  let out = ''
  let depth = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) {
      out += line[i] + line[i + 1]
      i++
      continue
    }
    if (line.startsWith('[[', i)) {
      depth++
      out += '[['
      i++
      continue
    }
    if (depth > 0 && line.startsWith(']]', i)) {
      depth--
      out += ']]'
      i++
      continue
    }
    out += depth > 0 && line[i] === '|' ? '\\|' : line[i]
  }
  return out
}

/**
 * Re-lay a table's columns to the width of their own widest cell.
 *
 * BlockNote 0.51's markdown serializer pads every column to at least ten
 * characters, so `| a | b |` came back as `| a          | b          |`. The
 * table means the same thing either way, but the bytes on disk are what sync
 * and the vault file compare, so the first time a note holding a table was
 * opened it was rewritten in full — every table in every vault, one no-op
 * change pushed to every device.
 *
 * The natural-width layout is what the old serializer wrote and what the
 * fixtures in `roundtrip-table-layout.md` hold, so this restores the existing
 * on-disk spelling rather than inventing a third one.
 */
function compactTables(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const run = tableRunAt(lines, i)
    if (!run) {
      out.push(lines[i])
      continue
    }
    out.push(...relayTable(lines.slice(i, run)))
    i = run - 1
  }
  return out
}

/** End index (exclusive) of the table starting at `start`, or null. */
function tableRunAt(lines: string[], start: number): number | null {
  if (!TABLE_ROW_LINE.test(lines[start] ?? '')) return null
  const separator = lines[start + 1]
  if (!separator || !TABLE_ROW_LINE.test(separator)) return null
  const cells = splitRow(separator)
  if (cells.length === 0 || !cells.every((cell) => SEPARATOR_CELL.test(cell))) return null

  let end = start + 2
  while (end < lines.length && TABLE_ROW_LINE.test(lines[end])) end++
  return end
}

/** Cells of one row, trimmed, without the outer delimiters. */
function splitRow(line: string): string[] {
  const trimmed = line.trim()
  const inner = trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]
    // An escaped pipe is cell content, not a delimiter.
    if (char === '\\' && inner[i + 1] === '|') {
      current += '\\|'
      i++
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

function relayTable(rows: string[]): string[] {
  const grid = rows.map(splitRow)
  const columns = Math.max(...grid.map((row) => row.length))
  const widths: number[] = []
  for (let column = 0; column < columns; column++) {
    let width = 0
    for (const [index, row] of grid.entries()) {
      // The separator sets no width of its own — it is padded to whatever the
      // content columns need.
      if (index === 1) continue
      width = Math.max(width, (row[column] ?? '').length)
    }
    // No floor beyond one dash: a one-character column is written `| d |`
    // with a `| - |` separator, which is what the old serializer wrote and
    // what the vault fixtures hold.
    widths.push(Math.max(width, 1))
  }

  return grid.map((row, index) =>
    index === 1
      ? `| ${widths.map((width, column) => separatorCell(row[column] ?? '-', width)).join(' | ')} |`
      : `| ${widths.map((width, column) => (row[column] ?? '').padEnd(width)).join(' | ')} |`
  )
}

/** A separator cell widened to the column, keeping whichever colons it had. */
function separatorCell(cell: string, width: number): string {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':') && cell.length > 1
  const dashes = width - (left ? 1 : 0) - (right ? 1 : 0)
  return `${left ? ':' : ''}${'-'.repeat(Math.max(dashes, 1))}${right ? ':' : ''}`
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TextRegion {
  text: string
  isCode: boolean
}

function splitByCodeFences(markdown: string): TextRegion[] {
  const regions: TextRegion[] = []
  const fenceRegex = /^( {0,3})(```|~~~)/gm
  let inCode = false
  let openFence = ''
  let lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = fenceRegex.exec(markdown)) !== null) {
    const fence = match[2]

    if (!inCode) {
      if (match.index > lastIndex) {
        regions.push({ text: markdown.slice(lastIndex, match.index), isCode: false })
      }
      inCode = true
      openFence = fence
      lastIndex = match.index
    } else if (fence === openFence) {
      const lineEnd = markdown.indexOf('\n', match.index)
      const fenceEnd = lineEnd === -1 ? markdown.length : lineEnd
      regions.push({ text: markdown.slice(lastIndex, fenceEnd), isCode: true })
      const endPos = fenceEnd
      inCode = false
      openFence = ''
      lastIndex = endPos
    }
  }

  if (lastIndex < markdown.length) {
    regions.push({ text: markdown.slice(lastIndex), isCode: inCode })
  }

  return regions
}

function trimEdgeNewlines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '')
}
