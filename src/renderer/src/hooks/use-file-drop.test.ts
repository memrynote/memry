import { describe, it, expect, vi } from 'vitest'
import { extractValidPaths } from './use-file-drop'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  })
}))

describe('extractValidPaths', () => {
  describe('happy path', () => {
    it('includes file with valid path and supported extension', () => {
      // #given
      const files = [{ path: '/home/user/note.md', name: 'note.md' }]

      // #when
      const result = extractValidPaths(files)

      // #then
      expect(result.validPaths).toEqual(['/home/user/note.md'])
      expect(result.skippedCount).toBe(0)
    })

    it('includes PDF files', () => {
      // #given
      const files = [{ path: '/tmp/doc.pdf', name: 'doc.pdf' }]

      // #when
      const result = extractValidPaths(files)

      // #then
      expect(result.validPaths).toEqual(['/tmp/doc.pdf'])
      expect(result.skippedCount).toBe(0)
    })

    it('handles uppercase extensions', () => {
      // #given
      const files = [{ path: '/docs/SCAN.PDF', name: 'SCAN.PDF' }]

      // #when
      const result = extractValidPaths(files)

      // #then
      expect(result.validPaths).toEqual(['/docs/SCAN.PDF'])
      expect(result.skippedCount).toBe(0)
    })
  })

  describe('skipping', () => {
    it('skips unsupported extension', () => {
      // #given
      const files = [{ path: '/tmp/photo.exe', name: 'photo.exe' }]

      // #when
      const result = extractValidPaths(files)

      // #then
      expect(result.validPaths).toEqual([])
      expect(result.skippedCount).toBe(1)
    })

    it('skips file with no extension', () => {
      // #given
      const files = [{ path: '/project/Makefile', name: 'Makefile' }]

      // #when
      const result = extractValidPaths(files)

      // #then
      expect(result.validPaths).toEqual([])
      expect(result.skippedCount).toBe(1)
    })

    it('skips when both path and name are empty', () => {
      // #given
      const files = [{ path: '', name: '' }]

      // #when
      const result = extractValidPaths(files)

      // #then
      expect(result.validPaths).toEqual([])
      expect(result.skippedCount).toBe(1)
    })
  })

  describe('empty path with valid name (the PDF drop bug)', () => {
    it('skips supported file with empty path', () => {
      // #given — webUtils.getPathForFile failed to resolve a real path
      const files = [{ path: '', name: 'document.pdf' }]

      // #when
      const result = extractValidPaths(files)

      // #then — recognized as supported but cannot import without filesystem path
      expect(result.validPaths).toEqual([])
      expect(result.skippedCount).toBe(1)
    })

    it('skips unsupported file with empty path', () => {
      // #given
      const files = [{ path: '', name: 'virus.exe' }]

      // #when
      const result = extractValidPaths(files)

      // #then
      expect(result.validPaths).toEqual([])
      expect(result.skippedCount).toBe(1)
    })
  })

  describe('mixed batch', () => {
    it('correctly partitions valid and invalid files', () => {
      // #given
      const files = [
        { path: '/docs/readme.md', name: 'readme.md' },
        { path: '/pics/photo.jpg', name: 'photo.jpg' },
        { path: '/bin/script.exe', name: 'script.exe' },
        { path: '', name: 'report.pdf' }
      ]

      // #when
      const result = extractValidPaths(files)

      // #then
      expect(result.validPaths).toEqual(['/docs/readme.md', '/pics/photo.jpg'])
      expect(result.skippedCount).toBe(2)
    })
  })
})
