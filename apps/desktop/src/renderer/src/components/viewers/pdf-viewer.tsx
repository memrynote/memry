import { getI18n } from 'react-i18next'
/**
 * PDF Viewer Component
 *
 * Full-page PDF viewer with navigation, zoom, and a thumbnail rail.
 *
 * The toolbar is the viewer's ONLY chrome: the file page used to sit a second
 * header above it carrying the file's name and its actions, which cost a strip
 * of vertical space to say what the tab already said. Those now arrive through
 * the `title`/`chips`/`actions` slots, so the surfaces that have no file behind
 * them — a PDF attached to a review comment — simply pass nothing.
 *
 * @module components/viewers/pdf-viewer
 */

import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
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
  Maximize2,
  MoveVertical,
  Settings2,
  FileText,
  Columns2,
  BookOpen,
  Moon
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useEditorSettings } from '@/hooks/use-editor-settings'
import { useTabEntityViewState } from '@/hooks/use-tab-entity-view-state'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'
import {
  FILE_VIEW_STATE_KEYS,
  parseNullableScale,
  parseStoredPdfFitMode,
  parsePdfPage,
  parsePdfPageMode,
  parseRotation,
  parseViewerBoolean,
  pdfPageScrollKey,
  pdfSpreadPages,
  pdfSpreadStart,
  resolveLegacyFitMode,
  type StoredPdfFitMode,
  type PdfPageMode
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
  /** Name shown at the start of the toolbar. Omitted outside the file page. */
  title?: string
  /** Badges rendered next to the title — the file's project chips. */
  chips?: React.ReactNode
  /**
   * File-level actions for the end of the toolbar (the `...` menu). Kept a
   * slot rather than built in: the viewer has a `src`, not a file id, and the
   * review-comment preview has no file record to act on at all.
   */
  actions?: React.ReactNode
}

const PDF_LOADING = (
  <div className="flex h-[600px] items-center justify-center">
    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
  </div>
)

/** Zoom bounds shared by the buttons and by the fit modes. */
const MIN_SCALE = 0.5
const MAX_SCALE = 3
const ZOOM_STEP = 0.25
/** The `p-4` gutter around the page — a fit must not render under it. */
const PAGE_VIEW_PADDING = 32
/** Gutter between the two halves of a spread. */
const SPREAD_GAP = 16

const clampScale = (value: number): number => Math.min(Math.max(value, MIN_SCALE), MAX_SCALE)

/** How many pages wide the layout is, regardless of how many the spread holds.
 *
 * A document's last page can be alone in a two-page spread. Fitting it as one
 * column would render it at twice the width of every other page, so the fit is
 * derived from the MODE and the lone page just leaves its half empty. */
const columnsFor = (mode: PdfPageMode): number => (mode === 'single' ? 1 : 2)

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
  /** Every page the main pane is showing — two of them in a spread. */
  activePages: number[]
  onSelectPage: (page: number) => void
  /** Inverted in dark themes alongside the page, so the rail matches it. */
  adaptToTheme: boolean
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
  activePages,
  onSelectPage,
  adaptToTheme
}: PdfThumbnailRailProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const leadPage = activePages[0] ?? 1

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
      virtualizer.scrollToIndex(leadPage - 1, { align: 'auto' })
    }
  }, [leadPage, numPages, virtualizer])

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
          const isActive = activePages.includes(page)

          return (
            <button
              key={row.key}
              type="button"
              data-testid="pdf-thumbnail"
              data-page={page}
              // Only the page the spread STARTS on is the reading position;
              // marking both would announce two current pages.
              aria-current={page === leadPage ? 'page' : undefined}
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
                className={cn(
                  'flex items-center justify-center overflow-hidden',
                  adaptToTheme && 'dark:[filter:invert(1)_hue-rotate(180deg)]'
                )}
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
// Page Number Field
// ============================================================================

interface PdfPageFieldProps {
  currentPage: number
  numPages: number
  onGoToPage: (page: number) => void
  label: string
}

/**
 * The `1 / 400` readout, with the left half editable.
 *
 * A rejected entry REVERTS rather than clamping: typing 9999 into a 400-page
 * document is a typo, and silently landing on the last page reads as the
 * viewer having obeyed something the user did not mean.
 */
function PdfPageField({
  currentPage,
  numPages,
  onGoToPage,
  label
}: PdfPageFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = useCallback(() => {
    const raw = draft
    setDraft(null)
    if (raw === null) return
    const parsed = Number.parseInt(raw.trim(), 10)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > numPages) return
    onGoToPage(parsed)
  }, [draft, numPages, onGoToPage])

  return (
    <span className="flex items-center gap-1 text-sm text-muted-foreground">
      <input
        type="text"
        inputMode="numeric"
        data-testid="pdf-page-input"
        aria-label={label}
        title={label}
        // Sized to the document rather than to a guess, so a 4-digit page
        // number does not scroll inside a 2-digit box.
        style={{ width: `${Math.max(2, String(numPages).length) + 1.5}ch` }}
        className="h-7 rounded border border-transparent bg-transparent px-1 text-center tabular-nums text-foreground hover:border-border focus:border-border focus:outline-none focus:ring-1 focus:ring-ring"
        value={draft ?? String(currentPage)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
      <span className="tabular-nums">/ {numPages}</span>
    </span>
  )
}

// ============================================================================
// PDF Viewer Component
// ============================================================================

export function PdfViewer({ src, className, title, chips, actions }: PdfViewerProps) {
  const { t: tPhaseF } = useT('notes')
  const pageScrollRef = useRef<HTMLDivElement>(null)
  const [numPages, setNumPages] = useState<number>(0)
  // The main pane shows one spread at a time, so the page number IS the
  // reading position — the scroll offset only refines it within that spread.
  const [currentPage, setCurrentPage] = useTabEntityViewState<number>({
    key: FILE_VIEW_STATE_KEYS.pdfPage,
    defaultValue: 1,
    parse: parsePdfPage
  })
  const [storedScale, setStoredScale] = useTabEntityViewState<number | null>({
    key: FILE_VIEW_STATE_KEYS.pdfScale,
    defaultValue: null,
    parse: parseNullableScale
  })
  // `'unset'` is a tab written before fit modes existed; those encoded "keep
  // fitting" as a null scale. See `resolveLegacyFitMode`.
  const [storedFitMode, setStoredFitMode] = useTabEntityViewState<StoredPdfFitMode>({
    key: FILE_VIEW_STATE_KEYS.pdfFitMode,
    defaultValue: 'unset',
    parse: parseStoredPdfFitMode
  })
  const fitMode = resolveLegacyFitMode(storedFitMode, storedScale)
  const [pageMode, setPageMode] = useTabEntityViewState<PdfPageMode>({
    key: FILE_VIEW_STATE_KEYS.pdfPageMode,
    defaultValue: 'single',
    parse: parsePdfPageMode
  })
  const [scale, setScale] = useState(storedScale ?? 1)
  const fitModeRef = useRef(fitMode)
  const scaleRef = useRef(scale)
  useLayoutEffect(() => {
    fitModeRef.current = fitMode
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
  const { settings: editorSettings, updateSettings: updateEditorSettings } = useEditorSettings()
  const adaptToTheme = editorSettings.pdfAdaptToTheme

  // The stored page is only guaranteed to be a spread start for the mode it
  // was stored under, so normalise before anything reads it.
  const spreadStart = pdfSpreadStart(currentPage, pageMode)
  const visiblePages = useMemo(
    () => (numPages > 0 ? pdfSpreadPages(spreadStart, pageMode, numPages) : [spreadStart]),
    [spreadStart, pageMode, numPages]
  )

  const getPageScrollEl = useCallback(() => pageScrollRef.current, [])
  useTabScrollRestore({
    getScrollElement: getPageScrollEl,
    key: pdfPageScrollKey(spreadStart)
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

  /** Jump to the spread that holds `page`, never to a half of one. */
  const goToPage = useCallback(
    (page: number) => {
      if (page >= 1 && page <= numPages) {
        setCurrentPage(pdfSpreadStart(page, pageMode))
      }
    },
    [numPages, pageMode, setCurrentPage]
  )

  const stepSpread = useCallback(
    (direction: 1 | -1) => {
      const width = pdfSpreadPages(spreadStart, pageMode, numPages).length
      const target =
        direction === 1 ? spreadStart + width : pdfSpreadStart(spreadStart - 1, pageMode)
      if (target >= 1 && target <= numPages) setCurrentPage(target)
    },
    [spreadStart, pageMode, numPages, setCurrentPage]
  )

  const choosePageMode = useCallback(
    (mode: PdfPageMode) => {
      setPageMode(mode)
      // The page on screen must stay on screen: its spread start moves when the
      // parity changes underneath it.
      setCurrentPage(pdfSpreadStart(spreadStart, mode))
    },
    [setPageMode, setCurrentPage, spreadStart]
  )

  // Measure the page pdf.js actually holds rather than assuming Letter: a page
  // that is A4, landscape or a mix of sizes fits to the wrong width otherwise.
  useEffect(() => {
    const pdf = pdfRef.current
    if (!pdf || typeof pdf.getPage !== 'function') return
    let cancelled = false
    void pdf
      .getPage(spreadStart)
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
  }, [spreadStart, numPages])

  /**
   * Every zoom write goes through here. A fit is derived from the pane, so it
   * does NOT persist a scale: storing it would freeze one pane's width into the
   * tab and stop the document fitting the next time it is opened somewhere
   * narrower. What persists is the fit MODE.
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

  /** The scale at which the layout fills the pane, or `null` if unmeasurable. */
  const computeFitScale = useCallback((): number | null => {
    const el = pageScrollRef.current
    if (!el || !pageSize || !fitMode) return null
    // A quarter turn swaps the axes the page is measured on.
    const quarterTurned = rotation % 180 !== 0
    const across = quarterTurned ? pageSize.height : pageSize.width
    const down = quarterTurned ? pageSize.width : pageSize.height

    if (fitMode === 'height') {
      const available = el.clientHeight - PAGE_VIEW_PADDING
      if (available <= 0 || down <= 0) return null
      return clampScale(available / down)
    }

    const columns = columnsFor(pageMode)
    const available = el.clientWidth - PAGE_VIEW_PADDING - SPREAD_GAP * (columns - 1)
    if (available <= 0 || across <= 0) return null
    return clampScale(available / (across * columns))
  }, [pageSize, rotation, fitMode, pageMode])

  // Keep fitting while a fit mode is chosen — the pane changes width when the
  // window resizes or the thumbnail rail toggles. This deliberately does NOT go
  // through `mayAutoPositionFor`: a fit mode is a stored choice, not the
  // auto-positioning a stored choice is supposed to suppress.
  useEffect(() => {
    const el = pageScrollRef.current
    if (!el) return
    const fit = () => {
      if (!fitModeRef.current) return
      const fitted = computeFitScale()
      if (fitted !== null) applyScale(fitted, { persist: false })
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [computeFitScale, applyScale])

  /** Picking a zoom by hand ends the fit; the number the user chose wins. */
  const zoomBy = useCallback(
    (delta: number) => {
      setStoredFitMode(null)
      applyScale(scaleRef.current + delta)
    },
    [applyScale, setStoredFitMode]
  )

  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy])
  const zoomOut = useCallback(() => zoomBy(-ZOOM_STEP), [zoomBy])

  const rotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360)
  }, [setRotation])

  /** Choosing a fit hands the zoom back to the pane, so the stored one goes. */
  const chooseFit = useCallback(
    (mode: 'width' | 'height') => {
      setStoredScale(null)
      setStoredFitMode(mode)
    },
    [setStoredScale, setStoredFitMode]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // The text layer is selectable and the page field is an input; neither
      // should have its keystrokes stolen for navigation.
      if (event.target instanceof HTMLInputElement) return
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault()
        stepSpread(1)
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        stepSpread(-1)
      } else if (event.key === 'Home') {
        event.preventDefault()
        goToPage(1)
      } else if (event.key === 'End') {
        event.preventDefault()
        goToPage(numPages)
      }
    },
    [stepSpread, goToPage, numPages]
  )

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

  const isFirstSpread = spreadStart <= 1
  const isLastSpread = spreadStart + visiblePages.length > numPages

  return (
    <div className={cn('flex h-full flex-col bg-muted/20 min-h-0 overflow-hidden', className)}>
      {/* Toolbar - the viewer's only chrome, fixed at top */}
      <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1.5 border-b border-border bg-background/80 backdrop-blur-sm flex-shrink-0">
        {/* Start: what the file IS */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="h-8 w-8 shrink-0 p-0"
            title={
              sidebarOpen
                ? tPhaseF('phaseF.componentsViewersPdfViewer.hideThumbnails')
                : tPhaseF('phaseF.componentsViewersPdfViewer.showThumbnails')
            }
          >
            {sidebarOpen ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeft className="h-4 w-4" />
            )}
          </Button>
          {title && (
            <span className="hidden truncate text-sm font-medium md:inline" title={title}>
              {title}
            </span>
          )}
          {chips && <div className="hidden min-w-0 shrink lg:flex">{chips}</div>}
        </div>

        {/* Centre: where the reader IS, and how the page is laid out */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => stepSpread(-1)}
            disabled={isFirstSpread}
            className="h-8 w-8 p-0"
            title={tPhaseF('phaseF.componentsViewersPdfViewer.previousPage')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <PdfPageField
            currentPage={spreadStart}
            numPages={numPages}
            onGoToPage={goToPage}
            label={tPhaseF('phaseF.componentsViewersPdfViewer.goToPage')}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => stepSpread(1)}
            disabled={isLastSpread}
            className="h-8 w-8 p-0"
            title={tPhaseF('phaseF.componentsViewersPdfViewer.nextPage')}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>

          <div className="mx-1 hidden h-5 w-px bg-border sm:block" />

          <Button
            variant="ghost"
            size="sm"
            onClick={zoomOut}
            className="hidden h-8 w-8 p-0 md:inline-flex"
            title={tPhaseF('phaseF.componentsViewersPdfViewer.zoomOut')}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={zoomIn}
            className="hidden h-8 w-8 p-0 md:inline-flex"
            title={tPhaseF('phaseF.componentsViewersPdfViewer.zoomIn')}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={rotate}
            className="h-8 w-8 p-0"
            title={tPhaseF('phaseF.componentsViewersPdfViewer.rotate')}
          >
            <RotateCw className="h-4 w-4" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                title={tPhaseF('phaseF.componentsViewersPdfViewer.viewOptions')}
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>
                {tPhaseF('phaseF.componentsViewersPdfViewer.fit')}
              </DropdownMenuLabel>
              {/* No fit is checked once the user picks a zoom; a radio group
                  with nothing selected is the honest reading of that state. */}
              <DropdownMenuRadioGroup
                value={fitMode ?? ''}
                onValueChange={(value) => chooseFit(value as 'width' | 'height')}
              >
                <DropdownMenuRadioItem value="width">
                  <Maximize2 className="me-2 h-4 w-4" />
                  {tPhaseF('phaseF.componentsViewersPdfViewer.fitToWidth')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="height">
                  <MoveVertical className="me-2 h-4 w-4" />
                  {tPhaseF('phaseF.componentsViewersPdfViewer.fitToHeight')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>
                {tPhaseF('phaseF.componentsViewersPdfViewer.pageLayout')}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={pageMode}
                onValueChange={(value) => choosePageMode(value as PdfPageMode)}
              >
                <DropdownMenuRadioItem value="single">
                  <FileText className="me-2 h-4 w-4" />
                  {tPhaseF('phaseF.componentsViewersPdfViewer.singlePage')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="two-odd">
                  <Columns2 className="me-2 h-4 w-4" />
                  {tPhaseF('phaseF.componentsViewersPdfViewer.twoPageOdd')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="two-even">
                  <BookOpen className="me-2 h-4 w-4" />
                  {tPhaseF('phaseF.componentsViewersPdfViewer.twoPageEven')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={adaptToTheme}
                onCheckedChange={(checked) => {
                  void updateEditorSettings({ pdfAdaptToTheme: checked === true })
                }}
              >
                <Moon className="me-2 h-4 w-4" />
                {tPhaseF('phaseF.componentsViewersPdfViewer.adaptToTheme')}
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* End: what can be DONE with the file */}
        <div className="flex flex-1 items-center justify-end gap-1">{actions}</div>
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
              activePages={visiblePages}
              onSelectPage={goToPage}
              adaptToTheme={adaptToTheme}
            />
          )}

          {/* PDF content - with both horizontal and vertical scrolling.
              `tabIndex` so the arrow keys have somewhere to land. */}
          <div
            ref={pageScrollRef}
            data-testid="pdf-page-view"
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className="flex-1 overflow-auto min-h-0 focus:outline-none"
          >
            <div
              className={cn(
                'inline-flex min-w-full justify-center p-4',
                // Inverting is a no-op in light themes by construction, so the
                // preference needs no theme read of its own.
                adaptToTheme && 'dark:[filter:invert(1)_hue-rotate(180deg)]'
              )}
              style={{ gap: `${SPREAD_GAP}px` }}
            >
              {visiblePages.map((page) => (
                <Page
                  key={page}
                  pageNumber={page}
                  scale={scale}
                  rotate={rotation}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  className="shadow-lg"
                />
              ))}
            </div>
          </div>
        </div>
      </Document>
    </div>
  )
}
