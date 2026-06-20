/**
 * Sort notes by a view's order config.
 *
 * Mirrors the table's column accessors so list/gallery views sort the same way
 * the table does (both read the same view.order). The table still sorts itself
 * via TanStack; this covers the non-table views.
 */

import type { NoteWithProperties } from '@/hooks/use-folder-view'

interface OrderEntry {
  property: string
  direction: 'asc' | 'desc'
}

/** Extract the sortable value for a property — matches grouped-table accessors. */
function getSortValue(note: NoteWithProperties, property: string): unknown {
  switch (property) {
    case 'title':
      return note.title
    case 'folder':
      return note.folder
    case 'tags':
      return note.tags.join(', ')
    case 'created':
      return note.created
    case 'modified':
      return note.modified
    case 'wordCount':
      return note.wordCount
    default:
      // ponytail: formula columns aren't evaluated here (rare in list/gallery);
      // swap to evaluateFormula if formula sort is ever needed outside the table.
      return note.properties[property] ?? ''
  }
}

function compareNonEmpty(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Return a sorted copy of notes. Empty/missing values always sort last,
 * regardless of direction. No order → returns the input unchanged.
 */
export function sortNotes(notes: NoteWithProperties[], order?: OrderEntry[]): NoteWithProperties[] {
  if (!order || order.length === 0) return notes

  return [...notes].sort((na, nb) => {
    for (const { property, direction } of order) {
      const av = getSortValue(na, property)
      const bv = getSortValue(nb, property)
      const aEmpty = av == null || av === ''
      const bEmpty = bv == null || bv === ''
      if (aEmpty && bEmpty) continue
      if (aEmpty) return 1
      if (bEmpty) return -1
      const cmp = compareNonEmpty(av, bv)
      if (cmp !== 0) return direction === 'desc' ? -cmp : cmp
    }
    return 0
  })
}
