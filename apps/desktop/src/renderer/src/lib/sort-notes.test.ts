import { describe, it, expect } from 'vitest'
import { sortNotes } from './sort-notes'
import type { NoteWithProperties } from '@/hooks/use-folder-view'

function note(partial: Partial<NoteWithProperties>): NoteWithProperties {
  return {
    id: partial.id ?? 'id',
    path: '',
    title: partial.title ?? '',
    emoji: null,
    folder: partial.folder ?? '',
    tags: partial.tags ?? [],
    created: partial.created ?? '',
    modified: partial.modified ?? '',
    wordCount: partial.wordCount ?? 0,
    properties: partial.properties ?? {}
  }
}

describe('sortNotes', () => {
  it('returns input unchanged when no order', () => {
    const notes = [note({ title: 'b' }), note({ title: 'a' })]
    expect(sortNotes(notes)).toBe(notes)
  })

  it('sorts strings ascending and descending', () => {
    const notes = [note({ title: 'Banana' }), note({ title: 'apple' }), note({ title: 'Cherry' })]
    expect(sortNotes(notes, [{ property: 'title', direction: 'asc' }]).map((n) => n.title)).toEqual(
      ['apple', 'Banana', 'Cherry']
    )
    expect(
      sortNotes(notes, [{ property: 'title', direction: 'desc' }]).map((n) => n.title)
    ).toEqual(['Cherry', 'Banana', 'apple'])
  })

  it('sorts numbers numerically, not lexically', () => {
    const notes = [note({ wordCount: 100 }), note({ wordCount: 9 }), note({ wordCount: 20 })]
    expect(
      sortNotes(notes, [{ property: 'wordCount', direction: 'asc' }]).map((n) => n.wordCount)
    ).toEqual([9, 20, 100])
  })

  it('sorts empty values last in both directions', () => {
    const notes = [note({ id: 'x', title: '' }), note({ id: 'y', title: 'a' })]
    expect(sortNotes(notes, [{ property: 'title', direction: 'asc' }]).map((n) => n.id)).toEqual([
      'y',
      'x'
    ])
    expect(sortNotes(notes, [{ property: 'title', direction: 'desc' }]).map((n) => n.id)).toEqual([
      'y',
      'x'
    ])
  })

  it('falls through to secondary sort key on ties', () => {
    const notes = [
      note({ id: 'a', folder: 'f', title: 'z' }),
      note({ id: 'b', folder: 'f', title: 'a' })
    ]
    const sorted = sortNotes(notes, [
      { property: 'folder', direction: 'asc' },
      { property: 'title', direction: 'asc' }
    ])
    expect(sorted.map((n) => n.id)).toEqual(['b', 'a'])
  })
})
