import { describe, it, expect } from 'vitest'
import { mapKeepNote } from './map-note.ts'
import type { KeepNote } from './types.ts'

const base: KeepNote = {
  title: 'Shopping List',
  textContent: '',
  listContent: undefined,
  color: 'DEFAULT',
  labels: [],
  isPinned: false,
  isArchived: false,
  isTrashed: false,
  attachments: [],
  createdTimestampUsec: 1_609_459_200_000_000, // 2021-01-01T00:00:00.000Z
  userEditedTimestampUsec: 1_612_137_600_000_000 // 2021-02-01T00:00:00.000Z
}

describe('mapKeepNote', () => {
  it('converts timestamps from microseconds to ISO strings', () => {
    const result = mapKeepNote(base)
    expect(result.created).toBe('2021-01-01T00:00:00.000Z')
    expect(result.modified).toBe('2021-02-01T00:00:00.000Z')
  })

  it('uses textContent as body when no listContent', () => {
    const result = mapKeepNote({ ...base, textContent: 'Some text here' })
    expect(result.body).toBe('Some text here')
  })

  it('converts listContent to markdown checkboxes', () => {
    const result = mapKeepNote({
      ...base,
      title: '',
      textContent: '',
      listContent: [
        { text: 'Milk', isChecked: false },
        { text: 'Eggs', isChecked: true },
        { text: '   ', isChecked: false } // blank — should be skipped
      ]
    })
    expect(result.body).toBe('- [ ] Milk\n- [x] Eggs')
  })

  it('resolves title from textContent when title is empty', () => {
    const result = mapKeepNote({ ...base, title: '', textContent: 'First line\nSecond line' })
    expect(result.title).toBe('First line')
  })

  it('resolves title from list item when title and textContent are empty', () => {
    const result = mapKeepNote({
      ...base,
      title: '',
      textContent: '',
      listContent: [{ text: 'First item', isChecked: false }]
    })
    expect(result.title).toBe('First item')
  })

  it('falls back to Untitled', () => {
    const result = mapKeepNote({ ...base, title: '', textContent: '', listContent: [] })
    expect(result.title).toBe('Untitled')
  })

  it('emits Keep/Color tag when color is not DEFAULT', () => {
    const result = mapKeepNote({ ...base, color: 'RED' })
    expect(result.tags).toContain('Keep/Color/RED')
  })

  it('does not emit color tag for DEFAULT', () => {
    const result = mapKeepNote({ ...base, color: 'DEFAULT' })
    expect(result.tags.some((t) => t.startsWith('Keep/Color'))).toBe(false)
  })

  it('emits Keep/Label tags', () => {
    const result = mapKeepNote({ ...base, labels: [{ name: 'work' }, { name: 'urgent' }] })
    expect(result.tags).toContain('Keep/Label/work')
    expect(result.tags).toContain('Keep/Label/urgent')
  })

  it('emits Keep/Pinned, Keep/Archived, Keep/Deleted tags', () => {
    const result = mapKeepNote({ ...base, isPinned: true, isArchived: true, isTrashed: true })
    expect(result.tags).toContain('Keep/Pinned')
    expect(result.tags).toContain('Keep/Archived')
    expect(result.tags).toContain('Keep/Deleted')
  })

  it('emits Keep/Attachment tag when attachments present', () => {
    const result = mapKeepNote({
      ...base,
      attachments: [{ filePath: 'Assets/img.png', mimetype: 'image/png' }]
    })
    expect(result.tags).toContain('Keep/Attachment')
  })

  it('collects attachmentPaths', () => {
    const result = mapKeepNote({
      ...base,
      attachments: [
        { filePath: 'Assets/img.png', mimetype: 'image/png' },
        { filePath: 'Assets/doc.pdf', mimetype: 'application/pdf' }
      ]
    })
    expect(result.attachmentPaths).toEqual(['Assets/img.png', 'Assets/doc.pdf'])
  })

  it('produces no tags for a plain default note', () => {
    const result = mapKeepNote(base)
    expect(result.tags).toEqual([])
  })
})
