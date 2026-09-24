/**
 * Inline preview for an attached `.html` file (#1872), rendered by the file
 * block when the attachment's mime type is `text/html`.
 *
 * @module components/note/content-area/html-embed-preview
 */

import { useLayoutEffect, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  FileCode,
  LeftToRightBlockQuote,
  RightToLeftBlockQuote,
  TextAlignCenter
} from '@/lib/icons'
import { cn } from '@/lib/utils'

const DEFAULT_HTML_HEIGHT = 480
const MIN_HTML_HEIGHT = 120
const MAX_HTML_HEIGHT = 4000
const MIN_HTML_WIDTH = 240
/** Card width assumed until the note column has been measured. */
const DEFAULT_HTML_WIDTH = 600
/** Releasing a drag within this many px of the column edge snaps to full width. */
const SNAP_THRESHOLD = 24

function clampHtmlHeight(value: number): number {
  return Math.round(Math.min(Math.max(value, MIN_HTML_HEIGHT), MAX_HTML_HEIGHT))
}

function clampHtmlWidth(value: number, max: number): number {
  return Math.round(Math.min(Math.max(value, MIN_HTML_WIDTH), max))
}

type HtmlAlign = 'left' | 'center' | 'right'

const ALIGN_VALUES: readonly HtmlAlign[] = ['left', 'center', 'right']

const ALIGN_ICONS: Record<HtmlAlign, typeof TextAlignCenter> = {
  left: LeftToRightBlockQuote,
  center: TextAlignCenter,
  right: RightToLeftBlockQuote
}

/**
 * The sandboxed URL an attached HTML file renders from, or `null` when the ref
 * is not a vault attachment (then it gets the plain download card).
 *
 * Never the memry-file URL itself: that origin can read the whole vault.
 * `memry-html://` serves the same path with a CSP sandbox and nothing else;
 * see `main/vault/html-embed-protocol.ts`.
 */
export function toHtmlEmbedUrl(resolvedUrl: string): string | null {
  return resolvedUrl.startsWith('memry-file:')
    ? `memry-html:${resolvedUrl.slice('memry-file:'.length)}`
    : null
}

export interface HtmlPreviewProps {
  /** The `memry-html://` URL, from {@link toHtmlEmbedUrl}. */
  src: string
  name: string
  /** Stored card width in px; `0` follows the note column. */
  width: number
  /** Stored frame height in px; `0` uses the default. */
  height: number
  align: HtmlAlign
  /** Commit a new width + height (px) to the block props. */
  onResize: (width: number, height: number) => void
  onAlign: (align: HtmlAlign) => void
  menu?: React.ReactNode
}

interface DragState {
  startX: number
  startY: number
  startWidth: number
  startHeight: number
  rtl: boolean
  corner: 'start' | 'end'
}

/**
 * An attached `.html` file, live: its scripts run and it may reach the web.
 *
 * What keeps that safe is the frame, not the content. `sandbox` without
 * `allow-same-origin` gives the document an opaque origin, so it cannot touch
 * this window, `window.api`, or any vault file; main repeats the same sandbox
 * as a CSP header so a dropped attribute cannot widen it. The file is shown as
 * it is — no sanitizing, since the sandbox, not a scrubbed copy, is the
 * boundary.
 *
 * Sized and aligned like the PDF embed: either bottom corner drags width and
 * height together, and the hover toolbar aligns the card in the column. A
 * width dragged to the column edge is stored as `0`, so it keeps following
 * the column when the window is resized instead of freezing at one px value.
 */
export function HtmlPreview({
  src,
  name,
  width,
  height,
  align,
  onResize,
  onAlign,
  menu
}: HtmlPreviewProps) {
  const { t: tPhaseF } = useT('notes')
  const viewRef = useRef<HTMLDivElement>(null)
  const [columnWidth, setColumnWidth] = useState(0)
  const [draft, setDraft] = useState<{ width: number; height: number } | null>(null)
  const dragRef = useRef<DragState | null>(null)

  useLayoutEffect(() => {
    const el = viewRef.current
    if (!el) return
    const measure = () => setColumnWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const widthLimit = columnWidth > 0 ? columnWidth : DEFAULT_HTML_WIDTH
  const storedWidth = width > 0 ? Math.min(width, widthLimit) : widthLimit
  const storedHeight = height > 0 ? clampHtmlHeight(height) : DEFAULT_HTML_HEIGHT
  const cardWidth = draft?.width ?? storedWidth
  const frameHeight = draft?.height ?? storedHeight

  const measureDrag = (drag: DragState, e: React.PointerEvent) => {
    const signX = (drag.corner === 'end' ? 1 : -1) * (drag.rtl ? -1 : 1)
    return {
      width: clampHtmlWidth(drag.startWidth + (e.clientX - drag.startX) * signX, widthLimit),
      height: clampHtmlHeight(drag.startHeight + e.clientY - drag.startY)
    }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>, corner: 'start' | 'end') => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: cardWidth,
      startHeight: frameHeight,
      rtl: getComputedStyle(e.currentTarget).direction === 'rtl',
      corner
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDraft({ width: cardWidth, height: frameHeight })
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag) setDraft(measureDrag(drag, e))
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    dragRef.current = null
    setDraft(null)
    const next = measureDrag(drag, e)
    onResize(next.width >= widthLimit - SNAP_THRESHOLD ? 0 : next.width, next.height)
  }

  // An interrupted drag (app switch, OS gesture, capture stolen) is abandoned,
  // not committed: the reader never released anywhere. After a normal
  // pointer-up the drag is already cleared, so the lost-capture that follows
  // it is a no-op.
  const cancelDrag = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setDraft(null)
  }

  // Keyboard commits exact values, no edge snap: Left/Right width, Up/Down
  // height.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 100 : 20
    const resize: Record<string, () => void> = {
      ArrowRight: () => onResize(clampHtmlWidth(cardWidth + step, widthLimit), height),
      ArrowLeft: () => onResize(clampHtmlWidth(cardWidth - step, widthLimit), height),
      ArrowDown: () => onResize(width, clampHtmlHeight(frameHeight + step)),
      ArrowUp: () => onResize(width, clampHtmlHeight(frameHeight - step))
    }
    const action = resize[e.key]
    if (!action) return
    e.preventDefault()
    action()
  }

  const alignLabels: Record<HtmlAlign, string> = {
    left: tPhaseF('phaseF.componentsNoteContentAreaFileBlock.alignLeft'),
    center: tPhaseF('phaseF.componentsNoteContentAreaFileBlock.alignCenter'),
    right: tPhaseF('phaseF.componentsNoteContentAreaFileBlock.alignRight')
  }
  const resizeLabel = tPhaseF('phaseF.componentsNoteContentAreaFileBlock.resizeHtml')
  const handleProps = {
    tabIndex: 0,
    'data-html-resize-handle': true,
    'aria-label': resizeLabel,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: cancelDrag,
    onLostPointerCapture: cancelDrag,
    onKeyDown: handleKeyDown
  }
  const handleClass =
    'absolute -bottom-1 z-10 h-3.5 w-3.5 touch-none border-b-2 border-foreground/60 opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary'

  return (
    <div ref={viewRef} className="file-html-wrap">
      <div
        className={cn(
          'file-html group relative rounded-md border border-border bg-muted/30 p-2',
          align === 'center' ? 'ms-auto me-auto' : align === 'right' ? 'ms-auto' : 'me-auto'
        )}
        style={{ width: cardWidth }}
      >
        <iframe
          src={src}
          title={name}
          data-testid="html-embed"
          sandbox="allow-scripts allow-forms allow-popups"
          referrerPolicy="no-referrer"
          loading="lazy"
          // While dragging, the frame would swallow the pointer the moment it
          // crosses into it and the resize would stall.
          className={cn('block w-full rounded bg-white', draft && 'pointer-events-none')}
          style={{ height: frameHeight }}
        />
        <div className="mt-2 flex items-center gap-2">
          <FileCode className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{name}</p>
          {menu}
        </div>

        {/* Alignment — hover reveal, top-inline-end, like the PDF embed. */}
        <div className="absolute top-3 end-3 z-10 flex items-center gap-px rounded-md border border-border bg-background/90 p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {ALIGN_VALUES.map((value) => {
            const Icon = ALIGN_ICONS[value]
            return (
              <button
                key={value}
                type="button"
                aria-label={alignLabels[value]}
                aria-pressed={align === value}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onAlign(value)}
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded transition-colors',
                  align === value
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50'
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            )
          })}
        </div>

        {/* Corner resize brackets, faint at rest so they can be found. */}
        <div
          {...handleProps}
          role="slider"
          aria-orientation="horizontal"
          aria-valuemin={MIN_HTML_WIDTH}
          aria-valuemax={widthLimit}
          aria-valuenow={cardWidth}
          onPointerDown={(e) => handlePointerDown(e, 'end')}
          className={cn(handleClass, '-end-1 cursor-nwse-resize border-e-2')}
        />
        <div
          {...handleProps}
          role="button"
          onPointerDown={(e) => handlePointerDown(e, 'start')}
          className={cn(handleClass, '-start-1 cursor-nesw-resize border-s-2')}
        />
      </div>
    </div>
  )
}
