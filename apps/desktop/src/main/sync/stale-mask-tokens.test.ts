/**
 * A mask token an older build left in a stored document never reaches the file.
 *
 * The read path hides constructs behind placeholders that carry a word drawn
 * once per process, so no process can decode another's. An older build that
 * seeded `[a](u  \nv)` left `uMEMRYHBK<word>0;` in the link's address, and a
 * note that falls back to house style wrote that into the vault on its next
 * edit. Write-back drops every token of the shapes a build could have left.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Block } from '@blocknote/core'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { blocksToYFragment, yDocToMarkdown } from './blocknote-converter'

/** A word of another process: twelve capitals, not this process's. */
const WORD = 'ZYXWVUTSRQPO'

const TOKENS: Array<[string, string]> = [
  ['a hard break', `MEMRYHBK${WORD}0;`],
  ['an empty block', `MEMRYEMB${WORD}`],
  ['an emphasis run', `MEMRYEMO${WORD}3;`],
  ['an emphasis run end', `MEMRYEMC${WORD}3;`],
  ['a code run', `MEMRYEMK${WORD}3;`],
  ['an underscore', `MEMRYEMU${WORD}3;`],
  ['a spaced address', `MEMRYLNK${WORD}12X`],
  ['an inline token', `MEMRYTKN${WORD}1X`],
  ['a code span character', `MEMRYCSP${WORD}1X`],
  ['a comment', `MEMRYCMT${WORD}3c20c6dX`],
  ['a colour start', `MEMRYICO${WORD}2:`],
  ['a colour end', `:MEMRYICC${WORD};`]
]

function docOf(blocks: unknown[]): Y.Doc {
  const doc = new Y.Doc()
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- partial blocks: ensureBlockIds fills the ids
  expect(blocksToYFragment(blocks as Block[], doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  return doc
}

const text = (value: string): unknown => ({ type: 'text', text: value, styles: {} })

const paragraph = (...content: unknown[]): unknown => ({
  type: 'paragraph',
  props: {},
  content,
  children: []
})

async function written(blocks: unknown[]): Promise<string> {
  const markdown = await yDocToMarkdown(docOf(blocks))
  expect(markdown).not.toBeNull()
  return markdown ?? ''
}

describe('a stale mask token in a stored document', () => {
  it.each(TOKENS)('is dropped from a link address: %s', async (_name, token) => {
    const markdown = await written([
      paragraph({
        type: 'link',
        href: `https://e.com/u${token}v`,
        content: [text('a')]
      })
    ])
    expect(markdown).toBe('[a](https://e.com/uv)')
  })

  it.each(TOKENS)('is dropped from text: %s', async (_name, token) => {
    expect(await written([paragraph(text(`a${token}b`))])).toBe('ab')
  })

  it('is dropped from a table cell, a heading, a list item and a quote', async () => {
    const [, token] = TOKENS[0]
    const markdown = await written([
      { type: 'heading', props: { level: 2 }, content: [text(`h${token}`)], children: [] },
      { type: 'bulletListItem', props: {}, content: [text(`i${token}`)], children: [] },
      { type: 'quote', props: {}, content: [text(`q${token}`)], children: [] },
      {
        type: 'table',
        props: {},
        content: {
          type: 'tableContent',
          rows: [{ cells: [[text(`c${token}`)], [text('d')]] }]
        },
        children: []
      }
    ])
    expect(markdown).not.toContain('MEMRY')
    expect(markdown).toContain('## h')
    expect(markdown).toContain('- i')
    expect(markdown).toContain('> q')
  })

  it('is dropped from an image address and a code block', async () => {
    const [, token] = TOKENS[0]
    const markdown = await written([
      {
        type: 'image',
        props: { url: `https://e.com/i.png${token}`, caption: `c${token}` },
        children: []
      },
      {
        type: 'codeBlock',
        props: { language: 'text' },
        content: [text(`x${token}`)],
        children: []
      }
    ])
    expect(markdown).not.toContain('MEMRY')
  })

  it('restores the < a hidden details tag stood for', async () => {
    expect(await written([paragraph(text(`MEMRYDLT${WORD};summary>x`))])).toBe('<summary>x')
  })

  it('leaves text that only looks like a token', async () => {
    const same = ['MEMRYHBK0;', 'MEMRYHBK', 'MEMRYHBKabc0;', `MEMRYHBK${WORD}`, 'MEMRYX', 'MEMRY']
    for (const value of same) {
      expect(await written([paragraph(text(`a ${value} b`))])).toBe(`a ${value} b`)
    }
  })
})
