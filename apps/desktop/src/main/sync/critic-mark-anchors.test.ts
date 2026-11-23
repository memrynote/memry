import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  parseCriticMarkup,
  readCriticMarkupMarksFromYDoc,
  serializeCriticMarkup,
  writeCriticMarkupMarksToYDoc,
  type CriticMarkupMark
} from '@memry/shared'
import {
  markdownToYFragment,
  yDocToMarkdown,
  yDocToMarkdownWithWritingRanges
} from './blocknote-converter'
import { applyCriticMarkMoves } from './critic-mark-anchors'
import { serializeNoteBody, type NoteBody } from './writing-markdown'

/** A comment on the first `visibleText` in `plain` at or after `from`. */
function comment(
  id: string,
  plain: string,
  visibleText: string,
  body: string,
  from = 0
): CriticMarkupMark {
  const start = plain.indexOf(visibleText, from)
  return { id, kind: 'comment', visibleText, start, end: start + visibleText.length, body }
}

async function seed(file: string): Promise<{ doc: Y.Doc; text: Y.XmlText }> {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  expect(await markdownToYFragment(file, fragment)).toBe(true)
  const paragraph = fragment.get(0)
  const text = paragraph instanceof Y.XmlElement ? findText(paragraph) : null
  if (!text) throw new Error('no text run')
  return { doc, text }
}

function findText(node: Y.XmlElement): Y.XmlText | null {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child
    if (child instanceof Y.XmlElement) {
      const found = findText(child)
      if (found) return found
    }
  }
  return null
}

/** One write-back pass over `file`, the body the last pass wrote: what it writes, and the doc after it. */
async function writeBack(doc: Y.Doc, file: string): Promise<NoteBody> {
  const body = await serializeNoteBody(
    doc,
    { readFileBody: async () => file },
    { yDocToMarkdown, yDocToMarkdownWithWritingRanges }
  )
  if (!body) throw new Error('write-back failed')
  applyCriticMarkMoves(doc, body.criticMarks.moves)
  return body
}

/** Each comment in the file, as its body and the text it covers. */
function fileComments(markdown: string): Array<[string | undefined, string]> {
  return parseCriticMarkup(markdown)
    .marks.filter((mark) => mark.kind === 'comment')
    .map((mark) => [mark.body, mark.visibleText])
}

/** Each comment in the doc, as its body and the text its offsets cover in `markdown`. */
function docComments(doc: Y.Doc, markdown: string): Array<[string | undefined, string]> {
  const plain = parseCriticMarkup(markdown).plainText
  return readCriticMarkupMarksFromYDoc(doc).map((mark) => [
    mark.body,
    plain.slice(mark.start, mark.end)
  ])
}

describe('review marks follow the edits made since the file was written', () => {
  it('grows a comment with the words typed inside it', async () => {
    const plain = 'Say hello world today.'
    const { doc, text } = await seed(
      serializeCriticMarkup(plain, [comment('c1', plain, 'hello world', 'Greeting.')])
    )
    const file = serializeCriticMarkup(plain, readCriticMarkupMarksFromYDoc(doc))
    text.insert('Say hello '.length, 'big ')

    const { markdown } = await writeBack(doc, file)

    expect(fileComments(markdown)).toEqual([['Greeting.', 'hello big world']])
    expect(docComments(doc, markdown)).toEqual([['Greeting.', 'hello big world']])
  })

  // Typing into the words right after commenting on them: one pass writes the
  // comment and the edit, and the file it reads has neither.
  it('grows a comment the file does not hold yet with the words typed inside it', async () => {
    const plain = 'Say hello world today.'
    const { doc, text } = await seed(plain)
    writeCriticMarkupMarksToYDoc(doc, [comment('c1', plain, 'hello world', 'Greeting.')])
    text.insert('Say hello '.length, 'big ')

    const { markdown } = await writeBack(doc, plain)

    expect(fileComments(markdown)).toEqual([['Greeting.', 'hello big world']])
    expect(docComments(doc, markdown)).toEqual([['Greeting.', 'hello big world']])
  })

  it('carries each comment through edits before, inside and after it in one pass', async () => {
    const plain = 'Alpha beta gamma. Delta epsilon zeta.'
    const { doc, text } = await seed(
      serializeCriticMarkup(plain, [
        comment('c1', plain, 'beta', 'On beta.'),
        comment('c2', plain, 'epsilon zeta', 'On the end.')
      ])
    )
    const file = serializeCriticMarkup(plain, readCriticMarkupMarksFromYDoc(doc))
    text.insert(text.length, ' Omega.')
    text.delete(text.toString().indexOf('epsilon'), 'epsilon'.length)
    text.insert(text.toString().indexOf(' zeta'), 'eta')
    text.insert(0, 'Intro. ')

    const { markdown } = await writeBack(doc, file)

    expect(parseCriticMarkup(markdown).plainText).toBe(
      'Intro. Alpha beta gamma. Delta eta zeta. Omega.'
    )
    expect(fileComments(markdown)).toEqual([
      ['On beta.', 'beta'],
      ['On the end.', 'eta zeta']
    ])
    expect(docComments(doc, markdown)).toEqual(fileComments(markdown))
  })

  it('keeps a comment whose words were all deleted as a point where they were', async () => {
    const plain = 'Keep this. Drop these words. End.'
    const { doc, text } = await seed(
      serializeCriticMarkup(plain, [comment('c1', plain, 'these words', 'On the words.')])
    )
    const file = serializeCriticMarkup(plain, readCriticMarkupMarksFromYDoc(doc))
    text.delete(plain.indexOf('these words'), 'these words'.length)

    const { markdown, criticMarks } = await writeBack(doc, file)

    expect(criticMarks.orphaned).toEqual(['c1'])
    expect(fileComments(markdown)).toEqual([['On the words.', '']])
    expect(readCriticMarkupMarksFromYDoc(doc)).toEqual([
      expect.objectContaining({ id: 'c1', visibleText: '', start: 16, end: 16 })
    ])
  })

  it('keeps two comments on the same word each on its own copy', async () => {
    const plain = 'TODO first. TODO second.'
    const { doc, text } = await seed(
      serializeCriticMarkup(plain, [
        comment('c1', plain, 'TODO', 'On the first.'),
        comment('c2', plain, 'TODO', 'On the second.', 1)
      ])
    )
    const file = serializeCriticMarkup(plain, readCriticMarkupMarksFromYDoc(doc))
    text.insert('TODO first. '.length, 'New TODO here. ')

    const { markdown } = await writeBack(doc, file)

    // The new TODO is nearer where the second comment was than its own word.
    const edited = 'TODO first. New TODO here. TODO second.'
    expect(markdown).toBe(
      serializeCriticMarkup(edited, [
        comment('c1', edited, 'TODO', 'On the first.'),
        comment('c2', edited, 'TODO', 'On the second.', edited.indexOf('TODO second'))
      ])
    )
  })

  // A suggestion's id is where it stood when the file was read into the doc,
  // so after it moves once the file names it differently from the doc.
  it('keeps moving a suggestion pass after pass', async () => {
    const { doc, text } = await seed('Old {++added++} words.')
    const first = await writeBack(doc, 'Old {++added++} words.')
    expect(first.markdown).toBe('Old {++added++} words.')

    text.insert(0, 'Very ')
    const second = await writeBack(doc, first.markdown)
    text.insert('Very '.length, 'much ')
    const third = await writeBack(doc, second.markdown)

    expect(second.markdown).toBe('Very Old {++added++} words.')
    expect(third.markdown).toBe('Very much Old {++added++} words.')
  })
})
