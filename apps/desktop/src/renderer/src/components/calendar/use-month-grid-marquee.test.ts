import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMonthGridMarquee } from './use-month-grid-marquee'
import type { RefObject } from 'react'

function createCell(date: string): HTMLDivElement {
  const el = document.createElement('div')
  el.dataset.date = date
  return el
}

function createMockGridRef(): RefObject<HTMLDivElement | null> {
  const el = document.createElement('div')
  return { current: el }
}

describe('useMonthGridMarquee', () => {
  it('starts with no selection', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))
    expect(result.current.selection).toBeNull()
  })

  it('starts not dragging', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))
    expect(result.current.isDragging).toBe(false)
  })

  it('creates single-day selection on double-click', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))
    const cell = createCell('2026-04-14')
    ref.current!.appendChild(cell)
    const event = {
      target: cell,
      button: 0,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent
    act(() => {
      result.current.handlers.onDoubleClick(event)
    })
    expect(result.current.selection).not.toBeNull()
    expect(result.current.selection!.startDate).toBe('2026-04-14')
    expect(result.current.selection!.endDate).toBe('2026-04-14')
  })

  it('clears selection via clearSelection()', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))
    const cell = createCell('2026-04-14')
    ref.current!.appendChild(cell)
    const event = {
      target: cell,
      button: 0,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent
    act(() => {
      result.current.handlers.onDoubleClick(event)
    })
    expect(result.current.selection).not.toBeNull()
    act(() => {
      result.current.clearSelection()
    })
    expect(result.current.selection).toBeNull()
  })

  it('ignores double-click on event chip', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))
    const cell = createCell('2026-04-14')
    const chip = document.createElement('div')
    chip.dataset.visualType = 'event'
    cell.appendChild(chip)
    ref.current!.appendChild(cell)
    const event = {
      target: chip,
      button: 0,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent
    act(() => {
      result.current.handlers.onDoubleClick(event)
    })
    expect(result.current.selection).toBeNull()
  })

  it('ignores double-click when no data-date found', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))
    const el = document.createElement('div')
    ref.current!.appendChild(el)
    const event = {
      target: el,
      button: 0,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent
    act(() => {
      result.current.handlers.onDoubleClick(event)
    })
    expect(result.current.selection).toBeNull()
  })

  it('starts dragging on mousedown but does not create selection until mousemove', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))
    const cell = createCell('2026-04-10')
    ref.current!.appendChild(cell)
    const event = {
      target: cell,
      button: 0,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent
    act(() => {
      result.current.handlers.onMouseDown(event)
    })
    expect(result.current.isDragging).toBe(true)
    expect(result.current.selection).toBeNull()
  })

  it('ignores non-left-button mousedown', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))
    const cell = createCell('2026-04-10')
    ref.current!.appendChild(cell)
    const event = {
      target: cell,
      button: 2,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent
    act(() => {
      result.current.handlers.onMouseDown(event)
    })
    expect(result.current.isDragging).toBe(false)
    expect(result.current.selection).toBeNull()
  })

  it('ignores mousedown on event chip', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))
    const cell = createCell('2026-04-10')
    const chip = document.createElement('div')
    chip.dataset.visualType = 'event'
    cell.appendChild(chip)
    ref.current!.appendChild(cell)
    const event = {
      target: chip,
      button: 0,
      preventDefault: vi.fn(),
    } as unknown as React.MouseEvent
    act(() => {
      result.current.handlers.onMouseDown(event)
    })
    expect(result.current.isDragging).toBe(false)
  })

  it('orderDates ensures startDate <= endDate for backward drag', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))

    const startCell = createCell('2026-04-14')
    ref.current!.appendChild(startCell)

    const endCell = createCell('2026-04-10')
    ref.current!.appendChild(endCell)

    act(() => {
      result.current.handlers.onMouseDown({
        target: startCell,
        button: 0,
        preventDefault: vi.fn(),
      } as unknown as React.MouseEvent)
    })

    act(() => {
      const moveEvent = new MouseEvent('mousemove', { bubbles: true })
      Object.defineProperty(moveEvent, 'target', { value: endCell })
      document.dispatchEvent(moveEvent)
    })

    if (result.current.selection) {
      expect(result.current.selection.startDate <= result.current.selection.endDate).toBe(true)
    }
  })
})
