/**
 * HTML comments through the shared doc (AF-015). The editor has an inline
 * `htmlComment` node for them, so a comment is part of the document rather
 * than bytes the source record happens to carry: an edit beside it, or a
 * house-style write-back with no record at all, writes it back unchanged.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Block } from '@blocknote/core'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { writeMarkdownSourceToYDoc } from '@memry/shared/markdown-source'
import {
  blocksToYFragment,
  markdownToYFragment,
  yDocToMarkdown,
  yFragmentToBlocks
} from './blocknote-converter'

const LT_002 = [
  '<!-- hidden links: [[Alpha]] [[Beta]] -->',
  '# Hidden links',
  '',
  'Line to edit.',
  '<!-- right under the edited line [[Gamma]] -->',
  '',
  'Inline <!-- inline [[Delta]] --> comment here.',
  '',
  '<!--',
  'A multi-line comment [[Epsilon]]',
  '',
  '## A heading inside it',
  '',
  '```js',
  'const x = 1',
  '```',
  '-->',
  '',
  '%% obsidian [[Zeta]] %%',
  '',
  '%%',
  'block obsidian comment [[Iota]]',
  '%%',
  '',
  'Footnote ref[^1].',
  '',
  '[^1]: The note [[Eta]].',
  ''
].join('\n')

const COMMENTS = [
  '<!-- hidden links: [[Alpha]] [[Beta]] -->',
  '<!-- right under the edited line [[Gamma]] -->',
  '<!-- inline [[Delta]] -->',
  '<!--\nA multi-line comment [[Epsilon]]\n\n## A heading inside it\n\n```js\nconst x = 1\n```\n-->'
]

const OTHER_FORMS = [
  '%% obsidian [[Zeta]] %%',
  '%%\nblock obsidian comment [[Iota]]\n%%',
  '[^1]: The note [[Eta]].'
]

async function seed(markdown: string, { keepSource = true } = {}): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok).toBe(true)
  if (!keepSource) writeMarkdownSourceToYDoc(doc, null)
  return doc
}

async function blocksOf(doc: Y.Doc): Promise<Block[]> {
  return (await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))) as Block[]
}

function inlineItems(blocks: Block[]): Array<{ type: string; text?: string; props?: unknown }> {
  const out: Array<{ type: string; text?: string; props?: unknown }> = []
  const visit = (list: Block[]): void => {
    for (const block of list) {
      if (Array.isArray(block.content)) out.push(...(block.content as never[]))
      visit((block.children ?? []) as Block[])
    }
  }
  visit(blocks)
  return out
}

/** Retype `from` as `to` inside its text run, leaving every other node as it is. */
async function edit(doc: Y.Doc, from: string, to: string): Promise<void> {
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const blocks = await blocksOf(doc)
  const run = inlineItems(blocks).find((item) => item.type === 'text' && item.text?.includes(from))
  if (!run) throw new Error(`no text run holds ${from}`)
  run.text = (run.text as string).replace(from, to)
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    blocksToYFragment(blocks, fragment)
  })
}

describe('HTML comments in the shared doc (AF-015)', () => {
  it('holds each comment as an htmlComment node, never as text', async () => {
    const items = inlineItems(await blocksOf(await seed(LT_002)))
    const comments = items.filter((item) => item.type === 'htmlComment')
    expect(comments.map((item) => (item.props as { source: string }).source)).toEqual(COMMENTS)
    for (const item of items) {
      if (item.type === 'text') expect(item.text).not.toContain('<!--')
    }
  })

  it('keeps the heading under a comment a heading', async () => {
    const blocks = await blocksOf(await seed(LT_002))
    expect(blocks.some((block) => block.type === 'heading')).toBe(true)
  })

  it.each([
    ['with the source record', true],
    ['in house style, with no record', false]
  ])('writes every comment back byte for byte %s', async (_label, keepSource) => {
    const doc = await seed(LT_002, { keepSource })
    const out = (await yDocToMarkdown(doc)) as string
    for (const comment of [...COMMENTS, ...OTHER_FORMS]) expect(out).toContain(comment)
    expect(await yDocToMarkdown(await seed(out, { keepSource }))).toBe(out)
  })

  it.each([
    ['the line right above a comment', 'Line to edit.', 'Line, edited.'],
    ['the text around an inline comment', 'Inline ', 'Inline, edited, '],
    ['the heading under a comment', 'Hidden links', 'Hidden links, edited'],
    ['the paragraph after a multi-line comment', '%% obsidian', '%% obsidian edited']
  ])('keeps every comment through an edit to %s', async (_label, from, to) => {
    for (const keepSource of [true, false]) {
      const doc = await seed(LT_002, { keepSource })
      await edit(doc, from, to)
      const out = (await yDocToMarkdown(doc)) as string
      expect(out).toContain(to)
      for (const comment of COMMENTS) expect(out).toContain(comment)
      for (const form of OTHER_FORMS) expect(out).toContain(form.replace(from, to))
    }
  })

  it('changes only the edited line when the record is kept', async () => {
    const doc = await seed(LT_002)
    await edit(doc, 'Inline ', 'Inline, edited, ')
    expect(await yDocToMarkdown(doc)).toBe(LT_002.replace('Inline ', 'Inline, edited, '))
  })

  it('leaves a comment in a code span or a fence as code', async () => {
    const markdown = 'Use `<!-- x -->` here.\n\n```html\n<!-- y -->\n```\n'
    const doc = await seed(markdown, { keepSource: false })
    expect(inlineItems(await blocksOf(doc)).some((item) => item.type === 'htmlComment')).toBe(false)
    expect(await yDocToMarkdown(doc)).toBe(markdown.trimEnd())
  })

  it('keeps a comment inside a list item and a table cell', async () => {
    const markdown = '- item <!-- li -->\n- two\n\n| a | b |\n| --- | --- |\n| 1 <!-- td --> | 2 |'
    const doc = await seed(markdown, { keepSource: false })
    const out = (await yDocToMarkdown(doc)) as string
    expect(out).toContain('- item <!-- li -->')
    expect(out).toContain('1 <!-- td -->')
  })
})
