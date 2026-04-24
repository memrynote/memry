import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../drop-target-utils', () => ({
  findDropTarget: vi.fn().mockReturnValue({ blockId: 'block-1', position: 'after' as const })
}))

import { useEditorDragDrop } from './use-editor-drag-drop'

function createMockDragEvent(overrides: Partial<React.DragEvent> = {}): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { types: ['Files'] },
    clientY: 100,
    currentTarget: {
      getBoundingClientRect: () => ({ left: 0, right: 500, top: 0, bottom: 500 })
    },
    clientX: 250,
    ...overrides
  } as unknown as React.DragEvent
}

describe('useEditorDragDrop', () => {
  let containerRef: React.RefObject<HTMLDivElement | null>

  beforeEach(() => {
    containerRef = { current: document.createElement('div') }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should initialize with no drag state', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))

    // #then
    expect(result.current.isDragging).toBe(false)
    expect(result.current.dropTarget).toBeNull()
  })

  it('should set isDragging on dragOver with Files', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))
    const event = createMockDragEvent()

    // #when
    act(() => {
      result.current.handleDragOver(event)
    })

    // #then
    expect(result.current.isDragging).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('should ignore dragOver without Files type', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))
    const event = createMockDragEvent({
      dataTransfer: { types: ['text/plain'] } as unknown as DataTransfer
    })

    // #when
    act(() => {
      result.current.handleDragOver(event)
    })

    // #then
    expect(result.current.isDragging).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('should reset state on handleDrop', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))

    // #when — set dragging then drop
    act(() => {
      result.current.handleDragOver(createMockDragEvent())
    })
    expect(result.current.isDragging).toBe(true)

    act(() => {
      result.current.handleDrop()
    })

    // #then
    expect(result.current.isDragging).toBe(false)
    expect(result.current.dropTarget).toBeNull()
  })

  it('should reset state on dragLeave when cursor exits container', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))

    act(() => {
      result.current.handleDragOver(createMockDragEvent())
    })
    expect(result.current.isDragging).toBe(true)

    // #when — cursor leaves the bounding rect
    const leaveEvent = createMockDragEvent({
      clientX: -10,
      clientY: 250
    })

    act(() => {
      result.current.handleDragLeave(leaveEvent)
    })

    // #then
    expect(result.current.isDragging).toBe(false)
  })

  it('should NOT reset on dragLeave when cursor is still inside container', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))

    act(() => {
      result.current.handleDragOver(createMockDragEvent())
    })

    // #when — cursor is still within bounds
    const leaveEvent = createMockDragEvent({ clientX: 250, clientY: 250 })

    act(() => {
      result.current.handleDragLeave(leaveEvent)
    })

    // #then — still dragging
    expect(result.current.isDragging).toBe(true)
  })

  it('should reset on global dragend event', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))

    act(() => {
      result.current.handleDragOver(createMockDragEvent())
    })
    expect(result.current.isDragging).toBe(true)

    // #when — global dragend fires (user cancels drag)
    act(() => {
      window.dispatchEvent(new Event('dragend'))
    })

    // #then
    expect(result.current.isDragging).toBe(false)
  })

  it('should reset on window blur', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))

    act(() => {
      result.current.handleDragOver(createMockDragEvent())
    })

    // #when
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })

    // #then
    expect(result.current.isDragging).toBe(false)
  })

  it('should clean up global listeners on unmount', () => {
    // #given
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useEditorDragDrop({ containerRef }))

    // #when
    unmount()

    // #then
    const removedEvents = removeSpy.mock.calls.map((c) => c[0])
    expect(removedEvents).toContain('dragend')
    expect(removedEvents).toContain('blur')
  })
})
