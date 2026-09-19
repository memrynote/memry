import { describe, it, expect } from 'vitest'
import { mapNote } from './map-notes.ts'

const ROOT = 'Apple Notes'

describe('mapNote', () => {
  it('nests a single folder under the importer root', () => {
    const mapped = mapNote(ROOT, { title: 'A', folderPath: ['Work'] }, false)
    expect(mapped.folder).toBe('Apple Notes/Work')
    expect(mapped.title).toBe('A')
  })

  it('keeps the whole nested chain', () => {
    const mapped = mapNote(ROOT, { title: 'A', folderPath: ['Work', 'Clients', 'Acme'] }, false)
    expect(mapped.folder).toBe('Apple Notes/Work/Clients/Acme')
  })

  it('keeps same-named leaves under different parents apart', () => {
    const work = mapNote(ROOT, { title: 'A', folderPath: ['Work', 'Clients', 'Acme'] }, false)
    const personal = mapNote(ROOT, { title: 'B', folderPath: ['Personal', 'Acme'] }, false)
    expect(work.folder).not.toBe(personal.folder)
    expect(personal.folder).toBe('Apple Notes/Personal/Acme')
  })

  it('drops a default-named leaf but keeps its ancestors', () => {
    expect(mapNote(ROOT, { title: 'A', folderPath: ['Work', 'Notes'] }, false).folder).toBe(
      'Apple Notes/Work'
    )
    // A "Notes" ancestor is a real folder — only the leaf is suppressed.
    expect(mapNote(ROOT, { title: 'A', folderPath: ['Notes', 'Work'] }, false).folder).toBe(
      'Apple Notes/Notes/Work'
    )
  })

  it('maps an empty chain to the importer root', () => {
    expect(mapNote(ROOT, { title: 'A' }, false).folder).toBe('Apple Notes')
    expect(mapNote(ROOT, { title: 'A', folderPath: [] }, false).folder).toBe('Apple Notes')
  })

  it('nests by account only when more than one account exists', () => {
    const row = { title: 'A', accountName: 'iCloud', folderPath: ['Work', 'Clients'] }
    expect(mapNote(ROOT, row, true).folder).toBe('Apple Notes/iCloud/Work/Clients')
    expect(mapNote(ROOT, row, false).folder).toBe('Apple Notes/Work/Clients')
  })

  it('sanitizes every segment', () => {
    const mapped = mapNote(ROOT, { title: 'A', folderPath: [' Work/Life ', 'A  B'] }, false)
    expect(mapped.folder).toBe('Apple Notes/Work-Life/A B')
  })

  it('converts CoreTime timestamps when present', () => {
    const mapped = mapNote(
      ROOT,
      { title: 'A', createdCoreTime: 700000000, modifiedCoreTime: 700100000 },
      false
    )
    expect(mapped.created).toContain('2023-03-08')
    expect(mapped.modified).toBeDefined()
  })
})
