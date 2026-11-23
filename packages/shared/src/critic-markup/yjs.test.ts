import { describe, expect, it } from 'vitest'
import { readCriticMarkupMarksFromYDoc, writeCriticMarkupMarksToYDoc } from './yjs'

class FakeYArray {
  values: unknown[] = []

  get length(): number {
    return this.values.length
  }

  get(index: number): unknown {
    return this.values[index]
  }

  toArray(): unknown[] {
    return [...this.values]
  }

  delete(index: number, length: number): void {
    this.values.splice(index, length)
  }

  insert(index: number, values: unknown[]): void {
    this.values.splice(index, 0, ...values)
  }

  push(values: unknown[]): void {
    this.values.push(...values)
  }
}

class FakeYDoc {
  array = new FakeYArray()

  getArray(): FakeYArray {
    return this.array
  }
}

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
    doc.array.values = [{ id: 'c1' }, copy(2), copy(5)]

    expect(readCriticMarkupMarksFromYDoc(doc)).toEqual([copy(2)])
  })

  // A newer build may add a kind or a field. An older build that rewrites the
  // array must not delete what it cannot read: both builds share the vault.
  it("keeps a newer build's marks and fields when it changes a mark", () => {
    const doc = new FakeYDoc()
    const newerKind = { id: 'n1', kind: 'highlight', visibleText: 'x', start: 0, end: 1 }
    doc.array.values = [
      { id: 'c1', kind: 'comment', visibleText: 'one', start: 0, end: 3, resolvedBy: 'kaan' },
      newerKind
    ]
    const [comment] = readCriticMarkupMarksFromYDoc(doc)

    writeCriticMarkupMarksToYDoc(doc, [{ ...comment, start: 4, end: 7 }])

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
