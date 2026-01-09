/**
 * PDF Viewer Component
 * Full-page PDF viewer with navigation, zoom, and thumbnail sidebar.
 *
 * @module components/viewers/pdf-viewer
 */

import { useState, useCallback, useRef } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

// Configure PDF.js worker - import from node_modules for Electron compatibility
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
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

// ============================================================================
// PDF Viewer Component
// ============================================================================

export function PdfViewer({ src, className }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(1.0)
  const [rotation, setRotation] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const handleLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages)
    setLoading(false)
  }, [])

  const handleLoadError = useCallback((err: Error) => {
    setError(err.message)
    setLoading(false)
  }, [])

  const goToPage = useCallback(
    (page: number) => {
      if (page >= 1 && page <= numPages) {
        setCurrentPage(page)
      }
    },
    [numPages]
  )

  const zoomIn = useCallback(() => {
    setScale((s) => Math.min(s + 0.25, 3))
  }, [])

  const zoomOut = useCallback(() => {
    setScale((s) => Math.max(s - 0.25, 0.5))
  }, [])

  const rotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360)
  }, [])

  const fitToWidth = useCallback(() => {
    if (containerRef.current) {
      const containerWidth = containerRef.current.clientWidth - (sidebarOpen ? 160 : 0) - 48
      // Assuming standard PDF width of 612 points (8.5 inches)
      const newScale = containerWidth / 612
      setScale(Math.min(Math.max(newScale, 0.5), 3))
    }
  }, [sidebarOpen])

  if (error) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center bg-muted/30 rounded-lg',
          className
        )}
      >
        <div className="text-center p-8">
          <p className="text-destructive font-medium mb-2">Failed to load PDF</p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className={cn('flex h-full flex-col bg-muted/20', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="flex items-center gap-2">
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

          <div className="w-px h-5 bg-border" />

          {/* Page navigation */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            className="h-8 w-8 p-0"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground min-w-[80px] text-center">
            {currentPage} / {numPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= numPages}
            className="h-8 w-8 p-0"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {/* Zoom controls */}
          <Button variant="ghost" size="sm" onClick={zoomOut} className="h-8 w-8 p-0">
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground min-w-[50px] text-center">
            {Math.round(scale * 100)}%
          </span>
          <Button variant="ghost" size="sm" onClick={zoomIn} className="h-8 w-8 p-0">
            <ZoomIn className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={fitToWidth}
            className="h-8 w-8 p-0"
            title="Fit to width"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>

          <div className="w-px h-5 bg-border" />

          {/* Rotate */}
          <Button
            variant="ghost"
            size="sm"
            onClick={rotate}
            className="h-8 w-8 p-0"
            title="Rotate"
          >
            <RotateCw className="h-4 w-4" />
          </Button>

        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Thumbnail sidebar */}
        {sidebarOpen && (
          <div className="w-[140px] border-r border-border bg-muted/30 flex-shrink-0">
            <ScrollArea className="h-full">
              <div className="p-2 space-y-2">
                {!loading && (
                  <Document file={src}>
                    {Array.from({ length: numPages }, (_, i) => (
                      <button
                        key={i + 1}
                        onClick={() => goToPage(i + 1)}
                        className={cn(
                          'w-full rounded border-2 overflow-hidden transition-all hover:border-primary/50',
                          currentPage === i + 1
                            ? 'border-primary ring-2 ring-primary/20'
                            : 'border-transparent'
                        )}
                      >
                        <Page
                          pageNumber={i + 1}
                          width={120}
                          renderTextLayer={false}
                          renderAnnotationLayer={false}
                        />
                        <div className="text-[10px] text-center py-1 bg-background/80 text-muted-foreground">
                          {i + 1}
                        </div>
                      </button>
                    ))}
                  </Document>
                )}
              </div>
            </ScrollArea>
          </div>
        )}

        {/* PDF content */}
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="flex justify-center items-center p-4 min-h-full">
            <div className="overflow-hidden">
              <Document
                file={src}
                onLoadSuccess={handleLoadSuccess}
                onLoadError={handleLoadError}
                loading={
                  <div className="flex h-[600px] items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                }
              >
                <Page
                  pageNumber={currentPage}
                  scale={scale}
                  rotate={rotation}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  className="shadow-lg"
                />
              </Document>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
