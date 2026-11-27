/**
 * The renderer reads markdown into the document main reads it into.
 *
 * Both processes run one pipeline (`@memry/editor-schema/note-markdown`), so
 * the same bytes open the same way whether a note is pasted, seeded from a
 * template or opened from the vault. Each case below is a place the renderer's
 * old hand-kept copy of main's parser drifted; the expected documents are the
 * ones main builds (differential harness over the real server schema).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type Block } from '@blocknote/core'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    parse: () => Promise.resolve(true),
    render: () => Promise.resolve({ svg: '<svg/>' })
  }
}))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
})

import { editorSchema } from './editor-schema'
import { parseMarkdownPreservingBlanks } from './markdown-utils'

const editor = BlockNoteEditor.create({ schema: editorSchema, _headless: true } as never)

const types = async (markdown: string): Promise<string[]> =>
  (await parseMarkdownPreservingBlanks(editor, markdown)).map((block) => block.type as string)

const parse = (markdown: string): Promise<Block[]> =>
  parseMarkdownPreservingBlanks(editor, markdown)

const CALLOUT = '> [!info]\n> hi'

describe('markdown the renderer reads as main does', () => {
  it('keeps `$$` directly under a callout as text, since it does not start a paragraph', async () => {
    expect(await types(`${CALLOUT}\n$$\nx\n$$`)).toEqual(['callout', 'paragraph'])
  })

  it.each([
    ['an image', '![a](https://e.com/a.png)', 'image'],
    ['a bookmark', '![bookmark](https://e.com)', 'bookmark'],
    ['a whiteboard', '![whiteboard](memry://canvas/abc)', 'whiteboard'],
    ['a YouTube line', '![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)', 'youtubeEmbed']
  ])('claims a callout on the line under %s', async (_, line, type) => {
    expect(await types(`${line}\n${CALLOUT}`)).toEqual([type, 'callout'])
  })

  it.each([
    ['a relative path', 'assets/p.png'],
    ['a mailto link', 'mailto:a@b.c']
  ])('keeps `![bookmark](…)` with %s as an image', async (_, url) => {
    const [block] = await parse(`![bookmark](${url})`)
    expect(block.type).toBe('image')
    expect(block.props).toMatchObject({ url })
  })

  it.each([
    ['a list item', '- ![x](assets/p.png)', 'assets/p.png'],
    ['a list item body', '- a\n\n  ![x](../attachments/p.png)', '../attachments/p.png']
  ])('keeps a note-relative image address as written in %s', async (_, markdown, url) => {
    // `img.src` resolves against the page's base URL; written back, that is
    // how a vault stops being portable between machines.
    const urls = JSON.stringify(await parse(markdown)).match(/"url":"[^"]*"/g)
    expect(urls).toEqual([`"url":"${url}"`])
  })

  it('keeps a file marker inside a code fence as code', async () => {
    const marker =
      '<!-- file:{"url":"memry-file://local/a.pdf","name":"a.pdf","size":1,"mimeType":"application/pdf"} -->'
    const blocks = await parse(`\`\`\`\n${marker}\n\`\`\``)
    expect(blocks.map((block) => block.type)).toEqual(['codeBlock'])
    expect(JSON.stringify(blocks[0].content)).toContain('<!-- file:')
  })

  it('keeps every header cell of a table whose first one is a wiki link', async () => {
    const [table] = await parse('| [[w|al]] | ![i](https://e.com/i.png) |\n|---|---|\n| a | b |')
    const content = table.content as { rows: Array<{ cells: Array<{ content: unknown[] }> }> }
    const [first, second] = content.rows[0].cells
    expect(content.rows[0].cells).toHaveLength(2)
    expect(first.content).toEqual([expect.objectContaining({ type: 'text', text: '[[w|al]]' })])
    expect(second.content).toEqual([expect.objectContaining({ type: 'inlineImage' })])
  })
})
