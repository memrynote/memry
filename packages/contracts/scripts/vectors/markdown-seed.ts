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
 * `record-envelope.ts` records). So this generator runs the production pieces
 * that function runs, in its order: line endings to `\n`, `maskHtmlComments`,
 * then `parseNoteMarkdown`, the note pipeline both desktop processes share,
 * with `parseMarkdownToBlocksRepaired` through a `ServerBlockNoteEditor` on
 * desktop's schema (code block options included) and desktop's
 * `serializeBlocks`, then `normalizeLinkMentions` and `normalizeDateMentions`
 * as `prepareFragmentSeed` runs them, and `blocksToYXmlFragment`. The layers
 * before that pipeline it does not reproduce (CriticMarkup, link references,
 * wiki embeds), and the layers no case here is proven against (colour spans,
 * column regions, `<!--` comments and sidecar markers, task blocks,
 * plain-checkbox markers), are refused by {@link refuseUnreproduced} rather
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
import { memryCodeBlockOptions } from '@memry/editor-schema/code-block'
import {
  normalizeDateMentions,
  normalizeLinkMentions,
  writeHtmlCommentTokens
} from '@memry/editor-schema/inline'
import { parseNoteMarkdown } from '@memry/editor-schema/note-markdown'
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
  hideBacktickLanguages,
  spellBacktickLanguages
} from '../../../shared/src/code-fence-language.ts'
import { normalizeSerializedMarkdown } from '../../../shared/src/empty-lines.ts'
import {
  extractInlineColorRuns,
  restoreInlineColorTokens
} from '../../../shared/src/inline-colors.ts'
import { maskHtmlComments } from '../../../shared/src/html-comments.ts'
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

const withoutSummaryComment = (text: string): string =>
  text.replace(/^(<summary>.*?)<!--.*?-->/m, '$1')

/** A handled tag after a backslash is text (`raw_html.rs`): the seed builds it, so it is no layer. */
const withoutEscapedTags = (text: string): string =>
  text.replace(/(?<!\\)((?:\\\\)*)\\<(?=[a-z/])/gi, '$1')

/**
 * The markdown shapes that reach a converter layer this generator does not
 * reproduce. A case holding one would pin a document desktop does not build.
 */
function refuseUnreproduced(name: string, markdown: string): void {
  const layers: Array<[string, RegExp]> = [
    ['CriticMarkup', /\{(\+\+|--|~~|==|>>)/],
    ['link reference definition', /^ {0,3}\[[^\]]+\]:/m],
    // Toggle markup lines, file markers and raw HTML the editor has no node for
    // are reproduced; a tag the editor handles (a mark, a link, an image, a
    // break, a colour span, a checkbox), a comment and a sidecar marker are not.
    [
      'handled HTML, colour span or marker line',
      /<\/?(?:b|strong|i|em|u|s|del|strike|code|a|img|br|span|input)(?![\w-])|<!--(?! file:\{)/i
    ],
    ['wiki embed', /!\[\[/],
    // `blocks/columns.ts` `readColumnRegion`: an MCM start line, or a
    // Pandoc `:::` opener naming a columns class.
    ['column region', /^(?:---|===)\s*(?:start-multi-column|multi-column-start)|^:{3,}.*column/im],
    ['task block', /\{task:/],
    ['plain checkbox', /\{check\}/],
    ['line terminator', /[\u2028\u2029]/]
  ]
  // A comment in a `<summary>` line is reproduced: its `<` are hidden, so the
  // seed builds the comment node there (`markdown_seed/toggles.rs`).
  let reproduced = withoutEscapedTags(markdown)
  for (let next = withoutSummaryComment(reproduced); next !== reproduced;) {
    reproduced = next
    next = withoutSummaryComment(reproduced)
  }
  for (const [layer, pattern] of layers) {
    if (pattern.test(reproduced)) {
      throw new Error(`markdown-seed case "${name}" reaches the ${layer} layer`)
    }
  }
}

function parse(markdown: string): Promise<SeedBlock[]> {
  return parseMarkdownToBlocksRepaired<SeedBlock>(serverEditor(), markdown)
}

/** `blocknote-converter.ts` `serializeBlocks`, the callout and quote claims' proof. */
async function serializeBlocks(blocks: SeedBlock[]): Promise<string> {
  const { blocks: spelled, languages } = hideBacktickLanguages(blocks)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector generator over untyped fixture rows; the fixture literals fix the shape and vectors:check pins the output
  const marked = withPlainCheckboxMarkers(spelled as never[])
  const { blocks: wrapped, replacements } = extractInlineColorRuns(marked)
  const markdown = normalizeSerializedMarkdown(
    await writeHtmlCommentTokens(wrapped, (b) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector generator over untyped fixture rows; the fixture literals fix the shape and vectors:check pins the output
      serverEditor().blocksToMarkdownLossy(b as never)
    )
  )
  return restoreInlineColorTokens(spellBacktickLanguages(markdown, languages), replacements)
}

/**
 * `prepareFragmentSeed` → `markdownToBlocks` → `markdownToBlocksPreserving` for
 * the reproduced layers: every comment masked before any line is split
 * (`@memry/shared/html-comments`), then the note pipeline both desktop
 * processes run (`@memry/editor-schema/note-markdown`), then the link and date
 * mention promotion `prepareFragmentSeed` runs on the result, in its order.
 */
async function markdownToBlocks(markdown: string): Promise<SeedBlock[]> {
  const blocks = await parseNoteMarkdown<SeedBlock>(
    { parse, serialize: serializeBlocks },
    maskHtmlComments(markdown.replace(/\r\n?/g, '\n'))
  )
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector generator over untyped fixture rows; the fixture literals fix the shape and vectors:check pins the output
  return normalizeDateMentions(normalizeLinkMentions(blocks as never[]).blocks).blocks
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
        "desktop's markdownToYFragment path: LF line endings, maskHtmlComments, parseNoteMarkdown (editor-schema note-markdown) with parseMarkdownToBlocksRepaired on desktop's server schema, normalizeLinkMentions then normalizeDateMentions, blocksToYXmlFragment",
      provenAgainst: 'apps/desktop/src/main/sync/markdown-seed-vectors.test.ts',
      blockIds: 'removed from every blockContainer line: BlockNote mints them at random',
      caseCount: cases.length
    }),
    cases
  }
}
