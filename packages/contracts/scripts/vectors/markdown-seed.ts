/**
 * Class: markdown → BlockNote document seed (`markdown-seed.json`), spec
 * 005-journal JP022a.
 *
 * Template markdown in, the `prosemirror` fragment desktop's converter builds
 * from it out, in the canonical fragment form (`../fragment-canonical.ts`,
 * `crdt/canonical.rs` on the Rust side). The Rust port
 * (`crates/memry-core/src/crdt/markdown_seed/`) seeds a journal day on the
 * phone and must build the same document.
 *
 * WHY NOT DESKTOP'S CONVERTER DIRECTLY. `markdownToYFragment` lives in
 * `apps/desktop/src/main/sync/blocknote-converter.ts`, which reaches
 * `electron-log`, the index database and the vault through its imports, and a
 * `packages/contracts` script must not depend on an app (the boundary
 * `record-envelope.ts` records). So this generator runs the same production
 * pieces that function runs, in its order: line endings to `\n`,
 * `separateBlockImages`, `splitMarkdownByToggles` (each toggle's summary and
 * body parsed as `parseToggleSegment` does), `splitMarkdownPreservingBlanks`,
 * `parseContentWithMarkers` (callouts, `$$` math, structured quotes and the
 * one-line file, YouTube, bookmark and whiteboard markers, claimed by the
 * editor-schema readers and resolvers), `parseMarkdownToBlocksRepaired`
 * through a `ServerBlockNoteEditor` on desktop's schema (code block options
 * included), and `blocksToYXmlFragment`. The layers it does not reproduce
 * (CriticMarkup, link references, wiki embeds, colour spans, column regions,
 * HTML comments and sidecar markers, inline tokens, task blocks,
 * plain-checkbox markers) are refused by {@link refuseUnreproduced} rather
 * than skipped. The proof that the result is desktop's is
 * `apps/desktop/src/main/sync/markdown-seed-vectors.test.ts`, which runs the
 * real `markdownToYFragment` over every case here.
 *
 * Block ids are random in BlockNote, so every `blockContainer` line of the
 * canonical form is written without its `id` attribute, and a port compares
 * the same way.
 */
import * as Y from 'yjs'
import { createMemrySchema } from '@memry/editor-schema'
import {
  BOOKMARK_LINE_REGEX,
  FILE_BLOCK_LINE_REGEX,
  parseFileBlockMarker,
  parseWhiteboardLine,
  parseYoutubeEmbedLine,
  readCalloutRun,
  readMathRun,
  readStructuredQuoteRun,
  resolveCalloutRun,
  resolveQuoteRun,
  splitMarkdownByToggles,
  type ParsedBlockShape
} from '@memry/editor-schema/blocks'
import { memryCodeBlockOptions } from '@memry/editor-schema/code-block'
import { writeHtmlCommentTokens } from '@memry/editor-schema/inline'
import { parseMarkdownToBlocksRepaired } from '@memry/editor-schema/parse-markdown'
// `@blocknote/server-util` is a dependency of `@memry/editor-schema`, not of
// this package; the schema package re-exports it so both share one
// `@blocknote/core` instance.
import {
  ServerBlockNoteEditor,
  createServerBlockSpecs,
  createServerInlineSpecs
} from '@memry/editor-schema/server'
import {
  normalizeSerializedMarkdown,
  separateBlockImages,
  splitMarkdownPreservingBlanks
} from '../../../shared/src/empty-lines.ts'
import {
  extractInlineColorRuns,
  restoreInlineColorTokens
} from '../../../shared/src/inline-colors.ts'
import { createFenceTracker } from '../../../shared/src/markdown-fences.ts'
import { withPlainCheckboxMarkers } from '../../../shared/src/plain-checkbox.ts'

import { canonicalFragment } from '../fragment-canonical'
import { MARKDOWN_SEED_CASES } from './markdown-seed-cases'
import { meta } from './shared'

interface SeedBlock {
  id?: string
  type: string
  props: Record<string, unknown>
  content?: unknown
  children: SeedBlock[]
}

let editor: ServerBlockNoteEditor | null = null

/** Desktop main's editor: `blocknote-converter.ts` `serverSchema`. */
function serverEditor(): ServerBlockNoteEditor {
  if (!editor) {
    const schema = createMemrySchema({
      codeBlock: memryCodeBlockOptions,
      blocks: createServerBlockSpecs(),
      inline: createServerInlineSpecs()
    })
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector generator over untyped fixture rows; the fixture literals fix the shape and vectors:check pins the output
    editor = ServerBlockNoteEditor.create({ schema }) as ServerBlockNoteEditor
  }
  return editor
}

/**
 * The markdown shapes that reach a converter layer this generator does not
 * reproduce. A case holding one would pin a document desktop does not build.
 */
function refuseUnreproduced(name: string, markdown: string): void {
  const layers: Array<[string, RegExp]> = [
    ['CriticMarkup', /\{(\+\+|--|~~|==|>>)/],
    ['link reference definition', /^ {0,3}\[[^\]]+\]:/m],
    // Toggle markup lines and file markers are reproduced; any other tag,
    // comment or sidecar marker is not.
    [
      'HTML, colour span or marker line',
      /<(?!details[\s>]|\/details>|summary>|\/summary>|!-- file:\{)[A-Za-z/!?]/
    ],
    ['wiki embed', /!\[\[/],
    // `blocks/columns.ts` `readColumnRegion`: an MCM start line, or a
    // Pandoc `:::` opener naming a columns class.
    ['column region', /^(?:---|===)\s*(?:start-multi-column|multi-column-start)|^:{3,}.*column/im],
    ['inline token', /\(\((mention|date):/],
    ['task block', /\{task:/],
    ['plain checkbox', /\{check\}/],
    ['masking token', /MEMRY/],
    ['line terminator', /[\u2028\u2029]/]
  ]
  for (const [layer, pattern] of layers) {
    if (pattern.test(markdown)) {
      throw new Error(`markdown-seed case "${name}" reaches the ${layer} layer`)
    }
  }
}

function emptyParagraph(): SeedBlock {
  return { type: 'paragraph', props: {}, content: [], children: [] }
}

function parse(markdown: string): Promise<SeedBlock[]> {
  return parseMarkdownToBlocksRepaired<SeedBlock>(serverEditor(), markdown)
}

/** `blocknote-converter.ts` `serializeBlocks`, the callout and quote claims' proof. */
async function serializeBlocks(blocks: ParsedBlockShape[]): Promise<string> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector generator over untyped fixture rows; the fixture literals fix the shape and vectors:check pins the output
  const marked = withPlainCheckboxMarkers(blocks as never[])
  const { blocks: wrapped, replacements } = extractInlineColorRuns(marked)
  const markdown = normalizeSerializedMarkdown(
    await writeHtmlCommentTokens(wrapped, (b) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector generator over untyped fixture rows; the fixture literals fix the shape and vectors:check pins the output
      serverEditor().blocksToMarkdownLossy(b as never)
    )
  )
  return restoreInlineColorTokens(markdown, replacements)
}

/** `blocknote-converter.ts` `parseCustomBlockMarkerLine`. */
function markerBlock(line: string): SeedBlock | null {
  const trimmed = line.trim()
  const file = FILE_BLOCK_LINE_REGEX.test(trimmed) ? parseFileBlockMarker(trimmed) : null
  if (file) return { type: 'file', props: { ...file }, children: [] }
  const embed = parseYoutubeEmbedLine(line)
  if (embed) return { type: 'youtubeEmbed', props: { ...embed }, children: [] }
  const bookmark = BOOKMARK_LINE_REGEX.exec(line)
  if (bookmark) {
    try {
      const url = new URL(bookmark[1])
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const domain = url.hostname.replace(/^www\./, '')
        return { type: 'bookmark', props: { url: bookmark[1], domain }, children: [] }
      }
    } catch {
      // Not an address: the line stays an image.
    }
  }
  const canvasId = parseWhiteboardLine(line)
  return canvasId ? { type: 'whiteboard', props: { canvasId }, children: [] } : null
}

/**
 * `blocknote-converter.ts` `parseContentWithMarkers`, without the sidecar
 * markers {@link refuseUnreproduced} keeps out.
 */
async function parseContentWithMarkers(text: string): Promise<SeedBlock[]> {
  const blocks: SeedBlock[] = []
  let buffer: string[] = []
  // `parseMarkdownWithNestingMarkers` with no marker: one chunk, its edge
  // newlines trimmed, parsed only when it holds text.
  const flush = async (): Promise<void> => {
    const chunk = buffer.join('\n').replace(/^\n+|\n+$/g, '')
    if (chunk.trim()) blocks.push(...(await parse(chunk)))
    buffer = []
  }
  const fence = createFenceTracker()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const insideFence = fence.consume(line)
    let claimed: { block: SeedBlock; end: number } | null = null
    if (!insideFence) {
      const atParagraphStart = i === 0 || lines[i - 1].trim() === ''
      const callout = readCalloutRun(lines, i, atParagraphStart)
      const resolved = callout ? await resolveCalloutRun(callout, parse, serializeBlocks) : null
      const math = readMathRun(lines, i, atParagraphStart)
      const quote = atParagraphStart ? readStructuredQuoteRun(lines, i) : null
      const quoted = quote ? await resolveQuoteRun(quote, parse, serializeBlocks) : null
      if (callout && resolved) {
        const props = { type: resolved.type, fold: resolved.fold }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector generator over untyped fixture rows; the fixture literals fix the shape and vectors:check pins the output
        const children = resolved.children as SeedBlock[]
        claimed = {
          block: { type: 'callout', props, content: resolved.content, children },
          end: callout.end
        }
      } else if (math) {
        claimed = {
          block: { type: 'mathBlock', props: { latex: math.latex }, children: [] },
          end: math.end
        }
      } else if (quote && quoted) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector generator over untyped fixture rows; the fixture literals fix the shape and vectors:check pins the output
        const children = quoted.children as SeedBlock[]
        claimed = {
          block: { type: 'quote', props: {}, content: quoted.content, children },
          end: quote.end
        }
      }
    }
    if (claimed) {
      await flush()
      blocks.push(claimed.block)
      for (let consumed = i + 1; consumed < claimed.end; consumed++) fence.consume(lines[consumed])
      i = claimed.end - 1
      continue
    }
    const marker = insideFence ? null : markerBlock(line)
    if (marker) {
      await flush()
      blocks.push(marker)
      continue
    }
    buffer.push(line)
  }
  await flush()
  return blocks
}

/**
 * `blocknote-converter.ts` `parseMarkdownWithToggles`: toggle segments (as
 * `parseToggleSegment` builds them), their gaps, then each markdown segment's
 * blank-line gaps and content.
 */
async function parseMasked(markdown: string): Promise<SeedBlock[]> {
  const blocks: SeedBlock[] = []
  for (const segment of splitMarkdownByToggles(markdown)) {
    if (segment.kind === 'toggle') {
      const summary = await parse(segment.summary)
      blocks.push({
        type: 'toggleListItem',
        props: { open: segment.open },
        content: summary[0]?.content ?? [],
        children: segment.body ? await parseMasked(segment.body) : []
      })
    } else if (segment.kind === 'gap') {
      for (let i = 0; i < segment.extraLines; i++) blocks.push(emptyParagraph())
    } else {
      for (const piece of splitMarkdownPreservingBlanks(segment.text)) {
        if (piece.type === 'gap') {
          for (let i = 0; i < piece.extraLines; i++) blocks.push(emptyParagraph())
        } else {
          blocks.push(...(await parseContentWithMarkers(piece.text)))
        }
      }
    }
  }
  return blocks
}

/** `prepareFragmentSeed` → `markdownToBlocksPreserving` for the reproduced layers. */
function markdownToBlocks(markdown: string): Promise<SeedBlock[]> {
  return parseMasked(separateBlockImages(markdown.replace(/\r\n?/g, '\n')))
}

/** Fixed ids in place of `ensureBlockIds`' random ones; stripped below anyway. */
function withIds(blocks: SeedBlock[], prefix: string): SeedBlock[] {
  return blocks.map((block, index) => {
    const id = `${prefix}-${index}`
    return { ...block, id, children: withIds(block.children ?? [], id) }
  })
}

/** The canonical form with every `blockContainer`'s random `id` removed. */
export function withoutBlockIds(canonical: string): string {
  return canonical.replace(/^(\d+ element blockContainer) id="[^"]*"/gm, '$1')
}

async function seededCanonical(markdown: string): Promise<string> {
  const doc = new Y.Doc()
  doc.clientID = 0x6d656d72
  const blocks = withIds(await markdownToBlocks(markdown), 'seed')
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector generator over untyped fixture rows; the fixture literals fix the shape and vectors:check pins the output
  serverEditor().blocksToYXmlFragment(blocks as never, doc.getXmlFragment('prosemirror'))
  return withoutBlockIds(canonicalFragment(doc))
}

export async function buildMarkdownSeed(): Promise<Record<string, unknown>> {
  const cases = []
  for (const entry of MARKDOWN_SEED_CASES) {
    refuseUnreproduced(entry.name, entry.markdown)
    cases.push({
      name: entry.name,
      pins: entry.pins,
      markdown: entry.markdown,
      expectedCanonical: await seededCanonical(entry.markdown)
    })
  }
  return {
    meta: meta({
      class: 'markdown-seed',
      spec: '005-ios-journal-parity JP022a',
      canonical: 'packages/contracts/scripts/fragment-canonical.ts',
      fragmentName: 'prosemirror',
      authoredBy:
        "desktop's markdownToYFragment path: LF line endings, separateBlockImages, splitMarkdownByToggles, splitMarkdownPreservingBlanks, parseContentWithMarkers (callouts, math, structured quotes, marker lines), parseMarkdownToBlocksRepaired on desktop's server schema, blocksToYXmlFragment",
      provenAgainst: 'apps/desktop/src/main/sync/markdown-seed-vectors.test.ts',
      blockIds: 'removed from every blockContainer line: BlockNote mints them at random',
      caseCount: cases.length
    }),
    cases
  }
}
