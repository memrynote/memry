import { getI18n } from 'react-i18next'
/**
 * FileBlock - Custom BlockNote block for file attachments with inline PDF preview.
 * Uses react-pdf for PDF rendering.
 *
 * @module components/note/content-area/file-block
 */

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useLayoutEffect,
  useSyncExternalStore
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { PDFDocumentProxy as PdfDocumentProxy } from 'pdfjs-dist'
import { createReactBlockSpec } from '@blocknote/react'
import { fileBlockConfig } from '@memry/editor-schema/blocks'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import {
  FileText,
  File,
  FileAudio,
  Download,
  Upload,
  Loader2,
  LeftToRightBlockQuote,
  TextAlignCenter,
  RightToLeftBlockQuote
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useSync } from '@/contexts/sync-context'
import { useT } from '@memry/i18n/renderer'
import { getAttachmentRevision, subscribeToAttachmentRevisions } from '@/lib/attachment-revision'
import { HAS_SCHEME, useAttachmentNoteId, useResolvedFileUrl } from './note-file-url-context'
import { AttachmentBlockContextMenu, AttachmentMenuButton } from './attachment-block-menu'
import type { FileBlockProps } from './file-block-markers'

export { parseFileBlockMarker, serializeFileBlock } from './file-block-markers'
export type { FileBlockProps } from './file-block-markers'

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Get file icon based on MIME type
 */
function getFileIcon(mimeType: string): React.ReactNode {
  if (mimeType === 'application/pdf') {
    return <FileText className="h-5 w-5 text-red-500" />
  }
  if (mimeType.startsWith('application/vnd.ms-') || mimeType.includes('officedocument')) {
    return <FileText className="h-5 w-5 text-blue-500" />
  }
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return <FileText className="h-5 w-5 text-gray-500" />
  }
  return <File className="h-5 w-5 text-gray-500" />
}

const PDF_LOADING_INDICATOR = (
  <div className="flex h-48 items-center justify-center">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
  </div>
)

// ============================================================================
// PDF Preview Component with Collapsible Sidebar
// ============================================================================

// Resize bounds for the inline PDF preview.
const MIN_PDF_WIDTH = 240
const MIN_PDF_HEIGHT = 96
// Release within this many px of the edge snaps to full width / full page.
const PDF_SNAP_THRESHOLD = 24
// Default card width; the embed resizes as a whole (card + page) like an image.
const DEFAULT_PDF_CARD_WIDTH = 600
// Card border (box-sizing: border-box) subtracted to get the page render width.
const PDF_CARD_BORDER = 2
// Vertical gap between stacked pages in the continuous scroll.
const PDF_PAGE_GAP = 8
// Aspect (height / width) assumed until pdf.js reports the real first page.
const LETTER_ASPECT = 11 / 8.5

function clampWidth(value: number, max: number): number {
  return Math.round(Math.min(Math.max(value, MIN_PDF_WIDTH), max))
}

function clampHeight(value: number, max: number): number {
  return Math.round(Math.min(Math.max(value, MIN_PDF_HEIGHT), max))
}

type PdfAlign = 'left' | 'center' | 'right'

const PDF_ALIGN_VALUES: readonly PdfAlign[] = ['left', 'center', 'right']

const PDF_ALIGN_ICONS: Record<PdfAlign, typeof TextAlignCenter> = {
  left: LeftToRightBlockQuote,
  center: TextAlignCenter,
  right: RightToLeftBlockQuote
}

interface PdfPreviewProps {
  url: string
  name: string
  /** Stored display width in px; `0` uses the responsive default. */
  width: number
  /** Stored crop height in px; `0` fits the first page (no crop). */
  height: number
  /** Alignment of the embed within the note column. */
  align: PdfAlign
  /** Commit a new display width + crop height (px) to the block props. */
  onResize: (width: number, height: number) => void
  /** Commit a new alignment to the block props. */
  onAlign: (align: PdfAlign) => void
  /** The attachment "⋯" menu button, rendered in the hover control cluster. */
  menu?: React.ReactNode
}

function PdfPreview({ url, name, width, height, align, onResize, onAlign, menu }: PdfPreviewProps) {
  const { t: tPhaseF } = useT('notes')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // --- Paging ---------------------------------------------------------------
  // The embed reads as one continuous document: every page is stacked in a
  // scroller and only the pages near the viewport are mounted. The chrome is a
  // read-only page indicator, revealed on hover like the alignment controls.
  const [numPages, setNumPages] = useState(0)
  /** First page's height / width at scale 1, straight from pdf.js. */
  const [pageAspect, setPageAspect] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // --- Resize state ---------------------------------------------------------
  // The column bounds the max width so the page never overflows horizontally;
  // the first page's natural rendered height bounds the max crop. Both measured
  // live so a stored size larger than the current layout clamps down.
  const viewRef = useRef<HTMLDivElement>(null)
  const [maxWidth, setMaxWidth] = useState(0)
  // Non-null only while dragging, for smooth feedback before the commit.
  const [draftWidth, setDraftWidth] = useState<number | null>(null)
  const [draftHeight, setDraftHeight] = useState<number | null>(null)
  const dragRef = useRef<{
    startX: number
    startY: number
    startWidth: number
    startHeight: number
    rtl: boolean
    corner: 'start' | 'end'
  } | null>(null)

  useLayoutEffect(() => {
    const el = viewRef.current
    if (!el) return
    const measure = () => setMaxWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Width scales the whole embed (card + page) like an image. Height is an
  // independent crop on the viewport into the document: shrinking it shows less
  // of the scroll at a time, it does not change how much of the file is there.
  const columnWidth = maxWidth > 0 ? maxWidth : DEFAULT_PDF_CARD_WIDTH
  const storedWidth = width > 0 ? width : columnWidth
  const widthLimit = columnWidth
  const cardWidth = Math.min(draftWidth ?? storedWidth, widthLimit)
  const pageWidth = Math.max(140, cardWidth - PDF_CARD_BORDER)

  // One page tall is both the default viewport and the crop ceiling, so an
  // untouched embed looks exactly like the single-page preview it replaces.
  // Rounded up so a single-page embed never overflows its own viewport by a
  // fraction of a pixel and grows a scrollbar it has nothing to scroll to.
  const pageNaturalHeight = Math.ceil(pageWidth * (pageAspect ?? LETTER_ASPECT))
  const heightLimit = numPages > 0 ? pageNaturalHeight : Infinity
  const draftCrop = draftHeight != null ? Math.min(draftHeight, heightLimit) : null
  const storedCrop = height > 0 ? Math.min(height, heightLimit) : 0
  // Effective crop height; `undefined` lets the card wrap the full first page.
  const cardHeight = draftCrop ?? (storedCrop > 0 ? storedCrop : undefined)
  // While the document is still loading the frame has no page to size itself
  // against, so it stays auto and wraps the loading indicator.
  const frameHeight = cardHeight ?? (numPages > 0 ? pageNaturalHeight : undefined)

  // --- Continuous scroll ----------------------------------------------------
  // A row is one page plus the gap that follows it. The last page has no gap,
  // so a single-page embed is exactly as tall as its page. Pages of a
  // mixed-size document are re-measured once painted; the estimate only has to
  // be right for the common case where every page is the same size.
  const isLastPage = (index: number): boolean => index === numPages - 1
  const estimateRowHeight = (index: number): number =>
    isLastPage(index) ? pageNaturalHeight : pageNaturalHeight + PDF_PAGE_GAP

  const measurePage = (el: Element): number => {
    const measured = el.getBoundingClientRect().height
    // A page pdf.js has not painted yet (and every element under jsdom)
    // measures 0, which would collapse the whole list onto one offset.
    if (measured > 0) return measured
    return estimateRowHeight(Number((el as HTMLElement).dataset.index ?? 0))
  }

  // TanStack Virtual's `useVirtualizer()` returns unstable function refs, a
  // known library limitation the React Compiler can't memoize around.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: numPages,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateRowHeight,
    measureElement: measurePage,
    overscan: 1
  })

  // Resizing the embed changes every row's height; the virtualizer keeps its
  // cached measurements until it is told to drop them. False positive below:
  // `virtualizer`'s config closes over local refs/props (scrollRef, the width
  // and height that feed pageNaturalHeight), and this plugin's taint tracking
  // reads calling a method on the returned object as forwarding those to a
  // parent. Nothing here is passed to or received from any parent.
  useEffect(() => {
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-live-state-to-parent, react-you-might-not-need-an-effect/no-pass-ref-to-parent
    virtualizer.measure()
  }, [pageNaturalHeight, numPages, virtualizer])

  const virtualPages = virtualizer.getVirtualItems()

  // The indicator follows the scroll, not the other way round. It cannot be
  // derived during render: the virtualizer only re-renders when the mounted
  // window changes, and a short document never leaves its first window.
  const [currentPage, setCurrentPage] = useState(1)
  const trackCurrentPage = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // The page being read is the first one still showing below the top edge.
    const row = virtualizer.getVirtualItemForOffset(el.scrollTop + PDF_PAGE_GAP)
    if (row) setCurrentPage(row.index + 1)
  }, [virtualizer])

  // Snap width to the column edge and height to the full page before committing.
  // Height "full" is the page's natural height, which changes with width, so it
  // is stored as 0 ("fit page") rather than a px that would stop meaning "full".
  const commitResize = useCallback(
    (nextWidth: number, nextHeight: number) => {
      const w = nextWidth >= widthLimit - PDF_SNAP_THRESHOLD ? widthLimit : nextWidth
      const h =
        heightLimit !== Infinity && nextHeight >= heightLimit - PDF_SNAP_THRESHOLD ? 0 : nextHeight
      onResize(w, h)
    },
    [widthLimit, heightLimit, onResize]
  )

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, corner: 'start' | 'end') => {
      e.preventDefault()
      e.stopPropagation()
      const rtl = getComputedStyle(e.currentTarget).direction === 'rtl'
      const startHeight = cardHeight ?? (pageNaturalHeight || MIN_PDF_HEIGHT)
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startWidth: cardWidth,
        startHeight,
        rtl,
        corner
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      setDraftWidth(cardWidth)
      setDraftHeight(startHeight)
    },
    [cardWidth, cardHeight, pageNaturalHeight]
  )

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const signX = (drag.corner === 'end' ? 1 : -1) * (drag.rtl ? -1 : 1)
      const dx = (e.clientX - drag.startX) * signX
      const dy = e.clientY - drag.startY
      setDraftWidth(clampWidth(drag.startWidth + dx, widthLimit))
      setDraftHeight(clampHeight(drag.startHeight + dy, heightLimit))
    },
    [widthLimit, heightLimit]
  )

  const handleResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      e.currentTarget.releasePointerCapture(e.pointerId)
      const signX = (drag.corner === 'end' ? 1 : -1) * (drag.rtl ? -1 : 1)
      const dx = (e.clientX - drag.startX) * signX
      const dy = e.clientY - drag.startY
      const nextWidth = clampWidth(drag.startWidth + dx, widthLimit)
      const nextHeight = clampHeight(drag.startHeight + dy, heightLimit)
      dragRef.current = null
      setDraftWidth(null)
      setDraftHeight(null)
      commitResize(nextWidth, nextHeight)
    },
    [widthLimit, heightLimit, commitResize]
  )

  // Keyboard commits precise values (no edge snap — snapping is a drag-release
  // feel only). Left/Right change width; Up/Down change the crop height, and
  // growing height past the full page stores 0 so it stays "fit page".
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 50 : 20
      const cropBase = cardHeight ?? pageNaturalHeight
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        onResize(clampWidth(cardWidth + step, widthLimit), height)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        onResize(clampWidth(cardWidth - step, widthLimit), height)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const raw = cropBase + step
        onResize(width, raw >= heightLimit ? 0 : clampHeight(raw, heightLimit))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        onResize(width, clampHeight(cropBase - step, heightLimit))
      }
    },
    [cardWidth, cardHeight, width, height, widthLimit, heightLimit, pageNaturalHeight, onResize]
  )

  // Measure the first page rather than assuming Letter: an A4 or landscape
  // document would otherwise scroll in rows of the wrong height.
  const handleLoadSuccess = (pdf: PdfDocumentProxy) => {
    setNumPages(pdf.numPages)
    setLoading(false)
    if (typeof pdf.getPage !== 'function') return
    void pdf
      .getPage(1)
      .then((page) => {
        const viewport = page.getViewport({ scale: 1 })
        if (viewport.width > 0) setPageAspect(viewport.height / viewport.width)
      })
      .catch(() => {
        // An unmeasurable first page just keeps the assumed aspect.
      })
  }

  const handleLoadError = (err: Error) => {
    setError(
      extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'notes')('phaseF.pagesFile.failedToLoadFile')
      )
    )
    setLoading(false)
  }

  const alignLabels: Record<PdfAlign, string> = {
    left: tPhaseF('phaseF.componentsNoteContentAreaFileBlock.alignLeft'),
    center: tPhaseF('phaseF.componentsNoteContentAreaFileBlock.alignCenter'),
    right: tPhaseF('phaseF.componentsNoteContentAreaFileBlock.alignRight')
  }
  if (error) {
    return (
      <div className="pdf-preview-error rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
        <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
          <FileText className="h-5 w-5" />
          <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          {menu}
        </div>
        <p className="mt-2 text-sm text-red-500">
          {tPhaseF('phaseF.componentsNoteContentAreaFileBlock.failedToLoadPdf')}
          {error}
        </p>
      </div>
    )
  }

  return (
    <div ref={viewRef} className="pdf-preview-wrap">
      <div
        className={cn(
          'pdf-preview group relative',
          align === 'center' ? 'ms-auto me-auto' : align === 'right' ? 'ms-auto' : 'me-auto'
        )}
        style={{ width: cardWidth }}
      >
        {/* Scrolling frame: rounded border + a viewport one page tall by
            default. Every page of the document is reachable by scrolling; only
            the pages near the viewport are mounted. */}
        <div
          ref={scrollRef}
          data-testid="pdf-embed-scroll"
          onScroll={trackCurrentPage}
          className="relative overflow-y-auto overflow-x-hidden rounded-md border border-border bg-muted/30"
          style={{ height: frameHeight }}
        >
          <div className="bg-white dark:bg-zinc-900">
            <Document
              file={url}
              onLoadSuccess={handleLoadSuccess}
              onLoadError={handleLoadError}
              loading={PDF_LOADING_INDICATOR}
            >
              <div
                data-testid="pdf-embed-sizer"
                className="relative w-full"
                style={{ height: numPages > 0 ? virtualizer.getTotalSize() : undefined }}
              >
                {virtualPages.map((row) => (
                  <div
                    key={row.key}
                    data-index={row.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      insetInlineStart: 0,
                      width: '100%',
                      paddingBottom: isLastPage(row.index) ? 0 : PDF_PAGE_GAP,
                      transform: `translateY(${row.start}px)`
                    }}
                  >
                    <Page
                      pageNumber={row.index + 1}
                      width={pageWidth}
                      renderTextLayer={true}
                      renderAnnotationLayer={true}
                    />
                  </div>
                ))}
              </div>
            </Document>
          </div>
        </div>

        {/* Page indicator — hover reveal, bottom-centered, read-only now that
            scrolling is what moves through the document. A sibling of the
            scroller rather than a child, so it stays put while pages scroll
            past. `inset-x-0` + a centering flex row keeps it RTL-safe. */}
        {!loading && !error && numPages > 1 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center opacity-0 transition-opacity group-hover:opacity-100">
            <div className="rounded-md border border-border bg-background/90 px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground shadow-sm">
              {currentPage} / {numPages}
            </div>
          </div>
        )}

        {/* Alignment controls — hover reveal, top-inline-end */}
        {!loading && !error && (
          <div className="absolute top-2 end-2 z-10 flex items-center gap-px rounded-md border border-border bg-background/90 p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {PDF_ALIGN_VALUES.map((value) => {
              const Icon = PDF_ALIGN_ICONS[value]
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
            {menu && (
              <>
                <div className="mx-0.5 h-4 w-px bg-border" />
                {menu}
              </>
            )}
          </div>
        )}

        {/* Corner resize brackets — sit just outside the bottom corners. Faint
            at rest rather than hidden: a control that only exists on hover is a
            control most readers never find out about. */}
        {!loading && !error && (
          <>
            <div
              role="slider"
              tabIndex={0}
              data-pdf-resize-handle
              aria-label={tPhaseF('phaseF.componentsNoteContentAreaFileBlock.resizePdf')}
              aria-orientation="horizontal"
              aria-valuemin={MIN_PDF_WIDTH}
              aria-valuemax={maxWidth || undefined}
              aria-valuenow={Math.round(cardWidth)}
              onPointerDown={(e) => handleResizePointerDown(e, 'end')}
              onPointerMove={handleResizePointerMove}
              onPointerUp={handleResizePointerUp}
              onKeyDown={handleResizeKeyDown}
              className="absolute -bottom-1 -end-1 z-10 h-3.5 w-3.5 cursor-nwse-resize touch-none border-b-2 border-e-2 border-foreground/60 opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            />
            <div
              role="button"
              tabIndex={0}
              data-pdf-resize-handle
              aria-label={tPhaseF('phaseF.componentsNoteContentAreaFileBlock.resizePdf')}
              onPointerDown={(e) => handleResizePointerDown(e, 'start')}
              onPointerMove={handleResizePointerMove}
              onPointerUp={handleResizePointerUp}
              onKeyDown={handleResizeKeyDown}
              className="absolute -bottom-1 -start-1 z-10 h-3.5 w-3.5 cursor-nesw-resize touch-none border-b-2 border-s-2 border-foreground/60 opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            />
          </>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Sync Progress Overlay
// ============================================================================

interface SyncProgressOverlayProps {
  progress: number
  status: string
  direction: 'upload' | 'download'
}

function SyncProgressOverlay({
  progress,
  status,
  direction
}: SyncProgressOverlayProps): React.ReactNode {
  const Icon = direction === 'upload' ? Upload : Download
  const label =
    status === 'completed'
      ? `${direction === 'upload' ? 'Uploaded' : 'Downloaded'}`
      : status === 'failed'
        ? 'Failed'
        : `${direction === 'upload' ? 'Uploading' : 'Downloading'}...`

  return (
    <div className="absolute inset-x-0 bottom-0 bg-background/80 backdrop-blur-sm px-3 py-1.5 border-t border-border">
      <div className="flex items-center gap-2 text-xs">
        <Icon className="h-3 w-3 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                status === 'completed' && 'bg-green-500',
                status === 'failed' && 'bg-red-500',
                status !== 'completed' && status !== 'failed' && 'bg-primary'
              )}
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
        </div>
        <span className="tabular-nums text-muted-foreground whitespace-nowrap">
          {label} {status !== 'completed' && status !== 'failed' ? `${progress}%` : ''}
        </span>
      </div>
    </div>
  )
}

// ============================================================================
// Generic File Preview Component
// ============================================================================

interface FilePreviewProps {
  url: string
  name: string
  size: number
  mimeType: string
  /** The attachment "⋯" menu button. */
  menu?: React.ReactNode
}

function FilePreview({ url, name, size, mimeType, menu }: FilePreviewProps) {
  const { t: tPhaseF } = useT('notes')
  const { state } = useSync()

  const uploadEntry = state.uploadProgress
    ? Object.entries(state.uploadProgress).find(([key]) => name && key.includes(name))?.[1]
    : null

  const downloadEntry = state.downloadProgress
    ? Object.entries(state.downloadProgress).find(([key]) => name && key.includes(name))?.[1]
    : null

  const activeTransfer = uploadEntry ?? downloadEntry
  const transferDirection: 'upload' | 'download' = uploadEntry ? 'upload' : 'download'

  return (
    <div className="file-attachment relative flex items-center gap-3 rounded-md border border-border bg-muted/30 p-3">
      {getFileIcon(mimeType)}
      <div className="flex-1 min-w-0">
        <p className="truncate font-medium text-sm">{name}</p>
        <p className="text-xs text-muted-foreground">{formatFileSize(size)}</p>
      </div>
      <Button variant="ghost" size="sm" asChild className="h-8">
        <a href={url} download={name}>
          <Download className="me-1 h-4 w-4" />

          {tPhaseF('phaseF.componentsNoteContentAreaFileBlock.download2')}
        </a>
      </Button>
      {menu}
      {activeTransfer && activeTransfer.status !== 'completed' && (
        <SyncProgressOverlay
          progress={activeTransfer.progress}
          status={activeTransfer.status}
          direction={transferDirection}
        />
      )}
    </div>
  )
}

function AudioPreview({ url, name, menu }: FilePreviewProps) {
  const { state } = useSync()

  const uploadEntry = state.uploadProgress
    ? Object.entries(state.uploadProgress).find(([key]) => name && key.includes(name))?.[1]
    : null

  const downloadEntry = state.downloadProgress
    ? Object.entries(state.downloadProgress).find(([key]) => name && key.includes(name))?.[1]
    : null

  const activeTransfer = uploadEntry ?? downloadEntry
  const transferDirection: 'upload' | 'download' = uploadEntry ? 'upload' : 'download'

  return (
    <div className="file-audio relative rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <FileAudio className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
          </div>
        </div>
        <audio
          controls
          preload="metadata"
          src={url}
          aria-label={name}
          className="h-9 w-full min-w-0 sm:max-w-xs"
        >
          <track kind="captions" />
        </audio>
        {menu}
      </div>
      {activeTransfer && activeTransfer.status !== 'completed' && (
        <SyncProgressOverlay
          progress={activeTransfer.progress}
          status={activeTransfer.status}
          direction={transferDirection}
        />
      )}
    </div>
  )
}

// ============================================================================
// Missing Attachment Card (#1713)
// ============================================================================

interface AttachmentPresence {
  missing: boolean
  /** The on-disk filename the ref expects, for the card's repair hint. */
  expectedFilename: string | null
}

const ATTACHMENT_PRESENT: AttachmentPresence = { missing: false, expectedFilename: null }

/**
 * Whether the block's attachment is actually on disk (after main's self-heal
 * pass had its chance). Re-checked when an attachment for this note lands, so
 * a file that syncs in later clears the card without a remount.
 */
function useAttachmentPresence(url: string): AttachmentPresence {
  const noteId = useAttachmentNoteId()
  const revision = useSyncExternalStore(subscribeToAttachmentRevisions, () =>
    getAttachmentRevision(noteId)
  )
  const [presence, setPresence] = useState<AttachmentPresence>(ATTACHMENT_PRESENT)

  // A changed note or ref means any pending resolve is now for a different
  // file: reset to neutral in the same render rather than in the effect below
  // — the "adjusting state during render" pattern at
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [prevKey, setPrevKey] = useState({ noteId, url })
  if (prevKey.noteId !== noteId || prevKey.url !== url) {
    setPrevKey({ noteId, url })
    setPresence(ATTACHMENT_PRESENT)
  }

  useEffect(() => {
    // Only vault refs (note-relative or legacy memry-file) are checkable;
    // http/data urls are not attachments. Surfaces without a note id (and
    // tests without the IPC surface) just never show the card.
    const isVaultRef = Boolean(url) && (!HAS_SCHEME.test(url) || url.startsWith('memry-file:'))
    if (!noteId || !isVaultRef || !window.api?.notes?.resolveAttachment) {
      return
    }
    let cancelled = false
    window.api.notes
      .resolveAttachment(noteId, url)
      .then((info) => {
        if (cancelled) return
        setPresence(
          info.exists
            ? ATTACHMENT_PRESENT
            : { missing: true, expectedFilename: info.storedFilename }
        )
      })
      .catch(() => {
        // An unresolvable url (invalid path shape) is not "missing on disk" —
        // leave the block to its normal rendering.
        if (!cancelled) setPresence(ATTACHMENT_PRESENT)
      })
    return () => {
      cancelled = true
    }
  }, [noteId, url, revision])

  return presence
}

function MissingAttachmentCard({
  name,
  expectedFilename,
  menu
}: {
  name: string
  expectedFilename: string | null
  menu?: React.ReactNode
}) {
  const { t: tPhaseF } = useT('notes')
  return (
    <div
      data-testid="attachment-missing-card"
      className="file-attachment-missing relative flex items-center gap-3 rounded-md border border-dashed border-border bg-muted/30 p-3"
    >
      <File className="h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {tPhaseF('editor.attachmentMenu.missingTitle')}
          {expectedFilename
            ? ` — ${tPhaseF('editor.attachmentMenu.missingExpected', { name: expectedFilename })}`
            : ''}
        </p>
      </div>
      {menu}
    </div>
  )
}

// ============================================================================
// FileBlock Spec
// ============================================================================

/**
 * Custom BlockNote block for file attachments.
 * Shows inline PDF preview for PDFs, download card for other files.
 * Returns a factory function - call it when adding to schema: `file: createFileBlock()`
 */
interface FileBlockEditor {
  updateBlock: (block: unknown, update: { props: Record<string, unknown> }) => void
}

function FileBlockRender({
  block,
  editor,
  contentRef
}: {
  block: {
    props: {
      url: string
      name: string
      size: number
      mimeType: string
      width?: number
      height?: number
      align?: 'left' | 'center' | 'right'
    }
  }
  editor: unknown
  contentRef: React.Ref<HTMLDivElement>
}) {
  const { t: tPhaseF } = useT('notes')
  const { url, name, size, mimeType, width, height, align } = block.props
  const isPdf = mimeType === 'application/pdf'
  const isAudio = mimeType.startsWith('audio/')

  // Attachments are stored as a ref relative to the note (`../attachments/…`),
  // which the browser would resolve against the renderer's own base URL. The
  // result is for rendering only — writing it back to `block.props` would put
  // this machine's vault path into the note's markdown.
  const resolvedUrl = useResolvedFileUrl(url)
  const presence = useAttachmentPresence(url)

  // Persist the user-chosen PDF width + crop height to the block props
  // (round-trips to the vault marker via serializeFileBlock). Declared before
  // the early return to keep hook order stable.
  const handleResize = useCallback(
    (nextWidth: number, nextHeight: number) => {
      const fileEditor = editor as FileBlockEditor | undefined
      fileEditor?.updateBlock(block, {
        props: { ...block.props, width: nextWidth, height: nextHeight }
      })
    },
    [editor, block]
  )

  const handleAlign = useCallback(
    (nextAlign: 'left' | 'center' | 'right') => {
      const fileEditor = editor as FileBlockEditor | undefined
      fileEditor?.updateBlock(block, { props: { ...block.props, align: nextAlign } })
    },
    [editor, block]
  )

  // The file on disk is already renamed when this runs (#1714); writing the new
  // ref into the block is what records the rename in the note — and what carries
  // it to the other devices, which rename their own copy from the body change.
  const handleRenamed = useCallback(
    (next: { url: string; name: string }) => {
      const fileEditor = editor as FileBlockEditor | undefined
      fileEditor?.updateBlock(block, { props: { ...block.props, url: next.url, name: next.name } })
    },
    [editor, block]
  )

  // Don't render if no URL
  if (!url) {
    return (
      <div ref={contentRef} className="file-block-empty p-2 text-muted-foreground text-sm">
        {tPhaseF('phaseF.componentsNoteContentAreaFileBlock.noFileAttached')}
      </div>
    )
  }

  // Still resolving a note-relative ref: render the frame without a target
  // rather than letting the viewer fetch the unresolved path and latch its
  // load error.
  if (resolvedUrl === null) {
    return <div ref={contentRef} className="file-block my-2" contentEditable={false} />
  }

  // The raw stored url goes to the menu, never `resolvedUrl` — main re-resolves
  // and validates it against the vault itself.
  const menuButton = <AttachmentMenuButton url={url} name={name} onRenamed={handleRenamed} />

  // The file is gone from disk and self-heal found no unique match: name the
  // expected file so the user can repair the rename by hand (#1713).
  if (presence.missing) {
    return (
      <AttachmentBlockContextMenu url={url} name={name} onRenamed={handleRenamed}>
        <div ref={contentRef} className="file-block my-2" contentEditable={false}>
          <MissingAttachmentCard
            name={name}
            expectedFilename={presence.expectedFilename}
            menu={menuButton}
          />
        </div>
      </AttachmentBlockContextMenu>
    )
  }

  return (
    <AttachmentBlockContextMenu url={url} name={name} onRenamed={handleRenamed}>
      <div ref={contentRef} className="file-block my-2" contentEditable={false}>
        {isPdf ? (
          <PdfPreview
            // Keyed by URL so a changed one rebuilds the preview from scratch. A
            // load error is otherwise terminal — the red card survives for as long
            // as the block is mounted, and the editor does not unmount when the
            // note is closed, so an attachment that synced in a moment later
            // stayed invisible until the app was restarted. The URL is what
            // changes when this note's attachments land (see `attachment-revision`).
            key={resolvedUrl}
            url={resolvedUrl}
            name={name}
            width={width ?? 0}
            height={height ?? 0}
            align={align ?? 'left'}
            onResize={handleResize}
            onAlign={handleAlign}
            menu={menuButton}
          />
        ) : isAudio ? (
          <AudioPreview
            url={resolvedUrl}
            name={name}
            size={size}
            mimeType={mimeType}
            menu={menuButton}
          />
        ) : (
          <FilePreview
            url={resolvedUrl}
            name={name}
            size={size}
            mimeType={mimeType}
            menu={menuButton}
          />
        )}
      </div>
    </AttachmentBlockContextMenu>
  )
}

/**
 * What the file panel's picker offers, and what the paste/drop handler treats
 * as file-block material.
 *
 * Mirrors `ALLOWED_IMAGE_EXTENSIONS` + `ALLOWED_FILE_EXTENSIONS` in
 * `apps/desktop/src/main/vault/attachments.ts`, which is the source of truth —
 * the renderer cannot import from main, so the list is restated here. Without
 * it BlockNote's picker accepts every file type and lets the user choose
 * something the main process then rejects.
 *
 * Extensions, not mime globs, on purpose: `image/*` here would compete with the
 * built-in `image` block for pasted images.
 */
export const FILE_BLOCK_ACCEPT = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.txt',
  '.md'
]

// Type/props/content come from the shared config so this block and the main
// process's headless twin cannot disagree. `file` is the one that shadows a
// BlockNote DEFAULT block: before the config was shared, main built the default
// spec and silently dropped size/mimeType/width/height/align on the way to disk.
export const createFileBlock = createReactBlockSpec(fileBlockConfig, {
  meta: { fileBlockAccept: FILE_BLOCK_ACCEPT },
  render: FileBlockRender
})

// ============================================================================
// File Block Serialization Helpers
// ============================================================================

/**
 * Create a FileBlock content object for insertion
 */
export function createFileBlockContent(props: FileBlockProps) {
  return {
    type: 'file' as const,
    props
  }
}
