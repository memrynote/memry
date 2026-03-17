/**
 * Inbox Detail Panel - Unified Preview & Filing Component
 * Combines content preview with filing controls in a single 600px panel
 *
 * Layout:
 * - Header: Item type icon, title, close button
 * - Metadata: Capture date, source URL, etc.
 * - Scrollable Content: Type-specific preview (link, image, voice, text)
 * - Sticky Filing Section: Folder selector, tags, note links
 * - Footer: Delete/File buttons with keyboard shortcuts
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Archive, Check, Loader2, GripHorizontal } from '@/lib/icons'
import { useQuery } from '@tanstack/react-query'

import { cn } from '@/lib/utils'

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  SheetDescription
} from '@/components/ui/sheet'
import * as VisuallyHidden from '@radix-ui/react-visually-hidden'
import { Button } from '@/components/ui/button'

import { ContentSection, ContentMetadata, ContentSkeleton, TypeIcon } from './content-section'
import { FilingSection, useFilingState } from './filing-section'
import { useRetryTranscription, useUpdateInboxItem } from '@/hooks/use-inbox'
import { isMac, isInputFocused } from '@/hooks/use-keyboard-shortcuts'
import type { InboxItem, InboxItemListItem, Folder } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:InboxDetailPanel')

// Panel can work with either full or list item types
type DetailItem = InboxItem | InboxItemListItem

// =============================================================================
// Types
// =============================================================================

interface InboxDetailPanelProps {
  isOpen: boolean
  item: DetailItem | null
  isLoading?: boolean
  onClose: () => void
  onFile: (itemId: string, folderId: string, tags: string[], linkedNoteIds: string[]) => void
  onArchive: (id: string) => void
}

// =============================================================================
// Main Component
// =============================================================================

export const InboxDetailPanel = ({
  isOpen,
  item,
  isLoading = false,
  onClose,
  onFile,
  onArchive
}: InboxDetailPanelProps): React.JSX.Element => {
  // Retry transcription mutation
  const retryTranscriptionMutation = useRetryTranscription()

  // Update item mutation for content editing
  const updateItemMutation = useUpdateInboxItem()

  // Filing state management
  const { selectedFolder, tags, linkedNotes, setSelectedFolder, setTags, setLinkedNotes, canFile } =
    useFilingState({ item, isOpen })

  // Fetch AI suggestions for keyboard shortcuts
  const { data: aiSuggestions = [] } = useQuery({
    queryKey: ['inbox', 'suggestions', item?.id],
    queryFn: async () => {
      if (!item?.id) return []
      try {
        const response = await window.api.inbox.getSuggestions(item.id)
        return response.suggestions || []
      } catch {
        return []
      }
    },
    enabled: isOpen && !!item?.id,
    staleTime: 30000
  })

  // Get suggested folders for number shortcuts
  const suggestedFoldersForShortcut = useMemo(() => {
    if (aiSuggestions.length > 0) {
      return aiSuggestions
        .filter((s) => s.destination.type === 'folder' && s.destination.path)
        .slice(0, 5)
        .map((s) => {
          const path = s.destination.path || ''
          return {
            id: path,
            name: path.split('/').pop() || path || 'Notes',
            path: path
          } as Folder
        })
    }
    return []
  }, [aiSuggestions])

  // Loading state for filing
  const [isFilingLoading, setIsFilingLoading] = useState(false)

  // Resizable filing section state (percentage of total height for filing section)
  const [filingSectionRatio, setFilingSectionRatio] = useState(0.35)
  const [isResizing, setIsResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Handle resize drag
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsResizing(true)

      const startY = e.clientY
      const startRatio = filingSectionRatio

      const handleMouseMove = (moveEvent: MouseEvent): void => {
        if (!containerRef.current) return

        const containerRect = containerRef.current.getBoundingClientRect()
        const containerHeight = containerRect.height
        const deltaY = startY - moveEvent.clientY
        const deltaRatio = deltaY / containerHeight

        const newRatio = Math.min(0.7, Math.max(0.2, startRatio + deltaRatio))
        setFilingSectionRatio(newRatio)
      }

      const handleMouseUp = (): void => {
        setIsResizing(false)
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [filingSectionRatio]
  )

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!isOpen) return

      // Skip if typing in an input field
      if (isInputFocused()) {
        // Still handle Escape in inputs
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
        return
      }

      // Escape to close
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }

      // Cmd/Ctrl + Enter to file
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (canFile && item) {
          handleFileItem()
        }
        return
      }

      // Number keys 1-5 to select suggested folders
      if (/^[1-5]$/.test(e.key)) {
        const index = parseInt(e.key, 10) - 1
        if (index < suggestedFoldersForShortcut.length) {
          e.preventDefault()
          setSelectedFolder(suggestedFoldersForShortcut[index])
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, canFile, item, suggestedFoldersForShortcut, setSelectedFolder, onClose])

  // Handle filing
  const handleFileItem = useCallback(async (): Promise<void> => {
    if (!selectedFolder || !item) return

    setIsFilingLoading(true)

    // Track suggestion feedback if AI suggestions were available
    if (aiSuggestions.length > 0) {
      const topSuggestion = aiSuggestions[0]
      const suggestedPath = topSuggestion?.destination?.path || ''

      window.api.inbox
        .trackSuggestion({
          itemId: item.id,
          itemType: item.type,
          suggestedTo: suggestedPath,
          actualTo: selectedFolder.id,
          confidence: topSuggestion?.confidence || 0,
          suggestedTags: topSuggestion?.suggestedTags || [],
          actualTags: tags
        })
        .catch((error) => {
          log.error('Failed to track suggestion', error)
        })
    }

    // Use path for folder location - prefer path, fallback to id
    const folderPath = selectedFolder.path ?? selectedFolder.id ?? ''

    onFile(
      item.id,
      folderPath,
      tags,
      linkedNotes.map((n) => n.id)
    )

    setIsFilingLoading(false)
    onClose()
  }, [selectedFolder, item, tags, linkedNotes, aiSuggestions, onFile, onClose])

  // Handle archive
  const handleArchive = useCallback((): void => {
    if (item) {
      onArchive(item.id)
      onClose()
    }
  }, [item, onArchive, onClose])

  // Handle retry transcription
  const handleRetryTranscription = useCallback((): void => {
    if (item) {
      retryTranscriptionMutation.mutate(item.id)
    }
  }, [item, retryTranscriptionMutation])

  // Debounce timer for content changes
  const contentChangeTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Handle content change (debounced save - 500ms delay)
  const handleContentChange = useCallback(
    (content: string): void => {
      if (!item) return

      // Clear any pending save
      if (contentChangeTimerRef.current) {
        clearTimeout(contentChangeTimerRef.current)
      }

      // Debounce the save
      contentChangeTimerRef.current = setTimeout(() => {
        updateItemMutation.mutate({ id: item.id, content })
      }, 500)
    },
    [item, updateItemMutation]
  )

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (contentChangeTimerRef.current) {
        clearTimeout(contentChangeTimerRef.current)
      }
    }
  }, [])

  // Handle folder selection
  const handleFolderSelect = useCallback(
    (folder: Folder): void => {
      setSelectedFolder(folder)
    },
    [setSelectedFolder]
  )

  // Handle sheet open change
  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      onClose()
    }
  }

  const modifierKeyDisplay = isMac ? '⌘' : 'Ctrl+'
  const keyboardHint = `${modifierKeyDisplay}⏎ file · 1-5 folder · Esc close`

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="w-[600px] sm:max-w-[600px] flex flex-col p-0 h-full overflow-hidden"
        aria-describedby={item ? undefined : 'detail-panel-description'}
      >
        {isLoading ? (
          <>
            {/* Hidden title/description for accessibility when loading */}
            <VisuallyHidden.Root>
              <SheetTitle>Loading preview</SheetTitle>
              <SheetDescription id="detail-panel-description">
                Loading item details...
              </SheetDescription>
            </VisuallyHidden.Root>
            <ContentSkeleton />
          </>
        ) : item ? (
          <>
            {/* Header */}
            <SheetHeader className="px-6 py-4 border-b border-[var(--border)] shrink-0">
              <div className="flex items-start gap-3">
                <TypeIcon type={item.type} />
                <SheetTitle className="text-lg font-semibold flex-1 line-clamp-2 pr-8">
                  {item.title}
                </SheetTitle>
              </div>
            </SheetHeader>

            {/* Metadata Bar */}
            <ContentMetadata item={item} />

            {/* Main Content Area - Resizable Split */}
            <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
              {/* Scrollable Content Area */}
              <div
                className="min-h-0 overflow-y-auto"
                style={{ flex: `${1 - filingSectionRatio} 1 0%` }}
              >
                <div className="px-6 py-4">
                  <ContentSection
                    item={item}
                    onRetryTranscription={handleRetryTranscription}
                    isRetrying={retryTranscriptionMutation.isPending}
                    onContentChange={handleContentChange}
                  />
                </div>
              </div>

              {/* Resize Handle */}
              <div
                onMouseDown={handleResizeStart}
                className={cn(
                  'relative h-2 shrink-0 cursor-row-resize group',
                  'border-y border-border bg-muted/30',
                  'hover:bg-muted/60 transition-colors',
                  isResizing && 'bg-primary/20'
                )}
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize filing section"
                tabIndex={0}
              >
                <div className="absolute inset-0 flex items-center justify-center">
                  <GripHorizontal
                    className={cn(
                      'size-4 text-muted-foreground/50',
                      'group-hover:text-muted-foreground transition-colors',
                      isResizing && 'text-primary'
                    )}
                  />
                </div>
              </div>

              {/* Filing Section - Resizable */}
              <div
                className="min-h-0 overflow-y-auto bg-muted/30"
                style={{ flex: `${filingSectionRatio} 1 0%` }}
              >
                <div className="px-6 py-4">
                  <FilingSection
                    item={item}
                    selectedFolder={selectedFolder}
                    tags={tags}
                    linkedNotes={linkedNotes}
                    onFolderSelect={handleFolderSelect}
                    onTagsChange={setTags}
                    onLinkedNotesChange={setLinkedNotes}
                  />
                </div>
              </div>
            </div>

            {/* Footer with Actions */}
            <SheetFooter className="shrink-0 px-6 py-3 border-t border-[var(--border)] flex-col gap-2">
              <div className="flex items-center justify-between w-full gap-3">
                <Button
                  variant="ghost"
                  onClick={handleArchive}
                  className="text-[var(--muted-foreground)]"
                >
                  <Archive className="size-4 mr-2" aria-hidden="true" />
                  Archive
                </Button>
                <Button
                  onClick={handleFileItem}
                  disabled={!canFile || isFilingLoading}
                  className="min-w-[120px]"
                >
                  {isFilingLoading ? (
                    <>
                      <Loader2 className="size-4 animate-spin mr-2" aria-hidden="true" />
                      Filing...
                    </>
                  ) : (
                    <>
                      {canFile && <Check className="size-4 mr-2" aria-hidden="true" />}
                      File item
                    </>
                  )}
                </Button>
              </div>
              <p className="text-xs text-[var(--muted-foreground)] text-center w-full">
                {keyboardHint}
              </p>
            </SheetFooter>
          </>
        ) : (
          // Hidden title/description for accessibility when no item
          <VisuallyHidden.Root>
            <SheetTitle>Detail panel</SheetTitle>
            <SheetDescription>No item selected</SheetDescription>
          </VisuallyHidden.Root>
        )}
      </SheetContent>
    </Sheet>
  )
}
