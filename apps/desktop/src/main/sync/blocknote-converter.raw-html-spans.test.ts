/**
 * A `</span>` that closes no coloured span stays text, whatever else the note holds.
 *
 * A colour or underline span reaches the editor as a token pair around its text.
 * Once a note held one, every `</span>` in it became a closing token, whether a
 * coloured span, a plain `<span>` or nothing had opened it, and a closing token
 * that found no open colour was dropped: `a </span> b <span style="color:red">c</span>`
 * lost its first tag. The writer made the same note out of `</span> <u>x</u>`,
 * which is read as text the first time and lost the second time. A closing tag
 * now closes the innermost open `<span>`, a coloured one only when that is what
 * it opened.
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

interface Run {
  type: string
  text?: string
  styles?: Record<string, unknown>
}

async function seed(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  expect(await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  return doc
}

async function runsOf(markdown: string): Promise<Run[]> {
  const doc = await seed(markdown)
  const blocks = (await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))) as Block[]
  return blocks.flatMap((block) => (Array.isArray(block.content) ? (block.content as Run[]) : []))
}

/** The note written, then read and written again. */
async function settle(markdown: string): Promise<{ once: string; twice: string }> {
  const once = (await yDocToCanonicalMarkdown(await seed(markdown))) ?? ''
  return { once, twice: (await yDocToCanonicalMarkdown(await seed(once))) ?? '' }
}

describe('a closing span tag that closes no coloured span', () => {
  it.each([
    [
      'a </span> b <span style="color:red">c</span>',
      'a \\</span> b <span style="color:red">c</span>'
    ],
    [
      '<span style="color:red">c</span> a </span> b',
      '<span style="color:red">c</span> a \\</span> b'
    ],
    ['<span style="color:red">a</span></span>', '<span style="color:red">a</span>\\</span>'],
    [
      '</span></span> <span style="text-decoration:underline">x</span>',
      '\\</span>\\</span> <span style="text-decoration:underline">x</span>'
    ],
    [
      '<span>a</span> <span style="color:red">c</span>',
      '\\<span>a\\</span> <span style="color:red">c</span>'
    ],
    [
      '<span class="x">a</span> <span style="color:red">c</span> <span>d</span>',
      '\\<span class="x">a\\</span> <span style="color:red">c</span> \\<span>d\\</span>'
    ],
    [
      '<span style="color:red">a <span>b</span> c</span>',
      '<span style="color:red">a \\<span>b\\</span> c</span>'
    ],
    [
      '`</span>` <span style="color:red">c</span> </span>',
      '`</span>` <span style="color:red">c</span> \\</span>'
    ]
  ])('is kept as text, escaped, in %s', async (markdown, written) => {
    const { once, twice } = await settle(markdown)
    expect(once).toBe(written)
    expect(twice).toBe(written)
  })

  it('is read as text, and the coloured span as a colour', async () => {
    const runs = await runsOf('a </span> b <span style="color:red">c</span>')
    expect(runs.map((run) => [run.text, run.styles?.textColor])).toEqual([
      ['a </span> b ', undefined],
      ['c', 'red']
    ])
  })

  it('does not end a coloured span early', async () => {
    const runs = await runsOf('<span style="color:red">a <span>b</span> c</span> d')
    expect(runs.map((run) => [run.text, run.styles?.textColor])).toEqual([
      ['a <span>b</span> c', 'red'],
      [' d', undefined]
    ])
  })
})

describe('a tag the writer makes out of a mark', () => {
  it.each([
    ['</span> <u>x</u>', '\\</span> <span style="text-decoration:underline">x</span>'],
    [
      '<span>a</span> <u>x</u>',
      '\\<span>a\\</span> <span style="text-decoration:underline">x</span>'
    ]
  ])('does not take a `</span>` of %j', async (markdown, written) => {
    const { once, twice } = await settle(markdown)
    expect(once).toBe(written)
    expect(twice).toBe(written)
  })
})

describe('a closing span tag in a later block than its open', () => {
  it('is text there, and the note settles', async () => {
    const { once, twice } = await settle('<span style="color:red">a\n\nb</span>')
    expect(once).toBe('<span style="color:red">a</span>\n\nb\\</span>')
    expect(twice).toBe(once)
  })
})
