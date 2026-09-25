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
 * pieces that function runs, in its order: `splitMarkdownByToggles`,
 * `splitMarkdownPreservingBlanks`, `parseMarkdownToBlocksRepaired` through a
 * `ServerBlockNoteEditor` on desktop's schema (code block options included),
 * the untagged-fence repair, and `blocksToYXmlFragment`. The layers it does not
 * reproduce (CriticMarkup, link references, embeds, colour spans, toggles,
 * callouts, math, structured quotes, marker lines, task blocks) are refused by
 * {@link refuseUnreproduced} rather than skipped. The proof that the result is
 * desktop's is `apps/desktop/src/main/sync/markdown-seed-vectors.test.ts`,
 * which runs the real `markdownToYFragment` over every case here.
 *
 * Block ids are random in BlockNote, so every `blockContainer` line of the
 * canonical form is written without its `id` attribute, and a port compares
 * the same way.
 */
import * as Y from 'yjs'
import { createMemrySchema } from '@memry/editor-schema'
import { splitMarkdownByToggles } from '@memry/editor-schema/blocks'
import { memryCodeBlockOptions } from '@memry/editor-schema/code-block'
import { parseMarkdownToBlocksRepaired } from '@memry/editor-schema/parse-markdown'
import { createServerBlockSpecs, createServerInlineSpecs } from '@memry/editor-schema/server'
// `@blocknote/server-util` is a dependency of `@memry/editor-schema`, not of
// this package; its ESM entry is imported by path so it shares that package's
// `@blocknote/core` instance with the schema built above.
import { ServerBlockNoteEditor } from '../../../editor-schema/node_modules/@blocknote/server-util/dist/blocknote-server-util.js'
import { splitMarkdownPreservingBlanks } from '../../../shared/src/empty-lines.ts'
import { listCodeFenceInfoStrings } from '../../../shared/src/markdown-fences.ts'

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
    ['HTML, toggle, colour span or marker line', /<[A-Za-z/!?]/],
    ['image or embed', /!\[/],
    ['callout', /\[!/],
    ['math', /\$\$/],
    ['inline token', /\(\((mention|date):/],
    ['task block', /\{task:/],
    ['structured quote', /^(>|> >.*)$/m],
    ['table', /^\s*\|.*\|\s*$/m],
    ['masking token', /MEMRY/],
    ['line terminator', /[\r\u2028\u2029]/]
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

/**
 * `blocknote-converter.ts` `markdownToBlocksPreserving` → `parseMaskedMarkdown`
 * for markdown with nothing but BlockNote's own constructs: toggle segments
 * and their gaps, blank-line gaps, then one parse per content chunk.
 */
async function markdownToBlocks(markdown: string): Promise<SeedBlock[]> {
  const blocks: SeedBlock[] = []
  for (const segment of splitMarkdownByToggles(markdown)) {
    if (segment.kind === 'toggle') throw new Error('toggle segment in a markdown-seed case')
    if (segment.kind === 'gap') {
      for (let i = 0; i < segment.extraLines; i++) blocks.push(emptyParagraph())
      continue
    }
    for (const piece of splitMarkdownPreservingBlanks(segment.text)) {
      if (piece.type === 'gap') {
        for (let i = 0; i < piece.extraLines; i++) blocks.push(emptyParagraph())
      } else if (piece.text.trim()) {
        blocks.push(...(await parseMarkdownToBlocksRepaired<SeedBlock>(serverEditor(), piece.text)))
      }
    }
  }
  restoreUntaggedFenceLanguages(markdown, blocks)
  return blocks
}

/** `blocknote-converter.ts` `restoreUntaggedFenceLanguages`, verbatim. */
function restoreUntaggedFenceLanguages(markdown: string, blocks: SeedBlock[]): void {
  const infoStrings = listCodeFenceInfoStrings(markdown)
  if (!infoStrings.includes('')) return
  const codeBlocks: SeedBlock[] = []
  const visit = (list: SeedBlock[]): void => {
    for (const block of list) {
      if (block.type === 'codeBlock') codeBlocks.push(block)
      visit(block.children ?? [])
    }
  }
  visit(blocks)
  if (codeBlocks.length !== infoStrings.length) return
  for (const [index, info] of infoStrings.entries()) {
    if (info === '') (codeBlocks[index].props as { language: string }).language = ''
  }
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
        "desktop's markdownToYFragment path: splitMarkdownByToggles, splitMarkdownPreservingBlanks, parseMarkdownToBlocksRepaired on desktop's server schema, restoreUntaggedFenceLanguages, blocksToYXmlFragment",
      provenAgainst: 'apps/desktop/src/main/sync/markdown-seed-vectors.test.ts',
      blockIds: 'removed from every blockContainer line: BlockNote mints them at random',
      caseCount: cases.length
    }),
    cases
  }
}
