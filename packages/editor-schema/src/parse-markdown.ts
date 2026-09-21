import {
  escapeWikiLinkPipesInTableRows,
  fenceIndentedCodeBlocks,
  maskHardBreaks,
  restoreHardBreakSpelling,
  unmaskHardBreaks
} from '@memry/shared/empty-lines'
import { restoreDetailsMarkup } from './blocks/markdown'
import { maskInlineTokens, restoreInlineTokens } from './inline/token-masking'

/**
 * Markdown to blocks, with BlockNote 0.51+'s markdown regressions repaired.
 *
 * 0.51 replaced the unified/remark markdown pipeline with a hand-written one
 * and lost several things the vault format depends on. Each is handled by a
 * mask applied before the parse and undone after it; see the individual
 * helpers for what each one measured.
 *
 * Shared by both surfaces on purpose. Main writes the vault file and the
 * renderer parses the same markdown for paste, templates and non-CRDT notes,
 * so a repair applied to one and not the other means the same bytes parse to
 * two different documents depending on which process read them. That is the
 * class of bug `@memry/editor-schema` exists to prevent, so the repair lives
 * with the schema rather than beside either caller.
 */

/** The slice of a BlockNote editor this needs. Both surfaces' editors satisfy it. */
export interface MarkdownParsingEditor {
  tryParseMarkdownToBlocks(markdown: string): Promise<unknown[]>
}

/**
 * BlockNote 0.51+ pretty-prints the HTML it builds on the way from markdown to
 * blocks, so a break arrives as `<br>\n` rather than `<br>`. The DOM parser
 * turns the `<br>` into a newline and then collapses the newline that follows
 * it into a space, so `kaan\nuraz` parses as `kaan\n uraz` and every
 * soft-broken paragraph in the vault gains one leading space per line on the
 * next write-back. Two passes compound it.
 *
 * Repaired in the block tree rather than at the serializer: the bytes are
 * already wrong there, so anything reading the doc — search, the editor, the
 * CRDT — sees the phantom space too.
 */
const BREAK_ARTIFACT = /\n[^\S\n]/g

/**
 * The same artifact, at the start of a run.
 *
 * The pretty-printer breaks a line wherever it likes, so the indent it adds
 * lands after a newline INSIDE a run in the common case and before the very
 * first character when the break fell on the block boundary. Measured on
 * `para\n\n    code`: 0.54 returns a second paragraph whose text is
 * `" const x = 1\nconst y = 2"`, while the same block first in the document
 * comes back with no leading space at all \u2014 the inconsistency is what makes it
 * the printer's and not the author's.
 *
 * Only the FIRST run of a block, and never a code block. A later run may open
 * with a real space (`**bold** tail` gives `" tail"`), and a fenced block's
 * first line may be indented on purpose. A block's first run may not: every
 * markdown block grammar eats its own leading whitespace.
 */
const LEADING_BREAK_ARTIFACT = /^[^\S\n]/

interface InlineRun {
  type?: string
  text?: string
}

interface BlockLike {
  type?: string
  content?: unknown
  children?: unknown
}

interface TableContent {
  rows?: Array<{ cells?: unknown[] }>
}

/**
 * A table cell is a bare `InlineRun[]` in the legacy shape and a
 * `{ type: 'tableCell', content: InlineRun[] }` object in BlockNote 0.47+.
 * Both are walked: a cell missed here keeps its placeholders and writes them
 * into the vault as literal text.
 */
function cellRuns(cell: unknown): InlineRun[] | null {
  if (Array.isArray(cell)) return cell as InlineRun[]
  const content = (cell as { content?: unknown } | null)?.content
  return Array.isArray(content) ? (content as InlineRun[]) : null
}

interface Masks {
  /** The spelling each hard-break token replaced. Empty when none was masked. */
  breaks: string[]
  /** The `((…))` payloads, by placeholder index. */
  tokens: string[]
}

/**
 * Nothing was masked, so nothing is touched: a run that merely looks like it
 * carries a token is then the author's own bytes.
 */
function unmaskRun(text: string, code: boolean, breaks: string[]): string {
  if (breaks.length === 0) return text
  return code ? restoreHardBreakSpelling(text, breaks) : unmaskHardBreaks(text)
}

function repairRuns(runs: InlineRun[], code: boolean, masks: Masks): void {
  for (const [index, run] of runs.entries()) {
    if (run?.type !== 'text' || typeof run.text !== 'string') continue
    // A newline followed by a space is the parser's artifact in prose and the
    // author's own indentation in a code block, so the strip is prose-only.
    let stripped = run.text
    if (!code) {
      stripped = stripped.replace(BREAK_ARTIFACT, '\n')
      if (index === 0) stripped = stripped.replace(LEADING_BREAK_ARTIFACT, '')
    }
    // Unmask after stripping, never before: the token sits directly against
    // the newline it marks, and the phantom space lands between the two.
    //
    // A code block gets the spelling back rather than the break: its bytes are
    // literal, so two trailing spaces mean two trailing spaces there.
    const unmasked = unmaskRun(stripped, code, masks.breaks)
    // Every restore is unconditional: a placeholder that survives into a block
    // is written into the vault as literal text.
    run.text = restoreInlineTokens(restoreDetailsMarkup(unmasked), masks.tokens)
  }
}

/**
 * Code blocks are walked like everything else.
 *
 * They used to be skipped whole, on the reasoning that a token inside a fence
 * is the author writing about the syntax. That reasoning holds for a fence and
 * only for a fence: both masks skip fenced regions, so no token ever enters
 * one. A token CAN reach a code block another way — BlockNote maps a raw
 * `<pre>` block onto `codeBlock`, and `<pre>` is prose to the masks — and
 * skipping the block meant that token was never restored. Measured: a vault
 * note holding `<pre><code>A  \nB</code></pre>` came back with `MEMRYHBK;`
 * written into the code fence, and stayed that way on every later save.
 */
function repairBlocks(blocks: BlockLike[], masks: Masks): void {
  for (const block of blocks) {
    const code = block.type === 'codeBlock'
    if (Array.isArray(block.content)) {
      repairRuns(block.content as InlineRun[], code, masks)
    } else if (block.content && typeof block.content === 'object') {
      // A table: its runs live two levels down, in the cells.
      for (const row of (block.content as TableContent).rows ?? []) {
        for (const cell of row?.cells ?? []) {
          const runs = cellRuns(cell)
          if (runs) repairRuns(runs, false, masks)
        }
      }
    }
    if (Array.isArray(block.children)) repairBlocks(block.children as BlockLike[], masks)
  }
}

/**
 * Parse `markdown` into blocks through `editor`, repairing what 0.51+ breaks.
 *
 * Every markdown→blocks conversion on either surface goes through here, so a
 * body, a toggle summary, a callout run and a quote run all get the same
 * treatment.
 */
export async function parseMarkdownToBlocksRepaired<T>(
  editor: MarkdownParsingEditor,
  markdown: string
): Promise<T[]> {
  // A `[[target|alias]]` already in a vault table has to be escaped before the
  // parse or 0.51's table parser splits the row on it and drops the alias.
  const source = fenceIndentedCodeBlocks(escapeWikiLinkPipesInTableRows(markdown))
  // A hard break and a soft break now parse to the same single newline, so the
  // hard one is marked to keep them apart.
  const { markdown: masked, breaks } = maskHardBreaks(source)
  // `((mention:…))` and `((date:…))` are opaque payloads the parser will apply
  // intraword emphasis inside.
  const { markdown: withTokensMasked, tokens } = maskInlineTokens(masked)

  const parsed = (await editor.tryParseMarkdownToBlocks(withTokensMasked)) as BlockLike[]
  repairBlocks(parsed, { breaks, tokens })
  return parsed as T[]
}
