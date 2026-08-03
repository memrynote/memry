import { describe, it, expect } from 'vitest'
import { mapRows } from './map-rows.ts'
import type { ParsedCsv } from './types.ts'

const parsed = (headers: string[], rows: Record<string, string>[]): ParsedCsv => ({
  headers,
  rows
})

describe('mapRows', () => {
  it('detects title column by alias "title" (case-insensitive)', () => {
    const result = mapRows(parsed(['Title', 'Tags'], [{ Title: 'My Note', Tags: 'work' }]))
    expect(result.titleColumn).toBe('Title')
    expect(result.notes[0].title).toBe('My Note')
  })

  it('detects title column by alias "name"', () => {
    const result = mapRows(parsed(['Name', 'Category'], [{ Name: 'Task A', Category: 'work' }]))
    expect(result.titleColumn).toBe('Name')
  })

  it('detects title column by alias "subject"', () => {
    const result = mapRows(parsed(['Subject', 'Body'], [{ Subject: 'Meeting', Body: 'notes' }]))
    expect(result.titleColumn).toBe('Subject')
  })

  it('falls back to first header when no alias matches', () => {
    const result = mapRows(parsed(['Heading', 'Content'], [{ Heading: 'Item', Content: 'text' }]))
    expect(result.titleColumn).toBe('Heading')
  })

  it('skips rows with empty title, counts in skipped + adds warning', () => {
    const result = mapRows(
      parsed(
        ['Title', 'Tags'],
        [
          { Title: '', Tags: 'work' },
          { Title: '  ', Tags: 'home' },
          { Title: 'Good Note', Tags: 'tag' }
        ]
      )
    )
    expect(result.stats.skipped).toBe(2)
    expect(result.stats.notes).toBe(1)
    expect(result.warnings.length).toBe(2)
  })

  it('uses custom folder option', () => {
    const result = mapRows(parsed(['Title'], [{ Title: 'Note' }]), { folder: 'Imports/CSV' })
    expect(result.notes[0].folder).toBe('Imports/CSV')
  })

  it('defaults folder to CSV', () => {
    const result = mapRows(parsed(['Title'], [{ Title: 'Note' }]))
    expect(result.notes[0].folder).toBe('CSV')
  })

  it('stores non-title columns as properties with sanitized keys', () => {
    const result = mapRows(
      parsed(
        ['Title', 'My Tags', '123Invalid', '  Spaced  '],
        [{ Title: 'Note', 'My Tags': 'work', '123Invalid': 'val', '  Spaced  ': 'x' }]
      )
    )
    const props = result.notes[0].properties
    expect(props['My_Tags']).toBe('work')
    expect(props['Invalid']).toBe('val')
    expect(props['Spaced']).toBe('x')
  })

  it('omits empty property values', () => {
    const result = mapRows(parsed(['Title', 'Tags'], [{ Title: 'Note', Tags: '' }]))
    expect(result.notes[0].properties).not.toHaveProperty('Tags')
  })

  it('applies bodyTemplate', () => {
    const result = mapRows(parsed(['Title', 'Notes'], [{ Title: 'A', Notes: 'some note' }]), {
      bodyTemplate: '## Details\n\n{{Notes}}'
    })
    expect(result.notes[0].content).toBe('## Details\n\nsome note')
  })

  it('empty content when no bodyTemplate', () => {
    const result = mapRows(parsed(['Title'], [{ Title: 'A' }]))
    expect(result.notes[0].content).toBe('')
  })

  it('sampleTitles capped at 5', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ Title: `Note ${i}` }))
    const result = mapRows(parsed(['Title'], rows))
    expect(result.sampleTitles).toHaveLength(5)
  })

  it('columns lists all headers', () => {
    const result = mapRows(parsed(['Title', 'Tags', 'Due'], []))
    expect(result.columns).toEqual(['Title', 'Tags', 'Due'])
  })

  it('returns empty plan for empty headers', () => {
    const result = mapRows(parsed([], []))
    expect(result.notes).toEqual([])
    expect(result.warnings.map((w) => w.message)).toContain('CSV file has no headers')
  })

  it('respects explicit titleColumn option', () => {
    const result = mapRows(parsed(['Name', 'Subject'], [{ Name: 'Alice', Subject: 'Meeting' }]), {
      titleColumn: 'Subject'
    })
    expect(result.titleColumn).toBe('Subject')
    expect(result.notes[0].title).toBe('Meeting')
  })

  it('sanitizeKey: leading non-alpha dropped', () => {
    const result = mapRows(parsed(['Title', '1foo'], [{ Title: 'N', '1foo': 'val' }]))
    expect(result.notes[0].properties['foo']).toBe('val')
  })
})
