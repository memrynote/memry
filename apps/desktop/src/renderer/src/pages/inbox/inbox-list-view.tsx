import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { getActiveLocale } from '@/lib/active-locale'
import { Check, Loader2, AlertCircle } from '@/lib/icons'
import { useQueryClient } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'

import { useTabs } from '@/contexts/tabs'
import { useAISettingsContext } from '@/contexts/ai-settings-context'
import { Button } from '@/components/ui/button'
import { ListView } from '@/components/list-view'
import { InboxDetailPanel } from '@/components/inbox-detail'
import { BulkActionBar, type ClusterSuggestion } from '@/components/bulk/bulk-action-bar'
import { BulkFilePanel } from '@/components/bulk/bulk-file-panel'
import { BulkTagPopover } from '@/components/bulk/bulk-tag-popover'
import { ArchiveConfirmationDialog } from '@/components/bulk/archive-confirmation-dialog'
import { EmptyState } from '@/components/empty-state/empty-state'
import { inboxService } from '@/services/inbox-service'
import { buildReminderTargetTab } from '@/lib/open-reminder-target'
import { useInboxRemindersPanel } from '@/hooks/use-inbox-reminders-panel'
import { InboxRemindersList } from '@/components/inbox/inbox-reminders-list'
import type { ReminderPanelEntry } from '@/lib/reminder-panel'
import type { InboxItemType } from '@memry/contracts/inbox-api'
import { detectClusters, getClusterKey } from '@/lib/ai-clustering'
import { cn } from '@/lib/utils'
import { isInputFocused } from '@/hooks/use-keyboard-shortcuts'
import { DENSITY_CONFIG, type DisplayDensity } from '@/hooks/use-display-density'
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
import type { FilingTarget, ImageFilingMode } from '@memry/domain-inbox'
import { toast } from 'sonner'

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']

export interface InboxListViewProps {
  className?: string
  selectedTypes: Set<InboxItemType>
  showSnoozedItems: boolean
  density?: DisplayDensity
  focusItemId?: string | null
  focusToken?: number | null
}

export function InboxListView({
  className,
  selectedTypes,
  showSnoozedItems,
  density = 'comfortable',
  focusItemId = null,
  focusToken
}: InboxListViewProps): React.JSX.Element {
  const { t } = useT('inbox')
  const queryClient = useQueryClient()
  const { openTab } = useTabs()
  const { enabled: aiEnabled } = useAISettingsContext()

  const densityConfig = DENSITY_CONFIG[density]

  // Data hooks
  const {
    items: backendItems,
    isLoading,
    error,
    refetch
  } = useInboxList({ includeSnoozed: showSnoozedItems })
  const remindersPanel = useInboxRemindersPanel()
  const fileItemMutation = useFileInboxItem()
  const _archiveItemMutation = useArchiveInboxItem()
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
  const [focusedItemIdState, setFocusedItemIdState] = useState<string | null>(null)
  const emptyStateDelayRef = useRef<number | null>(null)
  const lastConsumedFocusTokenRef = useRef<number | null>(null)
  const focusSequence = focusToken ?? null

  const isDetailPanelOpen = activeDetailItemId !== null
  const isInBulkMode = selectedItemIds.size > 0
  const selectedCount = selectedItemIds.size

  // Filtered items
  const items = useMemo(() => {
    const visibleItems = showSnoozedItems
      ? backendItems.filter((item) => item.snoozedUntil || item.type === 'reminder')
      : backendItems

    return visibleItems.filter((item) => {
      if (pendingArchiveIds.has(item.id)) return false
      if (selectedTypes.size > 0 && !selectedTypes.has(item.type)) return false
      return true
    })
  }, [backendItems, pendingArchiveIds, selectedTypes, showSnoozedItems])

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

  // Open the detail panel for an item requested from outside (e.g. calendar
  // snooze popover). Token-keyed so the same item can be re-focused after the
  // user closes the panel, and so switching tabs away and back does not
  // re-trigger after consumption.
  useEffect(() => {
    if (!focusItemId || focusSequence === null) return
    if (lastConsumedFocusTokenRef.current === focusSequence) return
    lastConsumedFocusTokenRef.current = focusSequence
    const focusTimer = window.setTimeout(() => {
      setActiveDetailItemId(focusItemId)
      setFocusedItemIdState(focusItemId)
    }, 0)
    return () => window.clearTimeout(focusTimer)
  }, [focusItemId, focusSequence])

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
    if (!aiEnabled) return null
    if (selectedItems.length === 0) return null
    const suggestion = detectClusters(selectedItems, items)
    if (!suggestion) return null
    const key = getClusterKey(suggestion)
    if (dismissedSuggestionKeys.has(key)) return null
    return suggestion
  }, [aiEnabled, selectedItems, items, dismissedSuggestionKeys])

  // === OPTIMISTIC ARCHIVE HELPER ===
  const archiveWithAnimation = useCallback(
    async (id: string, nextFocusId?: string | null): Promise<void> => {
      const targetItem = items.find((item) => item.id === id)
      if (!targetItem) return

      const willBeEmpty = items.length === 1

      setExitingItemIds((prev) => new Set(prev).add(id))

      if (activeDetailItemId === id) setActiveDetailItemId(null)

      setTimeout(() => {
        void (async () => {
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
            toast.error(t('toast.failedArchiveItem'))
          }
        })()
      }, 200)
    },
    [items, activeDetailItemId, archiveWithUndo, scheduleEmptyStateReveal, clearEmptyStateDelay, t]
  )

  // === KEYBOARD SHORTCUTS ===
  useInboxKeyboard({
    enabled: true,
    isDetailPanelOpen,
    isBulkFilePanelOpen,
    isInBulkMode,
    focusedItemId,
    items,
    onRefresh: () => refetch(),
    onArchiveFocusedItem: (itemId, nextItemId) => void archiveWithAnimation(itemId, nextItemId),
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
    (
      itemId: string,
      folderId: string,
      tags: string[],
      targets: FilingTarget[],
      imageMode?: ImageFilingMode
    ): void => {
      const filedItem = items.find((item) => item.id === itemId)
      if (!filedItem) return

      const willBeEmpty = items.length === 1
      setExitingItemIds((prev) => new Set(prev).add(itemId))

      setTimeout(() => {
        void (async () => {
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
              targets.length > 0
                ? { type: 'note' as const, targets, path: folderId }
                : { type: 'folder' as const, path: folderId }

            const result = await fileItemMutation.mutateAsync({
              itemId,
              destination,
              tags,
              ...(imageMode ? { imageMode } : {})
            })

            if (result.success) {
              void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
              if (targets.length > 0) {
                void queryClient.invalidateQueries({ queryKey: notesKeys.all })
              }
              toast.success(
                targets.length > 1
                  ? t('toast.linkedToNotes', { count: targets.length })
                  : targets.length === 1
                    ? t('toast.linkedToNote')
                    : t('toast.filedTo', { folder: folderId || t('detail.notesRoot') })
              )
              // The image is filed either way — this only explains why it is not
              // inline, so it rides after the success toast rather than replacing it.
              if (result.fellBackToLink) {
                toast.warning(t('toast.embedFellBackToLink'))
              }
            } else {
              throw new Error(result.error || t('toast.failedFile'))
            }
          } catch (error) {
            if (willBeEmpty) clearEmptyStateDelay()
            setPendingArchiveIds((prev) => {
              const next = new Set(prev)
              next.delete(itemId)
              return next
            })
            toast.error(extractErrorMessage(error, t('toast.failedFileItem')))
          }
        })()
      }, 200)
    },
    [items, fileItemMutation, queryClient, scheduleEmptyStateReveal, clearEmptyStateDelay, t]
  )

  const handleQuickFile = useCallback(
    (itemId: string, folderId: string): void => {
      const filedItem = items.find((item) => item.id === itemId)
      if (!filedItem) return

      const willBeEmpty = items.length === 1
      setExitingItemIds((prev) => new Set(prev).add(itemId))

      setTimeout(() => {
        void (async () => {
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
              void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
              toast.success(t('toast.filedTo', { folder: folderId || t('detail.notesRoot') }))
            } else {
              throw new Error(result.error || t('toast.failedFile'))
            }
          } catch (error) {
            if (willBeEmpty) clearEmptyStateDelay()
            setPendingArchiveIds((prev) => {
              const next = new Set(prev)
              next.delete(itemId)
              return next
            })
            toast.error(extractErrorMessage(error, t('toast.failedFileItem')))
          }
        })()
      }, 200)
    },
    [items, fileItemMutation, queryClient, scheduleEmptyStateReveal, clearEmptyStateDelay, t]
  )

  const handleOpenReminderEntry = useCallback(
    (entry: ReminderPanelEntry): void => {
      // Snoozed capture rows open in the inbox detail panel, like a normal click.
      if (entry.kind === 'inbox-item') {
        setActiveDetailItemId(entry.item.id)
        setFocusedItemIdState(entry.item.id)
        return
      }

      // A fired reminder row carries the inbox item id — mark it viewed on open.
      if (entry.inboxItemId) {
        void inboxService.markViewed(entry.inboxItemId)
      }

      openTab(
        buildReminderTargetTab({
          targetType: entry.nav.targetType,
          targetId: entry.nav.targetId,
          targetTitle: entry.nav.targetTitle,
          projectId: entry.nav.projectId,
          anchorId: entry.nav.anchorId,
          highlightStart: entry.nav.highlightStart,
          highlightEnd: entry.nav.highlightEnd,
          highlightText: entry.nav.highlightText,
          fallbacks: {
            note: t('reminder.noteFallback'),
            journal: t('reminder.journalFallback'),
            task: t('reminder.taskFallback')
          }
        })
      )
    },
    [openTab, t]
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

      setTimeout(() => {
        void (async () => {
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
              void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
              const snoozeDate = new Date(snoozeUntil)
              const timeString = snoozeDate.toLocaleString(getActiveLocale(), {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
              })
              toast.success(t('toast.snoozedUntil', { time: timeString }))
            } else {
              throw new Error(result.error || t('toast.failedSnooze'))
            }
          } catch (error) {
            if (willBeEmpty) clearEmptyStateDelay()
            setPendingArchiveIds((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
            toast.error(extractErrorMessage(error, t('toast.failedSnoozeItem')))
          }
        })()
      }, 200)
    },
    [items, activeDetailItemId, queryClient, scheduleEmptyStateReveal, clearEmptyStateDelay, t]
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
        const result = await window.api.inbox.bulkFile({
          itemIds,
          destination: { type: 'folder', path: folderId },
          tags
        })

        if (result.success) {
          void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
          toast.success(
            t('toast.filedItemsTo', {
              count: itemIds.length,
              folder: folderId || t('detail.notesRoot')
            })
          )
        } else if (result.errors.length > 0) {
          void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
          toast.success(
            t('toast.filedPartial', { processed: result.processedCount, total: itemIds.length })
          )
        } else {
          throw new Error(t('toast.failedFileItems'))
        }
      } catch (error) {
        setPendingArchiveIds((prev) => {
          const next = new Set(prev)
          itemIds.forEach((id) => next.delete(id))
          return next
        })
        toast.error(extractErrorMessage(error, t('toast.failedFileItems')))
      }
    },
    [queryClient, t]
  )

  const handleBulkTagApply = useCallback(
    async (tags: string[]): Promise<void> => {
      const itemIds = Array.from(selectedItemIds)
      try {
        const result = await window.api.inbox.bulkTag({ itemIds, tags })
        if (result.success || result.processedCount > 0) {
          void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
          toast.success(
            t('toast.appliedTags', { tagCount: tags.length, itemCount: result.processedCount })
          )
        } else {
          throw new Error(t('toast.failedApplyTags'))
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t('toast.failedApplyTags')))
      }
    },
    [selectedItemIds, queryClient, t]
  )

  const handleBulkArchiveConfirm = useCallback((): void => {
    const idsToArchive = Array.from(selectedItemIds)
    const willBeEmpty = items.length === idsToArchive.length

    setIsArchiveDialogOpen(false)
    setExitingItemIds(new Set(idsToArchive))

    if (activeDetailItemId && idsToArchive.includes(activeDetailItemId)) {
      setActiveDetailItemId(null)
    }

    setTimeout(() => {
      void (async () => {
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
          toast.success(t('toast.archivedItems', { count: idsToArchive.length }))
        } catch {
          if (willBeEmpty) clearEmptyStateDelay()
          setPendingArchiveIds((prev) => {
            const next = new Set(prev)
            idsToArchive.forEach((id) => next.delete(id))
            return next
          })
          toast.error(t('toast.failedArchiveItems'))
        }
      })()
    }, 200)
  }, [
    selectedItemIds,
    items,
    activeDetailItemId,
    bulkArchiveMutation,
    scheduleEmptyStateReveal,
    clearEmptyStateDelay,
    t
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

      setTimeout(() => {
        void (async () => {
          setPendingArchiveIds((prev) => {
            const next = new Set(prev)
            idsToSnooze.forEach((id) => next.add(id))
            return next
          })
          setExitingItemIds(new Set())
          setSelectedItemIds(new Set())

          if (willBeEmpty) scheduleEmptyStateReveal()

          try {
            const result = await window.api.inbox.bulkSnooze({ itemIds: idsToSnooze, snoozeUntil })
            if (result.success || result.processedCount > 0) {
              setPendingArchiveIds((prev) => {
                const next = new Set(prev)
                idsToSnooze.forEach((id) => next.delete(id))
                return next
              })
              void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
              const snoozeDate = new Date(snoozeUntil)
              const timeString = snoozeDate.toLocaleString(getActiveLocale(), {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
              })
              toast.success(
                t('toast.snoozedItemsUntil', { count: result.processedCount, time: timeString })
              )
            } else {
              throw new Error(t('toast.failedSnooze'))
            }
          } catch (error) {
            if (willBeEmpty) clearEmptyStateDelay()
            setPendingArchiveIds((prev) => {
              const next = new Set(prev)
              idsToSnooze.forEach((id) => next.delete(id))
              return next
            })
            toast.error(extractErrorMessage(error, t('toast.failedSnooze')))
          }
        })()
      }, 200)
    },
    [
      selectedItemIds,
      items,
      activeDetailItemId,
      queryClient,
      scheduleEmptyStateReveal,
      clearEmptyStateDelay,
      t
    ]
  )

  // === IMAGE CAPTURE HANDLERS ===

  const handleImageCapture = useCallback(
    async (file: File): Promise<void> => {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        toast.error(t('loading.unsupportedImageType', { type: file.type }))
        return
      }

      const MAX_SIZE = 50 * 1024 * 1024
      if (file.size > MAX_SIZE) {
        toast.error(t('loading.imageTooLarge'))
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
          toast.success(t('view.itemCaptured'))
        } else {
          throw new Error(result.error || t('toast.failedCaptureImage'))
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t('toast.failedCaptureImage')))
      } finally {
        setIsCapturingImage(false)
      }
    },
    [t]
  )

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
    const handlePasteEvent = (event: ClipboardEvent): void => {
      void handlePaste(event)
    }
    window.addEventListener('paste', handlePasteEvent)
    return () => window.removeEventListener('paste', handlePasteEvent)
  }, [handleImageCapture])

  // === RENDER ===

  return (
    <div className={cn('flex h-full overflow-hidden', className)}>
      <div
        className={cn(
          'flex flex-col flex-1 min-w-0 h-full relative',
          'px-4 lg:px-6 pb-4 lg:pb-6',
          isDraggingOver && 'ring-2 ring-primary/50 ring-inset bg-primary/5'
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(...args) => void handleDrop(...args)}
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
              <p className="text-sm font-medium text-foreground">{t('loading.dropImageTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('loading.dropImageTypes')}</p>
            </div>
          </div>
        )}

        {isCapturingImage && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="size-8 text-primary animate-spin" />
              <p className="text-sm text-muted-foreground">{t('loading.capturingImage')}</p>
            </div>
          </div>
        )}

        {/* Bulk selection header */}
        {isInBulkMode && (
          <header className={cn('relative pt-[46px]', densityConfig.headerMargin)}>
            <div className="flex items-center justify-between gap-6">
              <div className="flex items-center gap-3">
                <Check className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <span className="text-sm font-medium text-foreground">
                  {t('bulk.selected', { count: selectedCount })}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeselectAll}
                className="text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5"
              >
                {t('bulk.deselectAll')}
              </Button>
            </div>
          </header>
        )}

        {/* Content */}
        <div
          data-inbox-scroll
          className={cn(
            'flex-1 overflow-y-auto',
            !isInBulkMode && 'pt-[46px]',
            isInBulkMode && 'pb-32'
          )}
        >
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
              <Loader2 className="size-8 text-muted-foreground/50 animate-spin" />
              <p className="text-sm text-muted-foreground/60 font-serif">{t('loading.inbox')}</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
              <AlertCircle className="size-8 text-destructive/60" />
              <p className="text-sm text-destructive/80 font-serif">{t('loading.failed')}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                {t('loading.tryAgain')}
              </Button>
            </div>
          ) : showSnoozedItems ? (
            <InboxRemindersList panel={remindersPanel} onOpen={handleOpenReminderEntry} />
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
              onArchive={(...args) => void handleArchive(...args)}
              onSnooze={(...args) => void handleSnooze(...args)}
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
          onSnoozeAll={(...args) => void handleBulkSnoozeAll(...args)}
          aiSuggestion={aiSuggestion}
          onAddSuggestionToSelection={handleAddSuggestionToSelection}
          onDismissSuggestion={handleDismissSuggestion}
        />

        <BulkFilePanel
          isOpen={isBulkFilePanelOpen}
          items={selectedItems}
          onClose={() => setIsBulkFilePanelOpen(false)}
          onFile={(...args) => void handleBulkFileComplete(...args)}
        />

        <BulkTagPopover
          isOpen={isBulkTagPopoverOpen}
          itemCount={selectedCount}
          trigger={<span />}
          onOpenChange={setIsBulkTagPopoverOpen}
          onApplyTags={(...args) => void handleBulkTagApply(...args)}
        />

        <ArchiveConfirmationDialog
          isOpen={isArchiveDialogOpen}
          itemCount={selectedCount}
          onConfirm={handleBulkArchiveConfirm}
          onCancel={() => setIsArchiveDialogOpen(false)}
        />
      </div>

      <InboxDetailPanel
        isOpen={isDetailPanelOpen}
        item={activeDetailItem}
        isLoading={isDetailLoading}
        onClose={() => setActiveDetailItemId(null)}
        onFile={handleFilingComplete}
        onArchive={(...args) => void handleArchive(...args)}
      />
    </div>
  )
}
