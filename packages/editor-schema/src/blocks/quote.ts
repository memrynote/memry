import type { ParsedBlockShape } from './markdown'

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
 * A leading paragraph becomes the quote's own content and the rest its
 * children, which is the list `serializeQuoteBlock` is handed on the way out.
 */
export async function resolveQuoteRun(
  run: QuoteRun,
  parseMarkdown: (markdown: string) => Promise<ParsedBlockShape[]>,
  serializeBlocks: (blocks: ParsedBlockShape[]) => Promise<string>
): Promise<{ content: unknown; children: ParsedBlockShape[] } | null> {
  const parsed = await parseMarkdown(run.innerMarkdown)
  const claimed = splitQuoteBlocks(parsed)
  if (!claimed) return null

  const canonical = serializeQuoteBlock((await serializeBlocks(parsed)).trim())
  if (canonical !== run.raw) {
    if (!run.nested) return null
    if (!(await settles(canonical, parseMarkdown, serializeBlocks))) return null
  }

  return claimed
}

/**
 * Split a run's parsed inner blocks into the quote's own content and its
 * children, or null when a quote block cannot hold them.
 *
 * A leading paragraph is the quote's own line. A run that opens straight on a
 * nested level (`> > Inner only`) has no own line: its inner markdown parses to
 * a lone `quote`, so the quote keeps empty own content and every parsed block
 * as a child (#1896). Empty own content serializes to nothing ahead of the
 * children, so the bytes reproduce. Any other leading block declines, as before.
 *
 * No children means a flat quote, which the untouched path already serializes
 * correctly — claiming it would only route identical bytes through more code.
 */
function splitQuoteBlocks(
  parsed: ParsedBlockShape[]
): { content: unknown; children: ParsedBlockShape[] } | null {
  const [first, ...rest] = parsed
  if (!first || first.children?.length) return null
  if (first.type === 'quote') return { content: [], children: parsed }
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
  if (!splitQuoteBlocks(reparsed)) return false

  return serializeQuoteBlock((await serializeBlocks(reparsed)).trim()) === canonical
}
