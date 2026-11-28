import { createFenceTracker } from '@memry/shared/markdown-fences'
import { DETAILS_LINE_TAIL, DETAILS_MARKUP } from './block-starts.ts'
import type { ParsedBlockShape } from './markdown.ts'

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
  /**
   * The run holds a list. BlockNote's flat quote keeps only the items' text, so
   * declining it drops every marker: `> - a` came back `> a` (BBF-110).
   */
  listed: boolean
  /**
   * Read as this build reads quotes (a source record's `losslessBlocks`): any
   * run is read, and one holding a block the flat quote cannot hold is
   * claimed once its canonical form settles. False reads a source as builds
   * before it did: only the three shapes above, and only a nested or listed
   * run may settle.
   */
  lossless: boolean
}

/** A list item that can open a list anywhere, even inside a paragraph. */
const INTERRUPTING_ITEM = /^ {0,3}([-*+]|1[.)])[ \t]+\S/
/** A list item that opens a list where no paragraph runs on. */
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])([ \t]|$)/
/** A line that starts a block of its own instead of continuing a paragraph. */
const BLOCK_START =
  /^ {0,3}(>|#{1,6}([ \t]|$)|```|~~~|<|\||[-*_=]+[ \t]*$|[-*_]([ \t]*[-*_]){2,}[ \t]*$)/
const FENCE = /^ {0,3}(```|~~~)/
const DETAILS_MARKUP_LINE = new RegExp(`^(?:${DETAILS_MARKUP})${DETAILS_LINE_TAIL}$`)

/**
 * Read a blockquote run at `lines[start]` whose inner structure BlockNote
 * cannot hold flat, or null to leave the bytes on the path they are on today.
 *
 * BlockNote parses a whole blockquote into ONE block of inline content, so a
 * blank `>` separator and a `> >` nesting level are gone before serialization
 * ever runs: `> A\n>\n> B` comes back as `> A\n> B` and a nested callout comes
 * back unnested (#1881). A list loses every marker the same way: `> - a` comes
 * back `> a` (BBF-110), and so does every other block: a table came back as
 * its cells' text, a heading as its words. A `lossless` read hands every run
 * to `resolveQuoteRun`, which declines one that parses to a single paragraph,
 * so a flat quote stays on the untouched path. A legacy read hands over only
 * the three shapes above.
 *
 * Strict on the prefix: only `>` alone and `> …` are read. A `>text` line —
 * valid CommonMark, never bytes Memry writes — refuses the whole run rather
 * than ending it early, which would tear one blockquote into two.
 *
 * `lazyParagraph`: a lossless quote's last paragraph takes the lines after it
 * that open no block, as BlockNote's flat quote does. A callout's body ends at
 * its last `>` line.
 */
export function readStructuredQuoteRun(
  lines: readonly string[],
  start: number,
  lossless = true,
  lazyParagraph = false
): QuoteRun | null {
  if (!lines[start]?.startsWith('>')) return null

  const inner: string[] = []
  let end = start
  let separated = false
  let nested = false
  let listed = false
  // `- x` inside a fence is code, not an item: claiming `> ```\n> - x\n> ```` as
  // a list made the two pipelines split on a following lazy line (BBF-113).
  const fence = createFenceTracker()

  while (end < lines.length && lines[end].startsWith('>')) {
    const line = lines[end]
    if (line === '>') {
      inner.push('')
      separated = true
    } else if (line.startsWith('> ') || lossless) {
      // CommonMark's marker takes its space optionally, so `>b` is a quote
      // line too. A legacy read declined the run on one.
      const stripped = line.slice(line.startsWith('> ') ? 2 : 1)
      inner.push(stripped)
      if (stripped.startsWith('>')) nested = true
      const opensItem = inner.length === 1 || inner[inner.length - 2] === ''
      const isItem = INTERRUPTING_ITEM.test(stripped) || (opensItem && LIST_ITEM.test(stripped))
      if (!fence.consume(stripped) && isItem) listed = true
    } else {
      return null
    }
    end++
  }

  // A line after a listed run that neither opens a block nor follows a gap
  // continues the item's paragraph lazily: `> - [a\nb](u)` is one item, and
  // ending the run before `b](u)` tore its link in two (BBF-110). A quote's
  // last paragraph continues the same way: the flat quote BlockNote read from
  // `> q\nsee ![x](u)` dropped the image.
  // A lossless read keeps a details markup line as text: `> <details>\nsee ![x](u)`.
  const startsBlock = (line: string): boolean =>
    BLOCK_START.test(line) && !(lossless && DETAILS_MARKUP_LINE.test(line))
  const last = inner[inner.length - 1]
  const continues = listed || (lossless && lazyParagraph && !startsBlock(last))
  if (continues && last !== '' && !inner.some((line) => FENCE.test(line))) {
    while (
      end < lines.length &&
      lines[end].trim() !== '' &&
      !LIST_ITEM.test(lines[end]) &&
      !startsBlock(lines[end])
    ) {
      inner.push(lines[end])
      end++
    }
  }

  if (!lossless && !separated && !nested && !listed) return null
  return {
    innerMarkdown: inner.join('\n'),
    raw: lines.slice(start, end).join('\n'),
    end,
    nested,
    listed,
    lossless
  }
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
 * one-step normalization that keeps the nesting. A run holding a list gets the
 * same chance, because the flat fallback deletes every marker in it: a line
 * that continues an item lazily gains its `>`, and a list right under a
 * paragraph gains the blank `>` line the serializer writes between blocks. A
 * `lossless` run gets it whatever it holds, since declining any run that
 * claims flattens a block: `> | a |\n> |---|` settles as `> | a |\n> | - |`.
 *
 * A leading paragraph becomes the quote's own content and the rest its
 * children, which is the list `serializeQuoteBlock` is handed on the way out.
 */
export async function resolveQuoteRun(
  run: QuoteRun,
  parseMarkdown: (markdown: string) => Promise<ParsedBlockShape[]>,
  serializeBlocks: (blocks: ParsedBlockShape[]) => Promise<string>
): Promise<{ content: unknown; children: ParsedBlockShape[] } | null> {
  if (run.lossless) parseMarkdown = withItemBlocksAfterItems(parseMarkdown)
  const parsed = await parseMarkdown(run.innerMarkdown)
  const claimed = splitQuoteBlocks(parsed, run.lossless)
  if (!claimed) return null
  if (run.listed && parsed.some(itemHoldsNonList)) return null

  const canonical = serializeQuoteBlock((await serializeBlocks(parsed)).trim())
  if (canonical !== run.raw) {
    if (!run.lossless && !run.nested && !run.listed) return null
    if (!(await settles(canonical, parseMarkdown, serializeBlocks))) return null
  }

  return claimed
}

const LIST_BLOCKS = new Set<unknown>(['bulletListItem', 'numberedListItem', 'checkListItem'])

/**
 * A list item that owns a block other than a list item. The writer spells that
 * child with nesting markers, which no parse reads back inside a quote, so
 * `> - x\n>   y` would grow on every save. A lossless read moves those blocks
 * out instead (`withItemBlocksAfterItems`); a legacy read declines the run.
 */
export function itemHoldsNonList(block: ParsedBlockShape): boolean {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ParsedBlockShape.children is unknown[] (shared with the parse path); a block's children are blocks
  const children = (block.children ?? []) as ParsedBlockShape[]
  if (!LIST_BLOCKS.has(block.type)) return false
  return children.some((child) => !LIST_BLOCKS.has(child.type) || itemHoldsNonList(child))
}

/**
 * `parseMarkdown` with every block a list item owns that is not a list item
 * moved out to follow the item's top-level list item, in order. Declining the
 * run instead flattens the whole list, and with it the image a list item's
 * text held: `> - a ![i](u) b` keeps its list and settles as
 * `> - a b\n>\n> ![i](u)`.
 */
export function withItemBlocksAfterItems(
  parseMarkdown: (markdown: string) => Promise<ParsedBlockShape[]>
): (markdown: string) => Promise<ParsedBlockShape[]> {
  const itemsOnly = (item: ParsedBlockShape, after: ParsedBlockShape[]): ParsedBlockShape => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ParsedBlockShape.children is unknown[] (shared with the parse path); a block's children are blocks
    const children = (item.children ?? []) as ParsedBlockShape[]
    const items: ParsedBlockShape[] = []
    for (const child of children) {
      if (LIST_BLOCKS.has(child.type)) items.push(itemsOnly(child, after))
      else after.push(child)
    }
    return { ...item, children: items }
  }
  return async (markdown) =>
    (await parseMarkdown(markdown)).flatMap((block) => {
      if (!LIST_BLOCKS.has(block.type)) return [block]
      const after: ParsedBlockShape[] = []
      return [itemsOnly(block, after), ...after]
    })
}

/**
 * Split a run's parsed inner blocks into the quote's own content and its
 * children, or null when a quote block cannot hold them.
 *
 * A leading paragraph is the quote's own line. A run that opens straight on a
 * nested level (`> > Inner only`) has no own line: its inner markdown parses to
 * a lone `quote`, so the quote keeps empty own content and every parsed block
 * as a child (#1896). Empty own content serializes to nothing ahead of the
 * children, so the bytes reproduce. A run that opens on a list item has no own
 * line either (BBF-110), and in a `lossless` read neither does a run that
 * opens on any other block, a table or a heading say. A legacy read declines
 * those.
 *
 * No children means a flat quote, which the untouched path already serializes
 * correctly — claiming it would only route identical bytes through more code.
 */
function splitQuoteBlocks(
  parsed: ParsedBlockShape[],
  lossless: boolean
): { content: unknown; children: ParsedBlockShape[] } | null {
  const [first, ...rest] = parsed
  if (!first) return null
  if (LIST_BLOCKS.has(first.type)) return { content: [], children: parsed }
  if (first.children?.length) return null
  if (first.type === 'quote' || (lossless && first.type !== 'paragraph')) {
    return { content: [], children: parsed }
  }
  if (first.type !== 'paragraph' || rest.length === 0) return null
  return { content: first.content ?? [], children: rest }
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
  if (!splitQuoteBlocks(reparsed, true)) return false

  return serializeQuoteBlock((await serializeBlocks(reparsed)).trim()) === canonical
}
