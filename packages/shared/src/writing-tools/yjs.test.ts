import { describe, expect, it } from 'vitest'
import {
  WRITING_ALTERNATIVES_ARRAY,
  WRITING_GHOSTS_ARRAY,
  WRITING_OVERFLOW_ARRAY,
  WRITING_OVERFLOW_HTML_MAX,
  normalizeWritingOverflowItem,
  readWritingAlternativesFromYDoc,
  readWritingGhostsFromYDoc,
  readWritingOverflowFromYDoc,
  writeWritingAlternativesToYDoc,
  writeWritingGhostsToYDoc,
  writeWritingOverflowToYDoc,
  type WritingAlternative
} from './yjs'

class FakeYArray {
  values: unknown[] = []
  operations = 0

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
    this.operations++
    this.values.splice(index, length)
  }

  push(values: unknown[]): void {
    this.operations++
    this.values.push(...values)
  }
}

class FakeYDoc {
  arrays = new Map<string, FakeYArray>()
  transactions = 0

  getArray(name: string): FakeYArray {
    let array = this.arrays.get(name)
    if (!array) {
      array = new FakeYArray()
      this.arrays.set(name, array)
    }
    return array
  }

  transact(fn: () => void): void {
    this.transactions++
    fn()
  }
}

const anchor = (clock: number) => ({ item: { client: 7, clock }, assoc: 0 })

function alternative(overrides: Partial<WritingAlternative> = {}): WritingAlternative {
  return {
    id: 'alt-1',
    anchorStart: anchor(1),
    anchorEnd: anchor(4),
    original: 'quick',
    variants: [{ id: 'v-1', text: 'fast', source: 'user', createdAt: 10 }],
    activeVariantId: null,
    ...overrides
  }
}

describe('writing tools Yjs helpers', () => {
  it('round-trips alternatives, ghosts and overflow items through their own arrays', () => {
    const doc = new FakeYDoc()
    const alt = alternative({ activeVariantId: 'v-1' })
    writeWritingAlternativesToYDoc(doc, [alt])
    writeWritingGhostsToYDoc(doc, [{ id: 'g-1', anchorStart: anchor(2), anchorEnd: anchor(9) }])
    writeWritingOverflowToYDoc(doc, [{ id: 'o-1', text: 'kept line', createdAt: 5 }])

    expect(readWritingAlternativesFromYDoc(doc)).toEqual([alt])
    expect(readWritingGhostsFromYDoc(doc)).toEqual([
      { id: 'g-1', anchorStart: anchor(2), anchorEnd: anchor(9) }
    ])
    expect(readWritingOverflowFromYDoc(doc)).toEqual([
      { id: 'o-1', text: 'kept line', createdAt: 5 }
    ])
    expect([...doc.arrays.keys()].sort()).toEqual(
      [WRITING_ALTERNATIVES_ARRAY, WRITING_GHOSTS_ARRAY, WRITING_OVERFLOW_ARRAY].sort()
    )
  })

  it('ignores malformed entries and unknown variant sources on read', () => {
    const doc = new FakeYDoc()
    doc.getArray(WRITING_ALTERNATIVES_ARRAY).values = [
      null,
      'text',
      { id: 'no-anchor', original: 'x', variants: [], activeVariantId: null },
      {
        ...alternative({ id: 'mixed' }),
        variants: [
          { id: 'v-1', text: 'fast', source: 'user', createdAt: 1 },
          { id: 'v-2', text: 'rapid', source: 'robot', createdAt: 1 },
          { id: 'v-3', text: 42, source: 'ai', createdAt: 1 }
        ],
        activeVariantId: 'v-2'
      },
      { ...alternative({ id: 'only-unknown' }), variants: [{ id: 'v', source: 'robot' }] },
      { ...alternative({ id: 'bad-anchor' }), anchorStart: { item: { client: 'x', clock: 1 } } }
    ]

    expect(readWritingAlternativesFromYDoc(doc)).toEqual([
      alternative({
        id: 'mixed',
        variants: [{ id: 'v-1', text: 'fast', source: 'user', createdAt: 1 }],
        // The active variant was dropped, so the original is what is shown.
        activeVariantId: null
      })
    ])
  })

  it('keeps one record per id, the later entry winning', () => {
    const doc = new FakeYDoc()
    doc.getArray(WRITING_OVERFLOW_ARRAY).values = [
      { id: 'o-1', text: 'first', createdAt: 1 },
      { id: 'o-1', text: 'second', createdAt: 2 },
      { id: 'o-2', text: '', createdAt: 3 }
    ]

    expect(readWritingOverflowFromYDoc(doc)).toEqual([{ id: 'o-1', text: 'second', createdAt: 2 }])
  })

  it('does not touch the array when the written records are already there', () => {
    const doc = new FakeYDoc()
    writeWritingOverflowToYDoc(doc, [{ id: 'o-1', text: 'kept', createdAt: 1 }])
    const array = doc.getArray(WRITING_OVERFLOW_ARRAY)
    const operationsAfterFirstWrite = array.operations

    writeWritingOverflowToYDoc(doc, [{ id: 'o-1', text: 'kept', createdAt: 1 }])

    expect(array.operations).toBe(operationsAfterFirstWrite)
  })

  it('rewrites only the changed record and leaves the others in place', () => {
    const doc = new FakeYDoc()
    const first = alternative({ id: 'a' })
    const second = alternative({ id: 'b', original: 'slow' })
    writeWritingAlternativesToYDoc(doc, [first, second])
    const array = doc.getArray(WRITING_ALTERNATIVES_ARRAY)
    const untouched = array.values[1]

    writeWritingAlternativesToYDoc(doc, [{ ...first, activeVariantId: 'v-1' }, second])

    expect(array.values).toHaveLength(2)
    expect(array.values[0]).toBe(untouched)
    expect(readWritingAlternativesFromYDoc(doc).find((alt) => alt.id === 'a')).toMatchObject({
      activeVariantId: 'v-1'
    })
  })

  it('deletes records missing from the next list but keeps entries it cannot read', () => {
    const doc = new FakeYDoc()
    const futureEntry = { id: 'future', kind: 'from-a-newer-build' }
    doc.getArray(WRITING_GHOSTS_ARRAY).values = [
      futureEntry,
      { id: 'g-1', anchorStart: anchor(1), anchorEnd: anchor(2) }
    ]

    writeWritingGhostsToYDoc(doc, [])

    expect(doc.getArray(WRITING_GHOSTS_ARRAY).values).toEqual([futureEntry])
  })

  it('keeps fields and variants from a newer build when this build rewrites the record', () => {
    const doc = new FakeYDoc()
    const stored = {
      ...alternative(),
      pinned: true,
      variants: [
        { id: 'v-1', text: 'fast', source: 'user', createdAt: 10, tone: 'casual' },
        { id: 'v-9', text: 'zippy', source: 'translation', createdAt: 11 }
      ]
    }
    doc.getArray(WRITING_ALTERNATIVES_ARRAY).values = [stored]

    writeWritingAlternativesToYDoc(doc, [alternative({ activeVariantId: 'v-1' })])

    expect(doc.getArray(WRITING_ALTERNATIVES_ARRAY).values).toEqual([
      {
        ...alternative({ activeVariantId: 'v-1' }),
        pinned: true,
        variants: [
          { id: 'v-1', text: 'fast', source: 'user', createdAt: 10, tone: 'casual' },
          { id: 'v-9', text: 'zippy', source: 'translation', createdAt: 11 }
        ]
      }
    ])
  })

  it('lets this build clear a field it owns while keeping unknown ones', () => {
    const doc = new FakeYDoc()
    doc.getArray(WRITING_OVERFLOW_ARRAY).values = [
      { id: 'o-1', text: 'kept', label: 'old', createdAt: 1, color: 'blue' }
    ]

    writeWritingOverflowToYDoc(doc, [{ id: 'o-1', text: 'kept', createdAt: 1 }])

    expect(doc.getArray(WRITING_OVERFLOW_ARRAY).values).toEqual([
      { id: 'o-1', text: 'kept', createdAt: 1, color: 'blue' }
    ])
  })

  it('collapses duplicate ids on write', () => {
    const doc = new FakeYDoc()
    const ghost = { id: 'g-1', anchorStart: anchor(1), anchorEnd: anchor(2) }
    doc.getArray(WRITING_GHOSTS_ARRAY).values = [ghost, { ...ghost }]

    writeWritingGhostsToYDoc(doc, [ghost])

    expect(doc.getArray(WRITING_GHOSTS_ARRAY).values).toEqual([ghost])
  })

  it('drops the record when its last variant is removed', () => {
    const doc = new FakeYDoc()
    writeWritingAlternativesToYDoc(doc, [alternative()])

    writeWritingAlternativesToYDoc(doc, [alternative({ variants: [] })])

    expect(doc.getArray(WRITING_ALTERNATIVES_ARRAY).values).toEqual([])
  })
})

describe('overflow html', () => {
  it('keeps stashed HTML and drops empty or oversized values', () => {
    const base = { id: 'o1', text: 'hi', createdAt: 1 }
    expect(normalizeWritingOverflowItem({ ...base, html: '<strong>hi</strong>' })?.html).toBe(
      '<strong>hi</strong>'
    )
    expect(normalizeWritingOverflowItem({ ...base, html: '' })).toEqual(base)
    expect(
      normalizeWritingOverflowItem({ ...base, html: 'x'.repeat(WRITING_OVERFLOW_HTML_MAX + 1) })
    ).toEqual(base)
  })
})
