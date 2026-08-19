import { getI18n } from 'react-i18next'
/**
 * PDF Viewer Component
 * Full-page PDF viewer with navigation, zoom, and thumbnail sidebar.
 *
 * @module components/viewers/pdf-viewer
 */

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { extractErrorMessage } from '@/lib/ipc-error'
import { Document, Page, pdfjs } from 'react-pdf'
import type { PDFDocumentProxy as PdfDocumentProxy } from 'pdfjs-dist'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Loader2,
  PanelLeft,
  PanelLeftClose,
  Maximize2
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { mayAutoPositionFor } from '@/hooks/use-tab-auto-position'
import { useTabEntityViewState } from '@/hooks/use-tab-entity-view-state'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'
import {
  FILE_VIEW_STATE_KEYS,
  parseNullableScale,
  parsePdfPage,
  parseRotation,
  parseViewerBoolean,
  pdfPageScrollKey
} from '@/pages/file-view-state'

// Configure PDF.js worker - import from node_modules for Electron compatibility
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useT } from '@memry/i18n/renderer'
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

// ============================================================================
// Types
// ============================================================================

interface PdfViewerProps {
  /** File path or URL to the PDF */
  src: string
  /** CSS classes */
  className?: string
}

const PDF_LOADING = (
  <div className="flex h-[600px] items-center justify-center">
    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
  </div>
)

/** Zoom bounds shared by the buttons and by fit-to-width. */
const MIN_SCALE = 0.5
const MAX_SCALE = 3
const ZOOM_STEP = 0.25
/** The `p-4` gutter around the page — width fit-to-width must not render under. */
const PAGE_VIEW_PADDING = 32

const clampScale = (value: number): number => Math.min(Math.max(value, MIN_SCALE), MAX_SCALE)

// ============================================================================
// Thumbnail Rail
// ============================================================================

/** Rendered width of a thumbnail canvas, in CSS pixels. */
const THUMBNAIL_WIDTH = 120
/** Fixed preview box height: a Letter/A4 portrait page at {@link THUMBNAIL_WIDTH}. */
const THUMBNAIL_MEDIA_HEIGHT = 156
/** Height of one rail row: preview box + page label + gap. */
const THUMBNAIL_ROW_HEIGHT = THUMBNAIL_MEDIA_HEIGHT + 26

interface PdfThumbnailRailProps {
  numPages: number
  currentPage: number
  onSelectPage: (page: number) => void
}

/**
 * Windowed thumbnail rail. Only the rows inside the rail viewport are mounted,
 * so a 500-page document keeps a handful of canvases alive instead of 500.
 * Rows have a fixed height so the window stays stable while pdf.js renders.
 *
 * Uses a native scroller rather than `ScrollArea` because the virtualizer needs
 * a ref to the element that actually scrolls.
 */
function PdfThumbnailRail({
  numPages,
  currentPage,
  onSelectPage
}: PdfThumbnailRailProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: numPages,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => THUMBNAIL_ROW_HEIGHT,
    overscan: 2
  })

  // The active page's thumbnail is not necessarily inside the window when the
  // page changes from the toolbar, so pull it back into view.
  useEffect(() => {
    if (numPages > 0) {
      virtualizer.scrollToIndex(currentPage - 1, { align: 'auto' })
    }
  }, [currentPage, numPages, virtualizer])

  return (
    <div
      ref={scrollRef}
      data-testid="pdf-thumbnail-rail"
      className="hidden w-[140px] flex-shrink-0 overflow-y-auto border-e border-border bg-muted/30 px-2 sm:block"
    >
      <div
        data-testid="pdf-thumbnail-sizer"
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((row) => {
          const page = row.index + 1
          const isActive = page === currentPage

          return (
            <button
              key={row.key}
              type="button"
              data-testid="pdf-thumbnail"
              data-page={page}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSelectPage(page)}
              style={{
                position: 'absolute',
                top: 0,
                insetInlineStart: 0,
                width: '100%',
                height: `${row.size}px`,
                transform: `translateY(${row.start}px)`
              }}
              className={cn(
                'overflow-hidden rounded border-2 transition-all hover:border-primary/50',
                isActive ? 'border-primary ring-2 ring-primary/20' : 'border-transparent'
              )}
            >
              <div
                className="flex items-center justify-center overflow-hidden"
                style={{ height: `${THUMBNAIL_MEDIA_HEIGHT}px` }}
              >
                <Page
                  pageNumber={page}
                  width={THUMBNAIL_WIDTH}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                />
              </div>
              <div className="bg-background/80 py-1 text-center text-[10px] text-muted-foreground">
                {page}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================================
// PDF Viewer Component
// ============================================================================

export function PdfViewer({ src, className }: PdfViewerProps) {
  const { t: tPhaseF } = useT('notes')
  const pageScrollRef = useRef<HTMLDivElement>(null)
  const [numPages, setNumPages] = useState<number>(0)
  // The main pane shows one page at a time, so the page number IS the reading
  // position — the scroll offset only refines it within that page.
  const [currentPage, setCurrentPage] = useTabEntityViewState<number>({
    key: FILE_VIEW_STATE_KEYS.pdfPage,
    defaultValue: 1,
    parse: parsePdfPage
  })
  // `null` is "the user has never zoomed this document", which is what lets
  // fit-to-width run. See `hooks/use-tab-auto-position.ts`.
  const [storedScale, setStoredScale] = useTabEntityViewState<number | null>({
    key: FILE_VIEW_STATE_KEYS.pdfScale,
    defaultValue: null,
    parse: parseNullableScale
  })
  const [scale, setScale] = useState(storedScale ?? 1)
  const storedScaleRef = useRef(storedScale)
  const scaleRef = useRef(scale)
  useLayoutEffect(() => {
    storedScaleRef.current = storedScale
    scaleRef.current = scale
  })
  /** Size of the current page at scale 1, straight from pdf.js. */
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null)
  const pdfRef = useRef<PdfDocumentProxy | null>(null)
  const [rotation, setRotation] = useTabEntityViewState<number>({
    key: FILE_VIEW_STATE_KEYS.pdfRotation,
    defaultValue: 0,
    parse: parseRotation
  })
  const [sidebarOpen, setSidebarOpen] = useTabEntityViewState<boolean>({
    key: FILE_VIEW_STATE_KEYS.pdfSidebarOpen,
    defaultValue: true,
    parse: parseViewerBoolean
  })
  const [error, setError] = useState<string | null>(null)

  const getPageScrollEl = useCallback(() => pageScrollRef.current, [])
  useTabScrollRestore({
    getScrollElement: getPageScrollEl,
    key: pdfPageScrollKey(currentPage)
  })

  const handleLoadSuccess = useCallback((pdf: PdfDocumentProxy) => {
    setNumPages(pdf.numPages)
    pdfRef.current = pdf
  }, [])

  const handleLoadError = useCallback((err: Error) => {
    setError(
      extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'notes')('phaseF.componentsViewersPdfViewer.failedToLoadPdf')
      )
    )
  }, [])

  const goToPage = useCallback(
    (page: number) => {
      if (page >= 1 && page <= numPages) {
        setCurrentPage(page)
      }
    },
    [numPages, setCurrentPage]
  )

  // Measure the page pdf.js actually holds rather than assuming Letter: a page
  // that is A4, landscape or a mix of sizes fits to the wrong width otherwise.
  useEffect(() => {
    const pdf = pdfRef.current
    if (!pdf || typeof pdf.getPage !== 'function') return
    let cancelled = false
    void pdf
      .getPage(currentPage)
      .then((page) => {
        if (cancelled) return
        const viewport = page.getViewport({ scale: 1 })
        setPageSize({ width: viewport.width, height: viewport.height })
      })
      .catch(() => {
        // A page that cannot be measured just keeps the current zoom.
      })
    return () => {
      cancelled = true
    }
  }, [currentPage, numPages])

  /**
   * Every zoom write goes through here. Fitting to the pane is auto-positioning
   * rather than a choice, so it does NOT persist: storing it would freeze one
   * pane's width into the tab and stop the document fitting the next time it is
   * opened somewhere narrower.
   */
  const applyScale = useCallback(
    (raw: number, options?: { persist?: boolean }) => {
      const next = clampScale(raw)
      scaleRef.current = next
      setScale(next)
      if (options?.persist !== false) setStoredScale(next)
    },
    [setStoredScale]
  )

  /** The scale at which the current page fills the pane, or `null` if unmeasurable. */
  const computeFitScale = useCallback((): number | null => {
    const el = pageScrollRef.current
    if (!el || !pageSize) return null
    const available = el.clientWidth - PAGE_VIEW_PADDING
    if (available <= 0) return null
    // A quarter turn swaps the axis the page is measured across.
    const acrossPane = rotation % 180 === 0 ? pageSize.width : pageSize.height
    if (acrossPane <= 0) return null
    return clampScale(available / acrossPane)
  }, [pageSize, rotation])

  // Fit on open, and keep fitting while the tab has no zoom of its own — the
  // pane changes width when the window resizes or the thumbnail rail toggles.
  useEffect(() => {
    const el = pageScrollRef.current
    if (!el) return
    const fit = () => {
      if (!mayAutoPositionFor(storedScaleRef.current)) return
      const fitted = computeFitScale()
      if (fitted !== null) applyScale(fitted, { persist: false })
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [computeFitScale, applyScale])

  const zoomIn = useCallback(() => {
    applyScale(scaleRef.current + ZOOM_STEP)
  }, [applyScale])

  const zoomOut = useCallback(() => {
    applyScale(scaleRef.current - ZOOM_STEP)
  }, [applyScale])

  const rotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360)
  }, [setRotation])

  const fitToWidth = useCallback(() => {
    const fitted = computeFitScale()
    // Pressing the button IS a choice, so unlike the automatic fit it persists.
    if (fitted !== null) applyScale(fitted)
  }, [computeFitScale, applyScale])

  if (error) {
    return (
      <div
        className={cn('flex h-full items-center justify-center bg-muted/30 rounded-md', className)}
      >
        <div className="text-center p-8">
          <p className="text-destructive font-medium mb-2">
            {tPhaseF('phaseF.componentsViewersPdfViewer.failedToLoadPdf')}
          </p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex h-full flex-col bg-muted/20 min-h-0 overflow-hidden', className)}>
      {/* Toolbar - fixed at top */}
      <div className="flex items-center justify-between gap-1 sm:gap-2 px-2 sm:px-4 py-2 border-b border-border bg-background/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center gap-1 sm:gap-2">
          {/* Sidebar toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="h-8 w-8 p-0"
            title={sidebarOpen ? 'Hide thumbnails' : 'Show thumbnails'}
          >
            {sidebarOpen ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeft className="h-4 w-4" />
            )}
          </Button>

          <div className="w-px h-5 bg-border hidden sm:block" />

          {/* Page navigation */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            className="h-8 w-8 p-0"
            title={tPhaseF('phaseF.componentsViewersPdfViewer.previousPage')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground min-w-[60px] sm:min-w-[80px] text-center">
            {currentPage} / {numPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= numPages}
            className="h-8 w-8 p-0"
            title={tPhaseF('phaseF.componentsViewersPdfViewer.nextPage')}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
          {/* Zoom controls */}
          <Button
            variant="ghost"
            size="sm"
            onClick={zoomOut}
            className="h-8 w-8 p-0"
            title={tPhaseF('phaseF.componentsViewersPdfViewer.zoomOut')}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground min-w-[40px] sm:min-w-[50px] text-center">
            {Math.round(scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={zoomIn}
            className="h-8 w-8 p-0"
            title={tPhaseF('phaseF.componentsViewersPdfViewer.zoomIn')}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={fitToWidth}
            className="h-8 w-8 p-0"
            title={tPhaseF('phaseF.componentsViewersPdfViewer.fitToWidth')}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>

          <div className="w-px h-5 bg-border hidden sm:block" />

          {/* Rotate */}
          <Button
            variant="ghost"
            size="sm"
            onClick={rotate}
            className="h-8 w-8 p-0"
            title={tPhaseF('phaseF.componentsViewersPdfViewer.rotate')}
          >
            <RotateCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Main content - one Document shared by the rail and the page view, so
          the file is loaded into a single pdf.js document proxy */}
      <Document
        file={src}
        onLoadSuccess={handleLoadSuccess}
        onLoadError={handleLoadError}
        loading={PDF_LOADING}
        className="flex flex-1 min-h-0 flex-col overflow-hidden"
      >
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Thumbnail sidebar */}
          {sidebarOpen && (
            <PdfThumbnailRail
              numPages={numPages}
              currentPage={currentPage}
              onSelectPage={goToPage}
            />
          )}

          {/* PDF content - with both horizontal and vertical scrolling */}
          <div
            ref={pageScrollRef}
            data-testid="pdf-page-view"
            className="flex-1 overflow-auto min-h-0"
          >
            <div className="inline-flex justify-center min-w-full p-4">
              <Page
                pageNumber={currentPage}
                scale={scale}
                rotate={rotation}
                renderTextLayer={true}
                renderAnnotationLayer={true}
                className="shadow-lg"
              />
            </div>
          </div>
        </div>
      </Document>
    </div>
  )
}
