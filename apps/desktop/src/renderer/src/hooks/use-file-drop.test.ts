import { act, renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractValidPaths, useFileDrop } from './use-file-drop'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  })
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

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

function dragEvent(files: File[], types = ['Files']) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      types,
      dropEffect: 'none',
      files: Object.assign(files, { item: (index: number) => files[index] ?? null })
    }
  } as unknown as React.DragEvent
}

describe('useFileDrop', () => {
  it('tracks external file drags, clears the drag state, and drops supported paths', async () => {
    vi.useFakeTimers()
    const onDrop = vi.fn()
    ;(
      window.api as typeof window.api & { getFileDropPaths: (files: File[]) => string[] }
    ).getFileDropPaths = vi.fn(() => ['/tmp/note.md', '/tmp/app.exe'])
    const { result } = renderHook(() => useFileDrop({ onDrop }))

    const over = dragEvent([new File(['note'], 'note.md')])
    act(() => {
      result.current.dropHandlers.onDragOver(over)
    })
    expect(over.preventDefault).toHaveBeenCalled()
    expect(over.stopPropagation).toHaveBeenCalled()
    expect(over.dataTransfer.dropEffect).toBe('copy')
    expect(result.current.isDraggingFiles).toBe(true)

    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current.isDraggingFiles).toBe(false)

    const drop = dragEvent([new File(['note'], 'note.md'), new File(['exe'], 'app.exe')])
    await act(async () => {
      result.current.dropHandlers.onDrop(drop)
    })
    expect(onDrop).toHaveBeenCalledWith(['/tmp/note.md'])
  })

  it('ignores non-file drops and falls back to file.path when preload path lookup fails', async () => {
    const onDrop = vi.fn()
    ;(
      window.api as typeof window.api & { getFileDropPaths: (files: File[]) => string[] }
    ).getFileDropPaths = vi.fn(() => {
      throw new Error('path lookup failed')
    })
    const { result } = renderHook(() => useFileDrop({ onDrop }))

    const textDrop = dragEvent([], ['text/plain'])
    await act(async () => {
      result.current.dropHandlers.onDrop(textDrop)
    })
    expect(onDrop).not.toHaveBeenCalled()

    const file = new File(['pdf'], 'report.pdf') as File & { path?: string }
    file.path = '/tmp/report.pdf'
    await act(async () => {
      result.current.dropHandlers.onDrop(dragEvent([file]))
    })
    expect(onDrop).toHaveBeenCalledWith(['/tmp/report.pdf'])

    await act(async () => {
      result.current.dropHandlers.onDrop(dragEvent([new File(['bin'], 'app.exe')]))
    })
    expect(onDrop).toHaveBeenCalledTimes(1)
  })
})
