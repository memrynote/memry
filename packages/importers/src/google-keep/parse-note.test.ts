import { describe, it, expect } from 'vitest'
import { parseKeepNote } from './parse-note.ts'

describe('parseKeepNote', () => {
  const base = {
    title: 'Test Note',
    textContent: 'Hello world',
    color: 'DEFAULT',
    isPinned: false,
    isArchived: false,
    isTrashed: false,
    createdTimestampUsec: 1_600_000_000_000_000,
    userEditedTimestampUsec: 1_600_100_000_000_000
  }

  it('returns null for non-objects', () => {
    expect(parseKeepNote(null)).toBeNull()
    expect(parseKeepNote('string')).toBeNull()
    expect(parseKeepNote(42)).toBeNull()
    expect(parseKeepNote([])).toBeNull()
  })

  it('returns null when timestamps are missing', () => {
    const { createdTimestampUsec: _, ...without } = base
    expect(parseKeepNote(without)).toBeNull()
  })

  it('parses a minimal note', () => {
    const result = parseKeepNote(base)
    expect(result).not.toBeNull()
    expect(result!.title).toBe('Test Note')
    expect(result!.textContent).toBe('Hello world')
    expect(result!.color).toBe('DEFAULT')
    expect(result!.isPinned).toBe(false)
    expect(result!.isArchived).toBe(false)
    expect(result!.isTrashed).toBe(false)
    expect(result!.labels).toEqual([])
    expect(result!.attachments).toEqual([])
  })

  it('parses labels as objects', () => {
    const result = parseKeepNote({ ...base, labels: [{ name: 'work' }, { name: 'home' }] })
    expect(result!.labels).toEqual([{ name: 'work' }, { name: 'home' }])
  })

  it('parses labels as strings', () => {
    const result = parseKeepNote({ ...base, labels: ['work', 'home'] })
    expect(result!.labels).toEqual([{ name: 'work' }, { name: 'home' }])
  })

  it('parses attachments', () => {
    const result = parseKeepNote({
      ...base,
      attachments: [{ filePath: 'Assets/image.png', mimetype: 'image/png' }]
    })
    expect(result!.attachments).toEqual([{ filePath: 'Assets/image.png', mimetype: 'image/png' }])
  })

  it('parses listContent', () => {
    const result = parseKeepNote({
      ...base,
      listContent: [
        { text: 'Buy milk', isChecked: false },
        { text: 'Buy eggs', isChecked: true }
      ]
    })
    expect(result!.listContent).toEqual([
      { text: 'Buy milk', isChecked: false },
      { text: 'Buy eggs', isChecked: true }
    ])
  })

  it('defaults missing optional string fields', () => {
    const result = parseKeepNote({
      createdTimestampUsec: 1_000_000_000_000_000,
      userEditedTimestampUsec: 1_000_000_000_000_000
    })
    expect(result!.title).toBe('')
    expect(result!.textContent).toBe('')
    expect(result!.color).toBe('DEFAULT')
  })
})
