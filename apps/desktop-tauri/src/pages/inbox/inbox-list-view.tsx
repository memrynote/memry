import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { Check, Loader2, AlertCircle } from '@/lib/icons'
import { useQueryClient } from '@tanstack/react-query'

import { useTabs } from '@/contexts/tabs'
import { Button } from '@/components/ui/button'
import { ListView } from '@/components/list-view'
import { InboxDetailPanel } from '@/components/inbox-detail'
import { BulkActionBar, type ClusterSuggestion } from '@/components/bulk/bulk-action-bar'
import { BulkFilePanel } from '@/components/bulk/bulk-file-panel'
import { BulkTagPopover } from '@/components/bulk/bulk-tag-popover'
import { ArchiveConfirmationDialog } from '@/components/bulk/archive-confirmation-dialog'
import { EmptyState } from '@/components/empty-state/empty-state'
import { KeyboardShortcutsModal } from '@/components/keyboard-shortcuts-modal'
import { inboxService } from '@/services/inbox-service'
import { invoke } from '@/lib/ipc/invoke'
import type { ReminderMetadata, InboxItemType } from '@memry/contracts/inbox-api'
import { detectClusters, getClusterKey } from '@/lib/ai-clustering'
import { cn } from '@/lib/utils'
import { isInputFocused } from '@/hooks/use-keyboard-shortcuts'
import { DENSITY_CONFIG } from '@/hooks/use-display-density'
import {
  useInboxList,
  useInboxItem,
  useArchiveInboxItem,
  useBulkArchiveInboxItems,
  useFileInboxItem,
  useInboxStats,
  inboxKeys
} from '@/hooks/use-inbox'
import { useUndoableAction } from '@/hooks/use-undoable-action'
import { notesKeys } from '@/hooks/use-notes-query'
import { useInboxKeyboard } from '@/hooks/use-inbox-keyboard'
import { toast } from 'sonner'

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']

export interface InboxListViewProps {
  className?: string
  selectedTypes: Set<InboxItemType>
  showSnoozedItems: boolean
}

export function InboxListView({
  className,
  selectedTypes,
  showSnoozedItems
}: InboxListViewProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const { openTab } = useTabs()

  const density = 'compact'
  const densityConfig = DENSITY_CONFIG.compact

  // Data hooks
  const {
    items: backendItems,
    isLoading,
    error,
    refetch
  } = useInboxList({ includeSnoozed: showSnoozedItems })
  const fileItemMutation = useFileInboxItem()
  const archiveItemMutation = useArchiveInboxItem()
  const bulkArchiveMutation = useBulkArchiveInboxItems()
  const { archiveWithUndo } = useUndoableAction()
  const [pendingArchiveIds, setPendingArchiveIds] = useState<Set<string>>(new Set())
  const [exitingItemIds, setExitingItemIds] = useState<Set<string>>(new Set())
  const [isEmptyStateExiting, setIsEmptyStateExiting] = useState(false)
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [isCapturingImage, setIsCapturingImage] = useState(false)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [dismissedSuggestionKeys, setDismissedSuggestionKeys] = useState<Set<string>>(new Set())
  const [activeDetailItemId, setActiveDetailItemId] = useState<string | null>(null)
  const [isBulkFilePanelOpen, setIsBulkFilePanelOpen] = useState(false)
  const [isBulkTagPopoverOpen, setIsBulkTagPopoverOpen] = useState(false)
  const [isArchiveDialogOpen, setIsArchiveDialogOpen] = useState(false)
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState(false)
  const [focusedItemIdState, setFocusedItemIdState] = useState<string | null>(null)
  const emptyStateDelayRef = useRef<number | null>(null)

  const isDetailPanelOpen = activeDetailItemId !== null
  const isInBulkMode = selectedItemIds.size > 0
  const selectedCount = selectedItemIds.size

  // Filtered items
  const items = useMemo(() => {
    return backendItems.filter((item) => {
      if (pendingArchiveIds.has(item.id)) return false
      if (selectedTypes.size > 0 && !selectedTypes.has(item.type)) return false
      return true
    })
  }, [backendItems, pendingArchiveIds, selectedTypes])

  // Empty state data
  const { stats: inboxStats } = useInboxStats()
  const itemsProcessedToday = inboxStats?.processedToday ?? 0
  const processedThisWeek = inboxStats?.processedThisWeek ?? 0
  const currentStreak = inboxStats?.currentStreak ?? 0
  const showEmptyState = !isLoading && items.length === 0 && !isEmptyStateExiting
  const focusedItemId = items.some((item) => item.id === focusedItemIdState)
    ? focusedItemIdState
    : (items[0]?.id ?? null)

  const clearEmptyStateDelay = useCallback(() => {
    if (emptyStateDelayRef.current !== null) {
      window.clearTimeout(emptyStateDelayRef.current)
      emptyStateDelayRef.current = null
    }
    setIsEmptyStateExiting(false)
  }, [])

  const scheduleEmptyStateReveal = useCallback(() => {
    clearEmptyStateDelay()
    setIsEmptyStateExiting(true)
    emptyStateDelayRef.current = window.setTimeout(() => {
      emptyStateDelayRef.current = null
      setIsEmptyStateExiting(false)
    }, 200)
  }, [clearEmptyStateDelay])

  useEffect(() => clearEmptyStateDelay, [clearEmptyStateDelay])

  // Computed values
  const selectedItems = useMemo(
    () => items.filter((item) => selectedItemIds.has(item.id)),
    [items, selectedItemIds]
  )

  const { item: fullDetailItem, isLoading: isDetailLoading } = useInboxItem(activeDetailItemId)

  const activeDetailItem = useMemo(() => {
    if (!activeDetailItemId) return null
    if (fullDetailItem) return fullDetailItem
    return items.find((item) => item.id === activeDetailItemId) || null
  }, [activeDetailItemId, fullDetailItem, items])

  const aiSuggestion = useMemo((): ClusterSuggestion | null => {
    if (selectedItems.length === 0) return null
    const suggestion = detectClusters(selectedItems, items)
    if (!suggestion) return null
    const key = getClusterKey(suggestion)
    if (dismissedSuggestionKeys.has(key)) return null
    return suggestion
  }, [selectedItems, items, dismissedSuggestionKeys])

  // === OPTIMISTIC ARCHIVE HELPER ===
  const archiveWithAnimation = useCallback(
    async (id: string, nextFocusId?: string | null): Promise<void> => {
      const targetItem = items.find((item) => item.id === id)
      if (!targetItem) return

      const willBeEmpty = items.length === 1

      setExitingItemIds((prev) => new Set(prev).add(id))

      if (activeDetailItemId === id) setActiveDetailItemId(null)

      setTimeout(async () => {
        setPendingArchiveIds((prev) => new Set(prev).add(id))
        setExitingItemIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        setSelectedItemIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })

        if (nextFocusId !== undefined) setFocusedItemIdState(nextFocusId)

        if (willBeEmpty) scheduleEmptyStateReveal()

        try {
          await archiveWithUndo(id, targetItem.title)
        } catch {
          if (willBeEmpty) clearEmptyStateDelay()
          setPendingArchiveIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          toast.error('Failed to archive item')
        }
      }, 200)
    },
    [items, activeDetailItemId, archiveWithUndo, scheduleEmptyStateReveal, clearEmptyStateDelay]
  )

  // === KEYBOARD SHORTCUTS ===
  useInboxKeyboard({
    enabled: true,
    isShortcutsModalOpen,
    isDetailPanelOpen,
    isBulkFilePanelOpen,
    isInBulkMode,
    focusedItemId,
    items,
    onOpenShortcutsModal: () => setIsShortcutsModalOpen(true),
    onRefresh: () => refetch(),
    onArchiveFocusedItem: (itemId, nextItemId) => archiveWithAnimation(itemId, nextItemId),
    onOpenBulkArchiveDialog: () => setIsArchiveDialogOpen(true),
    onOpenSourceUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer')
  })

  // === HANDLERS ===

  const handleSelectionChange = useCallback((newSelection: Set<string>): void => {
    setSelectedItemIds(newSelection)
  }, [])

  const handleDeselectAll = useCallback((): void => {
    setSelectedItemIds(new Set())
  }, [])

  const handleFilingComplete = useCallback(
    (itemId: string, folderId: string, tags: string[], linkedNoteIds: string[]): void => {
      const filedItem = items.find((item) => item.id === itemId)
      if (!filedItem) return

      const willBeEmpty = items.length === 1
      setExitingItemIds((prev) => new Set(prev).add(itemId))

      setTimeout(async () => {
        setPendingArchiveIds((prev) => new Set(prev).add(itemId))
        setExitingItemIds((prev) => {
          const next = new Set(prev)
          next.delete(itemId)
          return next
        })
        setSelectedItemIds((prev) => {
          const next = new Set(prev)
          next.delete(itemId)
          return next
        })

        if (willBeEmpty) scheduleEmptyStateReveal()

        try {
          const destination =
            linkedNoteIds.length > 0
              ? { type: 'note' as const, noteIds: linkedNoteIds, path: folderId }
              : { type: 'folder' as const, path: folderId }

          const result = await fileItemMutation.mutateAsync({ itemId, destination, tags })

          if (result.success) {
            queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
            if (linkedNoteIds.length > 0) {
              linkedNoteIds.forEach((noteId) => {
                queryClient.invalidateQueries({ queryKey: notesKeys.note(noteId) })
              })
            }
            toast.success(
              linkedNoteIds.length > 1
                ? `Linked to ${linkedNoteIds.length} notes`
                : linkedNoteIds.length === 1
                  ? 'Linked to note'
                  : `Filed to ${folderId || 'Notes'}`
            )
          } else {
            throw new Error(result.error || 'Failed to file')
          }
        } catch (error) {
          if (willBeEmpty) clearEmptyStateDelay()
          setPendingArchiveIds((prev) => {
            const next = new Set(prev)
            next.delete(itemId)
            return next
          })
          toast.error(extractErrorMessage(error, 'Failed to file item'))
        }
      }, 200)
    },
    [items, fileItemMutation, queryClient, scheduleEmptyStateReveal, clearEmptyStateDelay]
  )

  const handleQuickFile = useCallback(
    (itemId: string, folderId: string): void => {
      const filedItem = items.find((item) => item.id === itemId)
      if (!filedItem) return

      const willBeEmpty = items.length === 1
      setExitingItemIds((prev) => new Set(prev).add(itemId))

      setTimeout(async () => {
        setPendingArchiveIds((prev) => new Set(prev).add(itemId))
        setExitingItemIds((prev) => {
          const next = new Set(prev)
          next.delete(itemId)
          return next
        })
        setSelectedItemIds((prev) => {
          const next = new Set(prev)
          next.delete(itemId)
          return next
        })

        if (willBeEmpty) scheduleEmptyStateReveal()

        try {
          const result = await fileItemMutation.mutateAsync({
            itemId,
            destination: { type: 'folder', path: folderId },
            tags: []
          })

          if (result.success) {
            queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
            toast.success(`Filed to ${folderId || 'Notes'}`)
          } else {
            throw new Error(result.error || 'Failed to file')
          }
        } catch (error) {
          if (willBeEmpty) clearEmptyStateDelay()
          setPendingArchiveIds((prev) => {
            const next = new Set(prev)
            next.delete(itemId)
            return next
          })
          toast.error(extractErrorMessage(error, 'Failed to file item'))
        }
      }, 200)
    },
    [items, fileItemMutation, queryClient, scheduleEmptyStateReveal, clearEmptyStateDelay]
  )

  const openReminderTarget = useCallback(
    async (item: (typeof items)[0]): Promise<void> => {
      const metadata = item.metadata as ReminderMetadata | undefined
      if (!metadata) return

      await inboxService.markViewed(item.id)

      switch (metadata.targetType) {
        case 'note':
        case 'highlight':
          openTab({
            type: 'note',
            title: metadata.targetTitle || 'Note',
            icon: 'file-text',
            path: `/notes/${metadata.targetId}`,
            entityId: metadata.targetId,
            isPinned: false,
            isModified: false,
            isPreview: true,
            isDeleted: false,
            viewState:
              metadata.targetType === 'highlight'
                ? {
                    highlightStart: metadata.highlightStart,
                    highlightEnd: metadata.highlightEnd,
                    highlightText: metadata.highlightText
                  }
                : undefined
          })
          break
        case 'journal':
          openTab({
            type: 'journal',
            title: 'Journal',
            icon: 'book-open',
            path: '/journal',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false,
            viewState: { date: metadata.targetId }
          })
          break
      }
    },
    [openTab]
  )

  const handlePreview = useCallback(
    (id: string): void => {
      const item = items.find((i) => i.id === id)
      if (!item) return

      if (isDetailPanelOpen && activeDetailItemId === id) {
        setActiveDetailItemId(null)
      } else {
        setActiveDetailItemId(id)
        setFocusedItemIdState(id)
      }
    },
    [isDetailPanelOpen, activeDetailItemId, items]
  )

  const handleFocusedItemChange = useCallback(
    (id: string | null): void => {
      setFocusedItemIdState(id)
      if (isDetailPanelOpen && id) setActiveDetailItemId(id)
    },
    [isDetailPanelOpen]
  )

  const handleArchive = useCallback(
    async (id: string): Promise<void> => {
      await archiveWithAnimation(id)
    },
    [archiveWithAnimation]
  )

  const handleSnooze = useCallback(
    async (id: string, snoozeUntil: string): Promise<void> => {
      const snoozedItem = items.find((item) => item.id === id)
      if (!snoozedItem) return

      const willBeEmpty = items.length === 1
      setExitingItemIds((prev) => new Set(prev).add(id))

      if (activeDetailItemId === id) setActiveDetailItemId(null)

      setTimeout(async () => {
        setPendingArchiveIds((prev) => new Set(prev).add(id))
        setExitingItemIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        setSelectedItemIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })

        if (willBeEmpty) scheduleEmptyStateReveal()

        try {
          const result = await inboxService.snooze({ itemId: id, snoozeUntil })
          if (result.success) {
            setPendingArchiveIds((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
            queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
            const snoozeDate = new Date(snoozeUntil)
            const timeString = snoozeDate.toLocaleString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            })
            toast.success(`Snoozed until ${timeString}`)
          } else {
            throw new Error(result.error || 'Failed to snooze')
          }
        } catch (error) {
          if (willBeEmpty) clearEmptyStateDelay()
          setPendingArchiveIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          toast.error(extractErrorMessage(error, 'Failed to snooze item'))
        }
      }, 200)
    },
    [items, activeDetailItemId, queryClient, scheduleEmptyStateReveal, clearEmptyStateDelay]
  )

  // === BULK HANDLERS ===

  const handleBulkFileComplete = useCallback(
    async (itemIds: string[], folderId: string, tags: string[]): Promise<void> => {
      setPendingArchiveIds((prev) => {
        const next = new Set(prev)
        itemIds.forEach((id) => next.add(id))
        return next
      })
      setSelectedItemIds(new Set())

      try {
        const result = await invoke<{
          success: boolean
          processedCount: number
          errors: Array<{ itemId: string; error: string }>
        }>('inbox_bulk_file', {
          itemIds,
          destination: { type: 'folder', path: folderId },
          tags
        })

        if (result.success) {
          queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
          toast.success(`Filed ${itemIds.length} items to ${folderId || 'Notes'}`)
        } else if (result.errors.length > 0) {
          queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
          toast.success(`Filed ${result.processedCount} of ${itemIds.length} items`)
        } else {
          throw new Error('Failed to file items')
        }
      } catch (error) {
        setPendingArchiveIds((prev) => {
          const next = new Set(prev)
          itemIds.forEach((id) => next.delete(id))
          return next
        })
        toast.error(extractErrorMessage(error, 'Failed to file items'))
      }
    },
    [queryClient]
  )

  const handleBulkTagApply = useCallback(
    async (tags: string[]): Promise<void> => {
      const itemIds = Array.from(selectedItemIds)
      try {
        const result = await invoke<{ success: boolean; processedCount: number }>(
          'inbox_bulk_tag',
          { itemIds, tags }
        )
        if (result.success || result.processedCount > 0) {
          queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
          toast.success(
            `Applied ${tags.length} tag${tags.length !== 1 ? 's' : ''} to ${result.processedCount} item${result.processedCount !== 1 ? 's' : ''}`
          )
        } else {
          throw new Error('Failed to apply tags')
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, 'Failed to apply tags'))
      }
    },
    [selectedItemIds, queryClient]
  )

  const handleBulkArchiveConfirm = useCallback((): void => {
    const idsToArchive = Array.from(selectedItemIds)
    const willBeEmpty = items.length === idsToArchive.length

    setIsArchiveDialogOpen(false)
    setExitingItemIds(new Set(idsToArchive))

    if (activeDetailItemId && idsToArchive.includes(activeDetailItemId)) {
      setActiveDetailItemId(null)
    }

    setTimeout(async () => {
      setPendingArchiveIds((prev) => {
        const next = new Set(prev)
        idsToArchive.forEach((id) => next.add(id))
        return next
      })
      setExitingItemIds(new Set())
      setSelectedItemIds(new Set())

      if (willBeEmpty) scheduleEmptyStateReveal()

      try {
        await bulkArchiveMutation.mutateAsync({ itemIds: idsToArchive })
        toast.success(`Archived ${idsToArchive.length} item${idsToArchive.length !== 1 ? 's' : ''}`)
      } catch {
        if (willBeEmpty) clearEmptyStateDelay()
        setPendingArchiveIds((prev) => {
          const next = new Set(prev)
          idsToArchive.forEach((id) => next.delete(id))
          return next
        })
        toast.error('Failed to archive items')
      }
    }, 200)
  }, [
    selectedItemIds,
    items,
    activeDetailItemId,
    bulkArchiveMutation,
    scheduleEmptyStateReveal,
    clearEmptyStateDelay
  ])

  const handleAddSuggestionToSelection = useCallback((): void => {
    if (!aiSuggestion) return
    const newSelection = new Set(selectedItemIds)
    aiSuggestion.items.forEach((item) => newSelection.add(item.id))
    setSelectedItemIds(newSelection)
  }, [aiSuggestion, selectedItemIds])

  const handleDismissSuggestion = useCallback((): void => {
    if (!aiSuggestion) return
    const key = getClusterKey(aiSuggestion)
    setDismissedSuggestionKeys((prev) => new Set(prev).add(key))
  }, [aiSuggestion])

  const handleBulkSnoozeAll = useCallback(
    async (snoozeUntil: string): Promise<void> => {
      const idsToSnooze = Array.from(selectedItemIds)
      if (idsToSnooze.length === 0) return

      const willBeEmpty = items.length === idsToSnooze.length
      setExitingItemIds(new Set(idsToSnooze))

      if (activeDetailItemId && idsToSnooze.includes(activeDetailItemId)) {
        setActiveDetailItemId(null)
      }

      setTimeout(async () => {
        setPendingArchiveIds((prev) => {
          const next = new Set(prev)
          idsToSnooze.forEach((id) => next.add(id))
          return next
        })
        setExitingItemIds(new Set())
        setSelectedItemIds(new Set())

        if (willBeEmpty) scheduleEmptyStateReveal()

        try {
          const result = await invoke<{ success: boolean; processedCount: number }>(
            'inbox_bulk_snooze',
            { itemIds: idsToSnooze, snoozeUntil }
          )
          if (result.success || result.processedCount > 0) {
            setPendingArchiveIds((prev) => {
              const next = new Set(prev)
              idsToSnooze.forEach((id) => next.delete(id))
              return next
            })
            queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
            const snoozeDate = new Date(snoozeUntil)
            const timeString = snoozeDate.toLocaleString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            })
            toast.success(
              `Snoozed ${result.processedCount} item${result.processedCount !== 1 ? 's' : ''} until ${timeString}`
            )
          } else {
            throw new Error('Failed to snooze items')
          }
        } catch (error) {
          if (willBeEmpty) clearEmptyStateDelay()
          setPendingArchiveIds((prev) => {
            const next = new Set(prev)
            idsToSnooze.forEach((id) => next.delete(id))
            return next
          })
          toast.error(extractErrorMessage(error, 'Failed to snooze items'))
        }
      }, 200)
    },
    [
      selectedItemIds,
      items,
      activeDetailItemId,
      queryClient,
      scheduleEmptyStateReveal,
      clearEmptyStateDelay
    ]
  )

  // === IMAGE CAPTURE HANDLERS ===

  const handleImageCapture = useCallback(async (file: File): Promise<void> => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      toast.error(`Unsupported image type: ${file.type}`)
      return
    }

    const MAX_SIZE = 50 * 1024 * 1024
    if (file.size > MAX_SIZE) {
      toast.error('Image too large (max 50MB)')
      return
    }

    setIsCapturingImage(true)
    try {
      const arrayBuffer = await file.arrayBuffer()
      const result = await inboxService.captureImage({
        data: arrayBuffer,
        filename: file.name,
        mimeType: file.type
      })
      if (result.success) {
        toast.success('Image captured')
      } else {
        throw new Error(result.error || 'Failed to capture image')
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, 'Failed to capture image'))
    } finally {
      setIsCapturingImage(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true)
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX
    const y = e.clientY
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
      setIsDraggingOver(false)
    }
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent): Promise<void> => {
      e.preventDefault()
      e.stopPropagation()
      setIsDraggingOver(false)
      const files = Array.from(e.dataTransfer.files)
      const imageFiles = files.filter((file) => file.type.startsWith('image/'))
      if (imageFiles.length === 0) return
      for (const file of imageFiles) {
        await handleImageCapture(file)
      }
    },
    [handleImageCapture]
  )

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent): Promise<void> => {
      if (isInputFocused()) return
      const clipItems = e.clipboardData?.items
      if (!clipItems) return
      for (const item of Array.from(clipItems)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (file) await handleImageCapture(file)
          return
        }
      }
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [handleImageCapture])

  // === RENDER ===

  return (
    <div className={cn('flex h-full overflow-hidden', className)}>
      <div
        className={cn(
          'flex flex-col flex-1 min-w-0 h-full relative',
          'px-4 lg:px-6 pt-3 pb-4 lg:pb-6',
          isDraggingOver && 'ring-2 ring-primary/50 ring-inset bg-primary/5'
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDraggingOver && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-dashed border-primary/50 bg-background/90">
              <div className="size-12 rounded-full bg-primary/10 flex items-center justify-center">
                <svg
                  className="size-6 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              </div>
              <p className="text-sm font-medium text-foreground">Drop image to capture</p>
              <p className="text-xs text-muted-foreground">PNG, JPEG, GIF, WebP, SVG</p>
            </div>
          </div>
        )}

        {isCapturingImage && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="size-8 text-primary animate-spin" />
              <p className="text-sm text-muted-foreground">Capturing image...</p>
            </div>
          </div>
        )}

        {/* Bulk selection header */}
        {isInBulkMode && (
          <header className={cn('relative', densityConfig.headerMargin)}>
            <div className="flex items-center justify-between gap-6">
              <div className="flex items-center gap-3">
                <Check className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <span className="text-sm font-medium text-foreground">
                  {selectedCount} selected
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeselectAll}
                className="text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5"
              >
                Deselect all
              </Button>
            </div>
          </header>
        )}

        {/* Content */}
        <div className={cn('flex-1 overflow-y-auto', isInBulkMode && 'pb-32')}>
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
              <Loader2 className="size-8 text-muted-foreground/50 animate-spin" />
              <p className="text-sm text-muted-foreground/60 font-serif">Loading inbox...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
              <AlertCircle className="size-8 text-destructive/60" />
              <p className="text-sm text-destructive/80 font-serif">Failed to load inbox</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Try again
              </Button>
            </div>
          ) : showEmptyState ? (
            <EmptyState
              itemsProcessedToday={itemsProcessedToday}
              processedThisWeek={processedThisWeek}
              currentStreak={currentStreak}
              isExiting={isEmptyStateExiting}
            />
          ) : (
            <ListView
              items={items}
              selectedItemIds={selectedItemIds}
              exitingItemIds={exitingItemIds}
              density={density}
              onPreview={handlePreview}
              onArchive={handleArchive}
              onSnooze={handleSnooze}
              onQuickFile={handleQuickFile}
              onSelectionChange={handleSelectionChange}
              focusedItemId={focusedItemId}
              onFocusedItemChange={handleFocusedItemChange}
              isPreviewOpen={isDetailPanelOpen}
            />
          )}
        </div>

        {/* Bulk & Detail components */}
        <BulkActionBar
          selectedCount={selectedCount}
          onFileAll={() => setIsBulkFilePanelOpen(true)}
          onTagAll={() => setIsBulkTagPopoverOpen(true)}
          onArchiveAll={() => setIsArchiveDialogOpen(true)}
          onSnoozeAll={handleBulkSnoozeAll}
          aiSuggestion={aiSuggestion}
          onAddSuggestionToSelection={handleAddSuggestionToSelection}
          onDismissSuggestion={handleDismissSuggestion}
        />

        <BulkFilePanel
          isOpen={isBulkFilePanelOpen}
          items={selectedItems}
          onClose={() => setIsBulkFilePanelOpen(false)}
          onFile={handleBulkFileComplete}
        />

        <BulkTagPopover
          isOpen={isBulkTagPopoverOpen}
          itemCount={selectedCount}
          trigger={<span />}
          onOpenChange={setIsBulkTagPopoverOpen}
          onApplyTags={handleBulkTagApply}
        />

        <ArchiveConfirmationDialog
          isOpen={isArchiveDialogOpen}
          itemCount={selectedCount}
          onConfirm={handleBulkArchiveConfirm}
          onCancel={() => setIsArchiveDialogOpen(false)}
        />

        <KeyboardShortcutsModal
          isOpen={isShortcutsModalOpen}
          onClose={() => setIsShortcutsModalOpen(false)}
        />
      </div>

      <InboxDetailPanel
        isOpen={isDetailPanelOpen}
        item={activeDetailItem}
        isLoading={isDetailLoading}
        onClose={() => setActiveDetailItemId(null)}
        onFile={handleFilingComplete}
        onArchive={handleArchive}
      />
    </div>
  )
}
