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
})
