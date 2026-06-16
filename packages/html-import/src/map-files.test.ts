import { describe, it, expect } from 'vitest'
import { mapFiles } from './map-files.ts'

describe('mapFiles', () => {
  it('returns empty plan for empty input', () => {
    expect(mapFiles([])).toEqual({ notes: [] })
  })

  it('maps a root-level html file to HTML folder', () => {
    const plan = mapFiles([{ relPath: 'page.html', absPath: '/root/page.html', title: 'Page' }])
    expect(plan.notes).toHaveLength(1)
    expect(plan.notes[0].vaultFolder).toBe('HTML')
    expect(plan.notes[0].title).toBe('Page')
    expect(plan.notes[0].absPath).toBe('/root/page.html')
  })

  it('maps a nested file to an HTML sub-folder', () => {
    const plan = mapFiles([
      { relPath: 'docs/page.html', absPath: '/root/docs/page.html', title: 'Page' }
    ])
    expect(plan.notes[0].vaultFolder).toBe('HTML/docs')
  })

  it('handles .htm extension', () => {
    const plan = mapFiles([{ relPath: 'note.htm', absPath: '/root/note.htm', title: 'Note' }])
    expect(plan.notes).toHaveLength(1)
  })

  it('skips non-html files', () => {
    const plan = mapFiles([
      { relPath: 'image.png', absPath: '/root/image.png', title: 'image' },
      { relPath: 'note.md', absPath: '/root/note.md', title: 'note' },
      { relPath: 'page.html', absPath: '/root/page.html', title: 'Page' }
    ])
    expect(plan.notes).toHaveLength(1)
    expect(plan.notes[0].title).toBe('Page')
  })

  it('preserves title with spaces and mixed case', () => {
    const plan = mapFiles([
      { relPath: 'page.html', absPath: '/root/page.html', title: 'My Cool Page' }
    ])
    expect(plan.notes[0].title).toBe('My Cool Page')
  })
})
