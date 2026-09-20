import {
  escapeWikiLinkPipesInTableRows,
  maskHardBreaks,
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

function repairRuns(runs: InlineRun[], unmask: boolean, tokens: string[]): void {
  for (const run of runs) {
    if (run?.type !== 'text' || typeof run.text !== 'string') continue
    const stripped = run.text.replace(BREAK_ARTIFACT, '\n')
    // Unmask after stripping, never before: the token sits directly against
    // the newline it marks, and the phantom space lands between the two.
    const unmasked = unmask ? unmaskHardBreaks(stripped) : stripped
    // Both restores are unconditional: a placeholder that survives into a
    // block is written into the vault as literal text.
    run.text = restoreInlineTokens(restoreDetailsMarkup(unmasked), tokens)
  }
}

function repairBlocks(blocks: BlockLike[], unmask: boolean, tokens: string[]): void {
  for (const block of blocks) {
    if (block.type === 'codeBlock') {
      // Skipped whole: a newline followed by a space is real indentation here,
      // and a token inside a fence is the author writing about the syntax.
    } else if (Array.isArray(block.content)) {
      repairRuns(block.content as InlineRun[], unmask, tokens)
    } else if (block.content && typeof block.content === 'object') {
      // A table: its runs live two levels down, in the cells.
      for (const row of (block.content as TableContent).rows ?? []) {
        for (const cell of row?.cells ?? []) {
          const runs = cellRuns(cell)
          if (runs) repairRuns(runs, unmask, tokens)
        }
      }
    }
    if (Array.isArray(block.children)) repairBlocks(block.children as BlockLike[], unmask, tokens)
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
  const source = escapeWikiLinkPipesInTableRows(markdown)
  // A hard break and a soft break now parse to the same single newline, so the
  // hard one is marked to keep them apart.
  const masked = maskHardBreaks(source)
  // `((mention:…))` and `((date:…))` are opaque payloads the parser will apply
  // intraword emphasis inside.
  const { markdown: withTokensMasked, tokens } = maskInlineTokens(masked)

  const parsed = (await editor.tryParseMarkdownToBlocks(withTokensMasked)) as BlockLike[]
  repairBlocks(parsed, masked !== source, tokens)
  return parsed as T[]
}
