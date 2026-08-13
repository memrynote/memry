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
import { motion, useReducedMotion } from 'motion/react'
import { Archive, Check, Loader2, GripHorizontal, RotateCcw, Trash2 } from '@/lib/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'

import { cn } from '@/lib/utils'
import { useResizablePanel } from '@/hooks/use-resizable-panel'
import { PanelResizeRail } from '@/components/ui/panel-resize-rail'

import { Button } from '@/components/ui/button'

import { ContentSection, ContentSkeleton } from './content-section'
import { DetailHeader } from './detail-header'
import { NoteDetail } from './note-detail'
import { FilingSection, useFilingState } from './filing-section'
import { ConvertActions } from './convert-actions'
import { TypeSelector } from './type-selector'
import { NOTE_ONLY_TYPES, type ConvertType } from './convert-types'
import { InboxTitleInput } from './inbox-title-input'
import { useAISettingsContext } from '@/contexts/ai-settings-context'
import { useRetryTranscription, useUpdateInboxItem } from '@/hooks/use-inbox'
import { isMac, isInputFocused } from '@/hooks/use-keyboard-shortcuts'
import type { InboxItem, InboxItemListItem, Folder } from '@/types'
import type { FilingTarget, ImageFilingMode } from '@memry/domain-inbox'
import { useInboxPreferences } from '@/hooks/use-inbox-preferences'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:InboxDetailPanel')

// Panel can work with either full or list item types
type DetailItem = InboxItem | InboxItemListItem

// Types whose title is a real, user-owned field, so the panel offers an editable
// one. Note titles come from the body's first line and are handled by NoteDetail;
// link/reminder/social titles are derived from their source and stay read-only.
const EDITABLE_TITLE_TYPES = new Set(['voice', 'image', 'pdf'])

const INBOX_DETAIL_WIDTH_KEY = 'inbox-detail-width'
const INBOX_DETAIL_WIDTH_DEFAULT_PX = 380
const INBOX_DETAIL_WIDTH_MIN_PX = 300
const INBOX_DETAIL_WIDTH_MAX_PX = 560

// =============================================================================
// Types
// =============================================================================

interface InboxDetailPanelProps {
  isOpen: boolean
  item: DetailItem | null
  isLoading?: boolean
  readOnly?: boolean
  onClose: () => void
  onFile: (
    itemId: string,
    folderId: string,
    tags: string[],
    targets: FilingTarget[],
    imageMode?: ImageFilingMode
  ) => void
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
  const { t, i18n } = useT('inbox')
  const { enabled: aiEnabled } = useAISettingsContext()
  const prefersReducedMotion = useReducedMotion()
  const {
    width,
    setWidth,
    setIsResizing: setIsPanelResizing
  } = useResizablePanel({
    storageKey: INBOX_DETAIL_WIDTH_KEY,
    defaultPx: INBOX_DETAIL_WIDTH_DEFAULT_PX,
    minPx: INBOX_DETAIL_WIDTH_MIN_PX,
    maxPx: INBOX_DETAIL_WIDTH_MAX_PX
  })
  const queryClient = useQueryClient()

  // Retry transcription mutation
  const retryTranscriptionMutation = useRetryTranscription()

  // Update item mutation for content editing
  const updateItemMutation = useUpdateInboxItem()

  // Filing state management
  const { selectedFolder, tags, linkedNotes, setSelectedFolder, setTags, setLinkedNotes, canFile } =
    useFilingState({ item, isOpen })

  // How an image lands in the notes it is linked to (#807). The prompt only
  // appears until the user answers it once; after that the stored mode is used
  // silently and only Settings → Inbox can change it.
  const { settings: inboxSettings, updateSettings: updateInboxSettings } = useInboxPreferences()
  // Null until the user touches the control, so the stored preference stays
  // authoritative — including when it arrives after the first render.
  const [imageModeOverride, setImageModeOverride] = useState<ImageFilingMode | null>(null)
  const [rememberImageMode, setRememberImageMode] = useState(false)
  const imageMode = imageModeOverride ?? inboxSettings.imageFilingMode

  const isImageItem = item?.type === 'image'
  const imageFiling = useMemo(
    () => ({
      mode: imageMode,
      onModeChange: setImageModeOverride,
      remember: rememberImageMode,
      onRememberChange: setRememberImageMode,
      askUser: !inboxSettings.imageFilingModeRemembered
    }),
    [imageMode, rememberImageMode, inboxSettings.imageFilingModeRemembered]
  )

  // Embedding needs a note to own the attachment, not a folder — so the usual
  // "pick a destination folder" gate does not apply, and linking one is what
  // makes the item filable instead.
  const isEmbeddingImage = isImageItem && imageMode === 'embed'
  const canFileItem = isEmbeddingImage ? linkedNotes.length > 0 : canFile

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
    enabled: aiEnabled && isOpen && !!item?.id,
    staleTime: 30000
  })

  // Get suggested folders for number shortcuts
  const suggestedFoldersForShortcut = useMemo(() => {
    if (aiEnabled && aiSuggestions.length > 0) {
      return aiSuggestions
        .filter((s) => s.destination.type === 'folder' && s.destination.path)
        .slice(0, 5)
        .map((s) => {
          const path = s.destination.path || ''
          return {
            id: path,
            name: path.split('/').pop() || path || t('detail.notesRoot'),
            path: path
          } as Folder
        })
    }
    return []
  }, [aiEnabled, aiSuggestions, t])

  // Loading state for filing
  const [isFilingLoading, setIsFilingLoading] = useState(false)

  // Resizable content area: null = auto-height (handle sits right after content)
  const [manualContentHeight, setManualContentHeight] = useState<number | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // What the captured item becomes: note (file to folder) / task / event / reminder.
  const [selectedType, setSelectedType] = useState<ConvertType>('note')

  // Reset manual height and selected type during render when the item changes.
  const [storedItemId, setStoredItemId] = useState(item?.id)
  if (storedItemId !== item?.id) {
    setStoredItemId(item?.id)
    setManualContentHeight(null)
    setSelectedType('note')
  }

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

  // Handle filing
  const handleFileItem = useCallback(async (): Promise<void> => {
    // No folder is picked when embedding — the attachment goes under the note.
    if (!item || (!selectedFolder && !isEmbeddingImage)) return

    setIsFilingLoading(true)

    // Track suggestion feedback if AI suggestions were available
    if (aiEnabled && aiSuggestions.length > 0) {
      const topSuggestion = aiSuggestions[0]
      const suggestedPath = topSuggestion?.destination?.path || ''

      window.api.inbox
        .trackSuggestion({
          itemId: item.id,
          itemType: item.type,
          suggestedTo: suggestedPath,
          actualTo: selectedFolder?.id ?? '',
          confidence: topSuggestion?.confidence || 0,
          suggestedTags: topSuggestion?.suggestedTags || [],
          actualTags: tags
        })
        .catch((error) => {
          log.error('Failed to track suggestion', error)
        })
    }

    // Use path for folder location - prefer path, fallback to id. Embedding hides
    // the picker, so send nothing rather than a folder the user never saw: any
    // note staged in the picker then lands in their default note folder.
    const folderPath = isEmbeddingImage ? '' : (selectedFolder?.path ?? selectedFolder?.id ?? '')

    // Answering the prompt is what persists the preference — silently after the
    // filing either way, so a failed settings write never blocks the item.
    if (imageFiling.remember) {
      void updateInboxSettings({
        imageFilingMode: imageFiling.mode,
        imageFilingModeRemembered: true
      })
    }

    onFile(
      item.id,
      folderPath,
      tags,
      // Pending notes carry a title instead of an id — they are created by the
      // filing itself, in the folder chosen above.
      linkedNotes.map((note) =>
        note.isPending
          ? ({ kind: 'new', title: note.title } as const)
          : ({ kind: 'note', noteId: note.id } as const)
      ),
      isImageItem ? imageFiling.mode : undefined
    )

    setIsFilingLoading(false)
    onClose()
  }, [
    selectedFolder,
    item,
    tags,
    linkedNotes,
    aiEnabled,
    aiSuggestions,
    imageFiling,
    isImageItem,
    isEmbeddingImage,
    updateInboxSettings,
    onFile,
    onClose
  ])

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

      // Filing shortcuts only apply to the note (file-to-folder) path.
      if (selectedType !== 'note') return

      // Cmd/Ctrl + Enter to file
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (canFileItem && item) {
          void handleFileItem()
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
  }, [
    isOpen,
    canFileItem,
    item,
    selectedType,
    suggestedFoldersForShortcut,
    setSelectedFolder,
    onClose,
    handleFileItem
  ])

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

  const handleTitleSave = useCallback(
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
  const keyboardHint = t('detail.keyboardHint', { modifier: modifierKeyDisplay })

  // Enter and exit along the same path: slide from the end edge (RTL-aware).
  // 112% clears the pane edge including the start border.
  const closedX = i18n.dir() === 'rtl' ? '-112%' : '112%'

  return (
    <motion.aside
      aria-label={t('detail.ariaLabel')}
      aria-hidden={!isOpen}
      inert={!isOpen || undefined}
      data-testid="inbox-detail-panel"
      data-state={isOpen ? 'open' : 'closed'}
      initial={false}
      animate={
        prefersReducedMotion
          ? { x: 0, opacity: isOpen ? 1 : 0 }
          : { x: isOpen ? 0 : closedX, opacity: 1 }
      }
      transition={
        prefersReducedMotion
          ? { duration: 0.2 }
          : isOpen
            ? { type: 'spring', bounce: 0.2, duration: 0.35 }
            : { type: 'spring', bounce: 0, duration: 0.3 }
      }
      className={cn(
        // ponytail: absolute (not fixed) so the drawer stays inside its own pane in split view
        // top-[38px] clears the floating page chrome so the panel header stays visible
        'absolute top-[38px] bottom-0 end-0 z-10 border-s bg-surface overflow-hidden',
        isOpen ? 'border-border' : 'border-transparent pointer-events-none'
      )}
      style={{
        width: `${width}px`
      }}
    >
      <div
        style={{ width: `${width}px` }}
        className="h-full flex flex-col overflow-hidden [font-synthesis:none] text-[12px] leading-4"
      >
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
                {/* Type-specific preview materializes on item switch (crossfade
                    only under reduced motion); the filing chrome below stays put */}
                <motion.div
                  key={item.id}
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
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
                      {EDITABLE_TITLE_TYPES.has(item.type) && !readOnly ? (
                        <InboxTitleInput
                          itemId={item.id}
                          title={item.title}
                          placeholder={
                            item.type === 'voice'
                              ? t('detail.voiceTitlePlaceholder')
                              : t('detail.titlePlaceholder')
                          }
                          onSave={handleTitleSave}
                        />
                      ) : (
                        item.type !== 'link' &&
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
                </motion.div>
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
                    aria-label={t('detail.resizeFiling')}
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

                  {/* Type selector + type-driven body — fills remaining space */}
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    {/* Note-only items (image/pdf/video/clip) have a single
                        outcome, so the selector is hidden rather than shown
                        with three dead options. */}
                    {!NOTE_ONLY_TYPES.includes(item.type) && (
                      <div className="px-5 pt-4">
                        <TypeSelector value={selectedType} onChange={setSelectedType} />
                      </div>
                    )}
                    {selectedType === 'note' ? (
                      <FilingSection
                        item={item}
                        selectedFolder={selectedFolder}
                        tags={tags}
                        linkedNotes={linkedNotes}
                        onFolderSelect={handleFolderSelect}
                        onTagsChange={setTags}
                        onLinkedNotesChange={setLinkedNotes}
                        imageFiling={item.type === 'image' ? imageFiling : undefined}
                      />
                    ) : (
                      <ConvertActions item={item} type={selectedType} onConverted={onClose} />
                    )}
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
                    className="flex-1 text-muted-foreground border-border transition-all duration-150 ease-out active:scale-[0.98]"
                  >
                    <RotateCcw className="size-4 me-1.5" aria-hidden="true" />
                    {t('detail.restore')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => item && onDelete?.(item.id)}
                    className="flex-1 text-destructive border-destructive/30 hover:bg-destructive/10 transition-all duration-150 ease-out active:scale-[0.98]"
                  >
                    <Trash2 className="size-4 me-1.5" aria-hidden="true" />
                    {t('detail.delete')}
                  </Button>
                </div>
              ) : item?.type === 'reminder' ? (
                <Button
                  variant="outline"
                  onClick={handleArchive}
                  className="w-full text-muted-foreground border-border transition-all duration-150 ease-out active:scale-[0.98]"
                >
                  <Archive className="size-4 me-1.5" aria-hidden="true" />
                  {t('detail.archive')}
                </Button>
              ) : (
                <>
                  <div className="flex items-center w-full gap-2">
                    <Button
                      variant="outline"
                      onClick={handleArchive}
                      className="flex-1 text-muted-foreground border-border transition-all duration-150 ease-out active:scale-[0.98]"
                    >
                      <Archive className="size-4 me-1.5" aria-hidden="true" />
                      {t('detail.archive')}
                    </Button>
                    {selectedType === 'note' && (
                      <Button
                        onClick={() => void handleFileItem()}
                        disabled={!canFileItem || isFilingLoading}
                        className="flex-1 bg-tint hover:bg-tint-hover text-tint-foreground border-0 transition-all duration-150 ease-out active:scale-[0.98] disabled:active:scale-100"
                      >
                        {isFilingLoading ? (
                          <Loader2 className="size-4 animate-spin me-1.5" aria-hidden="true" />
                        ) : (
                          <Check className="size-4 me-1.5" aria-hidden="true" />
                        )}
                        {t('detail.file')}
                        <kbd className="ms-2 text-[11px] opacity-60">{modifierKeyDisplay}⏎</kbd>
                      </Button>
                    )}
                  </div>
                  {selectedType === 'note' && (
                    <p className="text-[10px] text-muted-foreground/50 text-center w-full">
                      {keyboardHint}
                    </p>
                  )}
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
      {isOpen && (
        <PanelResizeRail
          width={width}
          setWidth={setWidth}
          setIsResizing={setIsPanelResizing}
          minPx={INBOX_DETAIL_WIDTH_MIN_PX}
          maxPx={INBOX_DETAIL_WIDTH_MAX_PX}
          defaultPx={INBOX_DETAIL_WIDTH_DEFAULT_PX}
          ariaLabel={t('detail.resize')}
        />
      )}
    </motion.aside>
  )
}
