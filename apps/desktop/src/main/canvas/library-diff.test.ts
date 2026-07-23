import { describe, it, expect } from 'vitest'
import { diffLibraryItems, serializeLibraryItem, type StoredLibraryItem } from './library-diff'
import type { CanvasLibraryItem } from '@memry/contracts/canvas-api'

function item(id: string, extra: Record<string, unknown> = {}): CanvasLibraryItem {
  return { id, status: 'unpublished', created: 1, elements: [], ...extra } as CanvasLibraryItem
}

function stored(...items: CanvasLibraryItem[]): StoredLibraryItem[] {
  return items.map((it) => ({ id: it.id, json: serializeLibraryItem(it) }))
}

describe('diffLibraryItems', () => {
  it('inserts items the vault has never seen', () => {
    const diff = diffLibraryItems([], [item('a'), item('b')])

    expect(diff.inserts.map((i) => i.id)).toEqual(['a', 'b'])
    expect(diff.updates).toEqual([])
    expect(diff.deletes).toEqual([])
  })

  it('is a no-op when the payload matches storage', () => {
    const items = [item('a'), item('b')]

    const diff = diffLibraryItems(stored(...items), items)

    expect(diff).toEqual({ inserts: [], updates: [], deletes: [] })
  })

  it('updates an item whose contents changed', () => {
    const diff = diffLibraryItems(stored(item('a')), [item('a', { name: 'Renamed' })])

    expect(diff.updates.map((i) => i.id)).toEqual(['a'])
    expect(diff.inserts).toEqual([])
    expect(diff.deletes).toEqual([])
  })

  it('deletes live rows the payload omits', () => {
    const diff = diffLibraryItems(stored(item('a'), item('b')), [item('a')])

    expect(diff.deletes).toEqual(['b'])
    expect(diff.inserts).toEqual([])
    expect(diff.updates).toEqual([])
  })

  it('tombstones everything when the payload is empty (reset library)', () => {
    const diff = diffLibraryItems(stored(item('a'), item('b')), [])

    expect(diff.deletes).toEqual(['a', 'b'])
  })

  it('keeps the first occurrence when the payload repeats an id', () => {
    // Importing a library that overlaps one already installed can hand back the
    // same id twice; writing both would make the second clobber the first.
    const diff = diffLibraryItems([], [item('a', { name: 'First' }), item('a', { name: 'Second' })])

    expect(diff.inserts).toHaveLength(1)
    expect(diff.inserts[0].json).toContain('First')
  })

  it('does not re-delete an id that the payload also re-adds', () => {
    const diff = diffLibraryItems(stored(item('a')), [item('a'), item('b')])

    expect(diff.deletes).toEqual([])
    expect(diff.inserts.map((i) => i.id)).toEqual(['b'])
  })
})
