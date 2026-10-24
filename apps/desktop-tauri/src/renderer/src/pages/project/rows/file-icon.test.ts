import { describe, it, expect } from 'vitest'
import { File, FileCode, FileText, Image, Music, Video } from '@/lib/icons'
import { fileIconFor, formatFileSize } from './file-icon'

describe('fileIconFor', () => {
  it('maps by fileType', () => {
    expect(fileIconFor('pdf', 'survey.pdf')).toBe(FileText)
    expect(fileIconFor('image', 'diagram.png')).toBe(Image)
    expect(fileIconFor('audio', 'memo.mp3')).toBe(Music)
    expect(fileIconFor('video', 'demo.mov')).toBe(Video)
  })

  it('refines text-ish kinds by extension', () => {
    expect(fileIconFor('markdown', 'field-clock-spec.md')).toBe(FileCode)
    expect(fileIconFor('markdown', 'export.csv')).toBe(FileText)
  })

  it('falls back to a generic file icon', () => {
    expect(fileIconFor('unknown', 'blob.bin')).toBe(File)
    expect(fileIconFor('unknown', 'no-extension')).toBe(File)
  })
})

describe('formatFileSize', () => {
  it('formats bytes, kilobytes and megabytes', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(8192)).toBe('8 KB')
    expect(formatFileSize(1_258_291)).toBe('1.2 MB')
  })

  it('returns null when the size is unknown', () => {
    expect(formatFileSize(null)).toBeNull()
  })
})
