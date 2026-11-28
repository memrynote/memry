/**
 * Raw HTML the editor has no node for stays text in the document.
 *
 * BlockNote's markdown pass hands `<kbd>` through as HTML, ProseMirror has no
 * node for it and drops it, and a `<script>` loses its body with it. A tag at a
 * line start that is a block tag also became a raw HTML block that split its
 * paragraph. The tag is kept as the characters the author wrote, so nothing a
 * note holds vanishes when its paragraph is re-spelled.
 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Block } from '@blocknote/core'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  markdownToYFragment,
  yDocToCanonicalMarkdown,
  yFragmentToBlocks
} from './blocknote-converter'

async function seed(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  expect(await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  return doc
}

async function blocksOf(doc: Y.Doc): Promise<Block[]> {
  return (await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))) as Block[]
}

/** The blocks with their random ids removed, as JSON. */
function shape(blocks: Block[]): string {
  return JSON.stringify(blocks, (key, value: unknown) => (key === 'id' ? undefined : value))
}

interface Run {
  type: string
  text?: string
  styles?: Record<string, unknown>
  content?: Run[]
}

function runsOf(blocks: Block[]): Run[] {
  const out: Run[] = []
  const visit = (list: Block[]): void => {
    for (const block of list) {
      if (Array.isArray(block.content)) out.push(...(block.content as unknown as Run[]))
      visit(block.children ?? [])
    }
  }
  visit(blocks)
  return out
}

/** The characters of every text run, in order. */
const textOf = (blocks: Block[]): string =>
  runsOf(blocks)
    .map((run) => run.text ?? '')
    .join('')

const UNHANDLED = [
  '<kq>',
  '</kq>',
  '<kq-->',
  '<kbd>Ctrl</kbd>',
  '<kbd>Ctrl</kbd>+<kbd>K</kbd>',
  '<span>x</span>',
  '<sup>2</sup>',
  '<mark>m</mark>',
  '<x-y>',
  '<!x>',
  '<?x?>',
  '<![CDATA[x]]>',
  '<div>',
  '</div>',
  '<p>',
  '<details>',
  '<summary>s</summary>',
  '<script>kq9</script>',
  '<style>kq9</style>',
  '\\<kq>',
  '<kq a="1 2">',
  '<div class="x">',
  '<input type=text>',
  '<kq/>',
  '<x a="*b*">',
  '<x a="_">',
  '<kq\nb>',
  '<div',
  '<?x',
  '< kq>',
  '<1>'
]

const CONTEXTS: Array<[string, string]> = [
  ['paragraph', 'kq0 {t} kq1'],
  ['mid-word', 'kq0{t}kq1'],
  ['list item', '- kq0 {t} kq1'],
  ['quote', '> kq0 {t} kq1'],
  ['heading', '# kq0 {t} kq1'],
  ['bold', '**kq0 {t} kq1**'],
  ['table cell', '| a | b |\n| - | - |\n| kq0 {t} kq1 | x |'],
  ['alone', '{t}'],
  ['blank-separated', 'kq0\n\n{t}\n\nkq1'],
  ['soft-break separated', 'kq0\n{t}\nkq1'],
  ['link label', '[kq0 {t} kq1](https://e.com)'],
  ['image alt', '![kq0 {t} kq1](https://e.com/i.png)']
]

/** A tag with a line break in it reads as two lines, so it is checked line by line. */
const lines = (text: string): string[] => text.split('\n')

describe('raw HTML the editor does not handle', () => {
  describe.each(UNHANDLED)('%j', (tag) => {
    it.each(CONTEXTS)(
      'stays in the text of a %s, and settles on its own write',
      async (_label, pattern) => {
        const markdown = pattern.replace('{t}', tag)
        const doc = await seed(markdown)
        const out = (await yDocToCanonicalMarkdown(doc)) as string
        for (const line of lines(tag)) expect(out).toContain(line)
        expect(JSON.stringify(await blocksOf(doc))).not.toContain('MEMRY')
        expect(out).not.toContain('MEMRY')
        const again = await seed(out)
        expect(shape(await blocksOf(again))).toBe(shape(await blocksOf(doc)))
        expect(await yDocToCanonicalMarkdown(again)).toBe(out)
      }
    )
  })

  it('keeps a tag and the text around it in one paragraph', async () => {
    for (const markdown of [
      'kq0 <div> kq1',
      'kq0\n<div>\nkq1',
      'kq0\n<p>kq1',
      'kq0 <summary><!-- c'
    ]) {
      const blocks = await blocksOf(await seed(markdown))
      expect(blocks.filter((block) => block.type === 'paragraph')).toHaveLength(1)
    }
  })

  it('keeps the body of a script and a style', async () => {
    expect(textOf(await blocksOf(await seed('kq0 <script>kq9</script> <style>kq8</style>')))).toBe(
      'kq0 <script>kq9</script> <style>kq8</style>'
    )
  })

  it('keeps the characters inside a tag out of the markdown parse', async () => {
    const blocks = await blocksOf(await seed('a <x a="*b*"> c <x a="_" b="_"> d'))
    expect(runsOf(blocks).every((run) => run.styles?.italic !== true)).toBe(true)
    expect(textOf(blocks)).toBe('a <x a="*b*"> c <x a="_" b="_"> d')
  })

  it('writes a tag with a mark character in it verbatim, and not once more per round trip', async () => {
    let markdown = 'a <x a="*"> b *c* d <x a="_"> e _f_'
    const first = (await yDocToCanonicalMarkdown(await seed(markdown))) as string
    expect(first).toContain('<x a="*">')
    expect(first).toContain('<x a="_">')
    markdown = first
    for (let round = 0; round < 3; round++) {
      markdown = (await yDocToCanonicalMarkdown(await seed(markdown))) as string
    }
    expect(markdown).toBe(first)
  })

  it('reads emphasis next to and between tags as it did with the angle brackets there', async () => {
    const between = await blocksOf(await seed('<kbd>_x_</kbd>'))
    expect(runsOf(between).map((run) => [run.text, run.styles?.italic === true])).toEqual([
      ['<kbd>', false],
      ['x', true],
      ['</kbd>', false]
    ])
    const word = await blocksOf(await seed('a_<kbd>'))
    expect(textOf(word)).toBe('a_<kbd>')
    expect(runsOf(word).every((run) => run.styles?.italic !== true)).toBe(true)
  })

  it('leaves a tag in code as it was written', async () => {
    const markdown = 'kq0 `<kbd>` kq1\n\n```\n<div>\n<script>kq9</script>\n```'
    const doc = await seed(markdown)
    expect(await yDocToCanonicalMarkdown(doc)).toBe(markdown)
    expect(JSON.stringify(await blocksOf(doc))).not.toContain('MEMRY')
  })

  it('leaves a tag that opens a link address as the address', async () => {
    for (const [markdown, href] of [
      ['[a](<x>)', 'x'],
      ['[a](<x y>)', '<x y>']
    ]) {
      const blocks = await blocksOf(await seed(markdown))
      const link = runsOf(blocks).find((run) => run.type === 'link') as { href?: string }
      expect(link.href).toBe(href)
    }
  })

  it('keeps the tags the editor handles', async () => {
    const blocks = await blocksOf(await seed('kq0 <b>bold</b> <code>c</code> kq1'))
    expect(runsOf(blocks).some((run) => run.styles?.bold === true)).toBe(true)
    expect(runsOf(blocks).some((run) => run.styles?.code === true)).toBe(true)
  })

  it('keeps the tags the editor converts to a node', async () => {
    const types = async (markdown: string): Promise<string[]> =>
      (await blocksOf(await seed(markdown))).map((block) => block.type)
    expect(await types('<h2>t</h2>')).toEqual(['heading'])
    expect(await types('<blockquote>q</blockquote>')).toEqual(['quote'])
    expect(await types('<ul><li>a</li><li>b</li></ul>')).toEqual([
      'bulletListItem',
      'bulletListItem'
    ])
    expect(await types('<table>\n<tr><td>a</td></tr>\n</table>')).toEqual(['table'])
    expect(await types('<pre><code>a  \nb</code></pre>')).toEqual(['codeBlock'])
    expect(await types('a\n\n<hr />\n\nb')).toContain('divider')
    expect(
      await types(
        '<figure><img alt="|320" src="https://e.com/i.png"><figcaption>c</figcaption></figure>'
      )
    ).toEqual(['image'])
  })

  it('keeps a closing span that closes a plain span, or nothing, as text', async () => {
    for (const markdown of ['a <span>x</span> b</span> c', 'a </span> b']) {
      expect(textOf(await blocksOf(await seed(markdown)))).toBe(markdown)
    }
  })

  it('reads a note from before lossless blocks as it did', async () => {
    const { parseMarkdownToBlocksRepaired } = await import('@memry/editor-schema/parse-markdown')
    const editorHost = {
      tryParseMarkdownToBlocks: async () => [] as unknown[],
      tryParseHTMLToBlocks: () => [] as unknown[]
    }
    const seen: string[] = []
    await parseMarkdownToBlocksRepaired(
      {
        ...editorHost,
        tryParseMarkdownToBlocks: async (markdown: string) => {
          seen.push(markdown)
          return []
        }
      },
      'a <kbd>b</kbd>',
      { losslessBlocks: false }
    )
    expect(seen).toEqual(['a <kbd>b</kbd>'])
  })
})
