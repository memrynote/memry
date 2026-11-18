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

  it('keeps a mark field a newer build wrote when this build rewrites the array', () => {
    const doc = new FakeYDoc()
    doc.array.values = [
      {
        id: 'c1',
        kind: 'comment',
        visibleText: 'alpha',
        start: 0,
        end: 5,
        body: 'one',
        pinned: true
      },
      { id: 'c2', kind: 'comment', visibleText: 'beta', start: 6, end: 10, body: 'two' }
    ]

    // This build resolves c2: it writes back the marks it read, which lack `pinned`.
    writeCriticMarkupMarksToYDoc(doc, [readCriticMarkupMarksFromYDoc(doc)[0]])

    expect(doc.array.toArray()).toEqual([
      {
        id: 'c1',
        kind: 'comment',
        visibleText: 'alpha',
        start: 0,
        end: 5,
        body: 'one',
        pinned: true
      }
    ])
  })

  it('reads a mark once when two devices pushed it concurrently', () => {
    const doc = new FakeYDoc()
    const mark = { id: 'c1', kind: 'comment', visibleText: 'alpha', start: 0, end: 5, body: 'one' }
    // Two devices each deleted the array and pushed its marks: the merge keeps both pushes.
    doc.array.values = [mark, { ...mark, start: 7, end: 12 }]

    expect(readCriticMarkupMarksFromYDoc(doc)).toEqual([mark])
  })
})
