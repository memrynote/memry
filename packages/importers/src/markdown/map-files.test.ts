import { describe, it, expect } from 'vitest'
import { mapFiles } from './map-files.ts'

describe('mapFiles', () => {
  it('returns empty plan for empty input', () => {
    expect(mapFiles([])).toEqual({ notes: [] })
  })

  it('maps a root-level md file to Markdown folder', () => {
    const plan = mapFiles([{ relPath: 'note.md', absPath: '/root/note.md', rootDir: '/root' }])
    expect(plan.notes).toHaveLength(1)
    expect(plan.notes[0].vaultFolder).toBe('Markdown')
    expect(plan.notes[0].title).toBe('note')
    expect(plan.notes[0].absPath).toBe('/root/note.md')
  })

  it('maps a nested file to a Markdown sub-folder', () => {
    const plan = mapFiles([
      { relPath: 'work/project.md', absPath: '/root/work/project.md', rootDir: '/root' }
    ])
    expect(plan.notes[0].vaultFolder).toBe('Markdown/work')
    expect(plan.notes[0].title).toBe('project')
  })

  it('handles .markdown extension', () => {
    const plan = mapFiles([
      { relPath: 'note.markdown', absPath: '/root/note.markdown', rootDir: '/root' }
    ])
    expect(plan.notes).toHaveLength(1)
    expect(plan.notes[0].title).toBe('note')
  })

  it('skips non-markdown files', () => {
    const plan = mapFiles([
      { relPath: 'note.md', absPath: '/root/note.md', rootDir: '/root' },
      { relPath: 'image.png', absPath: '/root/image.png', rootDir: '/root' },
      { relPath: 'doc.pdf', absPath: '/root/doc.pdf', rootDir: '/root' }
    ])
    expect(plan.notes).toHaveLength(1)
    expect(plan.notes[0].title).toBe('note')
  })

  it('maps deeply nested file', () => {
    const plan = mapFiles([
      { relPath: 'a/b/c/deep.md', absPath: '/root/a/b/c/deep.md', rootDir: '/root' }
    ])
    expect(plan.notes[0].vaultFolder).toBe('Markdown/a/b/c')
    expect(plan.notes[0].title).toBe('deep')
  })

  it('strips only the outermost extension from filename', () => {
    const plan = mapFiles([
      { relPath: 'my.note.md', absPath: '/root/my.note.md', rootDir: '/root' }
    ])
    expect(plan.notes[0].title).toBe('my.note')
  })
})
