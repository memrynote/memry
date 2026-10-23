import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEditorDragDrop } from './use-editor-drag-drop'
import { findDropTarget } from '../drop-target-utils'

// Regression cover for #1088: `dragover` fires continuously while a file hovers
// the editor. Measuring every block and committing a fresh drop-target object on
// each event re-rendered the editor dozens of times per second. Measuring must be
// throttled to one frame, and the commit must bail out when the target is
// unchanged — without changing where the drop actually lands.

const BLOCK_COUNT = 40
const BLOCK_HEIGHT = 20

let measureCount = 0
let scrollOffset = 0
let frameCallbacks: Array<{ id: number; cb: FrameRequestCallback }> = []
let nextFrameId = 1

function createContainer(): HTMLDivElement {
  const container = document.createElement('div')
  for (let i = 0; i < BLOCK_COUNT; i += 1) {
    const el = document.createElement('div')
    el.setAttribute('data-id', `block-${i}`)
    const documentTop = i * BLOCK_HEIGHT
    el.getBoundingClientRect = (): DOMRect => {
      measureCount += 1
      const top = documentTop - scrollOffset
      return {
        top,
        bottom: top + BLOCK_HEIGHT,
        height: BLOCK_HEIGHT,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({})
      } as DOMRect
    }
    container.appendChild(el)
  }
  return container
}

function dragEvent(clientY: number, clientX = 50): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { types: ['Files'] },
    clientX,
    clientY,
    currentTarget: {
      getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 500 })
    }
  } as unknown as React.DragEvent
}

function flushFrames(): void {
  const pending = frameCallbacks
  frameCallbacks = []
  act(() => {
    pending.forEach(({ cb }) => cb(0))
  })
}

describe('useEditorDragDrop dragover throttling', () => {
  let containerRef: React.RefObject<HTMLDivElement | null>

  beforeEach(() => {
    measureCount = 0
    scrollOffset = 0
    frameCallbacks = []
    nextFrameId = 1
    containerRef = { current: createContainer() }
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      const id = nextFrameId
      nextFrameId += 1
      frameCallbacks.push({ id, cb })
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
      frameCallbacks = frameCallbacks.filter((frame) => frame.id !== id)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('measures at most once per frame across a dragover burst, but always preventDefaults', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))
    const events = Array.from({ length: 20 }, (_, i) => dragEvent(150 + i))

    // #when — a burst of dragover events arrives inside a single frame
    act(() => {
      events.forEach((event) => result.current.handleDragOver(event))
    })

    // #then — the drop is still accepted, but nothing has been measured yet
    events.forEach((event) => expect(event.preventDefault).toHaveBeenCalled())
    expect(measureCount).toBe(0)
    expect(frameCallbacks).toHaveLength(1)

    // #when — the frame runs
    flushFrames()

    // #then — a single measurement pass, resolved from the newest pointer position
    expect(measureCount).toBeGreaterThan(0)
    expect(measureCount).toBeLessThanOrEqual(BLOCK_COUNT)
    measureCount = 0
    expect(result.current.dropTarget).toEqual(findDropTarget(169, containerRef))
  })

  it('does not re-render while the drop target is unchanged', () => {
    // #given
    let renderCount = 0
    const { result } = renderHook(() => {
      renderCount += 1
      return useEditorDragDrop({ containerRef })
    })
    act(() => {
      result.current.handleDragOver(dragEvent(150))
    })
    flushFrames()
    const committed = result.current.dropTarget
    expect(committed).not.toBeNull()
    // React may render a component once more before it settles into bailing out,
    // so let the first unchanged update absorb that before counting.
    act(() => {
      result.current.handleDragOver(dragEvent(151))
    })
    flushFrames()
    const rendersAfterCommit = renderCount

    // #when — the cursor keeps hovering the same block
    for (let i = 0; i < 10; i += 1) {
      act(() => {
        result.current.handleDragOver(dragEvent(151))
      })
      flushFrames()
    }

    // #then — same object, no extra renders
    expect(result.current.dropTarget).toBe(committed)
    expect(renderCount).toBe(rendersAfterCommit)
  })

  it('commits a new target when the cursor moves to another block', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))
    act(() => {
      result.current.handleDragOver(dragEvent(150))
    })
    flushFrames()
    const first = result.current.dropTarget

    // #when
    act(() => {
      result.current.handleDragOver(dragEvent(410))
    })
    flushFrames()

    // #then
    expect(result.current.dropTarget).not.toBe(first)
    expect(result.current.dropTarget).toEqual(findDropTarget(410, containerRef))
  })

  it.each([
    ['first block, top half', 1],
    ['first block, bottom half', 15],
    ['a middle block', 333],
    ['last block', 795],
    ['past the last block', 5000]
  ])('resolves the same drop target as an unthrottled measurement (%s)', (_label, clientY) => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))

    // #when — a fast cursor move ending at clientY, then one frame
    act(() => {
      result.current.handleDragOver(dragEvent(clientY - 40))
      result.current.handleDragOver(dragEvent(clientY))
    })
    flushFrames()

    // #then
    expect(result.current.dropTarget).toEqual(findDropTarget(clientY, containerRef))
  })

  it('re-measures live geometry when the note scrolls mid-drag', () => {
    // #given — hovering block-7 at y=150
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))
    act(() => {
      result.current.handleDragOver(dragEvent(150))
    })
    flushFrames()
    expect(result.current.dropTarget?.blockId).toBe('block-7')

    // #when — the note scrolls under a stationary cursor
    scrollOffset = 200
    act(() => {
      result.current.handleDragOver(dragEvent(150))
    })
    flushFrames()

    // #then — resolved against the new rects, not cached ones
    expect(result.current.dropTarget?.blockId).toBe('block-17')
    expect(result.current.dropTarget).toEqual(findDropTarget(150, containerRef))
  })

  it('cancels a pending frame on drop', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))
    act(() => {
      result.current.handleDragOver(dragEvent(150))
    })
    flushFrames()
    act(() => {
      result.current.handleDragOver(dragEvent(410))
    })
    expect(frameCallbacks).toHaveLength(1)

    // #when
    act(() => {
      result.current.handleDrop()
    })

    // #then — no ghost target lands after the drop
    expect(frameCallbacks).toHaveLength(0)
    measureCount = 0
    flushFrames()
    expect(measureCount).toBe(0)
    expect(result.current.dropTarget).toBeNull()
    expect(result.current.isDragging).toBe(false)
  })

  it('cancels a pending frame when the cursor leaves the container', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))
    act(() => {
      result.current.handleDragOver(dragEvent(150))
    })
    expect(frameCallbacks).toHaveLength(1)

    // #when — cursor exits the container bounds
    act(() => {
      result.current.handleDragLeave(dragEvent(150, -10))
    })

    // #then
    expect(frameCallbacks).toHaveLength(0)
    measureCount = 0
    flushFrames()
    expect(measureCount).toBe(0)
    expect(result.current.dropTarget).toBeNull()
  })

  it('cancels a pending frame on unmount', () => {
    // #given
    const { result, unmount } = renderHook(() => useEditorDragDrop({ containerRef }))
    act(() => {
      result.current.handleDragOver(dragEvent(150))
    })
    expect(frameCallbacks).toHaveLength(1)

    // #when
    unmount()

    // #then
    expect(frameCallbacks).toHaveLength(0)
  })

  it('cancels a pending frame when the drag ends globally', () => {
    // #given
    const { result } = renderHook(() => useEditorDragDrop({ containerRef }))
    act(() => {
      result.current.handleDragOver(dragEvent(150))
    })
    expect(frameCallbacks).toHaveLength(1)

    // #when
    act(() => {
      window.dispatchEvent(new Event('dragend'))
    })

    // #then
    expect(frameCallbacks).toHaveLength(0)
    measureCount = 0
    flushFrames()
    expect(measureCount).toBe(0)
    expect(result.current.isDragging).toBe(false)
  })
})
