import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type React from 'react'

const marqueeIndentMocks = vi.hoisted(() => ({
  classifyBlocks: vi.fn(),
  indentTaskBlock: vi.fn(),
  outdentTaskBlock: vi.fn()
}))

vi.mock('./task-block-marquee-indent', () => marqueeIndentMocks)

import { topLevelSelectedBlockIds, useBlockMarqueeSelection } from './use-block-marquee-selection'

function setRect(el: Element, rect: Partial<DOMRect>): void {
  const value = {
    left: rect.left ?? 0,
    top: rect.top ?? 0,
    right: rect.right ?? (rect.left ?? 0) + (rect.width ?? 0),
    bottom: rect.bottom ?? (rect.top ?? 0) + (rect.height ?? 0),
    width: rect.width ?? 0,
    height: rect.height ?? 0,
    x: rect.left ?? 0,
    y: rect.top ?? 0,
    toJSON: () => ({})
  } as DOMRect
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => value,
    configurable: true
  })
}

function createBlock(id: string, top: number): HTMLDivElement {
  const block = document.createElement('div')
  block.className = 'bn-block'
  block.dataset.id = id
  setRect(block, { left: 10, top, width: 120, height: 20, right: 130, bottom: top + 20 })
  return block
}

function setupDom(): {
  trigger: HTMLDivElement
  blockContainer: HTMLDivElement
  blockContainerRef: React.RefObject<HTMLDivElement | null>
} {
  const trigger = document.createElement('div')
  const blockContainer = document.createElement('div')
  setRect(trigger, { left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 })
  blockContainer.append(createBlock('a', 10), createBlock('b', 40), createBlock('c', 80))
  trigger.append(blockContainer)
  document.body.append(trigger)
  return { trigger, blockContainer, blockContainerRef: { current: blockContainer } }
}

function mouse(type: string, init: MouseEventInit): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })
}

describe('useBlockMarqueeSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    marqueeIndentMocks.classifyBlocks.mockReturnValue({
      textblocks: ['a'],
      taskBlocks: ['b'],
      other: ['c']
    })
    marqueeIndentMocks.indentTaskBlock.mockReturnValue({ kind: 'updated' })
    marqueeIndentMocks.outdentTaskBlock.mockReturnValue({ kind: 'updated' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('selects intersecting blocks and supports indent, outdent, delete, and clear shortcuts', () => {
    const { trigger, blockContainerRef } = setupDom()
    const editor = {
      prosemirrorView: { focus: vi.fn(), dom: { blur: vi.fn() } },
      setTextCursorPosition: vi.fn(),
      canNestBlock: vi.fn(() => true),
      nestBlock: vi.fn(),
      canUnnestBlock: vi.fn(() => true),
      unnestBlock: vi.fn(),
      removeBlocks: vi.fn()
    }

    const { result, unmount } = renderHook(() =>
      useBlockMarqueeSelection({
        editor,
        blockContainerRef,
        triggerContainerEl: trigger
      })
    )

    act(() => {
      trigger.dispatchEvent(mouse('mousedown', { clientX: 0, clientY: 0 }))
      document.dispatchEvent(mouse('mousemove', { clientX: 150, clientY: 70 }))
      document.dispatchEvent(mouse('mouseup', { clientX: 150, clientY: 70 }))
    })

    expect([...result.current.selectedBlockIds]).toEqual(['a', 'b'])
    expect(result.current.highlightRects.map((rect) => rect.id)).toEqual(['a', 'b'])
    expect(trigger).not.toHaveAttribute('data-marquee-active')

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(editor.setTextCursorPosition).toHaveBeenCalledWith('a', 'start')
    expect(editor.nestBlock).toHaveBeenCalledTimes(1)
    expect(marqueeIndentMocks.indentTaskBlock).toHaveBeenCalledWith(editor, 'b')

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
      )
    })
    expect(editor.unnestBlock).toHaveBeenCalledTimes(1)
    expect(marqueeIndentMocks.outdentTaskBlock).toHaveBeenCalledWith(editor, 'b')

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })
    expect(editor.removeBlocks).toHaveBeenCalledWith(['a', 'b'])
    expect(result.current.selectedBlockIds.size).toBe(0)

    act(() => {
      trigger.dispatchEvent(mouse('mousedown', { clientX: 0, clientY: 0 }))
      document.dispatchEvent(mouse('mousemove', { clientX: 150, clientY: 70 }))
      document.dispatchEvent(mouse('mouseup', { clientX: 150, clientY: 70 }))
    })
    expect(result.current.selectedBlockIds.size).toBe(2)

    act(() => {
      result.current.clearSelection()
    })
    expect(result.current.selectedBlockIds.size).toBe(0)

    unmount()
    trigger.remove()
  })

  it('deletes only top-level ancestors when a nested child is also selected', () => {
    // Regression: a marquee box selects both a parent block and its nested
    // child (e.g. a list item whose sub-item holds a date/reminder pill).
    // Passing both ids to editor.removeBlocks throws "could not be found"
    // (the ancestor removal already deleted the child), rolling back the whole
    // transaction so NOTHING — including the date pill — gets removed.
    const { trigger, blockContainerRef } = setupDom()
    const editor = {
      prosemirrorView: { dom: { blur: vi.fn() } },
      // 'b' is nested under 'a'; the marquee selects both 'a' and 'b'.
      document: [{ id: 'a', children: [{ id: 'b' }] }, { id: 'c' }],
      removeBlocks: vi.fn()
    }

    const { result, unmount } = renderHook(() =>
      useBlockMarqueeSelection({
        editor,
        blockContainerRef,
        triggerContainerEl: trigger
      })
    )

    act(() => {
      trigger.dispatchEvent(mouse('mousedown', { clientX: 0, clientY: 0 }))
      document.dispatchEvent(mouse('mousemove', { clientX: 150, clientY: 70 }))
      document.dispatchEvent(mouse('mouseup', { clientX: 150, clientY: 70 }))
    })
    expect([...result.current.selectedBlockIds]).toEqual(['a', 'b'])

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })

    // Only the ancestor — 'b' is removed implicitly with it.
    expect(editor.removeBlocks).toHaveBeenCalledWith(['a'])
    expect(result.current.selectedBlockIds.size).toBe(0)

    unmount()
    trigger.remove()
  })

  it('ignores disabled, interactive, and mostly-horizontal editable drags', () => {
    const { trigger, blockContainerRef } = setupDom()
    const button = document.createElement('button')
    trigger.append(button)
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    trigger.append(editable)
    const editor = { prosemirrorView: { dom: { blur: vi.fn() } } }

    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useBlockMarqueeSelection({
          editor,
          blockContainerRef,
          triggerContainerEl: trigger,
          enabled
        }),
      { initialProps: { enabled: false } }
    )

    act(() => {
      trigger.dispatchEvent(mouse('mousedown', { clientX: 0, clientY: 0 }))
      document.dispatchEvent(mouse('mousemove', { clientX: 150, clientY: 70 }))
      document.dispatchEvent(mouse('mouseup', { clientX: 150, clientY: 70 }))
    })
    expect(result.current.selectedBlockIds.size).toBe(0)

    rerender({ enabled: true })

    act(() => {
      button.dispatchEvent(mouse('mousedown', { clientX: 0, clientY: 0 }))
      document.dispatchEvent(mouse('mousemove', { clientX: 150, clientY: 70 }))
      document.dispatchEvent(mouse('mouseup', { clientX: 150, clientY: 70 }))
    })
    expect(result.current.selectedBlockIds.size).toBe(0)

    act(() => {
      editable.dispatchEvent(mouse('mousedown', { clientX: 0, clientY: 0 }))
      document.dispatchEvent(mouse('mousemove', { clientX: 40, clientY: 16 }))
      document.dispatchEvent(mouse('mouseup', { clientX: 40, clientY: 16 }))
    })
    expect(result.current.selectedBlockIds.size).toBe(0)

    unmount()
    trigger.remove()
  })
})

describe('topLevelSelectedBlockIds', () => {
  it('keeps flat selections unchanged in document order', () => {
    const doc = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(topLevelSelectedBlockIds(doc, new Set(['a', 'c']))).toEqual(['a', 'c'])
  })

  it('drops a selected descendant when its ancestor is also selected', () => {
    const doc = [{ id: 'a', children: [{ id: 'b', children: [{ id: 'd' }] }] }, { id: 'c' }]
    expect(topLevelSelectedBlockIds(doc, new Set(['a', 'b', 'd']))).toEqual(['a'])
  })

  it('keeps a nested block when its ancestor is not selected', () => {
    const doc = [{ id: 'a', children: [{ id: 'b' }] }, { id: 'c' }]
    expect(topLevelSelectedBlockIds(doc, new Set(['b', 'c']))).toEqual(['b', 'c'])
  })

  it('drops stale ids that are absent from the document', () => {
    const doc = [{ id: 'a' }]
    expect(topLevelSelectedBlockIds(doc, new Set(['a', 'ghost']))).toEqual(['a'])
  })
})
