/**
 * Is `serializeThroughExternalHTML` still load-bearing on BlockNote 0.54 (#2309)?
 *
 * The wrapper exists because BlockNote's exporter never reaches an inline
 * node's `toExternalHTML` below a table: a `tableRow` is not registered inline
 * content, so the exporter hands the whole subtree to ProseMirror's
 * `DOMSerializer`, which builds each node through `toDOM` — i.e. from the
 * editor's rich `render` (#1865). A serializer rewrite (0.51) could have moved
 * that path, making the wrapper redundant or double-applied.
 *
 * Measured, not argued: the same table is serialized through two editors that
 * differ only in whether the inline specs went through the wrapper. If 0.54
 * reached `toExternalHTML` below a table, the unwrapped editor would write the
 * tokens too and the negative control below would fail — the signal to make
 * the wrapper a no-op. On 0.54.2 (and on 0.47.1, measured by hand) it writes
 * the chip text instead, so the wrapper stays.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  type Block
} from '@blocknote/core'
import { WikiLink } from '@memry/editor-schema'

// The file block's PDF preview pulls pdf.js, which touches `DOMMatrix` at
// import time; the real schema imports it. Nothing asserted here renders it.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

// See roundtrip-conformance.test.ts: nothing here asserts on UI, and the
// diagram preview's async state update would otherwise warn about act().
beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
})

import { editorSchema } from './editor-schema'
import { HashTag } from './hash-tag'
import { LinkMention } from './link-mention'
// Registered for schema parity with the real editor only: this surface keeps
// `#tag` and `((date:…))` as text in a cell, so they are not in the fixture.
import { DateMention } from './date-mention'
import { InlineImage } from './inline-image'
import { InlineCheckbox } from './inline-checkbox'
import { parseMarkdownPreservingBlanks } from './markdown-utils'
import { normalizeNoteBlocks } from './normalize-note-blocks'

const wrapped = BlockNoteEditor.create({ schema: editorSchema, _headless: true } as never)

// The renderer's own specs, registered raw: exactly what `createMemrySchema`
// receives before `createMemryInlineContentSpecs` wraps them.
const unwrapped = BlockNoteEditor.create({
  schema: BlockNoteSchema.create({
    blockSpecs: defaultBlockSpecs,
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      wikiLink: WikiLink,
      linkMention: LinkMention,
      hashTag: HashTag,
      dateMention: DateMention,
      inlineImage: InlineImage,
      inlineCheckbox: InlineCheckbox
    }
  }),
  _headless: true
} as never)

const MENTION = '((mention:https%3A%2F%2Fexample.com%2Fplain))'

/** Parsed and promoted the way every note surface does it. */
async function promotedBlocks(markdown: string): Promise<Block[]> {
  const parsed = await parseMarkdownPreservingBlanks(wrapped, markdown)
  return normalizeNoteBlocks(parsed as Block[]) as Block[]
}

/** BlockNote's own exporter, nothing of ours in between. */
function exportThrough(
  editor: { blocksToMarkdownLossy: (blocks: never) => Promise<string> },
  blocks: Block[]
): Promise<string> {
  return editor.blocksToMarkdownLossy(blocks as never)
}

describe('an inline node inside a table cell on BlockNote 0.54', () => {
  const table = [
    '| a | b | c |',
    '| --- | --- | --- |',
    `| [[Roadmap]] | ${MENTION} | [[Roadmap\\|the plan]] |`,
    '| [x] done | b | c |'
  ].join('\n')

  it('the promoted table really holds inline nodes, not token text', async () => {
    // #given / #when
    const [block] = await promotedBlocks(table)

    // #then — without this, both editors below would serialize plain text and
    // agree for the wrong reason
    const types = JSON.stringify(block)
    for (const type of ['wikiLink', 'linkMention', 'inlineCheckbox']) {
      expect(types).toContain(`"type":"${type}"`)
    }
  })

  it('writes every token when the specs go through the wrapper', async () => {
    // #given
    const blocks = await promotedBlocks(table)

    // #when
    const markdown = await exportThrough(wrapped, blocks)

    // #then
    expect(markdown).toContain('[[Roadmap]]')
    expect(markdown).toContain(MENTION)
    expect(markdown).toContain('[[Roadmap\\|the plan]]')
    expect(markdown).toContain('[x] done')
  })

  it('negative control: without the wrapper the chip text reaches the file', async () => {
    // #given the same blocks, exported by an editor whose inline specs were
    // registered raw
    const blocks = await promotedBlocks(table)

    // #when
    const markdown = await exportThrough(unwrapped, blocks)

    // #then #1865's exact damage, still present on 0.54: the link's target and
    // the mention's token are gone, and the alias replaces the aliased link.
    // If this starts failing, 0.54+ reaches `toExternalHTML` below a table and
    // `serializeThroughExternalHTML` can become a no-op.
    expect(markdown).not.toContain('[[Roadmap]]')
    expect(markdown).not.toContain(MENTION)
    expect(markdown).not.toContain('[[Roadmap\\|the plan]]')
    expect(markdown).toContain('| Roadmap ')
    expect(markdown).toContain('[example.com](https://example.com/plain)')
    expect(markdown).toContain('| the plan ')
  })

  it('outside a table the unwrapped specs are already fine', async () => {
    // #given — pins that the table is the ONLY path the wrapper changes: the
    // exporter does reach `toExternalHTML` for a paragraph's inline content
    const blocks = await promotedBlocks(`See [[Roadmap]] and ${MENTION}.`)

    // #when
    const markdown = await exportThrough(unwrapped, blocks)

    // #then
    expect(markdown).toContain('[[Roadmap]]')
    expect(markdown).toContain(MENTION)
  })
})
