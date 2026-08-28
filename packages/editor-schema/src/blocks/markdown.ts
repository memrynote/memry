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

export type ToggleContentSegment = ToggleBlockSegment | ToggleMarkdownSegment

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
 * Split markdown into toggle regions and everything between them.
 *
 * Callers parse the `markdown` segments however they normally would and rebuild
 * a `toggleListItem` from each toggle segment, recursing into `body` with the
 * same parser. Splitting has to happen BEFORE the blank-line and marker-line
 * scanners: those work line by line and would shred a toggle body apart at its
 * own paragraph gaps.
 *
 * An unterminated `<details data-memry-toggle>` stays markdown. Swallowing the
 * rest of the note into a block the author never closed loses more than it
 * saves.
 */
export function splitMarkdownByToggles(markdown: string): ToggleContentSegment[] {
  const lines = markdown.split('\n')
  const segments: ToggleContentSegment[] = []
  const fence = createFenceTracker()
  let buffer: string[] = []

  /**
   * Flush the pending markdown. Before a toggle, a trailing `<!-- colors:{…} -->`
   * is handed back instead of flushed: the marker applies to the block that
   * follows it, and that block is about to become a segment of its own.
   */
  const flushMarkdown = (popColorsMarker: boolean): string | null => {
    let marker: string | null = null

    if (popColorsMarker) {
      while (buffer.length > 0 && !buffer[buffer.length - 1].trim()) buffer.pop()
      const last = buffer[buffer.length - 1]?.trim()
      if (last && BLOCK_COLORS_LINE_REGEX.test(last)) {
        marker = last
        buffer.pop()
      }
    }

    const text = buffer.join('\n').trim()
    if (text) segments.push({ kind: 'markdown', text })
    buffer = []
    return marker
  }

  for (let i = 0; i < lines.length; i++) {
    const insideFence = fence.consume(lines[i])
    const openMatch = insideFence ? null : lines[i].trim().match(TOGGLE_OPEN_LINE_REGEX)
    const region = openMatch ? readToggleRegion(lines, i, Boolean(openMatch[1])) : null

    if (!region) {
      buffer.push(lines[i])
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
