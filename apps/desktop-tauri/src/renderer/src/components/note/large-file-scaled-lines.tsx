import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  anchorForScrollTop,
  endAnchor,
  scaledSpan,
  scrollTopForLine,
  settle,
  type ScrollAnchor
} from './large-file-scroll'
import { chordPendingRef } from '@/hooks/chord-pending-ref'

/** Px one arrow key press moves, as the browser's own keyboard scroll does. */
const ARROW_STEP_PX = 40
/** Share of the viewport a Page key moves, leaving a line of context. */
const PAGE_STEP = 0.9

interface ScaledLinesProps {
  lineCount: number
  /** The smallest height a row can have, in px; sizes the window and the scrollbar. */
  rowHeight: number
  /** Rows laid out beyond the viewport on either side. */
  overscan: number
  /** A line to center, set by find; a new object moves the viewport again. */
  target: { line: number } | null
  /** Names the scroll region for assistive tech. */
  label: string
  ensureRange: (startLine: number, endLine: number) => void
  /**
   * Whether this is the surface the keyboard belongs to. A viewer in a background tab stays
   * mounted, and one key press must not move two of them.
   */
  active: boolean
  renderRow: (line: number) => ReactNode
}

/**
 * The large-file rows for a file past `LARGE_FILE_SCALED_LINES`.
 *
 * The scrollbar spans a fixed `scaledSpan` and stands for a fraction of the
 * file, so dragging it moves through the whole file in one track. Everything
 * else (the wheel, the trackpad, arrow and page keys) moves the anchor by px,
 * row by measured row, the way a normal scroll does: in a 30-million-line file
 * one scrollbar px is ~10 lines, far too coarse to read by. Only the window of
 * rows around the anchor is in the DOM, laid out in flow, so a row's height is
 * whatever the browser makes it and no cache of heights is kept.
 */
export function ScaledLines({
  lineCount,
  rowHeight,
  overscan,
  target,
  label,
  ensureRange,
  active,
  renderRow
}: ScaledLinesProps): React.JSX.Element {
  const scrollRef = useRef<HTMLElement>(null)
  const windowRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<ScrollAnchor>({ line: 0, offset: 0 })
  const [size, setSize] = useState({ width: 0, height: 0 })
  // Set by every move except a drag: the scrollbar follows the anchor once
  // layout has placed it. A drag already put the scrollbar where it wants it.
  const [syncRequest, setSyncRequest] = useState(0)
  const syncedRequestRef = useRef(0)

  // Find centers its hit by setting the anchor, never by scrolling to a px. A
  // new hit object is a new jump, even to the same line.
  const [lastTarget, setLastTarget] = useState(target)
  if (target !== lastTarget) {
    setLastTarget(target)
    if (target) {
      setAnchor({ line: target.line, offset: -Math.max(0, size.height / 2 - rowHeight / 2) })
      setSyncRequest((request) => request + 1)
    }
  }

  const visibleRows = Math.max(1, Math.ceil(size.height / rowHeight))
  const reach = visibleRows + overscan
  const first = Math.max(0, anchor.line - reach)
  const last = Math.min(lineCount - 1, anchor.line + reach)
  const span = Math.max(scaledSpan(rowHeight), size.height)

  // The anchor after layout clamped it, which is what a wheel turn starts from.
  const settledRef = useRef(anchor)
  // The anchor a move asked for and no render has settled yet. A second wheel
  // event before that render starts from here, not from `settledRef`, so no
  // delta is dropped.
  const pendingRef = useRef<ScrollAnchor | null>(null)
  // Whether layout left the viewport on the file's last row.
  const atEndRef = useRef(false)
  // The scrollTop this component last wrote, so its own scroll event is not
  // read back as a drag.
  const writtenScrollTopRef = useRef<number | null>(null)

  // Fetch the pages of the rows in the window.
  useEffect(() => {
    // oxlint-disable-next-line react-you-might-not-need-an-effect/no-pass-live-state-to-parent, react-you-might-not-need-an-effect/no-pass-data-to-parent -- a page request, not state handed up
    if (lineCount > 0) ensureRange(first, last)
  }, [ensureRange, first, last, lineCount])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return undefined
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      )
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Place the window so the anchor line sits at the top edge, then clamp so
  // neither end of the file leaves blank space, and record where that put us.
  // Runs after every render that can move a row: rows grow when their page
  // arrives and reflow when the pane's width changes.
  useLayoutEffect(() => {
    const element = scrollRef.current
    const windowElement = windowRef.current
    if (!element || !windowElement) return
    const rows = rowElements(windowElement)
    const anchorRow = rows.find((row) => row.line === anchor.line)
    if (!anchorRow) return
    const contentHeight = windowElement.offsetHeight
    let top = anchorRow.element.offsetTop + anchor.offset
    top = Math.min(top, contentHeight - size.height)
    top = Math.max(top, 0)
    windowElement.style.transform = `translateY(${-top}px)`

    const atTop =
      rows.find(
        (row) => top >= row.element.offsetTop && top < row.element.offsetTop + row.height
      ) ?? anchorRow
    const settled = { line: atTop.line, offset: top - atTop.element.offsetTop }
    settledRef.current = settled
    pendingRef.current = null
    atEndRef.current = last === lineCount - 1 && top >= contentHeight - size.height - 1

    if (syncRequest !== syncedRequestRef.current) {
      syncedRequestRef.current = syncRequest
      // The end anchor maps past the last top line, to the bottom of the track.
      const atEnd = anchor.offset === Number.MAX_SAFE_INTEGER
      element.scrollTop = scrollTopForLine(
        atEnd ? lineCount : settled.line,
        element.scrollHeight - element.clientHeight,
        lineCount,
        visibleRows
      )
      writtenScrollTopRef.current = element.scrollTop
    }
  })

  const geometryRef = useRef({ lineCount, visibleRows, rowHeight, height: size.height })
  const activeRef = useRef(active)
  useEffect(() => {
    geometryRef.current = { lineCount, visibleRows, rowHeight, height: size.height }
    activeRef.current = active
  })

  // Wheel, trackpad and keys move by px from where the viewport is now; the
  // drag of the scrollbar is a share of the file. Listeners are attached here
  // because the wheel one must not be passive, so the native scroll, which
  // would be scaled, can be cancelled.
  useEffect(() => {
    const element = scrollRef.current
    const windowElement = windowRef.current
    if (!element || !windowElement) return undefined

    const moveTo = (next: ScrollAnchor): void => {
      const geometry = geometryRef.current
      const heights = new Map(rowElements(windowElement).map((row) => [row.line, row.height]))
      const settled =
        next.offset === Number.MAX_SAFE_INTEGER
          ? next
          : settle(next, (line) => heights.get(line) ?? geometry.rowHeight, geometry.lineCount)
      pendingRef.current = settled
      setAnchor(settled)
      setSyncRequest((request) => request + 1)
    }
    const moveBy = (px: number): void => {
      const from = pendingRef.current ?? settledRef.current
      moveTo({ line: from.line, offset: from.offset + px })
    }
    // At either end of the file a wheel turn past it is left to the page behind.
    const atEdge = (direction: number): boolean => {
      const current = pendingRef.current ?? settledRef.current
      if (direction < 0) return current.line === 0 && current.offset <= 0
      return current.offset === Number.MAX_SAFE_INTEGER || (!pendingRef.current && atEndRef.current)
    }

    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.deltaY === 0 || atEdge(Math.sign(event.deltaY))) return
      event.preventDefault()
      const { rowHeight: lineHeight, height } = geometryRef.current
      const unit = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? height : 1
      moveBy(event.deltaY * unit)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey) return
      // Option/Alt + arrow is a page move in the browser; nothing else takes Alt.
      if (event.altKey && !event.key.startsWith('Arrow')) return
      // Space on a button inside a row (show the rest of a line) is the button's.
      if (event.key === ' ' && event.target !== element) return
      const page = geometryRef.current.height * PAGE_STEP
      const steps: Record<string, (() => void) | undefined> = {
        ArrowDown: () => moveBy(event.altKey ? page : ARROW_STEP_PX),
        ArrowUp: () => moveBy(event.altKey ? -page : -ARROW_STEP_PX),
        PageDown: () => moveBy(page),
        PageUp: () => moveBy(-page),
        ' ': () => moveBy(event.shiftKey ? -page : page),
        Home: () => moveTo({ line: 0, offset: 0 }),
        End: () => moveTo(endAnchor(geometryRef.current.lineCount))
      }
      const step = steps[event.key]
      if (!step) return
      event.preventDefault()
      step()
    }

    const onScroll = (): void => {
      const written = writtenScrollTopRef.current
      if (written !== null && Math.abs(element.scrollTop - written) <= 1) return
      writtenScrollTopRef.current = null
      const geometry = geometryRef.current
      setAnchor(
        anchorForScrollTop(
          element.scrollTop,
          element.scrollHeight - element.clientHeight,
          geometry.lineCount,
          geometry.visibleRows
        )
      )
    }

    // With nothing focused (the find bar closed, a click on the page's margin) a key press is
    // left to the browser, which scrolls this region's scaled bar by hundreds of lines per
    // arrow. A key aimed at nothing in particular is the viewer's.
    const onBodyKeyDown = (event: KeyboardEvent): void => {
      if (!activeRef.current || event.defaultPrevented) return
      if (event.target !== document.body && event.target !== document.documentElement) return
      // Shift+Arrow is the second key of the pane chord (⌘K, then Shift+Arrow). The chord's own
      // listener may run after this one, when a restored tab mounted this viewer first, and
      // would find the key already taken here. With no chord pending it is an ordinary key.
      if (chordPendingRef.current && event.shiftKey && event.key.startsWith('Arrow')) return
      onKeyDown(event)
    }

    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('keydown', onKeyDown)
    element.addEventListener('scroll', onScroll)
    window.addEventListener('keydown', onBodyKeyDown)
    return () => {
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('keydown', onKeyDown)
      element.removeEventListener('scroll', onScroll)
      window.removeEventListener('keydown', onBodyKeyDown)
    }
  }, [])

  const lines: number[] = []
  for (let line = first; line <= last; line += 1) lines.push(line)

  return (
    <section
      ref={scrollRef}
      data-testid="large-file-scaled-lines"
      aria-label={label}
      // Focusable so the keys above reach it: left to the browser, an arrow
      // key would scroll the scaled bar by hundreds of lines.
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scroll region must take keys
      tabIndex={0}
      className="min-h-0 flex-1 overflow-y-auto focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)] focus-visible:ring-inset focus-visible:outline-none"
    >
      <div className="relative w-full" style={{ height: span }}>
        <div className="sticky top-0 overflow-hidden" style={{ height: size.height }}>
          <div ref={windowRef} className="relative w-full">
            {lines.map((line) => (
              <div key={line} data-line={line}>
                {renderRow(line)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function rowElements(
  windowElement: HTMLElement
): Array<{ line: number; element: HTMLElement; height: number }> {
  const rows: Array<{ line: number; element: HTMLElement; height: number }> = []
  for (const child of Array.from(windowElement.children)) {
    if (!(child instanceof HTMLElement)) continue
    rows.push({ line: Number(child.dataset.line), element: child, height: child.offsetHeight })
  }
  return rows
}
