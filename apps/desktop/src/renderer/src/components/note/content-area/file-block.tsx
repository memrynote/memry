/**
 * FileBlock - Custom BlockNote block for file attachments with inline PDF preview.
 * Uses react-pdf for PDF rendering.
 *
 * @module components/note/content-area/file-block
 */

import { useState, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createReactBlockSpec } from '@blocknote/react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import {
  FileText,
  File,
  Download,
  Upload,
  Loader2,
  PanelLeftClose,
  PanelLeft,
  ChevronLeft,
  ChevronRight
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useSync } from '@/contexts/sync-context'

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

// ============================================================================
// PDF Preview Component with Collapsible Sidebar
// ============================================================================

interface PdfPreviewProps {
  url: string
  name: string
}

function PdfPreview({ url, name }: PdfPreviewProps) {
  const [numPages, setNumPages] = useState<number>(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const handleLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages)
    setLoading(false)
  }

  const handleLoadError = (err: Error) => {
    setError(extractErrorMessage(err, 'Failed to load file'))
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
      <div className="pdf-preview-error rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
        <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
          <FileText className="h-5 w-5" />
          <span className="font-medium">{name}</span>
        </div>
        <p className="mt-2 text-sm text-red-500">Failed to load PDF: {error}</p>
      </div>
    )
  }

  return (
    <div className="pdf-preview rounded-lg border border-border bg-muted/30 overflow-hidden">
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
              <Download className="mr-1 h-3 w-3" />
              Download
            </a>
          </Button>
        </div>
      </div>

      {/* PDF Content */}
      <div className="flex">
        {/* Sidebar with page thumbnails */}
        {sidebarOpen && numPages > 1 && (
          <div className="w-[120px] border-r border-border bg-muted/30 flex-shrink-0">
            <ScrollArea className="h-[400px]">
              <div className="p-2 space-y-2">
                <Document file={url}>
                  {Array.from({ length: numPages }, (_, i) => (
                    <button
                      key={i + 1}
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
        <div className="flex-1 min-w-0">
          <div className="overflow-auto max-h-[400px] bg-white dark:bg-zinc-900">
            <Document
              file={url}
              onLoadSuccess={handleLoadSuccess}
              onLoadError={handleLoadError}
              loading={
                <div className="flex h-48 items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <Page
                pageNumber={currentPage}
                width={sidebarOpen ? 480 : 600}
                renderTextLayer={true}
                renderAnnotationLayer={true}
              />
            </Document>
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
    <div className="file-attachment relative flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
      {getFileIcon(mimeType)}
      <div className="flex-1 min-w-0">
        <p className="truncate font-medium text-sm">{name}</p>
        <p className="text-xs text-muted-foreground">{formatFileSize(size)}</p>
      </div>
      <Button variant="ghost" size="sm" asChild className="h-8">
        <a href={url} download={name}>
          <Download className="mr-1 h-4 w-4" />
          Download
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

// ============================================================================
// FileBlock Spec
// ============================================================================

/**
 * Custom BlockNote block for file attachments.
 * Shows inline PDF preview for PDFs, download card for other files.
 * Returns a factory function - call it when adding to schema: `file: createFileBlock()`
 */
export const createFileBlock = createReactBlockSpec(
  {
    type: 'file',
    propSchema: {
      url: { default: '' },
      name: { default: '' },
      size: { default: 0 },
      mimeType: { default: '' }
    },
    content: 'none'
  },
  {
    render: ({ block, contentRef }) => {
      const { url, name, size, mimeType } = block.props
      const isPdf = mimeType === 'application/pdf'

      // Don't render if no URL
      if (!url) {
        return (
          <div ref={contentRef} className="file-block-empty p-2 text-muted-foreground text-sm">
            No file attached
          </div>
        )
      }

      return (
        <div ref={contentRef} className="file-block my-2" contentEditable={false}>
          {isPdf ? (
            <PdfPreview url={url} name={name} />
          ) : (
            <FilePreview url={url} name={name} size={size} mimeType={mimeType} />
          )}
        </div>
      )
    }
  }
)

// ============================================================================
// File Block Serialization Helpers
// ============================================================================

/**
 * Regex to match file block markers in markdown
 * Format: <!-- file:{"url":"...","name":"...","size":123,"mimeType":"..."} -->
 */
export const FILE_BLOCK_REGEX = /<!-- file:(\{[^}]+\}) -->/g

/**
 * Serialize file block props to markdown marker
 */
export function serializeFileBlock(props: {
  url: string
  name: string
  size: number
  mimeType: string
}): string {
  return `<!-- file:${JSON.stringify(props)} -->`
}

/**
 * Parse file block marker from markdown
 */
export function parseFileBlockMarker(
  marker: string
): { url: string; name: string; size: number; mimeType: string } | null {
  const match = marker.match(/<!-- file:(\{[^}]+\}) -->/)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

// ============================================================================
// Helper to create FileBlock content
// ============================================================================

/**
 * Create a FileBlock content object for insertion
 */
export function createFileBlockContent(props: {
  url: string
  name: string
  size: number
  mimeType: string
}) {
  return {
    type: 'file' as const,
    props
  }
}
