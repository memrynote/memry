# Calendar Marquee Selection → Event Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag on empty calendar space (Day/Week/Month) to create events via an inline quick-create popover.

**Architecture:** Shared `useTimeGridMarquee` hook for Day+Week (identical `HOUR_HEIGHT=96` grid), separate `useMonthGridMarquee` hook for Month's date-cell grid. A `MarqueeSelectionOverlay` renders the highlight; a `CalendarQuickCreatePopover` handles inline event creation. All hooks are pure renderer-side — no backend changes.

**Tech Stack:** React 19, Vitest, Testing Library, existing `calendarService` IPC

**Spec:** `docs/superpowers/specs/2026-04-14-calendar-marquee-create-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `components/calendar/use-time-grid-marquee.ts` | Create | Drag + double-click → time selection for Day/Week grids |
| `components/calendar/use-time-grid-marquee.test.ts` | Create | Unit tests for snap math, drag direction, clamping, double-click |
| `components/calendar/use-month-grid-marquee.ts` | Create | Drag + double-click → date range selection for Month grid |
| `components/calendar/use-month-grid-marquee.test.ts` | Create | Unit tests for date range, backward drag, double-click |
| `components/calendar/marquee-selection-overlay.tsx` | Create | Presentational highlight rectangle |
| `components/calendar/calendar-quick-create-popover.tsx` | Create | Inline popover: title, location, datetime, save/details |
| `components/calendar/calendar-quick-create-popover.test.tsx` | Create | Component tests: keyboard, save, dismiss, "Add details" |
| `components/calendar/calendar-day-view.tsx` | Modify | Wire up `useTimeGridMarquee` + overlay + popover |
| `components/calendar/calendar-week-view.tsx` | Modify | Wire up `useTimeGridMarquee` + overlay + popover |
| `components/calendar/calendar-month-view.tsx` | Modify | Wire up `useMonthGridMarquee` + overlay + popover |
| `components/calendar/calendar-shell.tsx` | Modify | Pass `onCreateEventWithRange` + `onQuickSave` down to views |
| `pages/calendar.tsx` | Modify | Add `handleCreateEventWithRange` + `handleQuickSave` callbacks |
| `components/calendar/index.ts` | Modify | Re-export new components |

All paths below are relative to `apps/desktop/src/renderer/src/`.

---

### Task 1: Snap Math Utility + Tests

**Files:**
- Create: `components/calendar/use-time-grid-marquee.ts`
- Create: `components/calendar/use-time-grid-marquee.test.ts`

This task implements only the pure coordinate→time functions (no React hook yet). These are exported named functions so the hook and tests can both use them.

- [ ] **Step 1: Write failing tests for snap math**

Create `components/calendar/use-time-grid-marquee.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { pixelToSnappedMinutes, minutesToTimeString, selectionFromDrag } from './use-time-grid-marquee'

const HOUR_HEIGHT = 96
const SNAP_MINUTES = 15

describe('pixelToSnappedMinutes', () => {
  it('snaps 0px to 0 minutes (midnight)', () => {
    expect(pixelToSnappedMinutes(0, HOUR_HEIGHT, SNAP_MINUTES)).toBe(0)
  })

  it('snaps 96px to 60 minutes (1:00 AM)', () => {
    expect(pixelToSnappedMinutes(96, HOUR_HEIGHT, SNAP_MINUTES)).toBe(60)
  })

  it('snaps 48px to 30 minutes (0:30 AM)', () => {
    expect(pixelToSnappedMinutes(48, HOUR_HEIGHT, SNAP_MINUTES)).toBe(30)
  })

  it('snaps 36px to 15 minutes (nearest 15min boundary)', () => {
    expect(pixelToSnappedMinutes(36, HOUR_HEIGHT, SNAP_MINUTES)).toBe(15)
  })

  it('snaps 20px to 15 minutes (rounds to nearest)', () => {
    expect(pixelToSnappedMinutes(20, HOUR_HEIGHT, SNAP_MINUTES)).toBe(15)
  })

  it('clamps negative values to 0', () => {
    expect(pixelToSnappedMinutes(-50, HOUR_HEIGHT, SNAP_MINUTES)).toBe(0)
  })

  it('clamps above 23:45 (1425 minutes)', () => {
    expect(pixelToSnappedMinutes(9999, HOUR_HEIGHT, SNAP_MINUTES)).toBe(1425)
  })
})

describe('minutesToTimeString', () => {
  it('converts 0 to 00:00', () => {
    expect(minutesToTimeString(0)).toBe('00:00')
  })

  it('converts 90 to 01:30', () => {
    expect(minutesToTimeString(90)).toBe('01:30')
  })

  it('converts 1425 to 23:45', () => {
    expect(minutesToTimeString(1425)).toBe('23:45')
  })
})

describe('selectionFromDrag', () => {
  it('returns start < end when dragging downward', () => {
    // 96px = 60min (1:00), 192px = 120min (2:00)
    const result = selectionFromDrag(96, 192, HOUR_HEIGHT, SNAP_MINUTES)
    expect(result.startMinutes).toBe(60)
    expect(result.endMinutes).toBe(120)
  })

  it('swaps when dragging upward (end < start)', () => {
    const result = selectionFromDrag(192, 96, HOUR_HEIGHT, SNAP_MINUTES)
    expect(result.startMinutes).toBe(60)
    expect(result.endMinutes).toBe(120)
  })

  it('enforces minimum 15min duration when start equals end', () => {
    const result = selectionFromDrag(96, 96, HOUR_HEIGHT, SNAP_MINUTES)
    expect(result.startMinutes).toBe(60)
    expect(result.endMinutes).toBe(75)
  })

  it('returns pixel top and height', () => {
    // 96px=60min, 288px=180min → span=120min → height=120*(96/60)=192px
    const result = selectionFromDrag(96, 288, HOUR_HEIGHT, SNAP_MINUTES)
    expect(result.top).toBe(96)   // 60min * (96/60) = 96px
    expect(result.height).toBe(192) // 120min * (96/60) = 192px
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/calendar/use-time-grid-marquee.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement snap math functions**

Create `components/calendar/use-time-grid-marquee.ts`:

```typescript
const MAX_MINUTES = 1425 // 23:45

export function pixelToSnappedMinutes(
  pixelY: number,
  hourHeight: number,
  snapMinutes: number
): number {
  const rawMinutes = (pixelY / hourHeight) * 60
  const snapped = Math.round(rawMinutes / snapMinutes) * snapMinutes
  return Math.max(0, Math.min(snapped, MAX_MINUTES))
}

export function minutesToTimeString(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export interface MarqueeSelectionGeometry {
  startMinutes: number
  endMinutes: number
  top: number
  height: number
}

export function selectionFromDrag(
  startPixelY: number,
  endPixelY: number,
  hourHeight: number,
  snapMinutes: number
): MarqueeSelectionGeometry {
  const startMin = pixelToSnappedMinutes(startPixelY, hourHeight, snapMinutes)
  const endMin = pixelToSnappedMinutes(endPixelY, hourHeight, snapMinutes)
  const lo = Math.min(startMin, endMin)
  const hi = Math.max(startMin, endMin)
  const finalEnd = hi === lo ? lo + snapMinutes : hi
  const pxPerMinute = hourHeight / 60
  return {
    startMinutes: lo,
    endMinutes: Math.min(finalEnd, MAX_MINUTES + snapMinutes),
    top: lo * pxPerMinute,
    height: (Math.min(finalEnd, MAX_MINUTES + snapMinutes) - lo) * pxPerMinute
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/calendar/use-time-grid-marquee.test.ts`
Expected: all 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/use-time-grid-marquee.ts \
       apps/desktop/src/renderer/src/components/calendar/use-time-grid-marquee.test.ts
git commit -m "feat(calendar): add snap math utilities for marquee time selection"
```

---

### Task 2: `useTimeGridMarquee` React Hook

**Files:**
- Modify: `components/calendar/use-time-grid-marquee.ts`
- Modify: `components/calendar/use-time-grid-marquee.test.ts`

Build the hook on top of the snap math from Task 1. The hook manages drag state (mousedown/mousemove/mouseup on `document`) and double-click → 1-hour selection.

- [ ] **Step 1: Write failing tests for the hook**

Append to `components/calendar/use-time-grid-marquee.test.ts`:

```typescript
import { renderHook, act } from '@testing-library/react'
import { useTimeGridMarquee } from './use-time-grid-marquee'
import type { RefObject } from 'react'

function createMockGridRef(rect: Partial<DOMRect> = {}): RefObject<HTMLDivElement | null> {
  const element = {
    getBoundingClientRect: () => ({
      top: 0, left: 0, right: 500, bottom: 2304, width: 500, height: 2304,
      x: 0, y: 0, toJSON: () => ({}),
      ...rect
    }),
    scrollTop: 0,
    contains: () => true
  } as unknown as HTMLDivElement
  return { current: element }
}

describe('useTimeGridMarquee', () => {
  it('starts with no selection', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useTimeGridMarquee({ gridRef: ref, dateForColumn: () => '2026-04-14' }))
    expect(result.current.selection).toBeNull()
    expect(result.current.isDragging).toBe(false)
  })

  it('creates 1-hour selection on double-click', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useTimeGridMarquee({ gridRef: ref, dateForColumn: () => '2026-04-14' }))
    const event = { clientY: 864, clientX: 250, target: ref.current, preventDefault: vi.fn() } as unknown as React.MouseEvent
    act(() => { result.current.handlers.onDoubleClick(event, 0) })
    expect(result.current.selection).not.toBeNull()
    expect(result.current.selection!.startAt).toBe('2026-04-14T09:00')
    expect(result.current.selection!.endAt).toBe('2026-04-14T10:00')
  })

  it('clears selection via clearSelection()', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useTimeGridMarquee({ gridRef: ref, dateForColumn: () => '2026-04-14' }))
    const event = { clientY: 864, clientX: 250, target: ref.current, preventDefault: vi.fn() } as unknown as React.MouseEvent
    act(() => { result.current.handlers.onDoubleClick(event, 0) })
    expect(result.current.selection).not.toBeNull()
    act(() => { result.current.clearSelection() })
    expect(result.current.selection).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests — verify new tests fail**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/calendar/use-time-grid-marquee.test.ts`
Expected: 3 new tests FAIL — `useTimeGridMarquee` not exported

- [ ] **Step 3: Implement the hook**

Append to `components/calendar/use-time-grid-marquee.ts`:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

const HOUR_HEIGHT = 96
const SNAP_MINUTES = 15
const DOUBLE_CLICK_DURATION_MINUTES = 60
const AUTO_SCROLL_THRESHOLD = 48
const AUTO_SCROLL_MAX_SPEED = 12

export interface TimeGridSelection {
  top: number
  height: number
  date: string
  startAt: string
  endAt: string
  columnIndex: number
  anchorRect: { x: number; y: number; width: number; height: number }
}

interface UseTimeGridMarqueeOptions {
  gridRef: RefObject<HTMLElement | null>
  dateForColumn: (columnIndex: number) => string
  hourHeight?: number
  snapMinutes?: number
}

interface UseTimeGridMarqueeReturn {
  selection: TimeGridSelection | null
  isDragging: boolean
  handlers: {
    onMouseDown: (e: React.MouseEvent, columnIndex?: number) => void
    onDoubleClick: (e: React.MouseEvent, columnIndex?: number) => void
  }
  clearSelection: () => void
}

function isEventChip(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest('[data-visual-type]') !== null
}

function getMouseY(clientY: number, gridRef: RefObject<HTMLElement | null>): number {
  const el = gridRef.current
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  return clientY - rect.top + el.scrollTop
}

export function useTimeGridMarquee(options: UseTimeGridMarqueeOptions): UseTimeGridMarqueeReturn {
  const {
    gridRef,
    dateForColumn,
    hourHeight = HOUR_HEIGHT,
    snapMinutes = SNAP_MINUTES
  } = options

  const [selection, setSelection] = useState<TimeGridSelection | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const dragStateRef = useRef<{
    startY: number
    columnIndex: number
    scrollParent: HTMLElement
  } | null>(null)
  const autoScrollRef = useRef<number | null>(null)

  const buildSelection = useCallback(
    (startY: number, endY: number, columnIndex: number): TimeGridSelection => {
      const geo = selectionFromDrag(startY, endY, hourHeight, snapMinutes)
      const date = dateForColumn(columnIndex)
      const startTime = minutesToTimeString(geo.startMinutes)
      const endTime = minutesToTimeString(geo.endMinutes)
      const el = gridRef.current
      const rect = el?.getBoundingClientRect() ?? { x: 0, y: 0, width: 0, height: 0 }
      return {
        top: geo.top,
        height: geo.height,
        date,
        startAt: `${date}T${startTime}`,
        endAt: `${date}T${endTime}`,
        columnIndex,
        anchorRect: {
          x: rect.x,
          y: rect.y + geo.top - (el?.scrollTop ?? 0),
          width: rect.width,
          height: geo.height
        }
      }
    },
    [dateForColumn, gridRef, hourHeight, snapMinutes]
  )

  const clearSelection = useCallback(() => {
    setSelection(null)
    setIsDragging(false)
    dragStateRef.current = null
  }, [])

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current !== null) {
      cancelAnimationFrame(autoScrollRef.current)
      autoScrollRef.current = null
    }
  }, [])

  const onMouseDown = useCallback(
    (e: React.MouseEvent, columnIndex = 0) => {
      if (e.button !== 0) return
      if (isEventChip(e.target)) return

      e.preventDefault()
      const y = getMouseY(e.clientY, gridRef)
      const scrollParent = gridRef.current?.closest('[class*="overflow-y"]') as HTMLElement | null

      dragStateRef.current = {
        startY: y,
        columnIndex,
        scrollParent: scrollParent ?? gridRef.current!
      }
      setIsDragging(true)
      setSelection(null)
    },
    [gridRef]
  )

  const onDoubleClick = useCallback(
    (e: React.MouseEvent, columnIndex = 0) => {
      if (isEventChip(e.target)) return

      e.preventDefault()
      const y = getMouseY(e.clientY, gridRef)
      const startMinutes = pixelToSnappedMinutes(y, hourHeight, snapMinutes)
      const endMinutes = Math.min(startMinutes + DOUBLE_CLICK_DURATION_MINUTES, MAX_MINUTES + snapMinutes)
      const pxPerMinute = hourHeight / 60
      const startY = startMinutes * pxPerMinute
      const endY = endMinutes * pxPerMinute
      setSelection(buildSelection(startY, endY, columnIndex))
      setIsDragging(false)
    },
    [buildSelection, gridRef, hourHeight, snapMinutes]
  )

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const state = dragStateRef.current
      if (!state) return

      const y = getMouseY(e.clientY, gridRef)
      setSelection(buildSelection(state.startY, y, state.columnIndex))

      const scrollEl = state.scrollParent
      const scrollRect = scrollEl.getBoundingClientRect()
      const relY = e.clientY - scrollRect.top
      const distFromBottom = scrollRect.height - relY

      stopAutoScroll()
      if (relY < AUTO_SCROLL_THRESHOLD) {
        const speed = Math.ceil(AUTO_SCROLL_MAX_SPEED * (1 - relY / AUTO_SCROLL_THRESHOLD))
        const tick = () => {
          scrollEl.scrollTop -= speed
          autoScrollRef.current = requestAnimationFrame(tick)
        }
        autoScrollRef.current = requestAnimationFrame(tick)
      } else if (distFromBottom < AUTO_SCROLL_THRESHOLD) {
        const speed = Math.ceil(AUTO_SCROLL_MAX_SPEED * (1 - distFromBottom / AUTO_SCROLL_THRESHOLD))
        const tick = () => {
          scrollEl.scrollTop += speed
          autoScrollRef.current = requestAnimationFrame(tick)
        }
        autoScrollRef.current = requestAnimationFrame(tick)
      }
    }

    const onMouseUp = () => {
      stopAutoScroll()
      if (!dragStateRef.current) return
      dragStateRef.current = null
      setIsDragging(false)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      stopAutoScroll()
    }
  }, [buildSelection, gridRef, stopAutoScroll])

  return { selection, isDragging, handlers: { onMouseDown, onDoubleClick }, clearSelection }
}
```

Note: move the existing imports (`useCallback`, `useEffect`, `useRef`, `useState`) to the top of the file along with the `RefObject` type import.

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/calendar/use-time-grid-marquee.test.ts`
Expected: all 13 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/use-time-grid-marquee.ts \
       apps/desktop/src/renderer/src/components/calendar/use-time-grid-marquee.test.ts
git commit -m "feat(calendar): add useTimeGridMarquee hook for drag-to-create"
```

---

### Task 3: `MarqueeSelectionOverlay` Component

**Files:**
- Create: `components/calendar/marquee-selection-overlay.tsx`

Pure presentational — no tests needed (visual-only, no logic).

- [ ] **Step 1: Create the overlay component**

Create `components/calendar/marquee-selection-overlay.tsx`:

```tsx
import { cn } from '@/lib/utils'

interface MarqueeSelectionOverlayProps {
  top: number
  height: number
  left?: number
  width?: string
  className?: string
}

export function MarqueeSelectionOverlay({
  top,
  height,
  left,
  width,
  className
}: MarqueeSelectionOverlayProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'pointer-events-none absolute z-10 rounded-md border border-tint/40 bg-tint/20',
        className
      )}
      style={{
        top,
        height,
        left: left ?? 0,
        width: width ?? '100%'
      }}
      data-testid="marquee-selection-overlay"
    />
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/marquee-selection-overlay.tsx
git commit -m "feat(calendar): add MarqueeSelectionOverlay component"
```

---

### Task 4: `CalendarQuickCreatePopover` + Tests

**Files:**
- Create: `components/calendar/calendar-quick-create-popover.tsx`
- Create: `components/calendar/calendar-quick-create-popover.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `components/calendar/calendar-quick-create-popover.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarQuickCreatePopover } from './calendar-quick-create-popover'

const baseProps = {
  anchorRect: { x: 100, y: 200, width: 300, height: 96 },
  startAt: '2026-04-14T14:00',
  endAt: '2026-04-14T15:30',
  isAllDay: false,
  onSave: vi.fn(),
  onDismiss: vi.fn(),
  onOpenFullEditor: vi.fn()
}

describe('CalendarQuickCreatePopover', () => {
  it('renders with datetime display', () => {
    render(<CalendarQuickCreatePopover {...baseProps} />)
    expect(screen.getByTestId('quick-create-popover')).toBeInTheDocument()
    expect(screen.getByText(/14:00/)).toBeInTheDocument()
    expect(screen.getByText(/15:30/)).toBeInTheDocument()
  })

  it('auto-focuses the title input', () => {
    render(<CalendarQuickCreatePopover {...baseProps} />)
    const input = screen.getByPlaceholderText('New Event')
    expect(input).toHaveFocus()
  })

  it('calls onSave with draft when Enter pressed in title', async () => {
    const onSave = vi.fn()
    render(<CalendarQuickCreatePopover {...baseProps} onSave={onSave} />)
    const input = screen.getByPlaceholderText('New Event')
    await userEvent.type(input, 'Team standup{Enter}')
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0][0].title).toBe('Team standup')
  })

  it('does not call onSave when title is empty', async () => {
    const onSave = vi.fn()
    render(<CalendarQuickCreatePopover {...baseProps} onSave={onSave} />)
    const input = screen.getByPlaceholderText('New Event')
    await userEvent.type(input, '{Enter}')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('calls onDismiss on Escape', async () => {
    const onDismiss = vi.fn()
    render(<CalendarQuickCreatePopover {...baseProps} onDismiss={onDismiss} />)
    await userEvent.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('calls onOpenFullEditor with current draft when "Add details" clicked', async () => {
    const onOpenFullEditor = vi.fn()
    render(<CalendarQuickCreatePopover {...baseProps} onOpenFullEditor={onOpenFullEditor} />)
    const input = screen.getByPlaceholderText('New Event')
    await userEvent.type(input, 'Design review')
    await userEvent.click(screen.getByText('Add details'))
    expect(onOpenFullEditor).toHaveBeenCalledOnce()
    expect(onOpenFullEditor.mock.calls[0][0].title).toBe('Design review')
  })

  it('displays all-day format when isAllDay is true', () => {
    render(
      <CalendarQuickCreatePopover
        {...baseProps}
        isAllDay={true}
        startAt="2026-04-14"
        endAt="2026-04-16"
      />
    )
    expect(screen.getByText(/Apr 14/)).toBeInTheDocument()
    expect(screen.getByText(/Apr 16/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/calendar/calendar-quick-create-popover.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the popover**

Create `components/calendar/calendar-quick-create-popover.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { CalendarEventDraft } from './calendar-event-editor-drawer'

interface CalendarQuickCreatePopoverProps {
  anchorRect: { x: number; y: number; width: number; height: number }
  startAt: string
  endAt: string
  isAllDay: boolean
  onSave: (draft: CalendarEventDraft) => void
  onDismiss: () => void
  onOpenFullEditor: (draft: CalendarEventDraft) => void
}

function formatTimeRange(startAt: string, endAt: string, isAllDay: boolean): string {
  if (isAllDay) {
    const start = new Date(startAt + (startAt.includes('T') ? '' : 'T00:00:00'))
    const end = new Date(endAt + (endAt.includes('T') ? '' : 'T00:00:00'))
    const fmt = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    return start.getTime() === end.getTime() ? fmt(start) : `${fmt(start)} – ${fmt(end)}`
  }

  const start = new Date(startAt)
  const end = new Date(endAt)
  const dateFmt = start.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  const timeFmt = (d: Date) =>
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${dateFmt}  ${timeFmt(start)} – ${timeFmt(end)}`
}

export function CalendarQuickCreatePopover({
  anchorRect,
  startAt,
  endAt,
  isAllDay,
  onSave,
  onDismiss,
  onOpenFullEditor
}: CalendarQuickCreatePopoverProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [location, setLocation] = useState('')
  const popoverRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const buildDraft = useCallback(
    (): CalendarEventDraft => ({
      title: title.trim(),
      description: '',
      location: location.trim(),
      isAllDay,
      startAt,
      endAt
    }),
    [title, location, isAllDay, startAt, endAt]
  )

  const handleSave = useCallback(() => {
    if (title.trim().length === 0) return
    onSave(buildDraft())
  }, [title, onSave, buildDraft])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onDismiss()
      }
    },
    [onDismiss]
  )

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSave()
      }
    },
    [handleSave]
  )

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onDismiss()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onDismiss])

  const popoverStyle: React.CSSProperties = {
    position: 'fixed',
    top: anchorRect.y,
    left: anchorRect.x + anchorRect.width + 8,
    zIndex: 50
  }

  return (
    <div
      ref={popoverRef}
      className="w-72 rounded-xl border border-border bg-surface p-4 shadow-lg"
      style={popoverStyle}
      data-testid="quick-create-popover"
      onKeyDown={handleKeyDown}
    >
      <div className="flex flex-col gap-3">
        <Input
          ref={titleRef}
          placeholder="New Event"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleTitleKeyDown}
          className="text-base font-semibold"
        />

        <Input
          placeholder="Add location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          className="text-sm"
        />

        <p className="text-xs font-medium text-muted-foreground">
          {formatTimeRange(startAt, endAt, isAllDay)}
        </p>

        <div className="flex items-center justify-between">
          <button
            type="button"
            className="text-xs font-medium text-tint hover:underline"
            onClick={() => onOpenFullEditor(buildDraft())}
          >
            Add details
          </button>

          <Button size="sm" onClick={handleSave} disabled={title.trim().length === 0}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/calendar/calendar-quick-create-popover.test.tsx`
Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-quick-create-popover.tsx \
       apps/desktop/src/renderer/src/components/calendar/calendar-quick-create-popover.test.tsx
git commit -m "feat(calendar): add CalendarQuickCreatePopover with keyboard shortcuts"
```

---

### Task 5: Wire Marquee into CalendarDayView

**Files:**
- Modify: `components/calendar/calendar-day-view.tsx`
- Modify: `components/calendar/calendar-shell.tsx` (add new props)
- Modify: `pages/calendar.tsx` (add callbacks)

- [ ] **Step 1: Add `onQuickSave` and `onCreateEventWithRange` props through the shell**

In `pages/calendar.tsx`, add two new handlers after `handleSaveEditor` (line 268):

```typescript
const handleQuickSave = async (draft: CalendarEventDraft) => {
  try {
    await calendarService.createEvent(toCreatePayload(draft))
    await queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
  } catch {
    // popover stays open on error — user can retry
  }
}

const handleCreateEventWithRange = (startAt: string, endAt: string, isAllDay: boolean) => {
  setEditorState({
    mode: 'create',
    eventId: null,
    draft: { title: '', description: '', location: '', isAllDay, startAt, endAt }
  })
}
```

Pass both down through `CalendarShell`:

```tsx
onQuickSave={handleQuickSave}
onCreateEventWithRange={handleCreateEventWithRange}
```

- [ ] **Step 2: Update CalendarShell props and pass to views**

In `calendar-shell.tsx`, add to `CalendarShellProps`:

```typescript
onQuickSave: (draft: CalendarEventDraft) => void
onCreateEventWithRange: (startAt: string, endAt: string, isAllDay: boolean) => void
```

Pass both to `CalendarDayView`, `CalendarWeekView`, and `CalendarMonthView`:

```tsx
<CalendarDayView {...viewProps} onAnchorChange={onAnchorChange} onQuickSave={onQuickSave} onCreateEventWithRange={onCreateEventWithRange} />
```

- [ ] **Step 3: Wire marquee into CalendarDayView**

Update `components/calendar/calendar-day-view.tsx`:

Add imports:

```typescript
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTimeGridMarquee } from './use-time-grid-marquee'
import { MarqueeSelectionOverlay } from './marquee-selection-overlay'
import { CalendarQuickCreatePopover } from './calendar-quick-create-popover'
import type { CalendarEventDraft } from './calendar-event-editor-drawer'
```

Add props to `CalendarDayViewProps`:

```typescript
onQuickSave?: (draft: CalendarEventDraft) => void
onCreateEventWithRange?: (startAt: string, endAt: string, isAllDay: boolean) => void
```

Inside the component, add:

```typescript
const gridRef = useRef<HTMLDivElement>(null)
const dateForColumn = useCallback(() => anchorDate, [anchorDate])
const { selection, isDragging, handlers, clearSelection } = useTimeGridMarquee({
  gridRef,
  dateForColumn
})
```

Attach `ref={gridRef}`, `onMouseDown={(e) => handlers.onMouseDown(e, 0)}`, and `onDoubleClick={(e) => handlers.onDoubleClick(e, 0)}` to the time grid div (the `<div className="relative flex-1">`).

Inside that same div, after the current-time indicator, render:

```tsx
{selection && !isDragging && (
  <>
    <MarqueeSelectionOverlay top={selection.top} height={selection.height} />
    <CalendarQuickCreatePopover
      anchorRect={selection.anchorRect}
      startAt={selection.startAt}
      endAt={selection.endAt}
      isAllDay={false}
      onSave={(draft) => {
        onQuickSave?.(draft)
        clearSelection()
      }}
      onDismiss={clearSelection}
      onOpenFullEditor={(draft) => {
        onCreateEventWithRange?.(draft.startAt, draft.endAt, false)
        clearSelection()
      }}
    />
  </>
)}

{isDragging && selection && (
  <MarqueeSelectionOverlay top={selection.top} height={selection.height} />
)}
```

- [ ] **Step 4: Test manually**

Run: `cd apps/desktop && pnpm dev`
Open calendar → Day view → drag on empty space → verify overlay appears → release → popover appears → type title → Enter → event created.
Double-click on empty space → verify 1-hour popover appears.
Click on existing event → verify marquee does NOT start.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-day-view.tsx \
       apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx \
       apps/desktop/src/renderer/src/pages/calendar.tsx
git commit -m "feat(calendar): wire marquee-to-create into day view"
```

---

### Task 6: Wire Marquee into CalendarWeekView

**Files:**
- Modify: `components/calendar/calendar-week-view.tsx`

- [ ] **Step 1: Add marquee to week view**

Update `components/calendar/calendar-week-view.tsx`:

Add imports:

```typescript
import { useCallback, useMemo, useRef } from 'react'
import { useTimeGridMarquee } from './use-time-grid-marquee'
import { MarqueeSelectionOverlay } from './marquee-selection-overlay'
import { CalendarQuickCreatePopover } from './calendar-quick-create-popover'
import type { CalendarEventDraft } from './calendar-event-editor-drawer'
```

Add props:

```typescript
onQuickSave?: (draft: CalendarEventDraft) => void
onCreateEventWithRange?: (startAt: string, endAt: string, isAllDay: boolean) => void
```

Inside component, add:

```typescript
const gridRef = useRef<HTMLDivElement>(null)
const dateForColumn = useCallback((columnIndex: number) => days[columnIndex] ?? days[0], [days])
const { selection, isDragging, handlers, clearSelection } = useTimeGridMarquee({
  gridRef,
  dateForColumn
})
```

Attach `ref={gridRef}` to the parent grid div (`grid-cols-[72px_repeat(7,1fr)]` inside the scrollable area).

For each day column div, attach mouse handlers with column index:

```tsx
onMouseDown={(e) => handlers.onMouseDown(e, i)}
onDoubleClick={(e) => handlers.onDoubleClick(e, i)}
```

Where `i` is the day index from `days.map((day, i) => ...)`.

Inside each day column, render the overlay when selection matches that column:

```tsx
{selection && selection.columnIndex === i && !isDragging && (
  <>
    <MarqueeSelectionOverlay top={selection.top} height={selection.height} />
    <CalendarQuickCreatePopover
      anchorRect={selection.anchorRect}
      startAt={selection.startAt}
      endAt={selection.endAt}
      isAllDay={false}
      onSave={(draft) => {
        onQuickSave?.(draft)
        clearSelection()
      }}
      onDismiss={clearSelection}
      onOpenFullEditor={(draft) => {
        onCreateEventWithRange?.(draft.startAt, draft.endAt, false)
        clearSelection()
      }}
    />
  </>
)}

{isDragging && selection && selection.columnIndex === i && (
  <MarqueeSelectionOverlay top={selection.top} height={selection.height} />
)}
```

- [ ] **Step 2: Update CalendarShell to pass props to WeekView**

In `calendar-shell.tsx`, pass `onQuickSave` and `onCreateEventWithRange` to `CalendarWeekView`:

```tsx
<CalendarWeekView {...viewProps} onQuickSave={onQuickSave} onCreateEventWithRange={onCreateEventWithRange} />
```

- [ ] **Step 3: Test manually**

Run: `cd apps/desktop && pnpm dev`
Open calendar → Week view → drag on a day column → verify overlay confined to that column → release → popover → create event. Test drag in different columns. Double-click in a column. Verify no cross-column dragging.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-week-view.tsx \
       apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx
git commit -m "feat(calendar): wire marquee-to-create into week view"
```

---

### Task 7: `useMonthGridMarquee` Hook + Tests

**Files:**
- Create: `components/calendar/use-month-grid-marquee.ts`
- Create: `components/calendar/use-month-grid-marquee.test.ts`

- [ ] **Step 1: Write failing tests**

Create `components/calendar/use-month-grid-marquee.test.ts`:

```typescript
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

  it('creates single-day selection on double-click', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))
    const cell = createCell('2026-04-14')
    ref.current!.appendChild(cell)
    const event = {
      target: cell,
      preventDefault: vi.fn()
    } as unknown as React.MouseEvent
    act(() => { result.current.handlers.onDoubleClick(event) })
    expect(result.current.selection).not.toBeNull()
    expect(result.current.selection!.startDate).toBe('2026-04-14')
    expect(result.current.selection!.endDate).toBe('2026-04-14')
  })

  it('clears selection via clearSelection()', () => {
    const ref = createMockGridRef()
    const { result } = renderHook(() => useMonthGridMarquee({ gridRef: ref }))
    const cell = createCell('2026-04-14')
    ref.current!.appendChild(cell)
    const event = { target: cell, preventDefault: vi.fn() } as unknown as React.MouseEvent
    act(() => { result.current.handlers.onDoubleClick(event) })
    expect(result.current.selection).not.toBeNull()
    act(() => { result.current.clearSelection() })
    expect(result.current.selection).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/calendar/use-month-grid-marquee.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the hook**

Create `components/calendar/use-month-grid-marquee.ts`:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export interface MonthGridSelection {
  startDate: string
  endDate: string
  anchorRect: { x: number; y: number; width: number; height: number }
}

interface UseMonthGridMarqueeOptions {
  gridRef: RefObject<HTMLElement | null>
}

interface UseMonthGridMarqueeReturn {
  selection: MonthGridSelection | null
  isDragging: boolean
  handlers: {
    onMouseDown: (e: React.MouseEvent) => void
    onDoubleClick: (e: React.MouseEvent) => void
  }
  clearSelection: () => void
}

function getDateFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null
  const cell = target.closest<HTMLElement>('[data-date]')
  return cell?.dataset.date ?? null
}

function isEventChip(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest('[data-visual-type]') !== null
}

function orderDates(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a]
}

function getAnchorRect(gridRef: RefObject<HTMLElement | null>, startDate: string, endDate: string): MonthGridSelection['anchorRect'] {
  const el = gridRef.current
  if (!el) return { x: 0, y: 0, width: 0, height: 0 }
  const startCell = el.querySelector<HTMLElement>(`[data-date="${startDate}"]`)
  if (!startCell) {
    const rect = el.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: 40 }
  }
  const rect = startCell.getBoundingClientRect()
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

export function useMonthGridMarquee(options: UseMonthGridMarqueeOptions): UseMonthGridMarqueeReturn {
  const { gridRef } = options
  const [selection, setSelection] = useState<MonthGridSelection | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartDate = useRef<string | null>(null)

  const clearSelection = useCallback(() => {
    setSelection(null)
    setIsDragging(false)
    dragStartDate.current = null
  }, [])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      if (isEventChip(e.target)) return
      const date = getDateFromTarget(e.target)
      if (!date) return

      e.preventDefault()
      dragStartDate.current = date
      setIsDragging(true)
      setSelection(null)
    },
    []
  )

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEventChip(e.target)) return
      const date = getDateFromTarget(e.target)
      if (!date) return

      e.preventDefault()
      setSelection({
        startDate: date,
        endDate: date,
        anchorRect: getAnchorRect(gridRef, date, date)
      })
      setIsDragging(false)
    },
    [gridRef]
  )

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragStartDate.current) return
      const date = getDateFromTarget(e.target)
      if (!date) return
      const [start, end] = orderDates(dragStartDate.current, date)
      setSelection({
        startDate: start,
        endDate: end,
        anchorRect: getAnchorRect(gridRef, start, end)
      })
    }

    const onMouseUp = () => {
      if (!dragStartDate.current) return
      dragStartDate.current = null
      setIsDragging(false)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [gridRef])

  return { selection, isDragging, handlers: { onMouseDown, onDoubleClick }, clearSelection }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/calendar/use-month-grid-marquee.test.ts`
Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/use-month-grid-marquee.ts \
       apps/desktop/src/renderer/src/components/calendar/use-month-grid-marquee.test.ts
git commit -m "feat(calendar): add useMonthGridMarquee hook for date-range drag"
```

---

### Task 8: Wire Marquee into CalendarMonthView

**Files:**
- Modify: `components/calendar/calendar-month-view.tsx`
- Modify: `components/calendar/calendar-shell.tsx`

- [ ] **Step 1: Add `data-date` attributes to month cells**

In `calendar-month-view.tsx`, add `data-date={day}` to each day cell div (line 46):

```tsx
<div
  key={day}
  data-date={day}
  className={cn(
```

- [ ] **Step 2: Wire up the hook and overlay**

Add imports:

```typescript
import { useRef } from 'react'
import { useMonthGridMarquee } from './use-month-grid-marquee'
import { CalendarQuickCreatePopover } from './calendar-quick-create-popover'
import type { CalendarEventDraft } from './calendar-event-editor-drawer'
```

Add props:

```typescript
onQuickSave?: (draft: CalendarEventDraft) => void
onCreateEventWithRange?: (startAt: string, endAt: string, isAllDay: boolean) => void
```

Inside the component:

```typescript
const gridRef = useRef<HTMLDivElement>(null)
const { selection, isDragging, handlers, clearSelection } = useMonthGridMarquee({ gridRef })
```

Update the grid container div to use `gridRef` and handlers:

```tsx
<div
  ref={(el) => {
    containerRef(el)
    ;(gridRef as React.MutableRefObject<HTMLDivElement | null>).current = el
  }}
  className="grid flex-1 grid-cols-7"
  onMouseDown={handlers.onMouseDown}
  onDoubleClick={handlers.onDoubleClick}
>
```

Inside each day cell, add a selected highlight class when the date is within the drag range:

```tsx
const isSelected = selection && day >= selection.startDate && day <= selection.endDate
```

Add to the cell's className:

```typescript
isSelected && 'ring-2 ring-inset ring-tint/40 bg-tint/10'
```

After the grid container closing tag, render the popover when selection finalized:

```tsx
{selection && !isDragging && (
  <CalendarQuickCreatePopover
    anchorRect={selection.anchorRect}
    startAt={selection.startDate}
    endAt={selection.endDate}
    isAllDay={true}
    onSave={(draft) => {
      onQuickSave?.(draft)
      clearSelection()
    }}
    onDismiss={clearSelection}
    onOpenFullEditor={(draft) => {
      onCreateEventWithRange?.(draft.startAt, draft.endAt, true)
      clearSelection()
    }}
  />
)}
```

- [ ] **Step 3: Pass props through CalendarShell**

In `calendar-shell.tsx`, pass to `CalendarMonthView`:

```tsx
<CalendarMonthView {...viewProps} onQuickSave={onQuickSave} onCreateEventWithRange={onCreateEventWithRange} />
```

- [ ] **Step 4: Test manually**

Run: `cd apps/desktop && pnpm dev`
Calendar → Month view → drag across date cells → verify cells highlight → release → popover with all-day range.
Double-click on empty area of a date → single-day popover.
Click on event chip → no marquee started.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-month-view.tsx \
       apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx
git commit -m "feat(calendar): wire marquee-to-create into month view"
```

---

### Task 9: Update Barrel Exports + Lint/Typecheck

**Files:**
- Modify: `components/calendar/index.ts`

- [ ] **Step 1: Add new exports to barrel**

Add to `components/calendar/index.ts`:

```typescript
export { MarqueeSelectionOverlay } from './marquee-selection-overlay'
export { CalendarQuickCreatePopover } from './calendar-quick-create-popover'
```

- [ ] **Step 2: Run lint and typecheck**

Run: `cd apps/desktop && pnpm typecheck:node && pnpm typecheck:web`
Expected: PASS (ignoring pre-existing test file errors)

Run: `cd apps/desktop && pnpm lint`
Expected: PASS or only pre-existing warnings

- [ ] **Step 3: Run all calendar tests**

Run: `cd apps/desktop && pnpm vitest run src/renderer/src/components/calendar/`
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/index.ts
git commit -m "chore(calendar): update barrel exports for marquee components"
```

---

### Task 10: Integration Test — Day View Marquee Creates Event

**Files:**
- Modify: `components/calendar/calendar-page.test.tsx`

- [ ] **Step 1: Add marquee integration tests**

Append a new `describe` block to `calendar-page.test.tsx`:

```typescript
describe('marquee-to-create', () => {
  beforeEach(() => {
    mockUseCalendarRange.mockReturnValue({
      items: [],
      isLoading: false
    })
    mockListSources.mockResolvedValue({ sources: [] })
    mockCreateEvent.mockResolvedValue({ success: true })
  })

  it('creates event after drag on day view grid', async () => {
    // Switch to day view, simulate drag, verify createEvent called
    // This is an integration-level test verifying the full flow
    // Specific mouse event simulation depends on test utils available
  })
})
```

Note: full mouse drag simulation in JSDOM is limited. The hook unit tests (Tasks 1–2) cover the core logic. This test verifies the wiring at page level — if the test utils support `fireEvent.mouseDown/mouseMove/mouseUp`, wire it up; otherwise add a TODO comment noting E2E coverage is more appropriate.

- [ ] **Step 2: Run full test suite**

Run: `cd apps/desktop && pnpm vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-page.test.tsx
git commit -m "test(calendar): add marquee-to-create integration test scaffolding"
```

---

## Verification Checklist

After all tasks complete:

- [ ] `pnpm dev` — Day/Week/Month marquee works end-to-end
- [ ] Drag on empty space → overlay → popover → save → event appears
- [ ] Double-click on empty space → 1-hour (time) / 1-day (month) event popover
- [ ] Click on event chip → no marquee, existing edit flow works
- [ ] Escape dismisses popover + clears selection
- [ ] "Add details" opens editor drawer with pre-filled times
- [ ] `pnpm lint` — no new errors
- [ ] `pnpm typecheck:node && pnpm typecheck:web` — no new errors
- [ ] `pnpm vitest run` — all tests pass
