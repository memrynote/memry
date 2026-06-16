import { describe, it, expect } from 'vitest'
import { mapNote } from './map-notes.ts'
import type { BearInfo } from './types.ts'

const baseInfo: BearInfo = {
  uniqueIdentifier: 'TEST-001',
  archived: false,
  trashed: false
}

describe('mapNote', () => {
  it('extracts title from first h1 heading', () => {
    const md = '# My Note Title\n\nSome body text.'
    const result = mapNote({ folderName: 'FolderName', md, info: baseInfo })
    expect(result.title).toBe('My Note Title')
  })

  it('falls back to first non-empty line when no heading', () => {
    const md = 'Just some text\nmore lines'
    const result = mapNote({ folderName: 'FolderName', md, info: baseInfo })
    expect(result.title).toBe('Just some text')
  })

  it('falls back to folderName when content is empty', () => {
    const result = mapNote({ folderName: 'MyFolder', md: '', info: baseInfo })
    expect(result.title).toBe('MyFolder')
  })

  it('places normal note in Bear folder', () => {
    const result = mapNote({ folderName: 'Note', md: '# Note', info: baseInfo })
    expect(result.folder).toBe('Bear')
  })

  it('places archived note in Bear/Archived folder', () => {
    const info: BearInfo = { ...baseInfo, archived: true }
    const result = mapNote({ folderName: 'Note', md: '# Note', info })
    expect(result.folder).toBe('Bear/Archived')
  })

  it('places trashed note in Bear/Trash folder', () => {
    const info: BearInfo = { ...baseInfo, trashed: true }
    const result = mapNote({ folderName: 'Note', md: '# Note', info })
    expect(result.folder).toBe('Bear/Trash')
  })

  it('trashed takes precedence over archived', () => {
    const info: BearInfo = { ...baseInfo, archived: true, trashed: true }
    const result = mapNote({ folderName: 'Note', md: '# Note', info })
    expect(result.folder).toBe('Bear/Trash')
  })

  it('extracts asset refs from body', () => {
    const md = '# Note\n\n![img](assets/image.png)\n[file](assets/doc.pdf)'
    const result = mapNote({ folderName: 'Note', md, info: baseInfo })
    expect(result.assetRefs).toContain('image.png')
    expect(result.assetRefs).toContain('doc.pdf')
  })

  it('returns empty assetRefs when no assets', () => {
    const result = mapNote({ folderName: 'Note', md: '# Just text', info: baseInfo })
    expect(result.assetRefs).toEqual([])
  })

  it('preserves created and modified dates from info', () => {
    const created = new Date('2024-01-01')
    const modified = new Date('2024-06-01')
    const info: BearInfo = { ...baseInfo, created, modified }
    const result = mapNote({ folderName: 'Note', md: '# Note', info })
    expect(result.created).toBe(created)
    expect(result.modified).toBe(modified)
  })

  it('passes full md as body', () => {
    const md = '# Title\n\nFull body content here.'
    const result = mapNote({ folderName: 'Note', md, info: baseInfo })
    expect(result.body).toBe(md)
  })
})
