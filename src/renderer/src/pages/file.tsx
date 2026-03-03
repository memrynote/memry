/**
 * FilePage Component
 *
 * Displays non-markdown files (PDF, image, audio, video) in their appropriate viewers.
 * Loads file metadata via IPC and renders the file using the absolute path.
 */

import { useQuery } from '@tanstack/react-query'
import { Loader2, FileWarning, Download, ExternalLink } from 'lucide-react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { notesService } from '@/services/notes-service'
import { PdfViewer, ImageViewer, AudioPlayer, VideoPlayer } from '@/components/viewers'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { FileMetadata } from '../../../preload/index.d'

// ============================================================================
// Types
// ============================================================================

interface FilePageProps {
  fileId?: string
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ============================================================================
// Error State Component
// ============================================================================

function FileErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-center">
        <FileWarning className="h-12 w-12 text-muted-foreground" />
        <p className="text-destructive font-medium">Failed to load file</p>
        <p className="text-sm text-muted-foreground">{error}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Empty State Component
// ============================================================================

function FileEmptyState() {
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
        <FileWarning className="h-12 w-12" />
        <p className="text-sm">No file selected</p>
        <p className="text-xs">Select a file from the sidebar to view it</p>
      </div>
    </div>
  )
}

// ============================================================================
// Loading State Component
// ============================================================================

function FileLoadingState() {
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading file...</p>
      </div>
    </div>
  )
}

// ============================================================================
// File Info Bar Component
// ============================================================================

function FileInfoBar({ file }: { file: FileMetadata }) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 sm:px-4 py-2 border-b border-border bg-muted/30 flex-shrink-0">
      <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
        <h1 className="font-medium truncate flex-1 min-w-0">{file.title}</h1>
        <span className="text-xs text-muted-foreground uppercase flex-shrink-0 hidden sm:inline">
          {file.fileType}
        </span>
        <span className="text-xs text-muted-foreground flex-shrink-0 hidden md:inline">
          {formatFileSize(file.fileSize)}
        </span>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => window.api.notes.openExternal(file.id)}
          className="h-8 w-8 p-0 sm:w-auto sm:px-3"
          title="Open in default app"
        >
          <ExternalLink className="h-4 w-4 sm:mr-1" />
          <span className="hidden sm:inline">Open</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => window.api.notes.revealInFinder(file.id)}
          className="h-8 w-8 p-0 sm:w-auto sm:px-3"
          title="Reveal in Finder"
        >
          <Download className="h-4 w-4 sm:mr-1" />
          <span className="hidden sm:inline">Reveal</span>
        </Button>
      </div>
    </div>
  )
}

// ============================================================================
// File Viewer Component
// ============================================================================

function FileViewer({ file }: { file: FileMetadata }) {
  // Convert absolute path to memry-file:// protocol URL for secure local file access
  const fileUrl = `memry-file://local${file.absolutePath}`

  switch (file.fileType) {
    case 'pdf':
      return <PdfViewer src={fileUrl} className="flex-1" />

    case 'image':
      return <ImageViewer src={fileUrl} alt={file.title} className="flex-1" />

    case 'audio':
      return <AudioPlayer src={fileUrl} fileName={file.title} className="flex-1" />

    case 'video':
      return <VideoPlayer src={fileUrl} className="flex-1" />

    default:
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <FileWarning className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">Unsupported file type</p>
          </div>
        </div>
      )
  }
}

// ============================================================================
// Main FilePage Component
// ============================================================================

export function FilePage({ fileId }: FilePageProps) {
  // Query for file metadata
  const {
    data: file,
    isLoading,
    error,
    refetch
  } = useQuery({
    queryKey: ['file', fileId],
    queryFn: () => notesService.getFile(fileId!),
    enabled: !!fileId,
    staleTime: 60_000 // 1 minute
  })

  // Handle no file ID
  if (!fileId) {
    return <FileEmptyState />
  }

  // Handle loading
  if (isLoading) {
    return <FileLoadingState />
  }

  // Handle error
  if (error) {
    return (
      <FileErrorState
        error={extractErrorMessage(error, 'Failed to load file')}
        onRetry={() => refetch()}
      />
    )
  }

  // Handle file not found
  if (!file) {
    return (
      <FileErrorState
        error="File not found. It may have been deleted or moved."
        onRetry={() => refetch()}
      />
    )
  }

  return (
    <div className={cn('flex h-full flex-col min-h-0')}>
      <FileInfoBar file={file} />
      <FileViewer file={file} />
    </div>
  )
}

export default FilePage
