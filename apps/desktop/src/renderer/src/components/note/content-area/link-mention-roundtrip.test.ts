/**
 * A mention's real round trip: node → markdown → disk → markdown → node, with
 * the REAL editor schema and the REAL save/load serializers on both ends.
 *
 * `link-mention.test.ts` in `@memry/editor-schema` pins the token's own bytes.
 * This drives the pipeline those bytes travel through, because the failure in
 * #1844 lived between them: remark-stringify writes `*` and `~` into the token
 * unescaped, and remark-parse then reads the run between two tokens as an
 * emphasis or strikethrough span, shredding both mentions into literal text.
 * Neither half is wrong in isolation, so only the round trip catches it.
 */

import { describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type Block } from '@blocknote/core'

// pdf.js touches `DOMMatrix` at import time, which jsdom has none of. The rest
// of the schema is real.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

import { editorSchema } from './editor-schema'
import { serializeBlocksPreservingBlanks } from './markdown-utils'
import { normalizeLinkMentions } from './link-mention-utils'

function createEditor(): BlockNoteEditor {
  const editor = BlockNoteEditor.create({
    schema: editorSchema
  } as never) as unknown as BlockNoteEditor
  const element = document.createElement('div')
  document.body.appendChild(element)
  editor.mount(element)
  return editor
}

function mention(url: string): unknown {
  return {
    type: 'linkMention',
    props: { url, domain: 'x.test', title: '', favicon: '', siteName: '' }
  }
}

function paragraph(content: unknown[]): Block[] {
  return [{ id: 'b1', type: 'paragraph', props: {}, children: [], content }] as unknown as Block[]
}

/** Save the blocks, load them back, and report the mention URLs that survived. */
async function survivingUrls(editor: BlockNoteEditor, blocks: Block[]): Promise<string[]> {
  const markdown = await serializeBlocksPreservingBlanks(editor, blocks)
  const reparsed = await editor.tryParseMarkdownToBlocks(markdown)
  const { blocks: normalized } = normalizeLinkMentions(reparsed as Block[])

  const urls: string[] = []
  const walk = (items: unknown[]): void => {
    for (const item of items as Array<Record<string, any>>) {
      if (item?.type === 'linkMention') urls.push(item.props.url)
      if (Array.isArray(item?.content)) walk(item.content)
      if (Array.isArray(item?.children)) walk(item.children)
    }
  }
  walk(normalized)
  return urls
}

describe('a link mention survives the markdown round trip', () => {
  it.each([
    ['underscore', 'https://x.test/foo_bar_baz'],
    ['asterisk', 'https://x.test/a*b'],
    ['bang', 'https://x.test/a!b'],
    ['tilde', 'https://x.test/a~b'],
    ['apostrophe', "https://x.test/it's"],
    ['parens', 'https://x.test/a(b)c'],
    ['percent', 'https://x.test/100%25'],
    ['query string', 'https://x.test/s?q=a+b&page=2#frag'],
    ['space', 'https://x.test/a b'],
    ['non-ascii', 'https://eksisozluk.com/başlık/şeker'],
    ['every offender at once', "https://x.test/_*!~'()%?a=b&c=d#e"]
  ])('with %s in the URL', async (_name, url) => {
    const editor = createEditor()
    expect(await survivingUrls(editor, paragraph([mention(url)]))).toEqual([url])
  })

  it.each([
    ['asterisk', 'https://x.test/a*b', 'https://x.test/c*d'],
    ['tilde', 'https://x.test/a~b', 'https://x.test/c~d'],
    ['underscore', 'https://x.test/a_b', 'https://x.test/c_d']
  ])('with two mentions on one line, both holding a %s', async (_name, first, second) => {
    // The reported shape. Before the token alphabet was closed, the `*` and
    // `~` runs paired up ACROSS the gap between the two tokens and both
    // mentions came back as literal `((mention:…))` text.
    const editor = createEditor()
    const blocks = paragraph([
      mention(first),
      { type: 'text', text: ' and ', styles: {} },
      mention(second)
    ])
    expect(await survivingUrls(editor, blocks)).toEqual([first, second])
  })

  it('keeps a mention next to styled text', async () => {
    const editor = createEditor()
    const blocks = paragraph([
      mention('https://x.test/a*b'),
      { type: 'text', text: 'x', styles: { bold: true } }
    ])
    expect(await survivingUrls(editor, blocks)).toEqual(['https://x.test/a*b'])
  })

  it('writes bytes a second save reproduces exactly', async () => {
    // Opening a note must not rewrite it (#1434): the token has to be a fixed
    // point, or every open dirties the file and syncs a no-op change.
    const editor = createEditor()
    const url = "https://x.test/_*!~'()?a=b"
    const first = await serializeBlocksPreservingBlanks(editor, paragraph([mention(url)]))
    const reparsed = await editor.tryParseMarkdownToBlocks(first)
    const { blocks } = normalizeLinkMentions(reparsed as Block[])
    const second = await serializeBlocksPreservingBlanks(editor, blocks)
    expect(second).toBe(first)
  })
})

describe('a mangled token already on disk heals on open', () => {
  it.each([
    [
      'a stray space before the delimiter',
      '((mention:https%3A%2F%2Fx.test%2Fpage ))',
      'https://x.test/page'
    ],
    [
      'a stray escape inside the payload',
      '((mention:https%3A%2F%2Fx.test%2Fpage\\_1))',
      'https://x.test/page_1'
    ],
    ['both at once', '((mention:https%3A%2F%2Fx.test%2Fpage\\_1 ))', 'https://x.test/page_1']
  ])('recovers a mention from %s', (_name, text, expected) => {
    // Straight to the normalizer, not through `tryParseMarkdownToBlocks`:
    // remark unescapes `\_` while parsing, so the block text is the only place
    // a stray backslash can actually be observed.
    const { blocks, didChange } = normalizeLinkMentions(
      paragraph([{ type: 'text', text, styles: {} }])
    )

    expect(didChange).toBe(true)
    const content = (blocks[0] as Block).content as Array<Record<string, any>>
    expect(content[0].type).toBe('linkMention')
    expect(content[0].props.url).toBe(expected)
  })

  it('leaves prose that merely looks like a token alone', () => {
    const text = '((mention: see the note below))'
    expect(normalizeLinkMentions(paragraph([{ type: 'text', text, styles: {} }])).didChange).toBe(
      false
    )
  })
})
