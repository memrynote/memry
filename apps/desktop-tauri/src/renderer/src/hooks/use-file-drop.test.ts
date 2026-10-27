import { act, renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  extractValidFiles,
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

const named = (...names: string[]): File[] => names.map((name) => new File(['x'], name))

describe('extractValidFiles', () => {
  it('keeps supported files, whatever the case of the extension', () => {
    const files = named('note.md', 'doc.pdf', 'SCAN.PDF', 'photo.jpg')
    const result = extractValidFiles(files)
    expect(result.validFiles).toEqual(files)
    expect(result.skippedCount).toBe(0)
  })

  it('skips an unsupported extension, a file with none, and an empty name', () => {
    const result = extractValidFiles(named('photo.exe', 'Makefile', ''))
    expect(result.validFiles).toEqual([])
    expect(result.skippedCount).toBe(3)
  })

  it('partitions a mixed batch and keeps the order of the supported files', () => {
    const [readme, photo] = named('readme.md', 'photo.jpg')
    const result = extractValidFiles([readme, ...named('script.exe'), photo])
    expect(result.validFiles).toEqual([readme, photo])
    expect(result.skippedCount).toBe(1)
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

    const note = new File(['note'], 'note.md')
    const drop = dragEvent([note, new File(['exe'], 'app.exe')])
    await act(async () => {
      result.current.dropHandlers.onDrop(drop)
    })
    expect(onDrop).toHaveBeenCalledWith([note], '')
  })

  it('imports into the folder under the pointer, not into the vault root', async () => {
    // #given — the pointer is over a label inside the `projects` row
    const onDrop = vi.fn()
    const { label } = sidebarDom('projects')
    const { result } = renderHook(() => useFileDrop({ onDrop }))

    // #when
    const pdf = new File(['pdf'], 'sample.pdf')
    await act(async () => {
      result.current.dropHandlers.onDrop(dragEvent([pdf], ['Files'], label))
    })

    // #then — vault-relative, exactly the shape `importFiles` takes
    expect(onDrop).toHaveBeenCalledWith([pdf], 'projects')
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
    const { root } = sidebarDom('projects')
    const { result } = renderHook(() => useFileDrop({ onDrop }))

    // #when
    const pdf = new File(['pdf'], 'loose.pdf')
    await act(async () => {
      result.current.dropHandlers.onDrop(dragEvent([pdf], ['Files'], root))
    })

    // #then — selection is irrelevant; empty space means root
    expect(onDrop).toHaveBeenCalledWith([pdf], '')
  })

  it('ignores non-file drops and drops with nothing the app imports', async () => {
    const onDrop = vi.fn()
    const { result } = renderHook(() => useFileDrop({ onDrop }))

    await act(async () => {
      result.current.dropHandlers.onDrop(dragEvent([], ['text/plain']))
    })
    await act(async () => {
      result.current.dropHandlers.onDrop(dragEvent([new File(['bin'], 'app.exe')]))
    })
    expect(onDrop).not.toHaveBeenCalled()
  })
})
