import { getI18n } from 'react-i18next'
/**
 * FilePage Component
 *
 * Displays non-markdown files (PDF, image, audio, video) in their appropriate viewers.
 * Loads file metadata via IPC and renders the file using the absolute path.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Loader2,
  FileWarning,
  Download,
  ExternalLink,
  FolderPlus,
  MoreHorizontal
} from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { toMemryFileUrl } from '@/lib/memry-file-url'
import { notesService } from '@/services/notes-service'
import { PdfViewer, ImageViewer, AudioPlayer, VideoPlayer } from '@/components/viewers'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { FileMetadata } from '@memry/rpc/notes'
import { useT } from '@memry/i18n/renderer'
import { useFileActionLabels } from '@/hooks/use-file-action-labels'
import { ItemProjectChips } from '@/components/tasks/projects/item-project-chips'
import { AddFileToProjectDialog } from '@/components/tasks/projects/add-file-to-project-dialog'

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
  const { t: tPhaseF } = useT('notes')
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-center">
        <FileWarning className="h-12 w-12 text-muted-foreground" />
        <p className="text-destructive font-medium">
          {tPhaseF('phaseF.pagesFile.failedToLoadFile')}
        </p>
        <p className="text-sm text-muted-foreground">{error}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {tPhaseF('phaseF.pagesFile.tryAgain')}
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
  const { t: tPhaseF } = useT('notes')
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
        <FileWarning className="h-12 w-12" />
        <p className="text-sm">{tPhaseF('phaseF.pagesFile.noFileSelected')}</p>
        <p className="text-xs">{tPhaseF('phaseF.pagesFile.selectAFileFromTheSidebarToViewIt')}</p>
      </div>
    </div>
  )
}

// ============================================================================
// Loading State Component
// ============================================================================

function FileLoadingState() {
  const { t: tPhaseF } = useT('notes')
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{tPhaseF('phaseF.pagesFile.loadingFile')}</p>
      </div>
    </div>
  )
}

// ============================================================================
// File Actions Menu
// ============================================================================

/**
 * The file's actions as one `...` menu.
 *
 * The PDF viewer has no header of its own to spread three labelled buttons
 * across, and its toolbar is already carrying the reading controls — so on that
 * surface the same actions collapse into this.
 */
function FileActionsMenu({
  file,
  onAddToProject
}: {
  file: FileMetadata
  onAddToProject: () => void
}) {
  const { t: tPhaseF } = useT('notes')
  const { t: tTasks } = useT('tasks')
  const fileActions = useFileActionLabels()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          title={tPhaseF('phaseF.pagesFile.fileActions')}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onAddToProject}>
          <FolderPlus className="me-2 h-4 w-4" />
          {tTasks('addToProject.menuLabel')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void window.api.notes.openExternal(file.id)}>
          <ExternalLink className="me-2 h-4 w-4" />
          {fileActions.openInDefaultApp}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void window.api.notes.revealInFinder(file.id)}>
          <Download className="me-2 h-4 w-4" />
          {fileActions.revealInFolder}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ============================================================================
// File Info Bar Component
// ============================================================================

function FileInfoBar({ file, onAddToProject }: { file: FileMetadata; onAddToProject: () => void }) {
  const { t: tPhaseF } = useT('notes')
  const { t: tTasks } = useT('tasks')
  const fileActions = useFileActionLabels()
  return (
    <div className="flex flex-col gap-1 border-b border-border bg-muted/30 shrink-0">
      <div className="flex items-center justify-between gap-2 px-2 sm:px-4 py-2">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
          <h1 className="font-medium truncate flex-1 min-w-0">{file.title}</h1>
          <span className="text-xs text-muted-foreground uppercase shrink-0 hidden sm:inline">
            {file.fileType}
          </span>
          <span className="text-xs text-muted-foreground shrink-0 hidden md:inline">
            {formatFileSize(file.fileSize)}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onAddToProject}
            className="h-8 w-8 p-0 sm:w-auto sm:px-3"
            title={tTasks('addToProject.menuLabel')}
          >
            <FolderPlus className="h-4 w-4 sm:me-1" />
            <span className="hidden sm:inline">{tTasks('addToProject.menuLabel')}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void window.api.notes.openExternal(file.id)}
            className="h-8 w-8 p-0 sm:w-auto sm:px-3"
            title={fileActions.openInDefaultApp}
          >
            <ExternalLink className="h-4 w-4 sm:me-1" />
            <span className="hidden sm:inline">{tPhaseF('phaseF.pagesFile.open')}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void window.api.notes.revealInFinder(file.id)}
            className="h-8 w-8 p-0 sm:w-auto sm:px-3"
            title={fileActions.revealInFolder}
          >
            <Download className="h-4 w-4 sm:me-1" />
            <span className="hidden sm:inline">{tPhaseF('phaseF.pagesFile.reveal')}</span>
          </Button>
        </div>
      </div>
      <ItemProjectChips itemType="file" itemId={file.id} className="px-2 sm:px-4 pb-2" />
    </div>
  )
}

// ============================================================================
// File Viewer Component
// ============================================================================

function FileViewer({ file, onAddToProject }: { file: FileMetadata; onAddToProject: () => void }) {
  const { t: tPhaseF } = useT('notes')
  // Convert absolute path to memry-file:// protocol URL for secure local file access
  const fileUrl = toMemryFileUrl(file.absolutePath)

  switch (file.fileType) {
    case 'pdf':
      return (
        <PdfViewer
          src={fileUrl}
          className="flex-1"
          title={file.title}
          chips={<ItemProjectChips itemType="file" itemId={file.id} maxVisible={2} />}
          actions={<FileActionsMenu file={file} onAddToProject={onAddToProject} />}
        />
      )

    case 'image':
      return <ImageViewer src={fileUrl} alt={file.title} className="flex-1" />

    case 'audio':
      return (
        <AudioPlayer
          src={fileUrl}
          fileName={file.title}
          transcription={file.transcription}
          className="flex-1"
        />
      )

    case 'video':
      return <VideoPlayer src={fileUrl} className="flex-1" />

    default:
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <FileWarning className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">
              {tPhaseF('phaseF.pagesFile.unsupportedFileType')}
            </p>
          </div>
        </div>
      )
  }
}

// ============================================================================
// Main FilePage Component
// ============================================================================

export function FilePage({ fileId }: FilePageProps) {
  const [addToProjectOpen, setAddToProjectOpen] = useState(false)

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
        error={extractErrorMessage(
          error,
          getI18n().getFixedT(null, 'notes')('phaseF.pagesFile.failedToLoadFile')
        )}
        onRetry={() => void refetch()}
      />
    )
  }

  // Handle file not found
  if (!file) {
    return (
      <FileErrorState
        error="File not found. It may have been deleted or moved."
        onRetry={() => void refetch()}
      />
    )
  }

  // The PDF viewer carries the file's name, chips and actions in its own
  // toolbar, so stacking the info bar above it would say all of it twice and
  // cost a strip of the page for the privilege.
  const showInfoBar = file.fileType !== 'pdf'

  return (
    <div className={cn('flex h-full flex-col min-h-0')}>
      {showInfoBar && <FileInfoBar file={file} onAddToProject={() => setAddToProjectOpen(true)} />}
      <FileViewer file={file} onAddToProject={() => setAddToProjectOpen(true)} />
      <AddFileToProjectDialog
        open={addToProjectOpen}
        onOpenChange={setAddToProjectOpen}
        fileId={file.id}
      />
    </div>
  )
}

export default FilePage
