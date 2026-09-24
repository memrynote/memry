/**
 * Inline preview for an attached `.html` file (#1872), rendered by the file
 * block when the attachment's mime type is `text/html`.
 *
 * @module components/note/content-area/html-embed-preview
 */

import { useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { FileCode } from '@/lib/icons'
import { cn } from '@/lib/utils'

const DEFAULT_HTML_HEIGHT = 480
const MIN_HTML_HEIGHT = 120
const MAX_HTML_HEIGHT = 4000

function clampHtmlHeight(value: number): number {
  return Math.round(Math.min(Math.max(value, MIN_HTML_HEIGHT), MAX_HTML_HEIGHT))
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
  /** Stored frame height in px; `0` uses the default. */
  height: number
  onResize: (height: number) => void
  menu?: React.ReactNode
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
 * Width follows the note column; only the height is the reader's to set.
 */
export function HtmlPreview({ src, name, height, onResize, menu }: HtmlPreviewProps) {
  const { t: tPhaseF } = useT('notes')
  const frameHeight = height > 0 ? clampHtmlHeight(height) : DEFAULT_HTML_HEIGHT
  const [draftHeight, setDraftHeight] = useState<number | null>(null)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { startY: e.clientY, startHeight: frameHeight }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDraftHeight(frameHeight)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setDraftHeight(clampHtmlHeight(drag.startHeight + e.clientY - drag.startY))
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    dragRef.current = null
    setDraftHeight(null)
    onResize(clampHtmlHeight(drag.startHeight + e.clientY - drag.startY))
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 100 : 20
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      onResize(clampHtmlHeight(frameHeight + step))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      onResize(clampHtmlHeight(frameHeight - step))
    }
  }

  return (
    <div className="file-html group relative rounded-md border border-border bg-muted/30 p-2">
      <iframe
        src={src}
        title={name}
        data-testid="html-embed"
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        loading="lazy"
        // While dragging, the frame would swallow the pointer the moment it
        // crosses into it and the resize would stall.
        className={cn(
          'block w-full rounded bg-white',
          draftHeight !== null && 'pointer-events-none'
        )}
        style={{ height: draftHeight ?? frameHeight }}
      />
      <div
        role="slider"
        tabIndex={0}
        data-html-resize-handle
        aria-label={tPhaseF('phaseF.componentsNoteContentAreaFileBlock.resizeHtml')}
        aria-orientation="vertical"
        aria-valuemin={MIN_HTML_HEIGHT}
        aria-valuemax={MAX_HTML_HEIGHT}
        aria-valuenow={draftHeight ?? frameHeight}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
        className="mx-auto mt-1 h-1.5 w-10 cursor-ns-resize touch-none rounded-full bg-foreground/20 opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      />
      <div className="mt-1 flex items-center gap-2">
        <FileCode className="h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{name}</p>
        {menu}
      </div>
    </div>
  )
}
