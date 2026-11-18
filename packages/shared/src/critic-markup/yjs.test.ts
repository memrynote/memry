import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { CriticMarkupMark } from './parser'
import {
  CRITIC_MARKUP_MARKS_ARRAY,
  readCriticMarkupMarksFromYDoc,
  writeCriticMarkupMarksToYDoc
} from './yjs'

class FakeYDoc {
  doc = new Y.Doc()
  array = this.doc.getArray<unknown>(CRITIC_MARKUP_MARKS_ARRAY)

  getArray(): Y.Array<unknown> {
    return this.array
  }
}

function docWith(elements: unknown[], clientID = 1): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = clientID
  doc.getArray(CRITIC_MARKUP_MARKS_ARRAY).insert(0, elements)
  return doc
}

function fork(doc: Y.Doc, clientID: number): Y.Doc {
  const copy = new Y.Doc()
  copy.clientID = clientID
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}

function elementsOf(doc: Y.Doc): unknown[] {
  return doc.getArray(CRITIC_MARKUP_MARKS_ARRAY).toArray()
}

const c1: CriticMarkupMark = {
  id: 'c1',
  kind: 'comment',
  visibleText: 'alpha',
  body: 'one',
  metadata: 'id=c1;type=comment',
  start: 0,
  end: 5
}
const c2: CriticMarkupMark = { ...c1, id: 'c2', metadata: 'id=c2;type=comment', body: 'two' }

describe('critic markup marks across builds and devices (protocol 12.5.1)', () => {
  it('keeps a field this build does not know through an older build round trip', () => {
    const doc = docWith([{ ...c1, futureField: { v: 2, keep: ['x'] } }])

    writeCriticMarkupMarksToYDoc(doc, [{ ...readCriticMarkupMarksFromYDoc(doc)[0], body: 'edit' }])

    expect(elementsOf(doc)).toEqual([{ ...c1, body: 'edit', futureField: { v: 2, keep: ['x'] } }])
  })

  it('leaves one mark per id after two devices edit the same mark offline', () => {
    const base = docWith([c1])
    const a = fork(base, 10)
    const b = fork(base, 11)
    writeCriticMarkupMarksToYDoc(a, [{ ...c1, body: 'from a' }])
    writeCriticMarkupMarksToYDoc(b, [{ ...c1, body: 'from b' }])
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    const readA = readCriticMarkupMarksFromYDoc(a)
    expect(readA.map((mark) => mark.id)).toEqual(['c1'])
    expect(readCriticMarkupMarksFromYDoc(b)).toEqual(readA)
  })

  it('does not duplicate when two devices edit different marks offline', () => {
    const base = docWith([c1, c2])
    const a = fork(base, 10)
    const b = fork(base, 11)
    writeCriticMarkupMarksToYDoc(a, [{ ...c1, body: 'from a' }, c2])
    writeCriticMarkupMarksToYDoc(b, [c1, { ...c2, body: 'from b' }])
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))

    expect(elementsOf(a)).toEqual([
      { ...c1, body: 'from a' },
      { ...c2, body: 'from b' }
    ])
  })

  it('writes nothing when the stored marks differ only in key order', () => {
    const reordered = Object.fromEntries(Object.entries(c1).toReversed())
    const doc = docWith([reordered])
    const before = Y.encodeStateAsUpdate(doc)

    writeCriticMarkupMarksToYDoc(doc, [c1])

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('repairs duplicate copies on write, keeping the first', () => {
    const doc = docWith([c1, { ...c1, body: 'second copy' }, c2])

    writeCriticMarkupMarksToYDoc(doc, readCriticMarkupMarksFromYDoc(doc))

    expect(elementsOf(doc)).toEqual([c1, c2])
  })

  it('deletes a removed mark and inserts a new one after its predecessor', () => {
    const c3 = { ...c1, id: 'c3', metadata: 'id=c3;type=comment' }
    const doc = docWith([c1, c2])

    writeCriticMarkupMarksToYDoc(doc, [c1, c3])

    expect(elementsOf(doc)).toEqual([c1, c3])
  })
})

describe('critic markup Yjs helpers', () => {
  it('preserves structured comment mentions and attachments', () => {
    const doc = new FakeYDoc()

    writeCriticMarkupMarksToYDoc(doc, [
      {
        id: 'comment-1',
        kind: 'comment',
        visibleText: 'target',
        body: 'See @Planning note',
        mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
        attachments: [
          {
            id: 'attachments/note-1/spec.pdf',
            name: 'spec.pdf',
            path: 'attachments/note-1/spec.pdf',
            mimeType: 'application/pdf',
            type: 'file'
          }
        ],
        start: 0,
        end: 6
      }
    ])

    expect(doc.array.toArray()).toEqual([
      expect.objectContaining({
        mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
        attachments: [
          expect.objectContaining({
            id: 'attachments/note-1/spec.pdf',
            path: 'attachments/note-1/spec.pdf'
          })
        ]
      })
    ])
    expect(readCriticMarkupMarksFromYDoc(doc)).toEqual([
      expect.objectContaining({
        mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
        attachments: [
          expect.objectContaining({
            id: 'attachments/note-1/spec.pdf',
            path: 'attachments/note-1/spec.pdf'
          })
        ]
      })
    ])
  })

  it('preserves comment createdAt through write and read', () => {
    const doc = new FakeYDoc()

    writeCriticMarkupMarksToYDoc(doc, [
      {
        id: 'comment-1',
        kind: 'comment',
        visibleText: 'target',
        body: 'A comment',
        createdAt: 1748254022000,
        start: 0,
        end: 6
      }
    ])

    expect(readCriticMarkupMarksFromYDoc(doc)).toEqual([
      expect.objectContaining({ createdAt: 1748254022000 })
    ])
  })

  it('preserves comment format ranges and drops invalid ones', () => {
    const doc = new FakeYDoc()

    writeCriticMarkupMarksToYDoc(doc, [
      {
        id: 'c1',
        kind: 'comment',
        visibleText: 'quote',
        body: 'see this and that',
        start: 0,
        end: 5,
        formatRanges: [
          { start: 4, end: 8, marks: ['bold'] },
          { start: 4, end: 2, marks: ['italic'] },
          { start: 0, end: 3, marks: [] }
        ]
      }
    ])

    expect(readCriticMarkupMarksFromYDoc(doc)[0].formatRanges).toEqual([
      { start: 4, end: 8, marks: ['bold'] }
    ])
  })
})
