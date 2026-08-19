import { getI18n } from 'react-i18next'
/**
 * FileBlock - Custom BlockNote block for file attachments with inline PDF preview.
 * Uses react-pdf for PDF rendering.
 *
 * @module components/note/content-area/file-block
 */

import { useState, useCallback, useRef, useLayoutEffect } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
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
  ChevronLeft,
  ChevronRight,
  LeftToRightBlockQuote,
  TextAlignCenter,
  RightToLeftBlockQuote
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useSync } from '@/contexts/sync-context'
import { useT } from '@memry/i18n/renderer'
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
}

function PdfPreview({ url, name, width, height, align, onResize, onAlign }: PdfPreviewProps) {
  const { t: tPhaseF } = useT('notes')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // --- Paging ---------------------------------------------------------------
  // The embed stays chromeless at rest; the page controls are a hover overlay
  // and only exist at all when the document actually has more than one page.
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)

  // --- Resize state ---------------------------------------------------------
  // The column bounds the max width so the page never overflows horizontally;
  // the first page's natural rendered height bounds the max crop. Both measured
  // live so a stored size larger than the current layout clamps down.
  const viewRef = useRef<HTMLDivElement>(null)
  const [maxWidth, setMaxWidth] = useState(0)
  // Natural (unclipped) height of the rendered first page; caps the crop.
  const pageContentRef = useRef<HTMLDivElement>(null)
  const [pageNaturalHeight, setPageNaturalHeight] = useState(0)
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

  useLayoutEffect(() => {
    const el = pageContentRef.current
    if (!el) return
    const measure = () => setPageNaturalHeight(el.scrollHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Width scales the whole embed (card + page) like an image. Height is an
  // independent crop: shrinking it clips the first page from the top so only
  // the opening of the document shows — no inner scroll.
  const columnWidth = maxWidth > 0 ? maxWidth : DEFAULT_PDF_CARD_WIDTH
  const storedWidth = width > 0 ? width : columnWidth
  const widthLimit = columnWidth
  const cardWidth = Math.min(draftWidth ?? storedWidth, widthLimit)
  const pageWidth = Math.max(140, cardWidth - PDF_CARD_BORDER)

  const heightLimit = pageNaturalHeight > 0 ? pageNaturalHeight : Infinity
  const draftCrop = draftHeight != null ? Math.min(draftHeight, heightLimit) : null
  const storedCrop = height > 0 ? Math.min(height, heightLimit) : 0
  // Effective crop height; `undefined` lets the card wrap the full first page.
  const cardHeight = draftCrop ?? (storedCrop > 0 ? storedCrop : undefined)

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

  const handleLoadSuccess = ({ numPages: total }: { numPages: number }) => {
    setNumPages(total)
    setCurrentPage(1)
    setLoading(false)
  }

  const goToPage = useCallback(
    (page: number) => {
      setCurrentPage((current) => (page >= 1 && page <= numPages ? page : current))
    },
    [numPages]
  )

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
          <span className="font-medium">{name}</span>
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
        {/* Clipped frame: rounded border + first-page crop (no inner scroll). */}
        <div
          className="relative overflow-hidden rounded-md border border-border bg-muted/30"
          style={{ height: cardHeight }}
        >
          <div ref={pageContentRef} className="bg-white dark:bg-zinc-900">
            <Document
              file={url}
              onLoadSuccess={handleLoadSuccess}
              onLoadError={handleLoadError}
              loading={PDF_LOADING_INDICATOR}
            >
              <Page
                pageNumber={currentPage}
                width={pageWidth}
                renderTextLayer={true}
                renderAnnotationLayer={true}
              />
            </Document>
          </div>

          {/* Page controls — hover reveal, bottom-centered. `inset-x-0` + a
              centering flex row keeps this RTL-safe without a translate, and
              only the pill itself takes pointer events so the page stays
              selectable underneath. Sits above react-pdf's text layer (z-2). */}
          {!loading && !error && numPages > 1 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <div className="pointer-events-auto flex items-center gap-px rounded-md border border-border bg-background/90 p-0.5 shadow-sm">
                <button
                  type="button"
                  aria-label={tPhaseF('phaseF.componentsNoteContentAreaFileBlock.previousPage')}
                  disabled={currentPage <= 1}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => goToPage(currentPage - 1)}
                  className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
                </button>
                <span className="px-1 text-xs tabular-nums text-muted-foreground">
                  {currentPage} / {numPages}
                </span>
                <button
                  type="button"
                  aria-label={tPhaseF('phaseF.componentsNoteContentAreaFileBlock.nextPage')}
                  disabled={currentPage >= numPages}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => goToPage(currentPage + 1)}
                  className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <ChevronRight className="h-4 w-4 rtl:rotate-180" />
                </button>
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
            </div>
          )}
        </div>

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
}

function FilePreview({ url, name, size, mimeType }: FilePreviewProps) {
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

function AudioPreview({ url, name }: FilePreviewProps) {
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

  // Don't render if no URL
  if (!url) {
    return (
      <div ref={contentRef} className="file-block-empty p-2 text-muted-foreground text-sm">
        {tPhaseF('phaseF.componentsNoteContentAreaFileBlock.noFileAttached')}
      </div>
    )
  }

  return (
    <div ref={contentRef} className="file-block my-2" contentEditable={false}>
      {isPdf ? (
        <PdfPreview
          url={url}
          name={name}
          width={width ?? 0}
          height={height ?? 0}
          align={align ?? 'left'}
          onResize={handleResize}
          onAlign={handleAlign}
        />
      ) : isAudio ? (
        <AudioPreview url={url} name={name} size={size} mimeType={mimeType} />
      ) : (
        <FilePreview url={url} name={name} size={size} mimeType={mimeType} />
      )}
    </div>
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
