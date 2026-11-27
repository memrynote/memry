import { parseBlockColorsMarker } from '@memry/shared/block-colors'
import {
  type MarkedBlock,
  type SidecarPatch,
  parseSidecarMarkerLine
} from '@memry/shared/block-markers'
import {
  type BlockWithChildren,
  foldBlockNestingMarkers,
  isBlockNestingMarker,
  parseMarkdownWithNestingMarkers
} from '@memry/shared/block-nesting'
import { separateBlockImages, splitMarkdownPreservingBlanks } from '@memry/shared/empty-lines'
import { applyInlineColorTokens, maskInlineColorSpans } from '@memry/shared/inline-colors'
import { decodeHtmlCommentTokens, hasHtmlCommentToken } from '@memry/shared/html-comments'
import { createFenceTracker } from '@memry/shared/markdown-fences'
import {
  BOOKMARK_LINE_REGEX,
  FILE_BLOCK_LINE_REGEX,
  parseFileBlockMarker,
  parseWhiteboardLine,
  parseYoutubeEmbedLine,
  readCalloutRun,
  readMathRun,
  resolveCalloutRun,
  splitMarkdownByToggles,
  type ToggleBlockSegment
} from './blocks/markdown'
import { buildColumnListBlock, splitMarkdownByColumnRegions } from './blocks/columns'
import { readStructuredQuoteRun, resolveQuoteRun } from './blocks/quote'

/**
 * Markdown to the document a note holds, for both processes.
 *
 * Main seeds a note's shared Y.Doc from the vault file and the renderer parses
 * the same bytes for paste, templates and notes opened without a live doc. Two
 * hand-kept copies of this pipeline drifted (a callout under an image, `$$`
 * under a callout, a file marker inside a fence), so the same markdown opened
 * as two different documents depending on which process read it. It lives here,
 * once; each process supplies only what differs, the BlockNote editor it parses
 * and serializes with.
 */
export interface NoteMarkdownHost<B> {
  /** Markdown to blocks through the host's editor, with BlockNote's repairs applied. */
  parse(markdown: string): Promise<B[]>
  serialize(blocks: B[]): Promise<string>
}

type NoteBlock<B> = BlockWithChildren<B> & object

/**
 * `markdown` is what the host has left after masking HTML comments and
 * resolving wiki image embeds. Returns the note's blocks, custom blocks and
 * empty paragraphs included.
 */
export async function parseNoteMarkdown<B extends NoteBlock<B>>(
  host: NoteMarkdownHost<B>,
  markdown: string
): Promise<B[]> {
  // Inline color spans are masked into markdown-inert tokens before parsing
  // (BlockNote strips raw spans), then re-applied as styles on the parsed runs.
  const { text, spans } = maskInlineColorSpans(separateBlockImages(markdown))
  const blocks = await parseMaskedMarkdown(host, text)

  const colored = applyInlineColorTokens(blocks, spans)
  const tokened = hasHtmlCommentToken(JSON.stringify(colored) ?? '')
  return asBlocks<B>(tokened ? withCommentBytes(colored) : colored)
}

/**
 * `value` with every HTML comment token left in it turned back into the
 * comment's bytes. The parse turns the tokens in text into `htmlComment`
 * nodes, but a comment inside an image's alt or address, a link's address or
 * a `$$` block lands in a prop. The token's word is drawn per process, so one
 * left there reached the shared doc as text no other process can decode, and
 * a `$$` block wrote it into the vault.
 */
function withCommentBytes(value: unknown): unknown {
  if (typeof value === 'string') return decodeHtmlCommentTokens(value)
  if (Array.isArray(value)) return value.map(withCommentBytes)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, withCommentBytes(inner)])
  )
}

// BlockNote's `Block` is a union keyed on the schema's block types, with
// `props` keyed per type, and this package cannot name the host's schema, so
// no literal built below is assignable to the host's block type. Every block
// built here has the fields its `type` declares in `./blocks/*-specs`; the
// parity tests against the real schemas are what check them.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- B names the caller's block type, which only the return position can carry
function asBlock<B>(literal: unknown): B {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- B is the host's block type, which this package cannot name without its schema
  return literal as B
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- B names the caller's block type, which only the return position can carry
function asBlocks<B>(blocks: unknown): B[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- B is the host's block type, which this package cannot name without its schema
  return blocks as B[]
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- B names the caller's block type, which only the return position can carry
function createEmptyParagraph<B>(): B {
  return asBlock({
    type: 'paragraph',
    content: [],
    children: [],
    id: crypto.randomUUID(),
    props: {}
  })
}

/**
 * Toggle regions come off FIRST, before the blank-line and marker-line
 * scanners: those read one line at a time and would shred a toggle body apart
 * at its own paragraph gaps. Each body re-enters this function, so a toggle
 * nested inside a toggle works at any depth, images and all.
 */
async function parseMaskedMarkdown<B extends NoteBlock<B>>(
  host: NoteMarkdownHost<B>,
  markdown: string,
  insideColumn = false
): Promise<B[]> {
  // Column regions come off before toggles: a column holds toggles, blank
  // lines and fences of its own. A column cannot hold another column list,
  // and MCM does not nest regions either, so a column body is read without
  // this step.
  if (insideColumn) return parseMarkdownWithToggles(host, markdown)

  const blocks: B[] = []
  for (const segment of splitMarkdownByColumnRegions(markdown)) {
    if (segment.kind === 'columns') {
      blocks.push(
        await buildColumnListBlock<B>(
          segment,
          (body) => parseMaskedMarkdown(host, body, true),
          createEmptyParagraph<B>,
          () => crypto.randomUUID()
        )
      )
    } else if (segment.kind === 'gap') {
      for (let i = 0; i < segment.extraLines; i++) blocks.push(createEmptyParagraph<B>())
    } else {
      blocks.push(...(await parseMarkdownWithToggles(host, segment.text)))
    }
  }
  return blocks
}

async function parseMarkdownWithToggles<B extends NoteBlock<B>>(
  host: NoteMarkdownHost<B>,
  markdown: string
): Promise<B[]> {
  const blocks: B[] = []

  for (const segment of splitMarkdownByToggles(markdown)) {
    if (segment.kind === 'toggle') {
      blocks.push(await parseToggleSegment(host, segment))
    } else if (segment.kind === 'gap') {
      // Blank lines the user left at a toggle's edge. Same currency, and the
      // same empty paragraphs, as a gap the blank-line scanner finds inside a
      // markdown segment (#1877).
      for (let i = 0; i < segment.extraLines; i++) {
        blocks.push(createEmptyParagraph<B>())
      }
    } else {
      blocks.push(...(await parseMarkdownWithoutToggles(host, segment.text)))
    }
  }

  return blocks
}

async function parseToggleSegment<B extends NoteBlock<B>>(
  host: NoteMarkdownHost<B>,
  segment: ToggleBlockSegment
): Promise<B> {
  const parsedSummary = await host.parse(segment.summary)
  const colors = segment.colorsMarker ? parseBlockColorsMarker(segment.colorsMarker) : null

  // `toggleListItem` as its spec declares it: block colours plus `open`,
  // summary as inline content, body as children.
  return asBlock({
    type: 'toggleListItem',
    id: crypto.randomUUID(),
    props: { ...colors, open: segment.open },
    content: summaryContent(parsedSummary[0]),
    children: segment.body ? await parseMaskedMarkdown(host, segment.body) : []
  })
}

function summaryContent(summary: unknown): unknown {
  return typeof summary === 'object' && summary !== null && 'content' in summary
    ? (summary.content ?? [])
    : []
}

async function parseMarkdownWithoutToggles<B extends NoteBlock<B>>(
  host: NoteMarkdownHost<B>,
  markdown: string
): Promise<B[]> {
  const segments = splitMarkdownPreservingBlanks(markdown)
  const blocks: B[] = []

  for (const seg of segments) {
    if (seg.type === 'content') {
      blocks.push(...(await parseContentWithMarkers(host, seg.text)))
    } else {
      for (let i = 0; i < seg.extraLines; i++) {
        blocks.push(createEmptyParagraph<B>())
      }
    }
  }

  // A nesting marker can sit between blocks different parsers claim (a list
  // item and the callout under it), so levels apply to the whole run (#2365).
  return foldBlockNestingMarkers(blocks)
}

async function parseContentWithMarkers<B extends NoteBlock<B>>(
  host: NoteMarkdownHost<B>,
  text: string
): Promise<B[]> {
  const blocks: B[] = []
  let buffer: string[] = []
  let pending: SidecarPatch[] = []

  const applyPending = (block: B | undefined): void => {
    if (block) {
      // `MarkedBlock` is the `{ type, props }` subset the sidecar patches read
      // and write; every block has both.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- MarkedBlock is a structural subset of every block
      const marked = block as unknown as MarkedBlock
      for (const apply of pending) apply(marked)
    }
    pending = []
  }

  const flushBuffer = async (): Promise<void> => {
    if (buffer.length === 0) return
    const parsed = await parseMarkdownWithNestingMarkers(buffer.join('\n'), (md) => host.parse(md))
    applyPending(parsed.find((block) => !isBlockNestingMarker(block)))
    blocks.push(...parsed)
    buffer = []
  }

  const fence = createFenceTracker()
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    // A marker inside a code fence is the author's text, not a marker.
    const insideFence = fence.consume(line)

    // Callouts are claimed here ONLY in the exact shapes this feature owns —
    // see parseCalloutRunAt. Everything else `> `-prefixed stays a quote block
    // and its bytes stay untouched, which is what keeps `> [!danger]` or a
    // titled callout from another app byte-identical through Memry.
    if (!insideFence) {
      const afterSidecarMarker = buffer.length === 0 && pending.length > 0
      const atParagraphStart = i === 0 || lines[i - 1].trim() === '' || afterSidecarMarker
      const claimed = await parseCalloutRunAt(host, lines, i, atParagraphStart)
      if (claimed) {
        await flushBuffer()
        // `callout` as its spec declares it; `claimed.type` is one of the
        // callout kinds `parseCalloutRunAt` recognises.
        const callout = asBlock<B>({
          type: 'callout',
          props: { type: claimed.type, fold: claimed.fold },
          content: claimed.content,
          children: claimed.children
        })
        applyPending(callout)
        blocks.push(callout)
        for (let consumed = i + 1; consumed < claimed.end; consumed++) {
          fence.consume(lines[consumed])
        }
        i = claimed.end - 1
        continue
      }

      // A `$$` fence claims nothing a callout or a quote could have claimed, so
      // it is read after both. `readMathRun` demands the run own its whole
      // paragraph and re-serialize byte-for-byte, which is what keeps someone
      // else's `$$` notation on the untouched path.
      const math = readMathRun(lines, i, atParagraphStart)
      if (math) {
        await flushBuffer()
        // `mathBlock` as its spec declares it - one string prop.
        const block = asBlock<B>({ type: 'mathBlock', props: { latex: math.latex } })
        applyPending(block)
        blocks.push(block)
        for (let consumed = i + 1; consumed < math.end; consumed++) {
          fence.consume(lines[consumed])
        }
        i = math.end - 1
        continue
      }

      const quoted = atParagraphStart ? await parseQuoteRunAt(host, lines, i) : null
      if (quoted) {
        await flushBuffer()
        // `quote` as its spec declares it, with the run's parsed content and
        // children.
        const quote = asBlock<B>({
          type: 'quote',
          props: {},
          content: quoted.content,
          children: quoted.children
        })
        applyPending(quote)
        blocks.push(quote)
        for (let consumed = i + 1; consumed < quoted.end; consumed++) {
          fence.consume(lines[consumed])
        }
        i = quoted.end - 1
        continue
      }
    }

    // Deliberately NOT fence-guarded: this branch predates custom-block parsing
    // and guarding it would drop a sidecar marker that follows a fence this
    // tracker read differently, which is data loss on a path #1432 never
    // touched.
    const patch = parseSidecarMarkerLine(trimmed)
    if (patch) {
      await flushBuffer()
      pending.push(patch)
      continue
    }

    const marker = insideFence ? null : parseCustomBlockMarkerLine(line)
    if (marker) {
      await flushBuffer()
      pending = []
      blocks.push(asBlock<B>(marker))
      continue
    }

    buffer.push(line)
  }
  await flushBuffer()

  return blocks
}

/**
 * Claim a callout at `lines[i]`, or null to leave the bytes alone.
 *
 * The claim is proven, not pattern-matched: `resolveCalloutRun` re-serializes
 * the body and claims only when `serializeCalloutBlock` would write the run
 * back byte-for-byte. A type outside `CALLOUT_TYPE_VALUES`, a title after the marker, a
 * blank `>` line, a list in the body — all decline and stay quote blocks with
 * their bytes untouched, which is the Obsidian-vault guarantee the old
 * "never parse callouts" rule existed to protect (#1846). What that rule cost
 * was every Memry callout on this path: seeding a doc from the vault file
 * demoted `> [!info]` to a quote block, the editor lost the callout UI, and
 * the marker eventually tore away from its body as plain text.
 *
 * The bare `[!info]`-plus-body shape is the already-torn form of that damage;
 * `readCalloutRun` heals it only at a paragraph start with the body directly
 * below, so a lone `[!info]` someone typed as text stays text.
 */
async function parseCalloutRunAt<B extends NoteBlock<B>>(
  host: NoteMarkdownHost<B>,
  lines: readonly string[],
  i: number,
  atParagraphStart: boolean
): Promise<{
  type: string
  fold: string
  content: unknown
  children: B[]
  end: number
} | null> {
  const run = readCalloutRun(lines, i, atParagraphStart)
  if (!run) return null

  const claimed = await resolveCalloutRun(
    run,
    (md) => host.parse(md),
    (parsed) => host.serialize(asBlocks<B>(parsed))
  )
  if (!claimed) return null

  return {
    type: claimed.type,
    fold: claimed.fold,
    content: claimed.content,
    children: asBlocks<B>(claimed.children),
    end: run.end
  }
}

/**
 * Claim a structured blockquote at `lines[i]`, or null to leave the bytes on
 * BlockNote's own quote path.
 *
 * Only the two shapes BlockNote's flat quote block loses are read (a blank `>`
 * separator, a `> >` nesting level), and even those only when re-serializing
 * the parse reproduces the run byte-for-byte — see `resolveQuoteRun`. The
 * claimed run becomes a quote block that owns its later blocks as children,
 * which `serializeQuote` writes back inside the blockquote.
 *
 * Inner blocks are parsed flat, so a quote nested two levels deep declines and
 * keeps today's behavior rather than round-tripping through a half-applied
 * nesting.
 */
async function parseQuoteRunAt<B extends NoteBlock<B>>(
  host: NoteMarkdownHost<B>,
  lines: readonly string[],
  i: number
): Promise<{ content: unknown; children: B[]; end: number } | null> {
  const run = readStructuredQuoteRun(lines, i)
  if (!run) return null

  const claimed = await resolveQuoteRun(
    run,
    (md) => host.parse(md),
    (parsed) => host.serialize(asBlocks<B>(parsed))
  )
  if (!claimed) return null

  return { content: claimed.content, children: asBlocks<B>(claimed.children), end: run.end }
}

/**
 * The custom blocks whose on-disk form is a single marker line.
 *
 * Without this a marker parses as something else and the block is gone before
 * the editor ever sees it: `<!-- file:{…} -->` is dropped outright (an HTML
 * comment BlockNote has no block for), and the `![…](url)` markers become plain
 * image blocks pointing at a page or a canvas rather than an image.
 *
 * Callouts have no case here because their form spans lines; they are claimed
 * by `parseCalloutRunAt` in the caller's line loop, under the byte-round-trip
 * guard documented there.
 */
function parseCustomBlockMarkerLine(line: string): object | null {
  // Matched exactly as the rule says: `file` on the trimmed line, the three
  // image markers on the raw one. Trimming those as well would claim a marker
  // indented under a list item, dropping the nesting the parent preserved.
  const trimmed = line.trim()
  if (FILE_BLOCK_LINE_REGEX.test(trimmed)) {
    const props = parseFileBlockMarker(trimmed)
    // `parseFileBlockMarker` returns exactly the `file` spec's props.
    if (props) return { type: 'file', props }
  }

  // Any alt text, so another app's `![](youtube-url)` plays instead of
  // rendering as a broken image. A non-YouTube line stays an image.
  const embed = parseYoutubeEmbedLine(line)
  // `youtubeEmbed`'s declared props, all strings.
  if (embed) return { type: 'youtubeEmbed', props: embed }

  const bookmark = line.match(BOOKMARK_LINE_REGEX)
  if (bookmark) {
    const url = bookmark[1]
    // `![bookmark](assets/photo.png)` is someone's image with an unlucky alt
    // text, not a bookmark card. The embed branch checks for a video id
    // for the same reason; this is its counterpart.
    const parsed = parseHttpUrl(url)
    if (parsed) {
      // `bookmark`'s two required props; the rest of its propSchema has
      // defaults and is rehydrated at render time.
      return { type: 'bookmark', props: { url, domain: parsed.hostname.replace(/^www\./, '') } }
    }
  }

  // Only a `memry://canvas/<id>` target is claimed (`WHITEBOARD_LINE_REGEX`),
  // so `![whiteboard](https://…)` stays somebody's image.
  const canvasId = parseWhiteboardLine(line)
  // `whiteboard`'s one declared prop, a string.
  if (canvasId) return { type: 'whiteboard', props: { canvasId } }

  return null
}

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}
