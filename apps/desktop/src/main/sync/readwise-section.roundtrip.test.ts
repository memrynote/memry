/**
 * The Readwise section must be a fixed point of the main-process markdown
 * round trip (D5, #1410). The writer replaces the section only while its hash
 * matches. If an edit anywhere in the note rewrote the section's bytes on
 * writeback, the hash would stop matching and the section would count as
 * touched, so sync would stop applying Readwise edits to it.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { writeMarkdownSourceToYDoc } from '@memry/shared/markdown-source'
import { planNote, readSection, type NotePlan } from '@memry/importers/readwise'
import {
  COVER_PATH,
  COVER_URL,
  FULL_BOOK,
  TRICKY_BOOK,
  book,
  highlight
} from '@memry/importers/readwise/fixtures'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'

/** House style: the source bytes beside the doc are cleared, as in the conformance corpus. */
async function roundTrip(markdown: string): Promise<string> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'markdown reached the shared doc').toBe(true)
  writeMarkdownSourceToYDoc(doc, null)
  const out = await yDocToMarkdown(doc)
  expect(out, 'the doc serialized back at all').not.toBeNull()
  return out as string
}

const images = new Map([[COVER_URL, COVER_PATH]])

function plan(source: Parameters<typeof planNote>[0], timeZone = 'UTC'): NotePlan {
  const result = planNote(source, {
    root: 'Readwise',
    folderLayout: 'by-category',
    categories: {},
    timeZone,
    images
  })
  if (!result || 'deleted' in result) throw new Error('expected a note plan')
  return result
}

const CASES: Array<[string, NotePlan]> = [
  ['a full book with cover, notes, summary, headings and tags', plan(FULL_BOOK)],
  ['text that looks like Memry syntax', plan(TRICKY_BOOK)],
  [
    'an article without an image line',
    plan(
      book(103, { category: 'articles', cover_image_url: COVER_URL, highlights: [highlight(1)] })
    )
  ],
  ['a book with no highlights', plan(book(104))],
  [
    'an image highlight',
    plan(
      book(105, {
        category: 'articles',
        highlights: [highlight(1, { text: '![](https://cdn.example.com/a.png)' })]
      })
    )
  ]
]

describe('Readwise section, main markdown round trip', () => {
  it.each(CASES)('%s comes back byte for byte', async (_name, { section }) => {
    expect(await roundTrip(section)).toBe(section)
  })

  it.each(CASES)('%s stays untouched after an edit beside it', async (_name, { section }) => {
    const note = `Intro written by the user.\n\n${section}\n\nA thought below the section.`
    const once = await roundTrip(note)
    expect(once).toBe(note)
    const read = readSection(once)
    expect(read.found && read.untouched).toBe(true)
  })
})
