import { act, renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  extractValidPaths,
  resolveDropFolder,
  useFileDrop,
  FILE_DROP_FOLDER_ATTR
} from './use-file-drop'

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

function dragEvent(files: File[], types = ['Files'], target?: EventTarget) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target,
    dataTransfer: {
      types,
      dropEffect: 'none',
      files: Object.assign(files, { item: (index: number) => files[index] ?? null })
    }
  } as unknown as React.DragEvent
}

/** Sidebar shape: a root zone holding a folder row that holds a label span. */
function sidebarDom(folder: string) {
  const root = document.createElement('div')
  root.setAttribute(FILE_DROP_FOLDER_ATTR, '')

  const row = document.createElement('div')
  row.setAttribute(FILE_DROP_FOLDER_ATTR, folder)

  const label = document.createElement('span')
  row.appendChild(label)
  root.appendChild(row)

  return { root, row, label }
}

describe('resolveDropFolder', () => {
  it('reads the folder off the innermost zone under the pointer', () => {
    // #given — the pointer lands on a label, not on the row that owns the folder
    const { label } = sidebarDom('projects')

    // #when / #then
    expect(resolveDropFolder(label)).toBe('projects')
  })

  it('prefers a nested folder row over the root zone wrapping it', () => {
    // #given
    const { label } = sidebarDom('life/travel')

    // #then — a deeper zone wins, so nesting stays aimable
    expect(resolveDropFolder(label)).toBe('life/travel')
  })

  it('falls back to the vault root outside any declared zone', () => {
    // #given
    const orphan = document.createElement('div')

    // #then
    expect(resolveDropFolder(orphan)).toBe('')
    expect(resolveDropFolder(null)).toBe('')
  })

  it('reads the root zone itself as the vault root, not as a missing zone', () => {
    // #given — dropped on sidebar empty space
    const { root } = sidebarDom('projects')

    // #then
    expect(resolveDropFolder(root)).toBe('')
  })
})

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
    expect(onDrop).toHaveBeenCalledWith(['/tmp/note.md'], '')
  })

  it('imports into the folder under the pointer, not into the vault root', async () => {
    // #given — the pointer is over a label inside the `projects` row
    const onDrop = vi.fn()
    ;(
      window.api as typeof window.api & { getFileDropPaths: (files: File[]) => string[] }
    ).getFileDropPaths = vi.fn(() => ['/tmp/sample.pdf'])
    const { label } = sidebarDom('projects')
    const { result } = renderHook(() => useFileDrop({ onDrop }))

    // #when
    await act(async () => {
      result.current.dropHandlers.onDrop(
        dragEvent([new File(['pdf'], 'sample.pdf')], ['Files'], label)
      )
    })

    // #then — vault-relative, exactly the shape `importFiles` takes
    expect(onDrop).toHaveBeenCalledWith(['/tmp/sample.pdf'], 'projects')
  })

  it('reports the hovered folder while dragging and forgets it when the drag stops', () => {
    // #given
    vi.useFakeTimers()
    const { label } = sidebarDom('life/travel')
    const { result } = renderHook(() => useFileDrop({ onDrop: vi.fn() }))

    // #when
    act(() => {
      result.current.dropHandlers.onDragOver(dragEvent([], ['Files'], label))
    })

    // #then — drives the row highlight
    expect(result.current.dropFolder).toBe('life/travel')

    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(result.current.dropFolder).toBeNull()
  })

  it('drops into the vault root when nothing under the pointer claims a folder', async () => {
    // #given — sidebar empty space, below every row
    const onDrop = vi.fn()
    ;(
      window.api as typeof window.api & { getFileDropPaths: (files: File[]) => string[] }
    ).getFileDropPaths = vi.fn(() => ['/tmp/loose.pdf'])
    const { root } = sidebarDom('projects')
    const { result } = renderHook(() => useFileDrop({ onDrop }))

    // #when
    await act(async () => {
      result.current.dropHandlers.onDrop(
        dragEvent([new File(['pdf'], 'loose.pdf')], ['Files'], root)
      )
    })

    // #then — selection is irrelevant; empty space means root
    expect(onDrop).toHaveBeenCalledWith(['/tmp/loose.pdf'], '')
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
    expect(onDrop).toHaveBeenCalledWith(['/tmp/report.pdf'], '')

    await act(async () => {
      result.current.dropHandlers.onDrop(dragEvent([new File(['bin'], 'app.exe')]))
    })
    expect(onDrop).toHaveBeenCalledTimes(1)
  })
})
