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
import { Archive, Check, Loader2, GripHorizontal, RotateCcw, Trash2 } from '@/lib/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { cn } from '@/lib/utils'
import { useDayPanel } from '@/contexts/day-panel-context'

import { Button } from '@/components/ui/button'

import { ContentSection, ContentSkeleton } from './content-section'
import { DetailHeader } from './detail-header'
import { NoteDetail } from './note-detail'
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
  readOnly?: boolean
  onClose: () => void
  onFile: (itemId: string, folderId: string, tags: string[], linkedNoteIds: string[]) => void
  onArchive: (id: string) => void
  onRestore?: (id: string) => void
  onDelete?: (id: string) => void
}

// =============================================================================
// Main Component
// =============================================================================

export const InboxDetailPanel = ({
  isOpen,
  item,
  isLoading = false,
  readOnly = false,
  onClose,
  onFile,
  onArchive,
  onRestore,
  onDelete
}: InboxDetailPanelProps): React.JSX.Element => {
  const { isOpen: isDayPanelOpen, width: dayPanelWidth } = useDayPanel()
  const queryClient = useQueryClient()

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

  // Resizable content area: null = auto-height (handle sits right after content)
  const [manualContentHeight, setManualContentHeight] = useState<number | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setManualContentHeight(null)
  }, [item?.id])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)

    const startY = e.clientY
    const startHeight = contentRef.current?.getBoundingClientRect().height ?? 0
    const containerHeight = containerRef.current?.getBoundingClientRect().height ?? 0
    const MIN_CONTENT = 60
    const MIN_FILING = 120
    const HANDLE_HEIGHT = 8
    const maxContent = containerHeight - MIN_FILING - HANDLE_HEIGHT

    const handleMouseMove = (moveEvent: MouseEvent): void => {
      const deltaY = moveEvent.clientY - startY
      const newHeight = Math.min(maxContent, Math.max(MIN_CONTENT, startHeight + deltaY))
      setManualContentHeight(newHeight)
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
  }, [])

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
  const pendingTitleRef = useRef<string | null>(null)

  const handleTitleChange = useCallback((title: string): void => {
    pendingTitleRef.current = title
  }, [])

  const handleVoiceTitleSave = useCallback(
    (title: string): void => {
      if (!item) return
      const trimmed = title.trim()
      if (trimmed && trimmed !== item.title) {
        updateItemMutation.mutate({ id: item.id, title: trimmed })
      }
    },
    [item, updateItemMutation]
  )

  const handleContentChange = useCallback(
    (content: string): void => {
      if (!item) return

      if (contentChangeTimerRef.current) {
        clearTimeout(contentChangeTimerRef.current)
      }

      contentChangeTimerRef.current = setTimeout(() => {
        const update: { id: string; content: string; title?: string } = { id: item.id, content }
        if (pendingTitleRef.current !== null) {
          update.title = pendingTitleRef.current
          pendingTitleRef.current = null
        }
        updateItemMutation.mutate(update, {
          onSuccess: () => {
            void queryClient.invalidateQueries({
              queryKey: ['inbox', 'suggestions', item.id]
            })
          }
        })
      }, 1500)
    },
    [item, updateItemMutation, queryClient]
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

  const modifierKeyDisplay = isMac ? '⌘' : 'Ctrl+'
  const keyboardHint = `${modifierKeyDisplay}⏎ file · 1-5 folder · Esc close`

  return (
    <div
      role="complementary"
      aria-label="Item details"
      aria-hidden={!isOpen}
      className={cn(
        'fixed top-10 bottom-0 z-10 border-l bg-surface overflow-hidden',
        'transition-[width,opacity,right] duration-200 ease-out',
        isOpen ? 'w-[380px] opacity-100 border-border' : 'w-0 opacity-0 border-transparent'
      )}
      style={{ right: isDayPanelOpen ? `${dayPanelWidth}px` : 0 }}
    >
      <div className="w-[380px] h-full flex flex-col overflow-hidden [font-synthesis:none] text-[12px] leading-4">
        {isLoading ? (
          <ContentSkeleton />
        ) : item ? (
          <>
            <DetailHeader type={item.type} createdAt={item.createdAt} onClose={onClose} />

            {/* Main Content Area */}
            <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
              <div
                ref={contentRef}
                className={cn(
                  'overflow-y-auto',
                  readOnly || item.type === 'reminder' ? 'flex-1 min-h-0' : 'shrink-0'
                )}
                style={
                  readOnly || item.type === 'reminder'
                    ? undefined
                    : manualContentHeight !== null
                      ? { height: manualContentHeight }
                      : { maxHeight: '60%' }
                }
              >
                {item.type === 'note' ? (
                  <NoteDetail
                    item={item}
                    onContentChange={readOnly ? undefined : handleContentChange}
                    onTitleChange={readOnly ? undefined : handleTitleChange}
                  />
                ) : (
                  <div
                    className={
                      item.type === 'reminder' || item.type === 'social' ? '' : 'px-5 py-4'
                    }
                  >
                    {item.type === 'voice' ? (
                      <input
                        type="text"
                        defaultValue={item.title}
                        key={item.id + item.title}
                        onBlur={(e) => handleVoiceTitleSave(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur()
                          }
                        }}
                        className="text-[15px] leading-5 font-medium text-foreground mb-3.5 w-full bg-transparent focus:outline-none border-b border-transparent focus:border-muted-foreground/20 transition-colors"
                        placeholder="Name this voice memo..."
                      />
                    ) : (
                      item.type !== 'link' &&
                      item.type !== 'image' &&
                      item.type !== 'pdf' &&
                      item.type !== 'reminder' &&
                      item.type !== 'social' && (
                        <h3 className="text-[15px] leading-5 font-medium text-foreground mb-3.5">
                          {item.title}
                        </h3>
                      )
                    )}
                    <ContentSection
                      item={item}
                      onRetryTranscription={handleRetryTranscription}
                      isRetrying={retryTranscriptionMutation.isPending}
                      onContentChange={readOnly ? undefined : handleContentChange}
                    />
                  </div>
                )}
              </div>

              {!readOnly && item.type !== 'reminder' && (
                <>
                  {/* Resize Handle */}
                  <div
                    onMouseDown={handleResizeStart}
                    className={cn(
                      'relative h-2 shrink-0 cursor-row-resize group',
                      'border-t border-border/50 bg-muted/20',
                      'hover:bg-muted/50 transition-colors',
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

                  {/* Filing Section — fills remaining space */}
                  <div className="flex-1 min-h-0 overflow-y-auto">
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
                </>
              )}
            </div>

            {/* Footer */}
            <div className="shrink-0 px-5 py-3 border-t border-border flex flex-col gap-1.5">
              {readOnly ? (
                <div className="flex items-center w-full gap-2">
                  <Button
                    variant="outline"
                    onClick={() => item && onRestore?.(item.id)}
                    className="flex-1 text-muted-foreground border-border"
                  >
                    <RotateCcw className="size-4 mr-1.5" aria-hidden="true" />
                    Restore
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => item && onDelete?.(item.id)}
                    className="flex-1 text-destructive border-destructive/30 hover:bg-destructive/10"
                  >
                    <Trash2 className="size-4 mr-1.5" aria-hidden="true" />
                    Delete
                  </Button>
                </div>
              ) : item?.type === 'reminder' ? (
                <Button
                  variant="outline"
                  onClick={handleArchive}
                  className="w-full text-muted-foreground border-border"
                >
                  <Archive className="size-4 mr-1.5" aria-hidden="true" />
                  Archive
                </Button>
              ) : (
                <>
                  <div className="flex items-center w-full gap-2">
                    <Button
                      variant="outline"
                      onClick={handleArchive}
                      className="flex-1 text-muted-foreground border-border"
                    >
                      <Archive className="size-4 mr-1.5" aria-hidden="true" />
                      Archive
                    </Button>
                    <Button
                      onClick={handleFileItem}
                      disabled={!canFile || isFilingLoading}
                      className="flex-1 bg-tint hover:bg-tint-hover text-tint-foreground border-0"
                    >
                      {isFilingLoading ? (
                        <Loader2 className="size-4 animate-spin mr-1.5" aria-hidden="true" />
                      ) : (
                        <Check className="size-4 mr-1.5" aria-hidden="true" />
                      )}
                      File
                      <kbd className="ml-2 text-[11px] opacity-60">{modifierKeyDisplay}⏎</kbd>
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground/50 text-center w-full">
                    {keyboardHint}
                  </p>
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
