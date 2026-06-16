import { describe, it, expect } from 'vitest'
import { mapNotes } from './map-notes.ts'
import type { EnexNote } from './types.ts'

const note: EnexNote = {
  title: 'My Note',
  contentHtml: '<en-note><p>Hello</p></en-note>',
  tags: ['work'],
  resources: []
}

describe('mapNotes', () => {
  it('places notes under Evernote/<notebook>', () => {
    const plans = mapNotes([note], 'MyNotebook')
    expect(plans).toHaveLength(1)
    expect(plans[0].folder).toBe('Evernote/MyNotebook')
    expect(plans[0].note).toBe(note)
  })

  it('places notes under Evernote/ when notebook is empty', () => {
    const plans = mapNotes([note], '')
    expect(plans[0].folder).toBe('Evernote')
  })

  it('maps multiple notes to the same folder', () => {
    const note2: EnexNote = { ...note, title: 'Note 2' }
    const plans = mapNotes([note, note2], 'Work')
    expect(plans).toHaveLength(2)
    expect(plans.every((p) => p.folder === 'Evernote/Work')).toBe(true)
  })

  it('returns empty array for empty notes', () => {
    expect(mapNotes([], 'Empty')).toEqual([])
  })
})
