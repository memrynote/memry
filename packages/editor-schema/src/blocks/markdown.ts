/**
 * The on-disk form of every custom block — the bytes that reach the vault file.
 *
 * This is a contract, not a preference. Write-back byte-compares the serialized
 * document against the file before writing, so a single character of drift here
 * rewrites every note holding one of these blocks, in every vault, on next open.
 * The renderer serializes through these functions directly. Main cannot: a
 * server spec returns DOM and BlockNote converts that to markdown, so main
 * builds DOM shaped to serialize to the identical bytes. Two implementations
 * that must agree is exactly the drift this package exists to prevent, so the
 * agreement is asserted by test (see `blocknote-converter.test.ts`), not left
 * to reading.
 *
 * Each form below is the one already on disk today — see the git history of
 * `callout-block.tsx`, `youtube-embed-block.tsx`, `bookmark-block.tsx` and
 * `file-block-markers.ts`, from which these moved verbatim.
 */

import { BLOCK_COLORS_LINE_REGEX } from '@memry/shared/block-colors'
import { createFenceTracker } from '@memry/shared/markdown-fences'

// ---------------------------------------------------------------------------
// callout — `> [!type]` followed by the content, one `> ` per line
// ---------------------------------------------------------------------------

export const CALLOUT_TYPE_VALUES = ['info', 'warning', 'error', 'success'] as const

export type CalloutTypeValue = (typeof CALLOUT_TYPE_VALUES)[number]

/**
 * Exactly the marker `serializeCalloutBlock` writes: one of the four Memry
 * types, nothing after the `]`. `> [!note]` and `> [!info] A title` are NOT
 * this — those are someone else's bytes (Obsidian's, usually) and claiming
 * them would rewrite a file Memry never wrote.
 */
const MEMRY_CALLOUT_MARKER_REGEX = /^> \[!(info|warning|error|success)\]$/

/**
 * The damaged form #1846 heals: the marker alone on its line, its `> ` prefix
 * already lost. Healed only at a paragraph start with the body directly below
 * — a lone `[!info]` with nothing under it stays the author's text.
 */
const BARE_CALLOUT_MARKER_REGEX = /^\[!(info|warning|error|success)\]$/

export function serializeCalloutBlock(type: string, contentMarkdown: string): string {
  const lines = contentMarkdown.split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return `> [!${type}]`
  const quoted = lines.map((line) => `> ${line}`).join('\n')
  return `> [!${type}]\n${quoted}`
}

export interface CalloutRun {
  type: CalloutTypeValue
  /** Body lines with the `> ` prefix stripped; verbatim for a bare run. */
  contentLines: string[]
  /** The run's original lines, verbatim, for fallback parsing on decline. */
  raw: string
  /** Index of the first line after the run. */
  end: number
}

/**
 * Read one callout run starting at `lines[start]`, or null.
 *
 * Accepts only the two shapes this feature owns: the exact bytes
 * `serializeCalloutBlock` writes (strict marker + one `> ` per body line), and
 * the bare damaged shape (marker line without its `> `, body directly below).
 * Both require a paragraph start — a marker halfway through a paragraph or a
 * quote is part of that paragraph's bytes, not a callout.
 *
 * A run that abuts more quote lines (`>` on its own, `>text`) is refused
 * whole: `serializeCalloutBlock` never writes those, so the region is a quote
 * block that merely starts like a callout, and splitting it would tear the
 * quote in two.
 */
export function readCalloutRun(
  lines: readonly string[],
  start: number,
  atParagraphStart: boolean
): CalloutRun | null {
  if (!atParagraphStart) return null

  const quoted = lines[start].match(MEMRY_CALLOUT_MARKER_REGEX)
  if (quoted) {
    const contentLines: string[] = []
    let end = start + 1
    while (end < lines.length) {
      const body = lines[end].match(/^> (.+)$/)
      if (!body) break
      contentLines.push(body[1])
      end++
    }
    if (end < lines.length && lines[end].startsWith('>')) return null
    return {
      type: quoted[1] as CalloutTypeValue,
      contentLines,
      raw: lines.slice(start, end).join('\n'),
      end
    }
  }

  const bare = lines[start].match(BARE_CALLOUT_MARKER_REGEX)
  if (bare) {
    const contentLines: string[] = []
    let end = start + 1
    while (end < lines.length && lines[end].trim() !== '') {
      contentLines.push(lines[end])
      end++
    }
    if (contentLines.length === 0) return null
    return {
      type: bare[1] as CalloutTypeValue,
      contentLines,
      raw: lines.slice(start, end).join('\n'),
      end
    }
  }

  return null
}

interface ParsedBlockShape {
  type?: unknown
  content?: unknown
  children?: unknown[]
}

/**
 * Decide whether a run may become a callout block, by proof rather than by
 * pattern: parse the body, and claim only if serializing it back reproduces
 * the body byte-for-byte (so `serializeCalloutBlock` reproduces the whole run
 * on the way out). Anything the schema would normalize — a list in the body, a
 * nested quote, a second paragraph — declines, and the caller leaves the bytes
 * exactly as they were.
 */
export async function resolveCalloutRun(
  run: CalloutRun,
  parseMarkdown: (markdown: string) => Promise<ParsedBlockShape[]>,
  serializeBlock: (block: ParsedBlockShape) => Promise<string>
): Promise<{ type: CalloutTypeValue; content: unknown } | null> {
  const content = run.contentLines.join('\n')
  if (content === '') return { type: run.type, content: [] }

  const parsed = await parseMarkdown(content)
  if (parsed.length !== 1) return null
  const block = parsed[0]
  if (block.type !== 'paragraph' || block.children?.length) return null

  const roundTripped = (await serializeBlock(block)).trim()
  if (roundTripped !== content) return null

  return { type: run.type, content: block.content ?? [] }
}

// ---------------------------------------------------------------------------
// quote — a blockquote run whose inner structure BlockNote's flat `quote` block
// cannot hold on its own
// ---------------------------------------------------------------------------

/**
 * Re-quote inner markdown: one `> ` per line, a bare `>` for each blank line
 * separating the quote's own blocks. The exact inverse of the one-level strip
 * `readStructuredQuoteRun` performs.
 */
export function serializeQuoteBlock(innerMarkdown: string): string {
  return innerMarkdown
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

export interface QuoteRun {
  /** The run's lines with one `>` level stripped. */
  innerMarkdown: string
  /** The run's original lines, verbatim, for fallback parsing on decline. */
  raw: string
  /** Index of the first line after the run. */
  end: number
  /**
   * The run carries a second `>` level. Declining such a run is not free: the
   * flat fallback deletes the level outright, so `> Outer\n> > Inner` comes
   * back `> Outer\n> Inner` and a nested `> > [!warning]` callout comes back as
   * literal text (#1881).
   */
  nested: boolean
}

/**
 * Read a blockquote run at `lines[start]` whose inner structure BlockNote
 * cannot hold flat, or null to leave the bytes on the path they are on today.
 *
 * BlockNote parses a whole blockquote into ONE block of inline content, so a
 * blank `>` separator and a `> >` nesting level are gone before serialization
 * ever runs: `> A\n>\n> B` comes back as `> A\n> B` and a nested callout comes
 * back unnested (#1881). Those two are exactly the shapes claimed here. A run
 * with neither is already flat and stays on the untouched path, so no quote
 * that round-trips today changes.
 *
 * Strict on the prefix: only `>` alone and `> …` are read. A `>text` line —
 * valid CommonMark, never bytes Memry writes — refuses the whole run rather
 * than ending it early, which would tear one blockquote into two.
 */
export function readStructuredQuoteRun(lines: readonly string[], start: number): QuoteRun | null {
  if (!lines[start]?.startsWith('>')) return null

  const inner: string[] = []
  let end = start
  let separated = false
  let nested = false

  while (end < lines.length && lines[end].startsWith('>')) {
    const line = lines[end]
    if (line === '>') {
      inner.push('')
      separated = true
    } else if (line.startsWith('> ')) {
      const stripped = line.slice(2)
      inner.push(stripped)
      if (stripped.startsWith('>')) nested = true
    } else {
      return null
    }
    end++
  }

  if (!separated && !nested) return null
  return { innerMarkdown: inner.join('\n'), raw: lines.slice(start, end).join('\n'), end, nested }
}

/**
 * Decide whether a run may become a quote block that owns children, by proof
 * rather than by pattern — the same rule `resolveCalloutRun` applies: parse the
 * stripped inner markdown, then check what re-serializing and re-quoting it
 * gives back.
 *
 * Reproducing the run byte-for-byte claims it, and that is the only outcome a
 * run with just a blank `>` separator accepts. Anything else declines and the
 * caller leaves the bytes exactly as they were.
 *
 * A run carrying a `> >` level gets a second chance, because declining it is
 * not free. Lazy continuation (`> Outer\n> > Inner`, no blank line between the
 * levels) is AST-identical to the separator form `> Outer\n>\n> > Inner`, and a
 * block tree has nowhere to record which of the two spellings it was read from,
 * so exactly one of them can round-trip and the separator form is the one that
 * does. The cost of declining is not the missing separator, it is that the flat
 * fallback deletes the `>` level: `> Outer\n> Inner`, and a foreign
 * `> > [!warning]` callout demoted to literal text (#1881). So a nested run is
 * claimed when its canonical form settles — when re-reading and re-parsing
 * those bytes reproduces them — which trades an unreachable byte identity for a
 * one-step normalization that keeps the nesting.
 *
 * The first inner block becomes the quote's own content and the rest its
 * children, which is the list `serializeQuoteBlock` is handed on the way out.
 */
export async function resolveQuoteRun(
  run: QuoteRun,
  parseMarkdown: (markdown: string) => Promise<ParsedBlockShape[]>,
  serializeBlocks: (blocks: ParsedBlockShape[]) => Promise<string>
): Promise<{ content: unknown; children: ParsedBlockShape[] } | null> {
  const parsed = await parseMarkdown(run.innerMarkdown)
  const [first, ...children] = parsed
  if (!first || first.type !== 'paragraph' || first.children?.length) return null
  // No children means a flat quote, which the untouched path already serializes
  // correctly — claiming it would only route identical bytes through more code.
  if (children.length === 0) return null

  const canonical = serializeQuoteBlock((await serializeBlocks(parsed)).trim())
  if (canonical !== run.raw) {
    if (!run.nested) return null
    if (!(await settles(canonical, parseMarkdown, serializeBlocks))) return null
  }

  return { content: first.content ?? [], children }
}

/**
 * Whether `canonical` is a fixed point of this same seam: it reads back as one
 * whole quote run, and re-parsing and re-quoting that run returns it unchanged.
 * A run that settles is written once and then left alone on every later save,
 * so the vault file stops moving after the first write.
 */
async function settles(
  canonical: string,
  parseMarkdown: (markdown: string) => Promise<ParsedBlockShape[]>,
  serializeBlocks: (blocks: ParsedBlockShape[]) => Promise<string>
): Promise<boolean> {
  const lines = canonical.split('\n')
  const reread = readStructuredQuoteRun(lines, 0)
  if (!reread || reread.end !== lines.length) return false

  const reparsed = await parseMarkdown(reread.innerMarkdown)
  const [first, ...children] = reparsed
  if (!first || first.type !== 'paragraph' || first.children?.length) return false
  if (children.length === 0) return false

  return serializeQuoteBlock((await serializeBlocks(reparsed)).trim()) === canonical
}

// ---------------------------------------------------------------------------
// youtubeEmbed / bookmark — an image embed whose alt text names the block
// ---------------------------------------------------------------------------

/** A whole line that is nothing but an embed / bookmark marker. */
export const EMBED_LINE_REGEX = /^!\[embed\]\(([^)]+)\)$/
export const BOOKMARK_LINE_REGEX = /^!\[bookmark\]\(([^)]+)\)$/

export function serializeYoutubeEmbed(videoUrl: string): string {
  return `![embed](${videoUrl})`
}

export function serializeBookmark(url: string): string {
  return `![bookmark](${url})`
}

// ---------------------------------------------------------------------------
// file — an HTML comment carrying the props as JSON
// ---------------------------------------------------------------------------

export interface FileBlockProps {
  url: string
  name: string
  size: number
  mimeType: string
  /**
   * User-set display width in px for the inline PDF preview. `0`/undefined means
   * "use the default width" and is omitted from the marker so legacy markers stay
   * byte-for-byte identical on re-save.
   */
  width?: number
  /**
   * User-set crop height in px for the inline PDF preview. `0`/undefined means
   * "fit the first page" (no crop) and is omitted from the marker, so markers
   * that were never height-resized stay byte-for-byte identical on re-save.
   */
  height?: number
  /**
   * Alignment of the embed within the note column. `'left'` is the default and is
   * omitted from the marker so markers that were never aligned stay byte-identical.
   */
  align?: 'left' | 'center' | 'right'
}

/**
 * Regex to match file block markers in markdown
 * Format: <!-- file:{"url":"...","name":"...","size":123,"mimeType":"...","width":720} -->
 */

/** A whole line that is nothing but a file marker. */
export const FILE_BLOCK_LINE_REGEX = /^<!-- file:\{[^}]+\} -->$/

/**
 * Serialize file block props to markdown marker.
 *
 * Keys are written in a fixed order and the default `width`/`height` (0) are
 * dropped, so a block that was never resized produces the exact same marker
 * bytes as before the width/height props existed.
 */
export function serializeFileBlock(props: FileBlockProps): string {
  return `<!--${fileBlockCommentData(props)}-->`
}

/**
 * A comment terminator anywhere in the payload closes the marker early,
 * splitting it and spilling the rest into the note as a paragraph. A file
 * named `a-->b.pdf` is enough.
 *
 * HTML ends a comment on `-->` AND on `--!>` (the spec's comment-end-bang
 * state), so both are escaped. Only the `>` is replaced: escaping every `--`
 * would change the bytes of every marker whose filename contains one, and
 * write-back byte-compares. `\u003e` is JSON-equivalent, so `JSON.parse`
 * returns the original string unchanged.
 */
function escapeCommentTerminator(json: string): string {
  return json.replace(/--(!?)>/g, '--$1\\u003e')
}

/**
 * The marker's comment data — everything between `<!--` and `-->`, spaces
 * included. The main process needs this half on its own: its headless spec
 * builds a real DOM comment node, which is the only shape BlockNote's
 * HTML→markdown step passes through to the vault file untouched.
 */
export function fileBlockCommentData(props: FileBlockProps): string {
  const payload: FileBlockProps = {
    url: props.url,
    name: props.name,
    size: props.size,
    mimeType: props.mimeType
  }
  if (typeof props.width === 'number' && props.width > 0) {
    payload.width = props.width
  }
  if (typeof props.height === 'number' && props.height > 0) {
    payload.height = props.height
  }
  if (props.align && props.align !== 'left') {
    payload.align = props.align
  }
  return ` file:${escapeCommentTerminator(JSON.stringify(payload))} `
}

/**
 * Parse file block marker from markdown
 */
export function parseFileBlockMarker(marker: string): FileBlockProps | null {
  // Anchored: every caller passes one already-trimmed marker line, and leaving
  // it unanchored made the scan quadratic in the line's length — `<!-- file:{`
  // repeated a few thousand times is a note body, i.e. attacker-reachable
  // through sync. Measured 24ms at 2k repetitions, 392ms at 8k.
  const match = marker.match(/^<!-- file:(\{[^}]+\}) -->$/)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// toggleListItem — `<details data-memry-toggle>` wrapping a `<summary>` and the
// collapsed body
// ---------------------------------------------------------------------------

/**
 * BlockNote's own HTML export writes a toggle as a plain `<li>`, so markdown
 * gets it back as a bullet and the fold — plus every block nested under it —
 * is gone on the next open (#1643). This is the form that survives instead.
 *
 * `<details>`/`<summary>` is valid HTML inside GFM, so GitHub and Obsidian
 * render the note as a real collapsible section rather than as markup.
 *
 * The `data-memry-toggle` attribute is what makes the block OURS. A bare
 * `<details>` block written by hand in Obsidian is left as the author wrote it:
 * claiming it would run its body through BlockNote's markdown parser, and
 * anything that parser cannot represent comes back different — write-back
 * byte-compares, so that difference is a rewrite of a file Memry never wrote.
 * Renderers ignore the unknown attribute, so nothing is lost by carrying it.
 */
export const TOGGLE_OPEN_LINE = '<details data-memry-toggle>'
/**
 * An expanded toggle. `open` is HTML's own attribute, so GitHub and Obsidian
 * render the section unfolded too. It is written only when the toggle IS open:
 * collapsed is the default on both sides, and omitting the attribute is what
 * keeps every toggle already on disk byte-identical on its next save.
 */
export const TOGGLE_OPEN_LINE_EXPANDED = '<details data-memry-toggle open>'
export const TOGGLE_CLOSE_LINE = '</details>'

/** Only a `<details>` carrying our attribute, alone on its line, is a toggle. */
const TOGGLE_OPEN_LINE_REGEX = /^<details\s+data-memry-toggle(\s+open)?>$/
/** Any `<details>` open tag — used for depth only, so a foreign one nested in a
 * toggle body cannot close the toggle early. */
const DETAILS_OPEN_LINE_REGEX = /^<details(?:\s[^>]*)?>$/
const TOGGLE_SUMMARY_LINE_REGEX = /^<summary>(.*)<\/summary>$/

export interface ToggleBlockSegment {
  kind: 'toggle'
  /** Inline markdown of the toggle's own line — the part that stays visible. */
  summary: string
  /** Markdown of the blocks nested under it; `''` for an empty toggle. */
  body: string
  /** Whether the open tag carried `open`, i.e. the toggle was left expanded. */
  open: boolean
  /** A `<!-- colors:{…} -->` line that preceded the block, verbatim, or null. */
  colorsMarker: string | null
}

export interface ToggleMarkdownSegment {
  kind: 'markdown'
  text: string
}

/**
 * Blank lines at the seam between two segments, in the same `extraLines`
 * currency `splitMarkdownPreservingBlanks` uses inside one: the count BEYOND
 * the single blank line that separates any two blocks. Callers turn it into
 * that many empty paragraphs, exactly as they already do for a gap the
 * blank-line scanner finds mid-segment.
 */
export interface ToggleGapSegment {
  kind: 'gap'
  extraLines: number
}

export type ToggleContentSegment = ToggleBlockSegment | ToggleMarkdownSegment | ToggleGapSegment

export function serializeToggleBlock(
  summaryMarkdown: string,
  bodyMarkdown: string,
  colorsMarker?: string | null,
  open?: boolean
): string {
  // `<summary>` closes on its own line, so a soft break inside the toggle's own
  // content would split the tag and stop the block from parsing back at all.
  //
  // Split/trim/join rather than `/\s*\n\s*/g`: that pattern is quadratic in a
  // run of whitespace that never reaches a newline (`\s*` matches greedily at
  // every start position, then backtracks to fail), and a toggle summary is note
  // content — i.e. attacker-reachable through sync. Same reasoning as the
  // anchored marker match in `parseFileBlockMarker`.
  const summary = summaryMarkdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
  const body = bodyMarkdown.trim()

  const lines = [
    open ? TOGGLE_OPEN_LINE_EXPANDED : TOGGLE_OPEN_LINE,
    `<summary>${summary}</summary>`
  ]
  // The blank lines are not cosmetic: without them CommonMark reads the body as
  // part of the raw HTML block and GitHub/Obsidian render it unformatted.
  if (body) lines.push('', body, '')
  lines.push(TOGGLE_CLOSE_LINE)

  const block = lines.join('\n')
  return colorsMarker ? `${colorsMarker}\n${block}` : block
}

/**
 * The three whole-line shapes `<details>` markup takes on disk. Matched against
 * the raw line, never a trimmed one: an indented `<details>` is inside a code
 * block or a list item, and those bytes are not this function's to touch.
 */
const DETAILS_MARKUP_LINE_REGEX = /^(?:<details(?:\s[^>]*)?>|<summary>.*<\/summary>|<\/details>)$/

/**
 * Escape a `<details>` markup line that no toggle claimed, so CommonMark reads
 * it as text rather than as a raw HTML block.
 *
 * BlockNote's markdown parser has no block for raw HTML and drops it, which is
 * how an unterminated toggle lost its open and summary lines on the next
 * write-back (#1883) — and how a hand-written Obsidian `<details>` lost all
 * three, despite the promise above that it is left as its author wrote it.
 * Escaped, the line parses as an ordinary paragraph and remark writes the
 * backslash back out as nothing, so the author's bytes survive every save.
 *
 * Every `<` on the line is escaped, not just the leading one: a
 * `<summary>x</summary>` whose closing tag stays raw loses that tag to the same
 * parser and comes back as `<summary>x`.
 */
function escapeDetailsMarkup(line: string): string {
  return DETAILS_MARKUP_LINE_REGEX.test(line) ? line.replace(/</g, '\\<') : line
}

/**
 * Split markdown into toggle regions and everything between them.
 *
 * Callers parse the `markdown` segments however they normally would, rebuild a
 * `toggleListItem` from each toggle segment (recursing into `body` with the
 * same parser), and emit `extraLines` empty paragraphs for each gap segment.
 * Splitting has to happen BEFORE the blank-line and marker-line scanners: those
 * work line by line and would shred a toggle body apart at its own paragraph
 * gaps. Which is also why the gaps at a toggle's own edges are this function's
 * to carry — nothing downstream ever sees them (#1877).
 *
 * An unterminated `<details data-memry-toggle>` stays markdown. Swallowing the
 * rest of the note into a block the author never closed loses more than it
 * saves. Its lines are escaped on the way into that markdown, which is what
 * makes the decline actually preserve them (see `escapeDetailsMarkup`).
 */
export function splitMarkdownByToggles(markdown: string): ToggleContentSegment[] {
  const lines = markdown.split('\n')
  const segments: ToggleContentSegment[] = []
  const fence = createFenceTracker()
  let buffer: string[] = []

  /**
   * One blank line is the standard paragraph break `assembleMarkdownWithBlanks`
   * writes back on its own, so only the lines beyond it need carrying.
   *
   * A gap before the FIRST segment is dropped rather than carried. Assembly
   * writes a gap as `\n\n` plus its extra lines whether or not a segment
   * precedes it, so with nothing in front that `\n\n` is not a separator being
   * extended — it is two more blank lines. Measured: three leading blank lines
   * come back as four, and four as five, growing on every save. Leading blank
   * lines therefore stay trimmed, exactly as they were before gaps existed.
   */
  const pushGap = (blankLines: number): void => {
    if (segments.length > 0 && blankLines > 1) {
      segments.push({ kind: 'gap', extraLines: blankLines - 1 })
    }
  }

  /**
   * Flush the pending markdown. Before a toggle, a trailing `<!-- colors:{…} -->`
   * is handed back instead of flushed: the marker applies to the block that
   * follows it, and that block is about to become a segment of its own.
   */
  const flushMarkdown = (popColorsMarker: boolean): string | null => {
    let marker: string | null = null

    if (popColorsMarker) {
      // Scan back over the trailing blanks instead of popping them: they are
      // the user's gap against the toggle that follows, and discarding them
      // here was half of what collapsed it (#1877). Only the marker leaves.
      let candidate = buffer.length - 1
      while (candidate >= 0 && !buffer[candidate].trim()) candidate--
      const last = buffer[candidate]?.trim()
      if (last && BLOCK_COLORS_LINE_REGEX.test(last)) {
        marker = last
        buffer.splice(candidate, 1)
      }
    }

    // The blank lines at each end of the buffer are the user's spacing against
    // whatever segment sits on that side, and `.trim()` used to eat them
    // (#1877). Split off as gaps instead; a buffer that is nothing BUT blanks
    // is a single seam between two toggles, counted once.
    let first = 0
    while (first < buffer.length && buffer[first].trim() === '') first++
    let afterLast = buffer.length
    while (afterLast > first && buffer[afterLast - 1].trim() === '') afterLast--

    const text = buffer.slice(first, afterLast).join('\n').trim()
    if (text) {
      pushGap(first)
      segments.push({ kind: 'markdown', text })
      pushGap(buffer.length - afterLast)
    } else {
      pushGap(buffer.length)
    }

    buffer = []
    return marker
  }

  for (let i = 0; i < lines.length; i++) {
    const insideFence = fence.consume(lines[i])
    const openMatch = insideFence ? null : lines[i].trim().match(TOGGLE_OPEN_LINE_REGEX)
    const region = openMatch ? readToggleRegion(lines, i, Boolean(openMatch[1])) : null

    if (!region) {
      buffer.push(insideFence ? lines[i] : escapeDetailsMarkup(lines[i]))
      continue
    }

    const colorsMarker = flushMarkdown(true)
    segments.push({
      kind: 'toggle',
      summary: region.summary,
      body: region.body,
      open: region.open,
      colorsMarker
    })
    // The region's own lines never reach the outer fence tracker, which is
    // correct: they belong to the toggle, not to the markdown around it.
    i = region.endIndex
  }

  flushMarkdown(false)
  return segments
}

function readToggleRegion(
  lines: readonly string[],
  openIndex: number,
  open: boolean
): { summary: string; body: string; open: boolean; endIndex: number } | null {
  const summaryMatch = lines[openIndex + 1]?.trim().match(TOGGLE_SUMMARY_LINE_REGEX)
  if (!summaryMatch) return null

  const fence = createFenceTracker()
  const body: string[] = []
  let depth = 1

  for (let i = openIndex + 2; i < lines.length; i++) {
    const line = lines[i]
    if (!fence.consume(line)) {
      const trimmed = line.trim()
      if (DETAILS_OPEN_LINE_REGEX.test(trimmed)) {
        depth++
      } else if (trimmed === TOGGLE_CLOSE_LINE) {
        depth--
        if (depth === 0) {
          return {
            summary: summaryMatch[1].trim(),
            body: body.join('\n').trim(),
            open,
            endIndex: i
          }
        }
      }
    }
    body.push(line)
  }

  return null
}
