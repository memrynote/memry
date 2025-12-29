/**
 * Inbox Page - Contemplative Editorial Design
 * Consistent with Journal page aesthetic
 * A refined, warm interface for processing incoming items
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import { List, Grid, Check, Loader2, AlertCircle, Archive, Clock } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ToastContainer, type Toast } from '@/components/ui/toast'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { ListView } from '@/components/list-view'
import { CardView } from '@/components/card-view'
import { FilingPanel } from '@/components/filing/filing-panel'
import { PreviewPanel } from '@/components/preview/preview-panel'
import { BulkActionBar, type ClusterSuggestion } from '@/components/bulk/bulk-action-bar'
import { BulkFilePanel } from '@/components/bulk/bulk-file-panel'
import { BulkTagPopover } from '@/components/bulk/bulk-tag-popover'
import { DeleteConfirmationDialog } from '@/components/bulk/delete-confirmation-dialog'
import { EmptyState } from '@/components/empty-state/empty-state'
import { KeyboardShortcutsModal } from '@/components/keyboard-shortcuts-modal'
import { SRAnnouncer } from '@/components/sr-announcer'
import { CaptureInput } from '@/components/capture-input'
import { inboxService, onInboxSnoozeDue } from '@/services/inbox-service'
import { detectClusters, getClusterKey } from '@/lib/ai-clustering'
import { getStaleItems, getNonStaleItems } from '@/lib/stale-utils'
import { cn } from '@/lib/utils'
import { isInputFocused } from '@/hooks/use-keyboard-shortcuts'
import {
  useInboxList,
  useInboxItem,
  useDeleteInboxItem,
  useBulkDeleteInboxItems,
  useFileInboxItem,
  inboxKeys
} from '@/hooks/use-inbox'
import type { InboxItemListItem } from '@/types'

type ViewMode = 'list' | 'card'

// Type alias for list items used throughout the page
type ListItem = InboxItemListItem

interface InboxPageProps {
  className?: string
}

export function InboxPage({ className }: InboxPageProps): React.JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [showFiledItems, setShowFiledItems] = useState(false)
  const [showSnoozedItems, setShowSnoozedItems] = useState(false)
  const queryClient = useQueryClient()

  // Backend data hooks
  const {
    items: backendItems,
    isLoading,
    error,
    refetch
  } = useInboxList({
    includeFiled: showFiledItems,
    includeSnoozed: showSnoozedItems
  })

  // File mutation
  const fileItemMutation = useFileInboxItem()

  // Delete mutations
  const deleteItemMutation = useDeleteInboxItem()
  const bulkDeleteMutation = useBulkDeleteInboxItems()

  // Local state for optimistic UI (items pending deletion animation)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set())

  // Combine backend items with pending deletions for optimistic UI
  const items = useMemo(() => {
    return backendItems.filter((item) => !pendingDeleteIds.has(item.id))
  }, [backendItems, pendingDeleteIds])

  // Empty state tracking
  const [itemsProcessedToday, setItemsProcessedToday] = useState(0)
  // Simulated filing history - in a real app, this would come from persisted data
  const [hasFilingHistory, setHasFilingHistory] = useState(false)

  // Animation states for transitions
  const [exitingItemIds, setExitingItemIds] = useState<Set<string>>(new Set())
  const [isEmptyStateExiting, _setIsEmptyStateExiting] = useState(false)
  const [showEmptyState, setShowEmptyState] = useState(false)

  // Drag-drop state for image capture
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [isCapturingImage, setIsCapturingImage] = useState(false)

  // Sync empty state with actual items (after loading completes)
  useEffect(() => {
    if (!isLoading) {
      setShowEmptyState(items.length === 0)
    }
  }, [items.length, isLoading])

  // Selection state for bulk mode
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [dismissedSuggestionKeys, setDismissedSuggestionKeys] = useState<Set<string>>(new Set())

  // Filing panel state
  const [isFilingPanelOpen, setIsFilingPanelOpen] = useState(false)
  const [activeItemForFiling, setActiveItemForFiling] = useState<ListItem | null>(null)

  // Preview panel state
  const [isPreviewPanelOpen, setIsPreviewPanelOpen] = useState(false)
  const [previewingItemId, setPreviewingItemId] = useState<string | null>(null)

  // Bulk action panel states
  const [isBulkFilePanelOpen, setIsBulkFilePanelOpen] = useState(false)
  const [isBulkTagPopoverOpen, setIsBulkTagPopoverOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)

  // Keyboard shortcuts modal state
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState(false)

  // Focused item state (shared between views for preview navigation)
  const [focusedItemId, setFocusedItemId] = useState<string | null>(items[0]?.id || null)

  // Computed values
  const isInBulkMode = selectedItemIds.size > 0
  const selectedCount = selectedItemIds.size

  // Get selected items for bulk operations
  const selectedItems = useMemo(() => {
    return items.filter((item) => selectedItemIds.has(item.id))
  }, [items, selectedItemIds])

  // Fetch full item data for preview (includes attachmentUrl, transcription, etc.)
  const { item: fullPreviewItem, isLoading: isPreviewLoading } = useInboxItem(previewingItemId)

  // Get the item being previewed - prefer full item data when available
  const previewingItem = useMemo(() => {
    if (!previewingItemId) return null
    // Use full item if loaded, fallback to list item for immediate display
    if (fullPreviewItem) return fullPreviewItem
    return items.find((item) => item.id === previewingItemId) || null
  }, [previewingItemId, fullPreviewItem, items])

  // AI clustering suggestion
  const aiSuggestion = useMemo((): ClusterSuggestion | null => {
    if (selectedItems.length === 0) return null

    const suggestion = detectClusters(selectedItems, items)
    if (!suggestion) return null

    // Check if this suggestion has been dismissed
    const key = getClusterKey(suggestion)
    if (dismissedSuggestionKeys.has(key)) return null

    return suggestion
  }, [selectedItems, items, dismissedSuggestionKeys])

  // Separate items into stale and non-stale
  const staleItems = useMemo(() => getStaleItems(items), [items])
  const nonStaleItems = useMemo(() => getNonStaleItems(items), [items])

  // Generate unique toast ID
  const generateToastId = (): string => {
    return `toast-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
  }

  // Add a toast notification
  const addToast = useCallback((toast: Omit<Toast, 'id'>): string => {
    const id = generateToastId()
    setToasts((prev) => [...prev, { ...toast, id }])
    return id
  }, [])

  // Remove a toast notification
  const removeToast = useCallback((id: string): void => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  // Subscribe to snooze due events (items becoming active again)
  useEffect(() => {
    const unsubscribe = onInboxSnoozeDue((event) => {
      const { items: dueItems } = event
      if (dueItems.length > 0) {
        // Refresh the inbox list
        queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })

        // Show desktop notification
        if ('Notification' in window && Notification.permission === 'granted') {
          const count = dueItems.length
          const title = count === 1 ? dueItems[0].title : `${count} snoozed items`
          const body =
            count === 1 ? 'Your snoozed item is ready for review' : 'Your snoozed items are ready'
          new Notification(title, { body, icon: '/icon.png' })
        }

        // Show toast notification
        addToast({
          message:
            dueItems.length === 1
              ? `"${dueItems[0].title}" is back from snooze`
              : `${dueItems.length} snoozed items are back`,
          type: 'info'
        })
      }
    })

    // Request notification permission if not already granted
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }

    return () => unsubscribe()
  }, [queryClient, addToast])

  // Global keyboard shortcuts handler
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent): void => {
      // Skip if modal is open or typing in an input
      if (isShortcutsModalOpen || isFilingPanelOpen || isBulkFilePanelOpen) return

      // ? or Cmd+/ opens keyboard shortcuts help
      if (e.key === '?' || ((e.metaKey || e.ctrlKey) && e.key === '/')) {
        e.preventDefault()
        setIsShortcutsModalOpen(true)
        return
      }

      // Skip other shortcuts if in an input field
      if (isInputFocused()) return

      // V toggles view mode
      if (e.key.toLowerCase() === 'v' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setViewMode((prev) => (prev === 'list' ? 'card' : 'list'))
        return
      }

      // R refreshes the inbox
      if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        refetch()
        addToast({
          message: 'Inbox refreshed',
          type: 'success'
        })
        return
      }

      // Delete/Backspace for deleting focused or selected items
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // If in bulk mode, trigger bulk delete
        if (isInBulkMode) {
          e.preventDefault()
          setIsDeleteDialogOpen(true)
          return
        }

        // If single item is focused, delete it
        if (focusedItemId && !isPreviewPanelOpen) {
          e.preventDefault()
          // Find the focused item and trigger delete
          const focusedItem = items.find((i) => i.id === focusedItemId)
          if (focusedItem) {
            // Find next item to focus
            const allItems = [...staleItems, ...nonStaleItems]
            const currentIndex = allItems.findIndex((i) => i.id === focusedItemId)
            const nextItem = allItems[currentIndex + 1] || allItems[currentIndex - 1]

            // Trigger delete animation
            setExitingItemIds((prev) => new Set(prev).add(focusedItemId))

            // After animation, delete via backend
            setTimeout(async () => {
              // Add to pending deletes for optimistic UI
              setPendingDeleteIds((prev) => new Set(prev).add(focusedItemId))
              setExitingItemIds((prev) => {
                const next = new Set(prev)
                next.delete(focusedItemId)
                return next
              })

              // Update focus to next item
              if (nextItem) {
                setFocusedItemId(nextItem.id)
              }

              try {
                await deleteItemMutation.mutateAsync(focusedItemId)
                addToast({
                  message: `"${focusedItem.title}" deleted`,
                  type: 'success'
                })
              } catch {
                // Revert optimistic delete on error
                setPendingDeleteIds((prev) => {
                  const next = new Set(prev)
                  next.delete(focusedItemId)
                  return next
                })
                addToast({
                  message: 'Failed to delete item',
                  type: 'error'
                })
              }
            }, 200)
          }
        }
        return
      }

      // O opens the original link for the focused item
      if (e.key.toLowerCase() === 'o' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (focusedItemId) {
          const focusedItem = items.find((i) => i.id === focusedItemId)
          if (focusedItem?.sourceUrl) {
            e.preventDefault()
            window.open(focusedItem.sourceUrl, '_blank', 'noopener,noreferrer')
          }
        }
        return
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [
    isShortcutsModalOpen,
    isFilingPanelOpen,
    isBulkFilePanelOpen,
    isInBulkMode,
    focusedItemId,
    isPreviewPanelOpen,
    items,
    staleItems,
    nonStaleItems,
    addToast
  ])

  const handleViewChange = (value: string): void => {
    if (value === 'list' || value === 'card') {
      setViewMode(value)
    }
  }

  // Handle selection change
  const handleSelectionChange = useCallback((newSelection: Set<string>): void => {
    setSelectedItemIds(newSelection)
  }, [])

  // Handle select all
  const handleSelectAll = useCallback((): void => {
    const allIds = new Set(items.map((item) => item.id))
    setSelectedItemIds(allIds)
  }, [items])

  // Handle deselect all
  const handleDeselectAll = useCallback((): void => {
    setSelectedItemIds(new Set())
  }, [])

  // Handle file action - close preview first, then open filing panel
  const handleFile = useCallback(
    (id: string): void => {
      const item = items.find((i) => i.id === id)
      if (item) {
        // Close preview panel if open
        setIsPreviewPanelOpen(false)
        setPreviewingItemId(null)

        // Open filing panel
        setActiveItemForFiling(item)
        setIsFilingPanelOpen(true)
      }
    },
    [items]
  )

  // Handle filing panel close
  const handleFilingPanelClose = useCallback((): void => {
    setIsFilingPanelOpen(false)
    setActiveItemForFiling(null)
  }, [])

  // Handle filing complete with animation
  const handleFilingComplete = useCallback(
    (itemId: string, folderId: string, tags: string[], linkedNoteIds: string[]): void => {
      const filedItem = items.find((item) => item.id === itemId)
      if (!filedItem) return

      const willBeEmpty = items.length === 1

      // Start exit animation
      setExitingItemIds((prev) => new Set(prev).add(itemId))

      // After exit animation, file item via backend
      setTimeout(async () => {
        // Add to pending deletes for optimistic UI (item will be filtered out when filed)
        setPendingDeleteIds((prev) => new Set(prev).add(itemId))

        // Clear exiting state
        setExitingItemIds((prev) => {
          const next = new Set(prev)
          next.delete(itemId)
          return next
        })

        // Remove from selection if selected
        setSelectedItemIds((prev) => {
          const next = new Set(prev)
          next.delete(itemId)
          return next
        })

        // Increment items processed counter and mark filing history
        setItemsProcessedToday((prev) => prev + 1)
        setHasFilingHistory(true)

        // If this was the last item, show empty state after a brief pause
        if (willBeEmpty && !showFiledItems) {
          setTimeout(() => {
            setShowEmptyState(true)
          }, 200)
        }

        try {
          // Determine destination type based on linkedNoteIds
          const destination =
            linkedNoteIds.length > 0
              ? { type: 'note' as const, noteId: linkedNoteIds[0] }
              : { type: 'folder' as const, path: folderId }

          const result = await fileItemMutation.mutateAsync({
            itemId,
            destination,
            tags
          })

          if (result.success) {
            // Invalidate queries to refresh the list
            queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
            addToast({
              message:
                linkedNoteIds.length > 0 ? 'Linked to note' : `Filed to ${folderId || 'Notes'}`,
              type: 'success'
            })
          } else {
            throw new Error(result.error || 'Failed to file')
          }
        } catch (error) {
          // Revert optimistic UI on error
          setPendingDeleteIds((prev) => {
            const next = new Set(prev)
            next.delete(itemId)
            return next
          })
          setItemsProcessedToday((prev) => Math.max(0, prev - 1))
          addToast({
            message: error instanceof Error ? error.message : 'Failed to file item',
            type: 'error'
          })
        }
      }, 200)
    },
    [items, addToast, fileItemMutation, queryClient, showFiledItems]
  )

  // Handle Quick-File (inline keyboard filing from List View) with animation
  const handleQuickFile = useCallback(
    (itemId: string, folderId: string): void => {
      const filedItem = items.find((item) => item.id === itemId)
      if (!filedItem) return

      const willBeEmpty = items.length === 1

      // Start exit animation
      setExitingItemIds((prev) => new Set(prev).add(itemId))

      // After exit animation, file item via backend
      setTimeout(async () => {
        // Add to pending deletes for optimistic UI
        setPendingDeleteIds((prev) => new Set(prev).add(itemId))

        // Clear exiting state
        setExitingItemIds((prev) => {
          const next = new Set(prev)
          next.delete(itemId)
          return next
        })

        // Remove from selection if selected
        setSelectedItemIds((prev) => {
          const next = new Set(prev)
          next.delete(itemId)
          return next
        })

        // Increment items processed counter and mark filing history
        setItemsProcessedToday((prev) => prev + 1)
        setHasFilingHistory(true)

        // If this was the last item, show empty state after a brief pause
        if (willBeEmpty && !showFiledItems) {
          setTimeout(() => {
            setShowEmptyState(true)
          }, 200)
        }

        try {
          const result = await fileItemMutation.mutateAsync({
            itemId,
            destination: { type: 'folder', path: folderId },
            tags: []
          })

          if (result.success) {
            queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
            addToast({
              message: `Filed to ${folderId || 'Notes'}`,
              type: 'success'
            })
          } else {
            throw new Error(result.error || 'Failed to file')
          }
        } catch (error) {
          // Revert optimistic UI on error
          setPendingDeleteIds((prev) => {
            const next = new Set(prev)
            next.delete(itemId)
            return next
          })
          setItemsProcessedToday((prev) => Math.max(0, prev - 1))
          addToast({
            message: error instanceof Error ? error.message : 'Failed to file item',
            type: 'error'
          })
        }
      }, 200)
    },
    [items, addToast, fileItemMutation, queryClient, showFiledItems]
  )

  // Handle preview action - toggle preview panel
  const handlePreview = useCallback(
    (id: string): void => {
      // Close filing panel if open (only one panel at a time)
      if (isFilingPanelOpen) {
        setIsFilingPanelOpen(false)
        setActiveItemForFiling(null)
      }

      // Toggle preview: if already previewing this item, close; otherwise open/switch
      if (isPreviewPanelOpen && previewingItemId === id) {
        setIsPreviewPanelOpen(false)
        setPreviewingItemId(null)
      } else {
        setIsPreviewPanelOpen(true)
        setPreviewingItemId(id)
        setFocusedItemId(id)
      }
    },
    [isFilingPanelOpen, isPreviewPanelOpen, previewingItemId]
  )

  // Handle preview panel close
  const handlePreviewPanelClose = useCallback((): void => {
    setIsPreviewPanelOpen(false)
    setPreviewingItemId(null)
  }, [])

  // Handle focused item change (for navigation while preview is open)
  const handleFocusedItemChange = useCallback(
    (id: string | null): void => {
      setFocusedItemId(id)

      // If preview panel is open, update the preview to show the newly focused item
      if (isPreviewPanelOpen && id) {
        setPreviewingItemId(id)
      }
    },
    [isPreviewPanelOpen]
  )

  // Handle delete action with animation
  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      const deletedItem = items.find((item) => item.id === id)
      if (!deletedItem) return

      const willBeEmpty = items.length === 1

      // Start exit animation
      setExitingItemIds((prev) => new Set(prev).add(id))

      // If we're deleting the previewed item, close the preview
      if (previewingItemId === id) {
        setIsPreviewPanelOpen(false)
        setPreviewingItemId(null)
      }

      // After exit animation (200ms), delete via backend
      setTimeout(async () => {
        // Add to pending deletes for optimistic UI
        setPendingDeleteIds((prev) => new Set(prev).add(id))

        // Clear exiting state
        setExitingItemIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })

        // Remove from selection if selected
        setSelectedItemIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })

        // Increment items processed counter
        setItemsProcessedToday((prev) => prev + 1)

        // If this was the last item, show empty state after a brief pause
        if (willBeEmpty) {
          setTimeout(() => {
            setShowEmptyState(true)
          }, 200)
        }

        try {
          await deleteItemMutation.mutateAsync(id)
          addToast({
            message: 'Item deleted',
            type: 'success'
          })
        } catch {
          // Revert optimistic delete on error
          setPendingDeleteIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          // Decrement the processed counter on error
          setItemsProcessedToday((prev) => Math.max(0, prev - 1))
          addToast({
            message: 'Failed to delete item',
            type: 'error'
          })
        }
      }, 200)
    },
    [items, addToast, previewingItemId, deleteItemMutation]
  )

  // Handle snooze action with animation
  const handleSnooze = useCallback(
    async (id: string, snoozeUntil: string): Promise<void> => {
      const snoozedItem = items.find((item) => item.id === id)
      if (!snoozedItem) return

      const willBeEmpty = items.length === 1

      // Start exit animation
      setExitingItemIds((prev) => new Set(prev).add(id))

      // If we're snoozing the previewed item, close the preview
      if (previewingItemId === id) {
        setIsPreviewPanelOpen(false)
        setPreviewingItemId(null)
      }

      // After exit animation (200ms), snooze via backend
      setTimeout(async () => {
        // Add to pending deletes for optimistic UI (snoozed items disappear from view)
        setPendingDeleteIds((prev) => new Set(prev).add(id))

        // Clear exiting state
        setExitingItemIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })

        // Remove from selection if selected
        setSelectedItemIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })

        // If this was the last item, show empty state after a brief pause
        if (willBeEmpty) {
          setTimeout(() => {
            setShowEmptyState(true)
          }, 200)
        }

        try {
          const result = await inboxService.snooze({ itemId: id, snoozeUntil })
          if (result.success) {
            queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })

            // Format the snooze time for the toast message
            const snoozeDate = new Date(snoozeUntil)
            const timeString = snoozeDate.toLocaleString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            })
            addToast({
              message: `Snoozed until ${timeString}`,
              type: 'success'
            })
          } else {
            throw new Error(result.error || 'Failed to snooze')
          }
        } catch (error) {
          // Revert optimistic UI on error
          setPendingDeleteIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          addToast({
            message: error instanceof Error ? error.message : 'Failed to snooze item',
            type: 'error'
          })
        }
      }, 200)
    },
    [items, addToast, previewingItemId, queryClient]
  )

  // === BULK ACTION HANDLERS ===

  // Handle bulk file all
  const handleBulkFileAll = useCallback((): void => {
    setIsBulkFilePanelOpen(true)
  }, [])

  // Handle bulk file complete
  const handleBulkFileComplete = useCallback(
    async (itemIds: string[], folderId: string, tags: string[]): Promise<void> => {
      const processedCount = itemIds.length

      // Add to pending deletes for optimistic UI
      setPendingDeleteIds((prev) => {
        const next = new Set(prev)
        itemIds.forEach((id) => next.add(id))
        return next
      })

      // Clear selection
      setSelectedItemIds(new Set())

      // Increment items processed counter and mark filing history
      setItemsProcessedToday((prev) => prev + processedCount)
      setHasFilingHistory(true)

      try {
        // Use bulk file API
        const result = await window.api.inbox.bulkFile({
          itemIds,
          destination: { type: 'folder', path: folderId },
          tags
        })

        if (result.success) {
          queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
          addToast({
            message: `Filed ${itemIds.length} items to ${folderId || 'Notes'}`,
            type: 'success'
          })
        } else if (result.errors.length > 0) {
          // Partial success
          queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
          addToast({
            message: `Filed ${result.processedCount} of ${itemIds.length} items`,
            type: 'success'
          })
        } else {
          throw new Error('Failed to file items')
        }
      } catch (error) {
        // Revert optimistic delete on error
        setPendingDeleteIds((prev) => {
          const next = new Set(prev)
          itemIds.forEach((id) => next.delete(id))
          return next
        })
        setItemsProcessedToday((prev) => Math.max(0, prev - processedCount))
        addToast({
          message: error instanceof Error ? error.message : 'Failed to file items',
          type: 'error'
        })
      }
    },
    [addToast, queryClient]
  )

  // Handle bulk tag all
  const handleBulkTagAll = useCallback((): void => {
    setIsBulkTagPopoverOpen(true)
  }, [])

  // Handle bulk tag apply
  const handleBulkTagApply = useCallback(
    async (tags: string[]): Promise<void> => {
      const itemIds = Array.from(selectedItemIds)

      try {
        const result = await window.api.inbox.bulkTag({ itemIds, tags })

        if (result.success || result.processedCount > 0) {
          queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
          addToast({
            message: `Applied ${tags.length} tag${tags.length !== 1 ? 's' : ''} to ${result.processedCount} item${result.processedCount !== 1 ? 's' : ''}`,
            type: 'success'
          })
        } else {
          throw new Error('Failed to apply tags')
        }
      } catch (error) {
        addToast({
          message: error instanceof Error ? error.message : 'Failed to apply tags',
          type: 'error'
        })
      }
      // Keep selection - tagging doesn't remove items from inbox
    },
    [selectedItemIds, queryClient, addToast]
  )

  // Handle bulk delete all
  const handleBulkDeleteAll = useCallback((): void => {
    setIsDeleteDialogOpen(true)
  }, [])

  // Handle bulk delete confirm with animation
  const handleBulkDeleteConfirm = useCallback((): void => {
    const idsToDelete = Array.from(selectedItemIds)
    const processedCount = idsToDelete.length
    const willBeEmpty = items.length === idsToDelete.length

    // Close dialog immediately
    setIsDeleteDialogOpen(false)

    // Start exit animation for all items
    setExitingItemIds(new Set(idsToDelete))

    // Close the preview if any deleted item was being previewed
    if (previewingItemId && idsToDelete.includes(previewingItemId)) {
      setIsPreviewPanelOpen(false)
      setPreviewingItemId(null)
    }

    // After exit animation, delete via backend
    setTimeout(async () => {
      // Add to pending deletes for optimistic UI
      setPendingDeleteIds((prev) => {
        const next = new Set(prev)
        idsToDelete.forEach((id) => next.add(id))
        return next
      })

      // Clear exiting state
      setExitingItemIds(new Set())

      // Clear selection
      setSelectedItemIds(new Set())

      // Increment items processed counter
      setItemsProcessedToday((prev) => prev + processedCount)

      // If this removed all items, show empty state after a brief pause
      if (willBeEmpty) {
        setTimeout(() => {
          setShowEmptyState(true)
        }, 200)
      }

      try {
        await bulkDeleteMutation.mutateAsync({ itemIds: idsToDelete })
        addToast({
          message: `Deleted ${idsToDelete.length} item${idsToDelete.length !== 1 ? 's' : ''}`,
          type: 'success'
        })
      } catch {
        // Revert optimistic delete on error
        setPendingDeleteIds((prev) => {
          const next = new Set(prev)
          idsToDelete.forEach((id) => next.delete(id))
          return next
        })
        setItemsProcessedToday((prev) => Math.max(0, prev - processedCount))
        addToast({
          message: 'Failed to delete items',
          type: 'error'
        })
      }
    }, 200)
  }, [selectedItemIds, items, previewingItemId, addToast, bulkDeleteMutation])

  // Handle delete dialog cancel
  const handleDeleteDialogCancel = useCallback((): void => {
    setIsDeleteDialogOpen(false)
  }, [])

  // Handle AI suggestion - add to selection
  const handleAddSuggestionToSelection = useCallback((): void => {
    if (!aiSuggestion) return

    const newSelection = new Set(selectedItemIds)
    aiSuggestion.items.forEach((item) => {
      newSelection.add(item.id)
    })
    setSelectedItemIds(newSelection)
  }, [aiSuggestion, selectedItemIds])

  // Handle AI suggestion dismiss
  const handleDismissSuggestion = useCallback((): void => {
    if (!aiSuggestion) return

    const key = getClusterKey(aiSuggestion)
    setDismissedSuggestionKeys((prev) => new Set(prev).add(key))
  }, [aiSuggestion])

  // Handle bulk snooze all
  const handleBulkSnoozeAll = useCallback(
    async (snoozeUntil: string): Promise<void> => {
      const idsToSnooze = Array.from(selectedItemIds)
      if (idsToSnooze.length === 0) return

      const willBeEmpty = items.length === idsToSnooze.length

      // Start exit animation for all items
      setExitingItemIds(new Set(idsToSnooze))

      // Close the preview if any snoozed item was being previewed
      if (previewingItemId && idsToSnooze.includes(previewingItemId)) {
        setIsPreviewPanelOpen(false)
        setPreviewingItemId(null)
      }

      // After exit animation, snooze via backend
      setTimeout(async () => {
        // Add to pending deletes for optimistic UI (snoozed items disappear from view)
        setPendingDeleteIds((prev) => {
          const next = new Set(prev)
          idsToSnooze.forEach((id) => next.add(id))
          return next
        })

        // Clear exiting state
        setExitingItemIds(new Set())

        // Clear selection
        setSelectedItemIds(new Set())

        // If this removed all items, show empty state after a brief pause
        if (willBeEmpty) {
          setTimeout(() => {
            setShowEmptyState(true)
          }, 200)
        }

        try {
          // Use bulk snooze API
          const result = await window.api.inbox.bulkSnooze({
            itemIds: idsToSnooze,
            snoozeUntil
          })

          if (result.success || result.processedCount > 0) {
            queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })

            // Format the snooze time for the toast message
            const snoozeDate = new Date(snoozeUntil)
            const timeString = snoozeDate.toLocaleString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            })
            addToast({
              message: `Snoozed ${result.processedCount} item${result.processedCount !== 1 ? 's' : ''} until ${timeString}`,
              type: 'success'
            })
          } else {
            throw new Error('Failed to snooze items')
          }
        } catch (error) {
          // Revert optimistic UI on error
          setPendingDeleteIds((prev) => {
            const next = new Set(prev)
            idsToSnooze.forEach((id) => next.delete(id))
            return next
          })
          addToast({
            message: error instanceof Error ? error.message : 'Failed to snooze items',
            type: 'error'
          })
        }
      }, 200)
    },
    [selectedItemIds, items, previewingItemId, addToast, queryClient]
  )

  // === STALE ITEMS HANDLERS ===

  // Handle "File all to Unsorted" action for stale items
  const handleFileAllStaleToUnsorted = useCallback((): void => {
    if (staleItems.length === 0) return

    const processedCount = staleItems.length
    const staleIds = staleItems.map((i) => i.id)

    // Start exit animation for all stale items
    setExitingItemIds(new Set(staleIds))

    // After animation, file via backend
    setTimeout(async () => {
      // Add to pending deletes for optimistic UI
      setPendingDeleteIds((prev) => {
        const next = new Set(prev)
        staleIds.forEach((id) => next.add(id))
        return next
      })

      // Clear exiting state
      setExitingItemIds(new Set())

      // Clear any selections of stale items
      setSelectedItemIds((prev) => {
        const next = new Set(prev)
        staleItems.forEach((item) => next.delete(item.id))
        return next
      })

      // Increment items processed counter and mark filing history
      setItemsProcessedToday((prev) => prev + processedCount)
      setHasFilingHistory(true)

      try {
        // Use dedicated fileAllStale API - it handles finding stale items server-side
        const result = await window.api.inbox.fileAllStale()

        if (result.success || result.processedCount > 0) {
          queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
          addToast({
            message: `Filed ${result.processedCount} stale items to Unsorted`,
            type: 'success'
          })
        } else {
          throw new Error('Failed to file stale items')
        }
      } catch (error) {
        // Revert optimistic delete on error
        setPendingDeleteIds((prev) => {
          const next = new Set(prev)
          staleIds.forEach((id) => next.delete(id))
          return next
        })
        setItemsProcessedToday((prev) => Math.max(0, prev - processedCount))
        addToast({
          message: error instanceof Error ? error.message : 'Failed to file stale items',
          type: 'error'
        })
      }
    }, 200)
  }, [staleItems, addToast, queryClient])

  // Handle "Review one by one" action for stale items
  // Simple version: select all stale items to enter bulk mode
  const handleReviewStaleItems = useCallback((): void => {
    if (staleItems.length === 0) return

    // Select all stale items
    const staleIds = new Set(staleItems.map((i) => i.id))
    setSelectedItemIds(staleIds)

    // Focus the first stale item
    if (staleItems[0]) {
      setFocusedItemId(staleItems[0].id)
    }
  }, [staleItems])

  // === IMAGE CAPTURE HANDLERS ===

  // Allowed image MIME types for drag-drop and paste
  const ALLOWED_IMAGE_TYPES = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml'
  ]

  // Handle image capture (shared between drag-drop and paste)
  const handleImageCapture = useCallback(
    async (file: File): Promise<void> => {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        addToast({
          message: `Unsupported image type: ${file.type}`,
          type: 'error'
        })
        return
      }

      // Check file size (max 50MB)
      const MAX_SIZE = 50 * 1024 * 1024
      if (file.size > MAX_SIZE) {
        addToast({
          message: 'Image too large (max 50MB)',
          type: 'error'
        })
        return
      }

      setIsCapturingImage(true)

      try {
        // Read file as ArrayBuffer and convert to Uint8Array for IPC transfer
        const arrayBuffer = await file.arrayBuffer()

        const result = await inboxService.captureImage({
          data: arrayBuffer,
          filename: file.name,
          mimeType: file.type
        })

        if (result.success) {
          addToast({
            message: 'Image captured',
            type: 'success'
          })
        } else {
          throw new Error(result.error || 'Failed to capture image')
        }
      } catch (error) {
        addToast({
          message: error instanceof Error ? error.message : 'Failed to capture image',
          type: 'error'
        })
      } finally {
        setIsCapturingImage(false)
      }
    },
    [addToast]
  )

  // Handle drag over event
  const handleDragOver = useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()

    // Check if dragging files
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true)
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  // Handle drag leave event
  const handleDragLeave = useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()

    // Only clear if leaving the drop zone entirely
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX
    const y = e.clientY

    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
      setIsDraggingOver(false)
    }
  }, [])

  // Handle drop event
  const handleDrop = useCallback(
    async (e: React.DragEvent): Promise<void> => {
      e.preventDefault()
      e.stopPropagation()
      setIsDraggingOver(false)

      const files = Array.from(e.dataTransfer.files)
      const imageFiles = files.filter((file) => file.type.startsWith('image/'))

      if (imageFiles.length === 0) {
        // No image files dropped - could be text or other files
        return
      }

      // Process each image file
      for (const file of imageFiles) {
        await handleImageCapture(file)
      }
    },
    [handleImageCapture]
  )

  // Handle clipboard paste for images
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent): Promise<void> => {
      // Skip if we're in an input field
      if (isInputFocused()) return

      const items = e.clipboardData?.items
      if (!items) return

      // Look for image items in clipboard
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (file) {
            await handleImageCapture(file)
          }
          return // Only handle first image
        }
      }
    }

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [handleImageCapture])

  // Calculate today's items count for header
  const todayItemsCount = useMemo(() => {
    const today = new Date()
    return items.filter((item) => {
      const itemDate = item.createdAt instanceof Date ? item.createdAt : new Date(item.createdAt)
      return (
        itemDate.getDate() === today.getDate() &&
        itemDate.getMonth() === today.getMonth() &&
        itemDate.getFullYear() === today.getFullYear()
      )
    }).length
  }, [items])

  return (
    <div
      className={cn(
        'flex flex-col h-full relative',
        'px-6 lg:px-8',
        'py-8 lg:py-12',
        isDraggingOver && 'ring-2 ring-primary/50 ring-inset bg-primary/5',
        className
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop zone overlay */}
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

      {/* Loading overlay for image capture */}
      {isCapturingImage && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="size-8 text-primary animate-spin" />
            <p className="text-sm text-muted-foreground">Capturing image...</p>
          </div>
        </div>
      )}

      {/* Header with Dramatic Item Count */}
      <header className={cn('relative mb-8 lg:mb-10', 'journal-animate-in')}>
        {/* Large decorative item count watermark */}
        {!isInBulkMode && items.length > 0 && (
          <div
            className={cn(
              'absolute -left-2 lg:-left-4 -top-4 lg:-top-6',
              'text-[8rem] lg:text-[10rem]',
              'journal-day-watermark'
            )}
            aria-hidden="true"
          >
            {items.length}
          </div>
        )}

        {/* Content layer */}
        <div className="relative z-10">
          {isInBulkMode ? (
            /* Bulk Selection Header */
            <div className="flex items-start justify-between gap-6">
              <div className="opacity-0 journal-animate-in journal-stagger-1">
                <div className="flex items-center gap-3 mb-1">
                  <Check className="size-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                  <h1 className="font-display text-2xl lg:text-3xl font-normal tracking-tight text-foreground/90">
                    {selectedCount} selected
                  </h1>
                </div>
                <p className="font-serif text-sm text-muted-foreground/70 tracking-wide pl-8">
                  Ready to process
                </p>
              </div>

              <div
                className={cn(
                  'flex items-center gap-3',
                  'opacity-0 journal-animate-in journal-stagger-2'
                )}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDeselectAll}
                  className={cn(
                    'text-muted-foreground/60 hover:text-foreground',
                    'hover:bg-foreground/5',
                    'transition-all duration-200'
                  )}
                >
                  Deselect all
                </Button>
                <ToggleGroup
                  type="single"
                  value={viewMode}
                  onValueChange={handleViewChange}
                  className="gap-0.5 p-1 rounded-lg bg-muted/30"
                >
                  <ToggleGroupItem
                    value="list"
                    aria-label="List view"
                    className={cn(
                      'rounded-md px-3 py-1.5',
                      'data-[state=on]:bg-background data-[state=on]:shadow-sm',
                      'transition-all duration-200'
                    )}
                  >
                    <List className="size-4" />
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="card"
                    aria-label="Grid view"
                    className={cn(
                      'rounded-md px-3 py-1.5',
                      'data-[state=on]:bg-background data-[state=on]:shadow-sm',
                      'transition-all duration-200'
                    )}
                  >
                    <Grid className="size-4" />
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>
          ) : (
            /* Normal Header */
            <div className="flex items-start justify-between gap-6">
              <div className="opacity-0 journal-animate-in journal-stagger-1">
                <h1 className="font-display text-2xl lg:text-3xl font-normal tracking-tight text-foreground/90 mb-1">
                  Inbox
                </h1>
                <p className="font-serif text-sm text-muted-foreground/70 tracking-wide">
                  {items.length === 0
                    ? 'All caught up'
                    : todayItemsCount > 0
                      ? `${todayItemsCount} item${todayItemsCount !== 1 ? 's' : ''} arrived today`
                      : `${items.length} item${items.length !== 1 ? 's' : ''} waiting`}
                </p>
              </div>

              <div
                className={cn(
                  'flex items-center gap-3',
                  'opacity-0 journal-animate-in journal-stagger-2'
                )}
              >
                {items.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSelectAll}
                    className={cn(
                      'text-muted-foreground/60 hover:text-foreground',
                      'hover:bg-foreground/5',
                      'transition-all duration-200'
                    )}
                  >
                    Select all
                  </Button>
                )}
                <ToggleGroup
                  type="single"
                  value={viewMode}
                  onValueChange={handleViewChange}
                  className="gap-0.5 p-1 rounded-lg bg-muted/30"
                >
                  <ToggleGroupItem
                    value="list"
                    aria-label="List view"
                    className={cn(
                      'rounded-md px-3 py-1.5',
                      'data-[state=on]:bg-background data-[state=on]:shadow-sm',
                      'transition-all duration-200'
                    )}
                  >
                    <List className="size-4" />
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="card"
                    aria-label="Grid view"
                    className={cn(
                      'rounded-md px-3 py-1.5',
                      'data-[state=on]:bg-background data-[state=on]:shadow-sm',
                      'transition-all duration-200'
                    )}
                  >
                    <Grid className="size-4" />
                  </ToggleGroupItem>
                </ToggleGroup>

                {/* Show filed items toggle */}
                <div className="flex items-center gap-2 ml-4 pl-4 border-l border-border/40">
                  <Switch
                    id="show-filed"
                    checked={showFiledItems}
                    onCheckedChange={setShowFiledItems}
                    className="scale-90"
                  />
                  <Label
                    htmlFor="show-filed"
                    className="text-xs text-muted-foreground/70 cursor-pointer whitespace-nowrap"
                  >
                    <Archive className="inline-block size-3 mr-1" />
                    Show filed
                  </Label>
                </div>

                {/* Show snoozed items toggle */}
                <div className="flex items-center gap-2 ml-2">
                  <Switch
                    id="show-snoozed"
                    checked={showSnoozedItems}
                    onCheckedChange={setShowSnoozedItems}
                    className="scale-90"
                  />
                  <Label
                    htmlFor="show-snoozed"
                    className="text-xs text-muted-foreground/70 cursor-pointer whitespace-nowrap"
                  >
                    <Clock className="inline-block size-3 mr-1" />
                    Show snoozed
                  </Label>
                </div>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Quick Capture Input */}
      <div className="mb-6 opacity-0 journal-animate-in journal-stagger-2">
        <CaptureInput
          onCaptureSuccess={() => {
            addToast({
              message: 'Item captured',
              type: 'success'
            })
          }}
          onCaptureError={(errorMsg) => {
            addToast({
              message: errorMsg,
              type: 'error'
            })
          }}
        />
      </div>

      {/* Content: Scrollable area with view-based rendering or empty state */}
      <div
        className={cn(
          'flex-1 overflow-y-auto',
          'opacity-0 journal-animate-in journal-stagger-3',
          isInBulkMode && 'pb-32'
        )}
      >
        {/* Loading State */}
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <Loader2 className="size-8 text-muted-foreground/50 animate-spin" />
            <p className="text-sm text-muted-foreground/60 font-serif">Loading inbox...</p>
          </div>
        ) : error ? (
          /* Error State */
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
            hasFilingHistory={hasFilingHistory}
            isExiting={isEmptyStateExiting}
          />
        ) : viewMode === 'list' ? (
          <ListView
            items={nonStaleItems}
            staleItems={staleItems}
            selectedItemIds={selectedItemIds}
            exitingItemIds={exitingItemIds}
            onFile={handleFile}
            onPreview={handlePreview}
            onDelete={handleDelete}
            onSnooze={handleSnooze}
            onQuickFile={handleQuickFile}
            onSelectionChange={handleSelectionChange}
            onFileAllStale={handleFileAllStaleToUnsorted}
            onReviewStale={handleReviewStaleItems}
            focusedItemId={focusedItemId}
            onFocusedItemChange={handleFocusedItemChange}
            isPreviewOpen={isPreviewPanelOpen}
          />
        ) : (
          <CardView
            items={nonStaleItems}
            staleItems={staleItems}
            selectedItemIds={selectedItemIds}
            exitingItemIds={exitingItemIds}
            onFile={handleFile}
            onPreview={handlePreview}
            onDelete={handleDelete}
            onSnooze={handleSnooze}
            onSelectionChange={handleSelectionChange}
            onFileAllStale={handleFileAllStaleToUnsorted}
            onReviewStale={handleReviewStaleItems}
            focusedItemId={focusedItemId}
            onFocusedItemChange={handleFocusedItemChange}
            isPreviewOpen={isPreviewPanelOpen}
          />
        )}
      </div>

      {/* Bulk Action Bar */}
      <BulkActionBar
        selectedCount={selectedCount}
        onFileAll={handleBulkFileAll}
        onTagAll={handleBulkTagAll}
        onDeleteAll={handleBulkDeleteAll}
        onSnoozeAll={handleBulkSnoozeAll}
        aiSuggestion={aiSuggestion}
        onAddSuggestionToSelection={handleAddSuggestionToSelection}
        onDismissSuggestion={handleDismissSuggestion}
      />

      {/* Bulk File Panel */}
      <BulkFilePanel
        isOpen={isBulkFilePanelOpen}
        items={selectedItems}
        onClose={() => setIsBulkFilePanelOpen(false)}
        onFile={handleBulkFileComplete}
      />

      {/* Bulk Tag Popover - rendered as part of the action bar */}
      <BulkTagPopover
        isOpen={isBulkTagPopoverOpen}
        itemCount={selectedCount}
        trigger={<span />}
        onOpenChange={setIsBulkTagPopoverOpen}
        onApplyTags={handleBulkTagApply}
      />

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        isOpen={isDeleteDialogOpen}
        itemCount={selectedCount}
        onConfirm={handleBulkDeleteConfirm}
        onCancel={handleDeleteDialogCancel}
      />

      {/* Filing Panel */}
      <FilingPanel
        isOpen={isFilingPanelOpen}
        item={activeItemForFiling}
        onClose={handleFilingPanelClose}
        onFile={handleFilingComplete}
      />

      {/* Preview Panel */}
      <PreviewPanel
        isOpen={isPreviewPanelOpen}
        item={previewingItem}
        isLoading={isPreviewLoading}
        onClose={handlePreviewPanelClose}
        onFile={handleFile}
        onDelete={handleDelete}
      />

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />

      {/* Keyboard Shortcuts Modal */}
      <KeyboardShortcutsModal
        isOpen={isShortcutsModalOpen}
        onClose={() => setIsShortcutsModalOpen(false)}
      />

      {/* Screen Reader Announcer */}
      <SRAnnouncer />
    </div>
  )
}
