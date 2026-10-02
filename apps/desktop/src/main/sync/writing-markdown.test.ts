import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  readCriticMarkupMarksFromYDoc,
  readWritingAlternativesFromYDoc,
  readWritingGhostsFromYDoc,
  readWritingOverflowFromYDoc,
  writeWritingOverflowToYDoc,
  type WritingFrontmatter
} from '@memry/shared'
import {
  applyFragmentSeed,
  markdownToYFragment,
  prepareFragmentSeed,
  yDocToMarkdown,
  yDocToMarkdownWithWritingRanges
} from './blocknote-converter'
import { serializeNoteBody, type NoteBody } from './writing-markdown'

const EMPTY: WritingFrontmatter = { alternatives: {}, overflow: [] }

/** What the write-back puts in the file for `doc`. */
function written(doc: Y.Doc): Promise<NoteBody | null> {
  return serializeNoteBody(doc, {}, { yDocToMarkdown, yDocToMarkdownWithWritingRanges })
}

async function seed(markdown: string, writing: WritingFrontmatter = EMPTY): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(
    markdown,
    doc.getXmlFragment(CRDT_FRAGMENT_NAME),
    undefined,
    writing
  )
  expect(ok).toBe(true)
  return doc
}

/** Every text run of the body, joined: what the editor shows. */
function bodyText(doc: Y.Doc): string {
  const parts: string[] = []
  const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) parts.push(child.toString())
      else if (child instanceof Y.XmlElement) visit(child)
    }
  }
  visit(doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  return parts.join('\n')
}

function firstText(doc: Y.Doc): Y.XmlText {
  let found: Y.XmlText | null = null
  const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (found) return
      if (child instanceof Y.XmlText) found = child
      else if (child instanceof Y.XmlElement) visit(child)
    }
  }
  visit(doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  if (!found) throw new Error('no text run')
  return found
}

describe('writing tools in markdown', () => {
  const body = [
    'Sabah <!--alt:k3x9-->keskin<!--/alt:k3x9--> bir ruzgar esiyordu.',
    '',
    'Kahve dukkani <!--ghost-->biraz fazla<!--/ghost--> kalabalikti.'
  ].join('\n')
  const writing: WritingFrontmatter = {
    alternatives: {
      k3x9: {
        original: 'ayaz',
        versions: [{ text: 'soguk' }, { text: 'keskin', ai: true }]
      }
    },
    overflow: [{ text: 'Belki de en iyisi hic yazmamakti.', label: 'Spare' }, { text: 'ikinci' }]
  }

  it('seeds records from the file and writes the same file back', async () => {
    const doc = await seed(body, writing)

    expect(bodyText(doc)).not.toContain('<!--')
    const [alternative] = readWritingAlternativesFromYDoc(doc)
    expect(alternative).toMatchObject({ id: 'k3x9', original: 'ayaz' })
    expect(alternative.variants.map((variant) => [variant.text, variant.source])).toEqual([
      ['soguk', 'user'],
      ['keskin', 'ai']
    ])
    expect(alternative.variants.find((v) => v.id === alternative.activeVariantId)?.text).toBe(
      'keskin'
    )
    expect(readWritingGhostsFromYDoc(doc)).toHaveLength(1)
    expect(readWritingOverflowFromYDoc(doc).map((item) => item.text)).toEqual([
      'Belki de en iyisi hic yazmamakti.',
      'ikinci'
    ])

    const file = await written(doc)
    expect(file?.markdown).toBe(body)
    expect(file?.writing).toEqual(writing)
  })

  it('keeps markers on their text through edits around and inside the range', async () => {
    const doc = await seed('One <!--ghost-->two three<!--/ghost--> four.')
    const text = firstText(doc)
    text.insert(0, 'Zero. ')
    text.insert(text.toString().indexOf('three'), 'and ')

    expect((await written(doc))?.markdown).toBe(
      'Zero. One <!--ghost-->two and three<!--/ghost--> four.'
    )
  })

  it('drops a range whose text was deleted, and its versions with it', async () => {
    const doc = await seed(body, writing)
    const text = firstText(doc)
    text.delete(text.toString().indexOf('keskin'), 'keskin'.length)

    const file = await written(doc)
    expect(file?.markdown).not.toContain('alt:k3x9')
    expect(file?.writing.alternatives).toEqual({})
    expect(file?.writing.overflow).toEqual(writing.overflow)
  })

  it('keeps the text of a marker with no partner and drops the marker', async () => {
    const doc = await seed('Kept <!--ghost-->text and <!--alt:zz-->more.', writing)

    expect(bodyText(doc)).toBe('Kept text and more.')
    expect(readWritingGhostsFromYDoc(doc)).toEqual([])
    expect((await written(doc))?.markdown).toBe('Kept text and more.')
  })

  it('round-trips ranges next to CriticMarkup without moving either', async () => {
    const markdown =
      'A {++new++} word and <!--ghost-->a faded part<!--/ghost--> then {--old--} text.'
    const doc = await seed(markdown)

    expect(readCriticMarkupMarksFromYDoc(doc).map((mark) => mark.kind)).toEqual([
      'addition',
      'deletion'
    ])
    expect((await written(doc))?.markdown).toBe(markdown)
  })

  it('widens a range that cuts into CriticMarkup instead of splitting the mark', async () => {
    const doc = await seed('A <!--ghost-->faded {++ne<!--/ghost-->w++} word.')

    expect(readCriticMarkupMarksFromYDoc(doc)[0]).toMatchObject({ visibleText: 'new' })
    expect((await written(doc))?.markdown).toBe('A <!--ghost-->faded {++new++}<!--/ghost--> word.')
  })

  it('keeps versions and overflow from the doc when the caller has only the body', async () => {
    const doc = await seed(body, writing)
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    const prepared = await prepareFragmentSeed(`Template intro.\n\n${body}`, undefined)
    expect(prepared).not.toBeNull()
    doc.transact(() => {
      fragment.delete(0, fragment.length)
      applyFragmentSeed(prepared!, fragment)
    })

    const file = await written(doc)
    expect(file?.markdown).toBe(`Template intro.\n\n${body}`)
    expect(file?.writing).toEqual(writing)
  })

  it('writes overflow added in the app newest first', async () => {
    const doc = await seed('Body.', writing)
    writeWritingOverflowToYDoc(doc, [
      ...readWritingOverflowFromYDoc(doc),
      { id: 'new', text: 'just stashed', createdAt: Date.now() }
    ])

    expect((await written(doc))?.writing.overflow.map((item) => item.text)).toEqual([
      'just stashed',
      'Belki de en iyisi hic yazmamakti.',
      'ikinci'
    ])
  })
})
