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
  PanelLeftClose,
  PanelLeft,
  ChevronLeft,
  ChevronRight,
  GripVertical
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useSync } from '@/contexts/sync-context'
import { useT } from '@memry/i18n/renderer'
import type { FileBlockProps } from './file-block-markers'

export { FILE_BLOCK_REGEX, parseFileBlockMarker, serializeFileBlock } from './file-block-markers'
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
// Release within this many px of the column edge snaps to full width.
const PDF_SNAP_THRESHOLD = 24

function clampWidth(value: number, max: number): number {
  return Math.round(Math.min(Math.max(value, MIN_PDF_WIDTH), max))
}

interface PdfPreviewProps {
  url: string
  name: string
  /** Stored display width in px; `0` uses the responsive default. */
  width: number
  /** Commit a new display width (px) to the block prop. `0` restores default. */
  onResize: (width: number) => void
}

function PdfPreview({ url, name, width, onResize }: PdfPreviewProps) {
  const { t: tPhaseF } = useT('notes')
  const [numPages, setNumPages] = useState<number>(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // --- Resize state ---------------------------------------------------------
  // The page-view column bounds the max width so a page never overflows or
  // horizontally scrolls; measured live so a stored width wider than the
  // current window clamps down (and restores when the window widens).
  const viewRef = useRef<HTMLDivElement>(null)
  const [maxWidth, setMaxWidth] = useState(0)
  // Non-null only while dragging, for smooth feedback before the commit.
  const [draftWidth, setDraftWidth] = useState<number | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number; rtl: boolean } | null>(null)

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

  const defaultWidth = sidebarOpen ? 480 : 600
  const storedWidth = width > 0 ? width : defaultWidth
  const limit = maxWidth > 0 ? maxWidth : storedWidth
  const renderWidth = Math.min(draftWidth ?? storedWidth, limit)

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      const rtl = getComputedStyle(e.currentTarget).direction === 'rtl'
      dragRef.current = { startX: e.clientX, startWidth: renderWidth, rtl }
      e.currentTarget.setPointerCapture(e.pointerId)
      setDraftWidth(renderWidth)
    },
    [renderWidth]
  )

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const delta = (e.clientX - drag.startX) * (drag.rtl ? -1 : 1)
      setDraftWidth(clampWidth(drag.startWidth + delta, limit))
    },
    [limit]
  )

  const handleResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      e.currentTarget.releasePointerCapture(e.pointerId)
      const delta = (e.clientX - drag.startX) * (drag.rtl ? -1 : 1)
      const next = clampWidth(drag.startWidth + delta, limit)
      dragRef.current = null
      setDraftWidth(null)
      onResize(next >= limit - PDF_SNAP_THRESHOLD ? limit : next)
    },
    [limit, onResize]
  )

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 50 : 20
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault()
        onResize(clampWidth(renderWidth + step, limit))
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault()
        onResize(clampWidth(renderWidth - step, limit))
      }
    },
    [renderWidth, limit, onResize]
  )

  const handleLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages)
    setLoading(false)
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

  const goToPage = useCallback(
    (page: number) => {
      if (page >= 1 && page <= numPages) {
        setCurrentPage(page)
      }
    },
    [numPages]
  )

  const goToPrevPage = useCallback(() => {
    goToPage(currentPage - 1)
  }, [currentPage, goToPage])

  const goToNextPage = useCallback(() => {
    goToPage(currentPage + 1)
  }, [currentPage, goToPage])

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
    <div className="pdf-preview rounded-md border border-border bg-muted/30 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/50">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="h-4 w-4 text-red-500" />
          <span className="font-medium truncate max-w-[200px]">{name}</span>
          {!loading && numPages > 0 && (
            <span className="text-xs text-muted-foreground/70">
              ({numPages} {numPages === 1 ? 'page' : 'pages'})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {numPages > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="h-7 w-7 p-0"
              title={sidebarOpen ? 'Hide pages' : 'Show pages'}
            >
              {sidebarOpen ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeft className="h-4 w-4" />
              )}
            </Button>
          )}
          <Button variant="ghost" size="sm" asChild className="h-7 text-xs">
            <a href={url} download={name}>
              <Download className="me-1 h-3 w-3" />

              {tPhaseF('phaseF.componentsNoteContentAreaFileBlock.download')}
            </a>
          </Button>
        </div>
      </div>

      {/* PDF Content */}
      <div className="flex">
        {/* Sidebar with page thumbnails */}
        {sidebarOpen && numPages > 1 && (
          <div className="w-[120px] border-e border-border bg-muted/30 flex-shrink-0">
            <ScrollArea className="h-[400px]">
              <div className="p-2 space-y-2">
                <Document file={url}>
                  {Array.from({ length: numPages }, (_, i) => (
                    <button
                      key={i + 1}
                      type="button"
                      onClick={() => goToPage(i + 1)}
                      className={cn(
                        'w-full rounded border-2 overflow-hidden transition-all hover:border-primary/50',
                        currentPage === i + 1
                          ? 'border-primary ring-1 ring-primary/20'
                          : 'border-transparent'
                      )}
                    >
                      <Page
                        pageNumber={i + 1}
                        width={100}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                      />
                      <div className="text-[10px] text-center py-1 bg-background/80 text-muted-foreground">
                        {i + 1}
                      </div>
                    </button>
                  ))}
                </Document>
              </div>
            </ScrollArea>
          </div>
        )}

        {/* Main PDF View */}
        <div ref={viewRef} className="flex-1 min-w-0">
          <div className="group relative">
            <div className="overflow-auto max-h-[80vh] bg-white dark:bg-zinc-900">
              <Document
                file={url}
                onLoadSuccess={handleLoadSuccess}
                onLoadError={handleLoadError}
                loading={PDF_LOADING_INDICATOR}
              >
                <Page
                  pageNumber={currentPage}
                  width={renderWidth}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                />
              </Document>
            </div>
            {!loading && !error && (
              <div
                role="slider"
                tabIndex={0}
                aria-label={tPhaseF('phaseF.componentsNoteContentAreaFileBlock.resizePdf')}
                aria-orientation="horizontal"
                aria-valuemin={MIN_PDF_WIDTH}
                aria-valuemax={maxWidth || undefined}
                aria-valuenow={Math.round(renderWidth)}
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerUp}
                onKeyDown={handleResizeKeyDown}
                className="absolute bottom-2 end-2 flex h-5 w-5 cursor-ew-resize touch-none items-center justify-center rounded-sm border border-border bg-background/90 text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <GripVertical className="h-3 w-3" />
              </div>
            )}
          </div>

          {/* Page Navigation */}
          {numPages > 1 && (
            <div className="flex items-center justify-center gap-2 py-2 border-t border-border bg-muted/30">
              <Button
                variant="ghost"
                size="sm"
                onClick={goToPrevPage}
                disabled={currentPage <= 1}
                className="h-7 w-7 p-0"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground min-w-[60px] text-center">
                {currentPage} / {numPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={goToNextPage}
                disabled={currentPage >= numPages}
                className="h-7 w-7 p-0"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
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
  block: { props: { url: string; name: string; size: number; mimeType: string; width?: number } }
  editor: unknown
  contentRef: React.Ref<HTMLDivElement>
}) {
  const { t: tPhaseF } = useT('notes')
  const { url, name, size, mimeType, width } = block.props
  const isPdf = mimeType === 'application/pdf'
  const isAudio = mimeType.startsWith('audio/')

  // Persist the user-chosen PDF width to the block prop (round-trips to the
  // vault marker via serializeFileBlock). Declared before the early return to
  // keep hook order stable.
  const handleResize = useCallback(
    (nextWidth: number) => {
      const fileEditor = editor as FileBlockEditor | undefined
      fileEditor?.updateBlock(block, { props: { ...block.props, width: nextWidth } })
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
        <PdfPreview url={url} name={name} width={width ?? 0} onResize={handleResize} />
      ) : isAudio ? (
        <AudioPreview url={url} name={name} size={size} mimeType={mimeType} />
      ) : (
        <FilePreview url={url} name={name} size={size} mimeType={mimeType} />
      )}
    </div>
  )
}

export const createFileBlock = createReactBlockSpec(
  {
    type: 'file',
    propSchema: {
      url: { default: '' },
      name: { default: '' },
      size: { default: 0 },
      mimeType: { default: '' },
      width: { default: 0 }
    },
    content: 'none'
  },
  {
    render: FileBlockRender
  }
)

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
