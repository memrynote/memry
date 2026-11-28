/**
 * A comment between backticks is read the way the parser reads the backticks.
 *
 * The comment mask runs before the parse, so it has to find the same code
 * spans the parser does: a backslash makes a backtick text, and a run with no
 * closer of its length retries from each later backtick of the run. A mask
 * that disagreed hid a comment the parser then read inside a span (one backtick
 * lost on write-back), or let the parser drop one (`\`<!-- c -->\``).
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { canonicalFragment } from '../../../../../packages/contracts/scripts/fragment-canonical'
import { markdownToYFragment, yDocToCanonicalMarkdown } from './blocknote-converter'

async function seed(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'markdown reached the shared doc').toBe(true)
  return doc
}

/** The leaf lines of a one-paragraph note, the paragraph's own line left out. */
function inlineOf(doc: Y.Doc): string[] {
  return canonicalFragment(doc)
    .split('\n')
    .filter((line) => /^\s*\d+ (text|element htmlComment)/.test(line))
    .map((line) => line.replace(/^\s*\d+ /, ''))
}

const TICK = '`'
const ESCAPED = '\\' + TICK

describe('a comment between escaped backticks', () => {
  it.each([
    ['an HTML comment', `${ESCAPED}<!-- c -->${ESCAPED}`, '<!-- c -->'],
    ['a %% comment', `${ESCAPED}%%x%%${ESCAPED}`, '%%x%%'],
    ['a %% comment in a line of text', `a ${ESCAPED}%%x%%${ESCAPED} b`, '%%x%%']
  ])('keeps %s as a node between two text backticks', async (_name, markdown, source) => {
    const doc = await seed(markdown)
    const leaves = inlineOf(doc)
    expect(leaves.filter((leaf) => leaf.startsWith('element htmlComment'))).toEqual([
      `element htmlComment source="${source}"`
    ])
    const text = leaves.filter((leaf) => leaf.startsWith('text')).join('')
    expect(text.replaceAll('text ', '').replaceAll('"', '')).toContain(TICK)
    expect(await yDocToCanonicalMarkdown(doc)).toBe(markdown)
  })
})

describe('a comment in a run of backticks with no closer of its length', () => {
  it('stays in the span the parser reads, and nothing is lost on write-back', async () => {
    const markdown = 'a``%%x%%b`c'
    const first = await seed(markdown)
    expect(inlineOf(first)).toEqual(['text "a`"', 'text "%%x%%b" code={}', 'text "c"'])
    const written = await yDocToCanonicalMarkdown(first)
    expect(written).toBe('a\\``%%x%%b`c')
    const second = await seed(written ?? '')
    expect(inlineOf(second)).toEqual(inlineOf(first))
    expect(await yDocToCanonicalMarkdown(second)).toBe(written)
  })

  it('keeps the backticks around an empty span after an escaped one', async () => {
    const doc = await seed('\\``%%x%%`')
    expect(inlineOf(doc)).toEqual(['text "`"', 'text "%%x%%" code={}'])
  })
})
