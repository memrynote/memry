/**
 * Oracle functions of the `markers` layer that start from markdown: the source
 * goes through BlockNote's own parse (the memry schema, as stage 3), the blocks
 * through the function under test. The Rust side feeds the same functions with
 * its stage-3 `markdown_to_blocks`, which `parse.json` holds to BlockNote.
 */
import { sidecarMarkerLines } from '@memry/shared/block-markers'
import {
  applyInlineColorTokens,
  extractInlineColorRuns,
  maskInlineColorSpans
} from '@memry/shared/inline-colors'
import { normalizePlainCheckboxes, withPlainCheckboxMarkers } from '@memry/shared/plain-checkbox'
import { normalizeTaskBlocks, serializeTaskBlockTree } from '@memry/shared/task-block'

type Fn = (...args: never[]) => unknown
type Blocks = Parameters<typeof normalizeTaskBlocks>[0]

type ParseMarkdown = (markdown: string) => Promise<Blocks>

let parser: ParseMarkdown | undefined
const parsed = new Map<string, Promise<Blocks>>()

/**
 * BlockNote only loads under Vitest (the oracle process); `generate.ts` runs
 * under tsx and imports this module just for the case lists, so it loads late.
 */
async function getParser(): Promise<ParseMarkdown> {
  if (parser) return parser
  const { ServerBlockNoteEditor } = await import('@blocknote/server-util')
  const { createMemrySchema } = await import('@memry/editor-schema')
  const { memryCodeBlockOptions } = await import('@memry/editor-schema/code-block')
  const { createServerBlockSpecs, createServerInlineSpecs } =
    await import('@memry/editor-schema/server')
  const { canonicalBlocks } = await import('../bn-oracle')
  const editor = ServerBlockNoteEditor.create({
    schema: createMemrySchema({
      codeBlock: memryCodeBlockOptions,
      blocks: createServerBlockSpecs(),
      inline: createServerInlineSpecs()
    })
  })
  parser = async (markdown) => {
    const parsedBlocks: unknown = await editor.tryParseMarkdownToBlocks(markdown)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the editor's blocks are BlockNote blocks, as bn-oracle.ts passes them
    const canonical = canonicalBlocks(parsedBlocks as Parameters<typeof canonicalBlocks>[0])
    return canonical
  }
  return parser
}

async function parse(markdown: string): Promise<Blocks> {
  const parseMarkdown = await getParser()
  let pending = parsed.get(markdown)
  if (!pending) {
    pending = parseMarkdown(markdown)
    parsed.set(markdown, pending)
  }
  return structuredClone(await pending)
}

interface TreeBlock {
  type?: string
  children?: TreeBlock[]
}

function everyBlock(blocks: TreeBlock[], visit: (block: TreeBlock) => boolean): void {
  for (const block of blocks) {
    if (visit(block) && block.children) everyBlock(block.children, visit)
  }
}

export const MD_FNS: Record<string, Fn> = {
  'taskBlock.normalizeFromMarkdown': async (markdown: string) =>
    normalizeTaskBlocks(await parse(markdown), markdown),
  'taskBlock.normalizeFromMarkdownNoSource': async (markdown: string) =>
    normalizeTaskBlocks(await parse(markdown), null),
  'taskBlock.serializeTreesFromMarkdown': async (markdown: string) => {
    const { blocks } = normalizeTaskBlocks(await parse(markdown), markdown)
    const trees: (string[] | null)[] = []
    everyBlock(blocks, (block) => {
      if (block.type !== 'taskBlock') return true
      trees.push(serializeTaskBlockTree(block))
      return false
    })
    return trees
  },
  'plainCheckbox.pipelineFromMarkdown': async (markdown: string) => {
    const tasks = normalizeTaskBlocks(await parse(markdown), markdown).blocks
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the converter passes the same blocks
    const plain = normalizePlainCheckboxes(tasks as Parameters<typeof normalizePlainCheckboxes>[0])
    return { plain, withMarkers: withPlainCheckboxMarkers(plain.blocks) }
  },
  'inlineColors.pipelineFromMarkdown': async (markdown: string) => {
    const masked = maskInlineColorSpans(markdown)
    const blocks = applyInlineColorTokens(await parse(masked.text), masked.spans)
    const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks)
    return { masked, blocks, wrapped, replacements: [...replacements.entries()] }
  },
  'blockMarkers.linesFromMarkdown': async (markdown: string) => {
    const lines: string[][] = []
    everyBlock(await parse(markdown), (block) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a parsed block is a marked block
      const own = sidecarMarkerLines(block as Parameters<typeof sidecarMarkerLines>[0])
      if (own.length > 0) lines.push(own)
      return true
    })
    return lines
  }
}
