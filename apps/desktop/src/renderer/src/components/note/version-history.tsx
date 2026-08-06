import { getI18n } from 'react-i18next'
/**
 * VersionHistory Component
 *
 * Panel for viewing and restoring previous versions of a note.
 * Shows a timeline of snapshots with preview and restore functionality.
 *
 * @module components/note/version-history
 */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { formatDate } from '@/lib/format-date'
import { useDateFormat } from '@/hooks/use-date-format'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import {
  History,
  Clock,
  RotateCcw,
  Eye,
  EyeOff,
  Trash2,
  Loader2,
  AlertCircle,
  ChevronRight
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { notesService, type SnapshotDetail } from '@/services/notes-service'
import { formatDistanceToNow, format } from 'date-fns'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// Types
// ============================================================================

interface VersionHistoryProps {
  /** Whether the panel is open */
  open: boolean
  /** Callback when panel open state changes */
  onOpenChange: (open: boolean) => void
  /** ID of the note to show history for */
  noteId: string
  /** Title of the note (for display) */
  noteTitle: string
  /** Callback when a version is restored */
  onRestore?: () => void
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get a human-readable label for the snapshot reason.
 */
function getReasonLabel(reason: string, autoSavedLabel: string): string {
  switch (reason) {
    case 'manual':
    case 'auto':
    case 'timer':
    case 'significant':
      return autoSavedLabel
    default:
      return autoSavedLabel
  }
}

/**
 * Get icon for the snapshot reason.
 */
function getReasonIcon(): React.ReactNode {
  return <Clock className="h-3 w-3" />
}

// ============================================================================
// Component
// ============================================================================

export function VersionHistory({
  open,
  onOpenChange,
  noteId,
  noteTitle,
  onRestore
}: VersionHistoryProps): React.ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {open ? (
        <VersionHistorySession
          key={noteId}
          noteId={noteId}
          noteTitle={noteTitle}
          onOpenChange={onOpenChange}
          onRestore={onRestore}
        />
      ) : null}
    </Sheet>
  )
}

interface VersionHistorySessionProps {
  noteId: string
  noteTitle: string
  onOpenChange: (open: boolean) => void
  onRestore?: () => void
}

function VersionHistorySession({
  noteId,
  noteTitle,
  onOpenChange,
  onRestore
}: VersionHistorySessionProps): React.ReactElement {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  const dateFormat = useDateFormat()
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<SnapshotDetail | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [versionToDelete, setVersionToDelete] = useState<string | null>(null)
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false)
  const queryClient = useQueryClient()

  // Ref for focus restoration
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Handle keyboard navigation and focus management
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleteDialogOpen && !restoreDialogOpen) {
        e.preventDefault()
        onOpenChange(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      // Restore focus when closing
      if (previousFocusRef.current) {
        requestAnimationFrame(() => {
          previousFocusRef.current?.focus()
        })
      }
    }
  }, [deleteDialogOpen, restoreDialogOpen, onOpenChange])

  const {
    data: versions = [],
    isLoading: loading,
    error
  } = useQuery({
    queryKey: ['notes', 'versions', noteId],
    queryFn: async () => notesService.getVersions(noteId)
  })

  const errorMessage = error
    ? extractErrorMessage(
        error,
        getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToLoadVersionHistory')
      )
    : null

  /**
   * Load preview content for a version.
   */
  const handleSelectVersion = useCallback(
    async (snapshotId: string) => {
      setSelectedVersion(snapshotId)
      setPreviewLoading(true)

      try {
        const detail = await notesService.getVersion(snapshotId)
        setPreviewContent(detail)
      } catch (err) {
        trackRendererError('note_version_preview_failed', err)
        toast.error(t('versionHistory.toast.loadPreviewFailed'))
      } finally {
        setPreviewLoading(false)
      }
    },
    [t]
  )

  /**
   * Restore a version.
   */
  const handleRestore = useCallback(async () => {
    if (!selectedVersion) return

    setRestoring(true)

    try {
      const result = await notesService.restoreVersion(selectedVersion)
      if (result.success) {
        toast.success(t('versionHistory.toast.restored'))
        onOpenChange(false)
        onRestore?.()
      } else {
        trackRendererError('note_version_restore_failed', result.error)
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToRestoreVersion')
          )
        )
      }
    } catch (err) {
      trackRendererError('note_version_restore_failed', err)
      toast.error(
        extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToRestoreVersion')
        )
      )
    } finally {
      setRestoring(false)
      setRestoreDialogOpen(false)
    }
  }, [selectedVersion, onOpenChange, onRestore, t])

  /**
   * Delete a version.
   */
  const handleDelete = useCallback(async () => {
    if (!versionToDelete) return

    try {
      const result = await notesService.deleteVersion(versionToDelete)
      if (result.success) {
        toast.success(t('versionHistory.toast.deleted'))
        void queryClient.invalidateQueries({ queryKey: ['notes', 'versions', noteId] })
        if (selectedVersion === versionToDelete) {
          setSelectedVersion(null)
          setPreviewContent(null)
        }
      } else {
        trackRendererError('note_version_delete_failed', result.error)
        toast.error(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToDeleteVersion')
          )
        )
      }
    } catch (err) {
      trackRendererError('note_version_delete_failed', err)
      toast.error(
        extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToDeleteVersion')
        )
      )
    } finally {
      setDeleteDialogOpen(false)
      setVersionToDelete(null)
    }
  }, [noteId, queryClient, versionToDelete, selectedVersion, t])

  return (
    <>
      <SheetContent className="w-full sm:max-w-2xl flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            {t('versionHistory.title')}
          </SheetTitle>
          <SheetDescription>
            {t('versionHistory.description', { title: noteTitle })}
          </SheetDescription>
        </SheetHeader>

        {/* Toolbar */}
        <div className="flex items-center justify-end gap-2 py-3 border-b">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview(!showPreview)}
            disabled={!selectedVersion}
          >
            {showPreview ? <EyeOff className="me-2 h-4 w-4" /> : <Eye className="me-2 h-4 w-4" />}
            {showPreview ? t('versionHistory.hidePreview') : t('versionHistory.showPreview')}
          </Button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Version List */}
          <div className={cn('flex-1 overflow-hidden', showPreview && 'max-w-[280px]')}>
            <ScrollArea className="h-full">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : errorMessage ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <AlertCircle className="h-8 w-8 text-destructive mb-2" />
                  <p className="text-sm text-muted-foreground">{errorMessage}</p>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => {
                      void queryClient.invalidateQueries({
                        queryKey: ['notes', 'versions', noteId]
                      })
                    }}
                  >
                    {tCommon('button.retry')}
                  </Button>
                </div>
              ) : versions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <History className="h-8 w-8 text-muted-foreground/50 mb-2" />
                  <p className="text-sm text-muted-foreground">{t('versionHistory.empty')}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('versionHistory.emptyDescription')}
                  </p>
                </div>
              ) : (
                <div className="py-2 space-y-1">
                  {versions.map((version, index) => {
                    const isSelected = selectedVersion === version.id
                    const createdAt = new Date(version.createdAt)

                    return (
                      <button
                        type="button"
                        key={version.id}
                        onClick={() => void handleSelectVersion(version.id)}
                        className={cn(
                          'w-full text-start px-3 py-2.5 rounded-md transition-colors',
                          'hover:bg-muted/50 focus-visible:outline-none',
                          isSelected && 'bg-muted'
                        )}
                      >
                        <div className="flex items-start gap-3">
                          {/* Timeline indicator */}
                          <div className="flex flex-col items-center pt-1">
                            <div
                              className={cn(
                                'w-2 h-2 rounded-full',
                                index === 0 ? 'bg-primary' : 'bg-muted-foreground/30'
                              )}
                            />
                            {index < versions.length - 1 && (
                              <div className="w-px h-10 bg-muted-foreground/20 mt-1" />
                            )}
                          </div>

                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium truncate">{version.title}</span>
                              {index === 0 && (
                                <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                                  {t('versionHistory.latest')}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                              {getReasonIcon()}
                              <span>
                                {getReasonLabel(version.reason, t('versionHistory.autoSaved'))}
                              </span>
                              <span>•</span>
                              <span>{t('versionHistory.words', { count: version.wordCount })}</span>
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              {formatDistanceToNow(createdAt, { addSuffix: true })}
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1">
                            {isSelected && (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Preview Panel */}
          {showPreview && selectedVersion && (
            <>
              <Separator orientation="vertical" className="mx-2" />
              <div className="flex-1 flex flex-col overflow-hidden">
                {previewLoading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : previewContent ? (
                  <>
                    {/* Preview header */}
                    <div className="flex items-center justify-between py-2 px-3 border-b">
                      <div>
                        <div className="font-medium text-sm">{previewContent.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {`${formatDate(new Date(previewContent.createdAt), dateFormat)} ${format(new Date(previewContent.createdAt), 'p')}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => {
                            setVersionToDelete(selectedVersion)
                            setDeleteDialogOpen(true)
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                        </Button>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => setRestoreDialogOpen(true)}
                        >
                          <RotateCcw className="me-2 h-4 w-4" />
                          {t('versionHistory.restore')}
                        </Button>
                      </div>
                    </div>

                    {/* Preview content */}
                    <ScrollArea className="flex-1">
                      <div className="p-4">
                        <pre className="text-sm whitespace-pre-wrap font-mono text-muted-foreground">
                          {previewContent.fileContent}
                        </pre>
                      </div>
                    </ScrollArea>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    {t('versionHistory.selectPrompt')}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </SheetContent>

      {/* Restore Confirmation Dialog */}
      <AlertDialog open={restoreDialogOpen} onOpenChange={setRestoreDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('versionHistory.restoreTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('versionHistory.restoreDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>{tCommon('button.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleRestore()} disabled={restoring}>
              {restoring ? (
                <>
                  <Loader2 className="me-2 h-4 w-4 animate-spin" />
                  {t('versionHistory.restoring')}
                </>
              ) : (
                <>
                  <RotateCcw className="me-2 h-4 w-4" />
                  {t('versionHistory.restore')}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('versionHistory.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('versionHistory.deleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('button.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Trash2 className="me-2 h-4 w-4" />
              {tCommon('button.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
