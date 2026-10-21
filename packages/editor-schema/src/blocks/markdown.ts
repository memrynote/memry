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
import { extractYouTubeVideoId } from '@memry/shared/youtube'
import { itemHoldsNonList, readStructuredQuoteRun, serializeQuoteBlock } from './quote.ts'

// ---------------------------------------------------------------------------
// callout — `> [!type]` followed by the content, one `> ` per line
// ---------------------------------------------------------------------------

/**
 * The first four are the original types. The rest use the common Markdown
 * callout names, so an imported `> [!note]` reads as a callout here too. The `type` prop
 * is a free string in the CRDT, and builds before these types render an
 * unknown one as `info` and write it back unchanged.
 */
export const CALLOUT_TYPE_VALUES = [
  'info',
  'warning',
  'error',
  'success',
  'note',
  'abstract',
  'todo',
  'tip',
  'important',
  'question',
  'example',
  'quote',
  'bug'
] as const

export type CalloutTypeValue = (typeof CALLOUT_TYPE_VALUES)[number]

/**
 * Exactly the marker `serializeCalloutBlock` writes: one Memry type in
 * lowercase, nothing after the `]`. `> [!NOTE]`, `> [!danger]` and
 * `> [!info] A title` are NOT this. Claiming them would rewrite bytes
 * `serializeCalloutBlock` cannot reproduce.
 */
const MEMRY_CALLOUT_MARKER_REGEX = new RegExp(`^> \\[!(${CALLOUT_TYPE_VALUES.join('|')})\\]$`)

/**
 * The damaged form #1846 heals: the marker alone on its line, its `> ` prefix
 * already lost. Healed only at a paragraph start with the body directly below
 * — a lone `[!info]` with nothing under it stays the author's text. Only the
 * original four types: those are the ones the #1846 damage hit, and a bare
 * `[!note]` line is ordinary text someone typed.
 */
const BARE_CALLOUT_MARKER_REGEX = /^\[!(info|warning|error|success)\]$/

/**
 * `contentMarkdown` is the callout's own line followed by its child blocks,
 * separated by blank lines; each blank line becomes a bare `>`, the same inner
 * shape `serializeQuoteBlock` writes for a quote that owns children (#3186).
 * A callout without children has no blank line, so its bytes are unchanged.
 */
export function serializeCalloutBlock(type: string, contentMarkdown: string): string {
  const body = contentMarkdown.replace(/^\n+|\n+$/g, '')
  if (body === '') return `> [!${type}]`
  return `> [!${type}]\n${serializeQuoteBlock(body)}`
}

export interface CalloutRun {
  type: CalloutTypeValue
  /** Body lines with the `> ` prefix stripped; verbatim for a bare run. */
  contentLines: string[]
  /** The run's original lines, verbatim, for fallback parsing on decline. */
  raw: string
  /** Index of the first line after the run. */
  end: number
  /** The damaged shape #1846 heals: marker without its `> `. */
  bare: boolean
  /**
   * The body holds a list or a `> >` level. Declining it is not free: the quote
   * fallback drops the list markers or the nesting, so a one-step
   * normalization that settles is claimed instead (same rule as
   * `resolveQuoteRun`).
   */
  reshapes: boolean
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
    // A body with a blank `>` line, a list or a `> >` level is read the way a
    // structured quote is, lazy list continuations included (BBF-110), so it
    // can become the callout's child blocks (#3186).
    const structured = readStructuredQuoteRun(lines, start + 1)
    if (structured) {
      return {
        type: quoted[1] as CalloutTypeValue,
        contentLines: structured.innerMarkdown.split('\n'),
        raw: lines.slice(start, structured.end).join('\n'),
        end: structured.end,
        bare: false,
        reshapes: structured.listed || structured.nested
      }
    }
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
      end,
      bare: false,
      reshapes: false
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
      end,
      bare: true,
      reshapes: false
    }
  }

  return null
}

export interface ParsedBlockShape {
  type?: unknown
  content?: unknown
  children?: unknown[]
}

export interface ResolvedCallout {
  type: CalloutTypeValue
  content: unknown
  children: ParsedBlockShape[]
}

/**
 * Decide whether a run may become a callout block, by proof rather than by
 * pattern: parse the body, and claim only if serializing it back reproduces
 * the body byte-for-byte (so `serializeCalloutBlock` reproduces the whole run
 * on the way out). A leading paragraph is the callout's own line and every
 * later block a child; a body that opens on another block (a list, a heading)
 * has an empty own line (#3186).
 *
 * A body with a list or a `> >` level may also claim when its canonical form
 * settles, because the quote fallback would drop the markers or the nesting.
 * A bare damaged run heals only into a single paragraph, as before. A
 * checkbox in the body stays a checkbox: the editor never promotes one inside
 * a callout or a quote to a task, so claiming writes no task id (#3192).
 */
export async function resolveCalloutRun(
  run: CalloutRun,
  parseMarkdown: (markdown: string) => Promise<ParsedBlockShape[]>,
  serializeBlocks: (blocks: ParsedBlockShape[]) => Promise<string>
): Promise<ResolvedCallout | null> {
  const content = run.contentLines.join('\n')
  if (content === '') return { type: run.type, content: [], children: [] }

  const body = await parseCalloutBody(content, parseMarkdown, serializeBlocks)
  if (!body) return null
  if (run.bare && body.children.length > 0) return null
  if (body.markdown !== content) {
    if (!run.reshapes) return null
    const canonical = serializeCalloutBlock(run.type, body.markdown)
    if (!(await calloutSettles(canonical, parseMarkdown, serializeBlocks))) return null
  }

  return { type: run.type, content: body.content, children: body.children }
}

async function parseCalloutBody(
  content: string,
  parseMarkdown: (markdown: string) => Promise<ParsedBlockShape[]>,
  serializeBlocks: (blocks: ParsedBlockShape[]) => Promise<string>
): Promise<{ content: unknown; children: ParsedBlockShape[]; markdown: string } | null> {
  const parsed = await parseMarkdown(content)
  const [first, ...rest] = parsed
  if (!first || parsed.some(itemHoldsNonList)) return null
  const ownLine = first.type === 'paragraph'
  if (ownLine && first.children?.length) return null

  return {
    content: ownLine ? (first.content ?? []) : [],
    children: ownLine ? rest : parsed,
    markdown: (await serializeBlocks(parsed)).trim()
  }
}

/**
 * Whether `canonical` is a fixed point: it reads back as one whole callout
 * run, and re-parsing its body reproduces it, so the file stops moving after
 * the first write.
 */
async function calloutSettles(
  canonical: string,
  parseMarkdown: (markdown: string) => Promise<ParsedBlockShape[]>,
  serializeBlocks: (blocks: ParsedBlockShape[]) => Promise<string>
): Promise<boolean> {
  const lines = canonical.split('\n')
  const reread = readCalloutRun(lines, 0, true)
  if (!reread || reread.end !== lines.length) return false
  const content = reread.contentLines.join('\n')
  const body = await parseCalloutBody(content, parseMarkdown, serializeBlocks)
  return body?.markdown === content
}

// ---------------------------------------------------------------------------
// youtubeEmbed / bookmark — an image embed whose alt text names the block
// ---------------------------------------------------------------------------

/** A whole line that is nothing but a bookmark marker. */
export const BOOKMARK_LINE_REGEX = /^!\[bookmark\]\(([^)]+)\)$/

/** The alt text Memry itself writes, and the `alt` prop's default. */
export const YOUTUBE_EMBED_DEFAULT_ALT = 'embed'

/** A whole line that is nothing but `![alt](url)`, with any alt text. */
const IMAGE_LINE_REGEX = /^!\[([^\]\n]*)\]\(([^)\s]+)\)$/

/** Alt texts that name another marker block; never a YouTube embed. */
const RESERVED_IMAGE_ALTS = new Set(['bookmark', 'whiteboard'])

export interface YoutubeEmbedLine {
  videoId: string
  videoUrl: string
  alt: string
}

/**
 * A whole line `![alt](youtube-url)`, with any alt text, as a YouTube embed.
 *
 * Obsidian and other markdown apps embed a YouTube video from an image line
 * whatever its alt text says (`![](…)`, `![Embedded YouTube video](…)`). Only
 * `![embed](…)` used to be claimed, so those lines came in as image blocks
 * pointing at a web page and rendered as broken images. The alt is kept so
 * the line writes back byte-for-byte and still opens in the app that wrote it.
 */
export function parseYoutubeEmbedLine(line: string): YoutubeEmbedLine | null {
  const match = line.match(IMAGE_LINE_REGEX)
  if (!match) return null
  const [, alt, videoUrl] = match
  if (RESERVED_IMAGE_ALTS.has(alt)) return null
  const videoId = extractYouTubeVideoId(videoUrl)
  return videoId ? { videoId, videoUrl, alt } : null
}

export function serializeYoutubeEmbed(
  videoUrl: string,
  alt: string = YOUTUBE_EMBED_DEFAULT_ALT
): string {
  return `![${alt}](${videoUrl})`
}

export function serializeBookmark(url: string): string {
  return `![bookmark](${url})`
}

// ---------------------------------------------------------------------------
// whiteboard — the same image-embed shape, pointing at the canvas by id
// ---------------------------------------------------------------------------

/**
 * `memry://canvas/<id>` is the link every other surface already opens a canvas
 * from, so a whiteboard line pasted as a link still resolves. By id, not by
 * title: a rename must not break every note the board is embedded in.
 */
export const WHITEBOARD_LINE_REGEX = /^!\[whiteboard\]\(memry:\/\/canvas\/([A-Za-z0-9_-]+)\)$/

export function serializeWhiteboard(canvasId: string): string {
  return `![whiteboard](${whiteboardUrl(canvasId)})`
}

export function whiteboardUrl(canvasId: string): string {
  return `memry://canvas/${canvasId}`
}

/** The canvas id a whole-line whiteboard marker points at, or null. */
export function parseWhiteboardLine(line: string): string | null {
  return line.match(WHITEBOARD_LINE_REGEX)?.[1] ?? null
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
  /**
   * `'link'` shows a PDF as its file name instead of the inline viewer.
   * `'embed'` is the default and is omitted from the marker, so markers that
   * never chose a mode (every marker an older build wrote) stay byte-identical.
   */
  display?: 'embed' | 'link'
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
  if (props.display === 'link') {
    payload.display = 'link'
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
    const props: FileBlockProps = JSON.parse(match[1])
    // The prop's only non-default value is `link`. Anything else a hand-edited
    // or newer file carries reads as the default viewer, never as an
    // out-of-range value the block's propSchema would reject.
    if (props.display !== 'link') delete props.display
    return props
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// mathBlock — a `$$` fence around the LaTeX source
// ---------------------------------------------------------------------------

/**
 * The fence line. `$$` on a line of its own is the block form Obsidian, Pandoc
 * and GitHub all read, so a formula written here is a formula there — which is
 * the whole reason the source and not a rendering is what reaches the file.
 */
const MATH_FENCE_LINE = '$$'

/**
 * `$$` / source / `$$`, with the body's blank lines dropped.
 *
 * Dropping them is not cosmetic. Every parse in both pipelines splits on blank
 * lines BEFORE any block reader runs (`splitMarkdownPreservingBlanks`), so a
 * body carrying one arrives as two fragments and no reader can claim the run:
 * the block would come back as literal `$$` text on the next open. A blank line
 * is also invalid inside LaTeX math mode, so nothing a formula can mean is lost
 * by refusing to write one.
 */
export function serializeMathBlock(latex: string): string {
  const body = latex
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join('\n')
  return body
    ? `${MATH_FENCE_LINE}\n${body}\n${MATH_FENCE_LINE}`
    : `${MATH_FENCE_LINE}\n${MATH_FENCE_LINE}`
}

export interface MathRun {
  /** The formula source, verbatim between the fences. */
  latex: string
  /** The run's original lines, for the caller that declines it. */
  raw: string
  /** Index of the first line after the run. */
  end: number
}

/**
 * Read one math run starting at `lines[start]`, or null.
 *
 * Claimed by proof, the same rule `resolveCalloutRun` applies: the run becomes
 * a block only when `serializeMathBlock` writes those exact bytes back. So the
 * only shape claimed is the one Memry writes, and `$$ x $$` on one line, an
 * indented `$$` inside a list item, a fence with trailing spaces, or a body
 * carrying a blank line all stay the author's markdown — which matters because
 * `$$` is somebody else's notation too, and write-back byte-compares.
 *
 * An unterminated `$$` is refused whole rather than swallowing the rest of the
 * note, exactly as an unterminated `<details>` is.
 *
 * The run must also OWN its paragraph, at both ends. A fence that starts or
 * stops mid-paragraph belongs to that paragraph's bytes, and claiming it would
 * split one paragraph into two blocks — which the write-back rejoins with a
 * blank line between them, rewriting a file Memry never wrote.
 */
export function readMathRun(
  lines: readonly string[],
  start: number,
  atParagraphStart: boolean
): MathRun | null {
  if (!atParagraphStart) return null
  if (lines[start] !== MATH_FENCE_LINE) return null

  let end = start + 1
  while (end < lines.length && lines[end] !== MATH_FENCE_LINE) end++
  if (end >= lines.length) return null
  if (end + 1 < lines.length && lines[end + 1].trim() !== '') return null

  const raw = lines.slice(start, end + 1).join('\n')
  const latex = lines.slice(start + 1, end).join('\n')
  if (serializeMathBlock(latex) !== raw) return null

  return { latex, raw, end: end + 1 }
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
 * The `<` of a declined `<details>` line, while it crosses the parser.
 *
 * A markdown backslash escape used to do this job: `\<details>` parsed to the
 * text `<details>` and the serializer wrote it back bare. BlockNote 0.51's
 * parser does not implement `\<` — measured, it keeps the backslash in the
 * text and reads the rest of the line as raw HTML, so
 * `\<details data-memry-toggle>` came back as a paragraph holding a lone
 * backslash with the markup gone. Escaping the `>` too got the line through
 * intact but kept the backslash, writing `\<details …>` into the vault.
 *
 * So the `<` travels as a token instead, the same shape as the hard-break mask
 * in `empty-lines.ts`: ordinary text to any parser, restored once the blocks
 * exist. Nothing needs escaping on the way out — a text node holding
 * `<details>` serializes to `<details>` bare.
 */
const DETAILS_LT_TOKEN = 'MEMRYDLT;'

/**
 * Hide the `<` of a `<details>` markup line that no toggle claimed, so the
 * parser reads the line as text rather than dropping it as a raw HTML block.
 *
 * BlockNote's markdown parser has no block for raw HTML and drops it, which is
 * how an unterminated toggle lost its open and summary lines on the next
 * write-back (#1883) — and how a hand-written Obsidian `<details>` lost all
 * three, despite the promise above that it is left as its author wrote it.
 *
 * Every `<` on the line is hidden, not just the leading one: a
 * `<summary>x</summary>` whose closing tag stays raw loses that tag to the same
 * parser and comes back as `<summary>x`.
 *
 * The author's own backslashes are left exactly as written. The old escape had
 * to double them so a `\` already in front of a `<` could not pair with the
 * backslash being added; nothing is added now, so there is nothing to pair
 * with and `<summary>C:\<path></summary>` survives as its author wrote it.
 */
function escapeDetailsMarkup(line: string): string {
  if (!DETAILS_MARKUP_LINE_REGEX.test(line)) return line
  return line.split('<').join(DETAILS_LT_TOKEN)
}

/**
 * Put back every `<` that `escapeDetailsMarkup` hid, for one inline text run.
 *
 * Callers apply this to the blocks their parse produced. A token that reaches
 * a block unrestored is written into the user's file as literal text, so this
 * runs over every parsed run rather than only the ones expected to carry one.
 */
export function restoreDetailsMarkup(text: string): string {
  return text.includes(DETAILS_LT_TOKEN) ? text.split(DETAILS_LT_TOKEN).join('<') : text
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
