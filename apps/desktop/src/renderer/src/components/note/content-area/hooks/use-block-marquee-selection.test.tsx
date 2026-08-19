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

/** Every stubbed `getBoundingClientRect()` bumps this — one measure, one count. */
let rectReads = 0

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
    value: () => {
      rectReads += 1
      return value
    },
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

  it('ignores disabled, interactive, opted-out, and in-text drags', () => {
    const { trigger, blockContainerRef } = setupDom()
    const button = document.createElement('button')
    trigger.append(button)
    // The side rail opts out of marquee entirely (note-layout.tsx marks it
    // `data-marquee-ignore`), so a drag that starts on it selects nothing.
    const rail = document.createElement('div')
    rail.setAttribute('data-marquee-ignore', '')
    trigger.append(rail)
    // BlockNote renders its menus inside the marquee zone rather than
    // portaling them out, so dragging within one must not select blocks
    // behind it. Also covered end-to-end by editor-drag-handle-menu.e2e.ts.
    const sideMenu = document.createElement('div')
    sideMenu.className = 'bn-side-menu'
    trigger.append(sideMenu)
    // Icons render as SVG, which is an Element but not an HTMLElement.
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    trigger.append(icon)
    // The bug this rule exists to kill (#1441): a press inside a line of text
    // followed by a long straight-down drag. The class name is BlockNote's own
    // and is spelled out here on purpose — it is the tripwire that fires if an
    // upgrade renames the inline content element out from under the predicate.
    const inlineContent = document.createElement('div')
    inlineContent.className = 'bn-inline-content'
    trigger.append(inlineContent)
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

    for (const optedOut of [rail, sideMenu, icon]) {
      act(() => {
        optedOut.dispatchEvent(mouse('mousedown', { clientX: 0, clientY: 0 }))
        document.dispatchEvent(mouse('mousemove', { clientX: 150, clientY: 70 }))
        document.dispatchEvent(mouse('mouseup', { clientX: 150, clientY: 70 }))
      })
      expect(result.current.selectedBlockIds.size).toBe(0)
    }

    // Straight down the whole note — under the old direction heuristic this was
    // the gesture that selected blocks. It must now select nothing.
    act(() => {
      inlineContent.dispatchEvent(mouse('mousedown', { clientX: 60, clientY: 0 }))
      document.dispatchEvent(mouse('mousemove', { clientX: 60, clientY: 190 }))
      document.dispatchEvent(mouse('mouseup', { clientX: 60, clientY: 190 }))
    })
    expect(result.current.selectedBlockIds.size).toBe(0)

    unmount()
    trigger.remove()
  })

  it('starts a marquee everywhere except on selectable text', () => {
    // The decision table from #1441, one press location per row.
    const { trigger, blockContainerRef } = setupDom()
    const editor = { prosemirrorView: { dom: { blur: vi.fn() } } }

    // The gray margin beside the text column: nothing above it is inline content.
    const margin = document.createElement('div')
    trigger.append(margin)
    // A list marker, and any block holding no editable text (task, file,
    // bookmark, YouTube embed). Markers are a ::before on the block content
    // element and pseudo-elements are never event targets, so both press
    // locations report a `.bn-block-content` with no inline content inside it.
    const blockContentWithoutText = document.createElement('div')
    blockContentWithoutText.className = 'bn-block-content'
    trigger.append(blockContentWithoutText)
    // The empty area below the last block.
    const belowLastBlock = document.createElement('div')
    belowLastBlock.className = 'editor-click-area'
    trigger.append(belowLastBlock)
    // A line of text, plus a bold run nested inside it — the rule is about the
    // nearest inline content ancestor, not about the target itself.
    const line = document.createElement('div')
    line.className = 'bn-inline-content'
    trigger.append(line)
    const boldRun = document.createElement('strong')
    line.append(boldRun)

    const { result, unmount } = renderHook(() =>
      useBlockMarqueeSelection({
        editor,
        blockContainerRef,
        triggerContainerEl: trigger
      })
    )

    for (const outsideText of [margin, blockContentWithoutText, belowLastBlock]) {
      act(() => {
        outsideText.dispatchEvent(mouse('mousedown', { clientX: 0, clientY: 0 }))
        document.dispatchEvent(mouse('mousemove', { clientX: 150, clientY: 70 }))
        document.dispatchEvent(mouse('mouseup', { clientX: 150, clientY: 70 }))
      })
      expect([...result.current.selectedBlockIds]).toEqual(['a', 'b'])
      act(() => {
        result.current.clearSelection()
      })
    }

    for (const insideText of [line, boldRun]) {
      act(() => {
        insideText.dispatchEvent(mouse('mousedown', { clientX: 0, clientY: 0 }))
        document.dispatchEvent(mouse('mousemove', { clientX: 150, clientY: 70 }))
        document.dispatchEvent(mouse('mouseup', { clientX: 150, clientY: 70 }))
      })
      expect(result.current.selectedBlockIds.size).toBe(0)
    }

    unmount()
    trigger.remove()
  })

  it('needs a real drag rather than a click, in any direction', () => {
    const { trigger, blockContainerRef } = setupDom()
    const editor = { prosemirrorView: { dom: { blur: vi.fn() } } }

    const { result, unmount } = renderHook(() =>
      useBlockMarqueeSelection({
        editor,
        blockContainerRef,
        triggerContainerEl: trigger
      })
    )

    // Same press, same geometry over block 'a' — only the travel differs.
    // 4px is a click with a shaky hand and must not flash a selection box.
    act(() => {
      trigger.dispatchEvent(mouse('mousedown', { clientX: 10, clientY: 20 }))
      document.dispatchEvent(mouse('mousemove', { clientX: 14, clientY: 20 }))
      document.dispatchEvent(mouse('mouseup', { clientX: 14, clientY: 20 }))
    })
    expect(result.current.selectedBlockIds.size).toBe(0)
    expect(result.current.marqueeRect).toBeNull()

    // 6px of the same purely horizontal motion is a drag. Direction carries no
    // meaning any more, so sideways travel starts a marquee just as down does.
    act(() => {
      trigger.dispatchEvent(mouse('mousedown', { clientX: 10, clientY: 20 }))
      document.dispatchEvent(mouse('mousemove', { clientX: 16, clientY: 20 }))
      document.dispatchEvent(mouse('mouseup', { clientX: 16, clientY: 20 }))
    })
    expect([...result.current.selectedBlockIds]).toEqual(['a'])

    unmount()
    trigger.remove()
  })

  it('clears a live marquee selection when the press lands in text, without starting a new one', () => {
    const { trigger, blockContainerRef } = setupDom()
    const editor = { prosemirrorView: { dom: { blur: vi.fn() } } }
    const line = document.createElement('div')
    line.className = 'bn-inline-content'
    trigger.append(line)

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

    // Declining to start a marquee must not also decline to clear the old one:
    // a stale block highlight competing with the caret is its own bug.
    act(() => {
      line.dispatchEvent(mouse('mousedown', { clientX: 60, clientY: 0 }))
      document.dispatchEvent(mouse('mousemove', { clientX: 60, clientY: 190 }))
      document.dispatchEvent(mouse('mouseup', { clientX: 60, clientY: 190 }))
    })
    expect(result.current.selectedBlockIds.size).toBe(0)
    expect(result.current.highlightRects).toEqual([])

    unmount()
    trigger.remove()
  })
})

// --- Marquee measurement cost -------------------------------------------------

interface BlockSpec {
  id: string
  children?: BlockSpec[]
}

const BLOCK_ROW_PX = 20
const BLOCK_GAP_PX = 4
const NEST_INDENT_PX = 24

/**
 * Lay a note out the way CSS block flow does: siblings stack top-to-bottom in
 * document order and a nested block is rendered inside its parent's box, so the
 * parent's rect encloses every descendant. Returns the y the caller continues at.
 */
function layoutBlocks(
  specs: ReadonlyArray<BlockSpec>,
  parent: HTMLElement,
  startTop: number,
  left: number
): number {
  let y = startTop
  for (const spec of specs) {
    const el = document.createElement('div')
    el.className = 'bn-block'
    el.dataset.id = spec.id
    parent.append(el)
    const top = y
    y += BLOCK_ROW_PX
    if (spec.children?.length) {
      y = layoutBlocks(spec.children, el, y, left + NEST_INDENT_PX)
    }
    setRect(el, { left, top, width: 300 - (left - 10), height: y - top })
    y += BLOCK_GAP_PX
  }
  return y
}

function setupNote(specs: ReadonlyArray<BlockSpec>): {
  trigger: HTMLDivElement
  blockContainer: HTMLDivElement
  blockContainerRef: React.RefObject<HTMLDivElement | null>
  cleanup: () => void
} {
  const trigger = document.createElement('div')
  const blockContainer = document.createElement('div')
  const height = layoutBlocks(specs, blockContainer, 10, 10)
  setRect(trigger, { left: 0, top: 0, width: 400, height: height + 10 })
  trigger.append(blockContainer)
  document.body.append(trigger)
  return {
    trigger,
    blockContainer,
    blockContainerRef: { current: blockContainer },
    cleanup: () => trigger.remove()
  }
}

function flatNote(count: number): BlockSpec[] {
  return Array.from({ length: count }, (_, index) => ({ id: `b${index}` }))
}

/**
 * The reference implementation: measure every block, keep the ones the box
 * touches. Whatever the hook does, it must agree with this exactly.
 */
function exhaustiveHits(
  blockContainer: HTMLElement,
  box: { left: number; top: number; right: number; bottom: number }
): string[] {
  const ids: string[] = []
  blockContainer.querySelectorAll<HTMLElement>('.bn-block[data-id]').forEach((el) => {
    const r = el.getBoundingClientRect()
    if (!(r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom)) {
      const id = el.dataset.id
      if (id && !ids.includes(id)) ids.push(id)
    }
  })
  return ids
}

function boxOf(
  from: { x: number; y: number },
  to: { x: number; y: number }
): { left: number; top: number; right: number; bottom: number } {
  return {
    left: Math.min(from.x, to.x),
    right: Math.max(from.x, to.x),
    top: Math.min(from.y, to.y),
    bottom: Math.max(from.y, to.y)
  }
}

/** Deterministic LCG so a failure is reproducible from the seed alone. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

describe('useBlockMarqueeSelection measurement cost', () => {
  const editor = { prosemirrorView: { dom: { blur: vi.fn() } } }

  beforeEach(() => {
    rectReads = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  function drag(
    trigger: HTMLElement,
    blockContainerRef: React.RefObject<HTMLDivElement | null>,
    from: { x: number; y: number },
    to: { x: number; y: number },
    downTarget?: HTMLElement
  ): { ids: string[]; readsForOneFrame: number; unmount: () => void } {
    const { result, unmount } = renderHook(() =>
      useBlockMarqueeSelection({ editor, blockContainerRef, triggerContainerEl: trigger })
    )
    act(() => {
      ;(downTarget ?? trigger).dispatchEvent(
        mouse('mousedown', { clientX: from.x, clientY: from.y })
      )
    })
    rectReads = 0
    act(() => {
      document.dispatchEvent(mouse('mousemove', { clientX: to.x, clientY: to.y }))
    })
    const readsForOneFrame = rectReads
    act(() => {
      document.dispatchEvent(mouse('mouseup', { clientX: to.x, clientY: to.y }))
    })
    return { ids: [...result.current.selectedBlockIds], readsForOneFrame, unmount }
  }

  it('measures a handful of blocks per frame instead of every block in the note', () => {
    // 200 flat blocks on a 24px pitch: b0 spans 10..30, b199 spans 4786..4806.
    const { trigger, blockContainerRef, cleanup } = setupNote(flatNote(200))
    // A marquee low in the note — the case where "scan from the top" is worst.
    const from = { x: 5, y: 4002 }
    const to = { x: 200, y: 4060 }

    const { ids, readsForOneFrame, unmount } = drag(trigger, blockContainerRef, from, to)

    // Identical selection to the reference scan…
    expect(ids).toEqual(exhaustiveHits(blockContainerRef.current!, boxOf(from, to)))
    expect(ids).toEqual(['b166', 'b167', 'b168'])
    // …at a fixed cost: 1 trigger rect + 7 binary-search probes + 4 blocks
    // walked back from the marquee (3 hits plus the one that ends above it).
    expect(readsForOneFrame).toBe(12)

    unmount()
    cleanup()
  })

  it('still selects an enclosing parent when the marquee only covers its deep children', () => {
    // The parent's own rect reaches down over its children, so a marquee that
    // touches only the children touches the parent too.
    const { trigger, blockContainerRef, cleanup } = setupNote([
      { id: 'lead' },
      {
        id: 'parent',
        children: Array.from({ length: 12 }, (_, index) => ({ id: `child${index}` }))
      },
      { id: 'tail' }
    ])
    const from = { x: 5, y: 150 }
    const to = { x: 200, y: 195 }

    const { ids, unmount } = drag(trigger, blockContainerRef, from, to)

    expect(ids).toEqual(exhaustiveHits(blockContainerRef.current!, boxOf(from, to)))
    expect(ids).toEqual(['parent', 'child4', 'child5'])

    unmount()
    cleanup()
  })

  it('selects the same blocks as an exhaustive scan for every drag shape', () => {
    const specs: BlockSpec[] = [
      { id: 'b0' },
      { id: 'b1', children: [{ id: 'b1a' }, { id: 'b1b', children: [{ id: 'b1b1' }] }] },
      { id: 'b2' },
      { id: 'b3', children: [{ id: 'b3a' }] },
      { id: 'b4' },
      { id: 'b5' }
    ]

    const shapes: Array<{
      name: string
      from: { x: number; y: number }
      to: { x: number; y: number }
      onBlock?: string
      expected: string[]
    }> = [
      {
        name: 'down',
        from: { x: 5, y: 15 },
        to: { x: 250, y: 120 },
        expected: ['b0', 'b1', 'b1a', 'b1b', 'b1b1']
      },
      {
        name: 'up',
        from: { x: 250, y: 200 },
        to: { x: 5, y: 60 },
        expected: ['b1', 'b1a', 'b1b', 'b1b1', 'b2', 'b3', 'b3a']
      },
      {
        name: 'right-to-left',
        from: { x: 320, y: 60 },
        to: { x: 12, y: 130 },
        expected: ['b1', 'b1a', 'b1b', 'b1b1', 'b2']
      },
      {
        name: 'starts inside a block',
        from: { x: 40, y: 140 },
        to: { x: 250, y: 260 },
        onBlock: 'b2',
        expected: ['b2', 'b3', 'b3a', 'b4', 'b5']
      },
      // A thin drag in the left gutter: vertically over the note, horizontally
      // clear of every block, so it must select nothing.
      { name: 'selects nothing', from: { x: 1, y: 60 }, to: { x: 6, y: 200 }, expected: [] }
    ]

    for (const shape of shapes) {
      const { trigger, blockContainer, blockContainerRef, cleanup } = setupNote(specs)
      const downTarget = shape.onBlock
        ? blockContainer.querySelector<HTMLElement>(`[data-id="${shape.onBlock}"]`)!
        : undefined

      const { ids, unmount } = drag(trigger, blockContainerRef, shape.from, shape.to, downTarget)

      expect({ shape: shape.name, ids }).toEqual({
        shape: shape.name,
        ids: exhaustiveHits(blockContainer, boxOf(shape.from, shape.to))
      })
      expect({ shape: shape.name, ids }).toEqual({ shape: shape.name, ids: shape.expected })

      unmount()
      cleanup()
    }
  })

  it('agrees with the exhaustive scan across randomised marquees on a nested note', () => {
    const specs: BlockSpec[] = Array.from({ length: 40 }, (_, index) =>
      index % 3 === 0
        ? {
            id: `n${index}`,
            children: [
              { id: `n${index}c0` },
              { id: `n${index}c1`, children: [{ id: `n${index}c1c` }] }
            ]
          }
        : { id: `n${index}` }
    )
    const random = makeRandom(20260808)

    for (let i = 0; i < 150; i += 1) {
      const { trigger, blockContainer, blockContainerRef, cleanup } = setupNote(specs)
      const height = trigger.getBoundingClientRect().height
      const y1 = Math.round(random() * height)
      const y2 = Math.max(
        0,
        Math.min(height, y1 + (random() < 0.5 ? -1 : 1) * (16 + random() * 400))
      )
      const from = { x: Math.round(random() * 380), y: y1 }
      const to = { x: Math.round(random() * 380), y: Math.round(y2) }

      const { ids, unmount } = drag(trigger, blockContainerRef, from, to)

      expect({ i, ids }).toEqual({ i, ids: exhaustiveHits(blockContainer, boxOf(from, to)) })

      unmount()
      cleanup()
    }
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
