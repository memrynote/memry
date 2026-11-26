import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { CriticMarkupMark } from './parser'
import {
  CRITIC_MARKUP_MARKS_ARRAY,
  readCriticMarkupMarksFromYDoc,
  updateCriticMarkupMarksInYDoc,
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

  // REVIEW-5839B: a newer build's element (an unknown kind, or any shape this
  // build cannot read) and a known mark's unknown field survive a whole-list
  // write, as they do through updateCriticMarkupMarksInYDoc (#5574).
  it('keeps an element it cannot read and unknown fields through a whole-list write', () => {
    const newerKind = { id: 'n1', kind: 'highlight', visibleText: 'x', start: 0, end: 1, tone: 'y' }
    const unreadable = [null, 'x', { ...c2, end: -1 }]
    const doc = docWith([{ ...c1, future: 1 }, newerKind, ...unreadable])

    writeCriticMarkupMarksToYDoc(doc, [{ ...c1, body: 'edit' }])

    expect(elementsOf(doc)).toEqual([{ ...c1, body: 'edit', future: 1 }, newerKind, ...unreadable])
  })

  it('keeps an unknown field of an unchanged known mark through a whole-list write', () => {
    const doc = docWith([{ ...c1, future: { v: 2 } }, c2])

    writeCriticMarkupMarksToYDoc(doc, [c1])

    expect(elementsOf(doc)).toEqual([{ ...c1, future: { v: 2 } }])
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

  it('writes nothing when only the offsets differ', () => {
    const doc = docWith([c1, c2])
    const before = Y.encodeStateAsUpdate(doc)

    writeCriticMarkupMarksToYDoc(doc, [
      { ...c1, start: 7, end: 12 },
      { ...c2, start: 7, end: 12 }
    ])

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it("keeps another device's edit when this one only moved the mark", () => {
    for (const [here, there] of [
      [10, 11],
      [11, 10]
    ]) {
      const base = docWith([c1, c2])
      const a = fork(base, here)
      const b = fork(base, there)
      writeCriticMarkupMarksToYDoc(a, [
        { ...c1, start: 7, end: 12 },
        { ...c2, body: 'edited here' }
      ])
      writeCriticMarkupMarksToYDoc(b, [{ ...c1, body: 'edited there' }, c2])
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b))

      expect(readCriticMarkupMarksFromYDoc(a).map((mark) => mark.body)).toEqual([
        'edited there',
        'edited here'
      ])
    }
  })

  it('writes nothing back over unknown keys nested in known arrays', () => {
    const doc = docWith([
      {
        ...c1,
        mentions: [{ kind: 'note', refId: 'n1', label: 'Plan', future: 1 }],
        formatRanges: [{ start: 0, end: 2, marks: ['bold'], future: 1 }]
      }
    ])
    const before = Y.encodeStateAsUpdate(doc)

    writeCriticMarkupMarksToYDoc(doc, readCriticMarkupMarksFromYDoc(doc))

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('inserts a new mark first, or right after the existing mark before it', () => {
    const c0 = { ...c1, id: 'c0', metadata: 'id=c0;type=comment' }
    const c3 = { ...c1, id: 'c3', metadata: 'id=c3;type=comment' }
    const doc = docWith([c1, c2])

    writeCriticMarkupMarksToYDoc(doc, [c0, c1, c3, c2])

    expect(elementsOf(doc).map((element) => (element as CriticMarkupMark).id)).toEqual([
      'c0',
      'c1',
      'c3',
      'c2'
    ])
  })

  describe('keeps a concurrent change when a write changes many separate marks', () => {
    const many = Array.from({ length: 70 }, (_, index) => ({
      ...c1,
      id: `m${index}`,
      metadata: `id=m${index};type=comment`
    }))
    const withBody = (marks: CriticMarkupMark[], body: string, pick: (i: number) => boolean) =>
      marks.map((mark, index) => (pick(index) ? { ...mark, body } : mark))
    const evens = withBody(many, 'from a', (i) => i % 2 === 0)
    const byId = (marks: CriticMarkupMark[]) => marks.toSorted((x, y) => x.id.localeCompare(y.id))

    it.each([
      [
        'an edit',
        withBody(many, 'from b', (i) => i === 41),
        withBody(evens, 'from b', (i) => i === 41)
      ],
      [
        'a second large write',
        withBody(many, 'from b', (i) => i % 2 === 1),
        withBody(evens, 'from b', (i) => i % 2 === 1)
      ],
      ['a delete', many.toSpliced(41, 1), evens.toSpliced(41, 1)]
    ])('%s', (_, fromB, expected) => {
      for (const [idA, idB] of [
        [10, 11],
        [11, 10]
      ]) {
        const base = docWith(many)
        const a = fork(base, idA)
        const b = fork(base, idB)
        writeCriticMarkupMarksToYDoc(a, evens)
        writeCriticMarkupMarksToYDoc(b, fromB)
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

        expect(byId(readCriticMarkupMarksFromYDoc(a)), `A=${idA}`).toEqual(byId(expected))
        expect(byId(readCriticMarkupMarksFromYDoc(b)), `A=${idA}`).toEqual(byId(expected))
      }
    })
  })

  it('makes one array operation per run of changes, two per replaced run', () => {
    const many = Array.from({ length: 1000 }, (_, index) => ({
      ...c1,
      id: `m${index}`,
      metadata: `id=m${index};type=comment`
    }))
    const count = (marks: CriticMarkupMark[], next: CriticMarkupMark[]) => {
      const array = docWith(marks).getArray<unknown>(CRITIC_MARKUP_MARKS_ARRAY)
      let ops = 0
      const counted = {
        get length() {
          return array.length
        },
        get: (index: number) => array.get(index),
        toArray: () => array.toArray(),
        delete: (index: number, length: number) => {
          ops++
          array.delete(index, length)
        },
        insert: (index: number, values: unknown[]) => {
          ops++
          array.insert(index, values)
        }
      }
      writeCriticMarkupMarksToYDoc({ getArray: () => counted }, next)
      expect(readCriticMarkupMarksFromYDoc({ getArray: () => counted })).toEqual(next)
      return ops
    }
    const edited = (mark: CriticMarkupMark) => ({ ...mark, body: 'edited' })

    expect(count(many, many.map(edited))).toBe(2)
    expect(
      count(
        many,
        many.filter((_, index) => index % 2 === 0)
      )
    ).toBe(500)
    expect(
      count(
        many,
        many.map((mark, index) => (index % 2 ? mark : edited(mark)))
      )
    ).toBe(1000)
    expect(count(many, [...many.slice(0, 500), c1, ...many.slice(500)])).toBe(1)
    expect(
      count(
        many,
        many.map((mark, index) => (index % 100 ? mark : edited(mark)))
      )
    ).toBe(20)
  })

  it('deletes a removed mark and inserts a new one after its predecessor', () => {
    const c3 = { ...c1, id: 'c3', metadata: 'id=c3;type=comment' }
    const doc = docWith([c1, c2])

    writeCriticMarkupMarksToYDoc(doc, [c1, c3])

    expect(elementsOf(doc)).toEqual([c1, c3])
  })
})

describe('critic markup Yjs helpers', () => {
  // Two devices that move the same mark at once each replace its element, and
  // the array keeps both. Every device must read the same one, and read it once.
  it('reads a mark replaced on two devices at once once, the first well-formed one', () => {
    const doc = new FakeYDoc()
    const copy = (start: number) => ({
      id: 'c1',
      kind: 'comment',
      visibleText: 'x',
      start,
      end: start + 1
    })
    doc.array.insert(0, [{ id: 'c1' }, copy(2), copy(5)])

    expect(readCriticMarkupMarksFromYDoc(doc)).toEqual([copy(2)])
  })

  // A newer build may add a kind or a field. An older build that rewrites the
  // array must not delete what it cannot read: both builds share the vault.
  it("keeps a newer build's marks and fields when it changes a mark", () => {
    const doc = new FakeYDoc()
    const newerKind = { id: 'n1', kind: 'highlight', visibleText: 'x', start: 0, end: 1 }
    doc.array.insert(0, [
      { id: 'c1', kind: 'comment', visibleText: 'one', start: 0, end: 3, resolvedBy: 'kaan' },
      newerKind
    ])
    const [comment] = readCriticMarkupMarksFromYDoc(doc)

    updateCriticMarkupMarksInYDoc(doc, { upsert: [{ ...comment, start: 4, end: 7 }] })

    expect(doc.array.toArray()).toEqual([
      { id: 'c1', kind: 'comment', visibleText: 'one', start: 4, end: 7, resolvedBy: 'kaan' },
      newerKind
    ])
  })

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
