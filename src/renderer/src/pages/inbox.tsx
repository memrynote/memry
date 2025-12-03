import { useState, useCallback, useMemo, useEffect } from "react"
import { List, Grid, Check } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ToastContainer, type Toast } from "@/components/ui/toast"
import { ListView } from "@/components/list-view"
import { CardView } from "@/components/card-view"
import { FilingPanel } from "@/components/filing/filing-panel"
import { PreviewPanel } from "@/components/preview/preview-panel"
import { BulkActionBar, type ClusterSuggestion } from "@/components/bulk/bulk-action-bar"
import { BulkFilePanel } from "@/components/bulk/bulk-file-panel"
import { BulkTagPopover } from "@/components/bulk/bulk-tag-popover"
import { DeleteConfirmationDialog } from "@/components/bulk/delete-confirmation-dialog"
import { EmptyState } from "@/components/empty-state/empty-state"
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal"
import { SRAnnouncer } from "@/components/sr-announcer"
import { sampleInboxItems } from "@/data/sample-inbox-items"
import { sampleFolders, UNSORTED_FOLDER_ID } from "@/data/filing-data"
import { detectClusters, getClusterKey } from "@/lib/ai-clustering"
import { getStaleItems, getNonStaleItems } from "@/lib/stale-utils"
import { cn } from "@/lib/utils"
import { isInputFocused, isMac } from "@/hooks/use-keyboard-shortcuts"
import type { InboxItem } from "@/types"

type ViewMode = "list" | "card"

interface DeletedItem {
  item: InboxItem
  index: number
}

interface FiledItem {
  item: InboxItem
  index: number
  folderId: string
}

interface BulkDeletedItems {
  items: { item: InboxItem; index: number }[]
}

interface InboxPageProps {
  className?: string
}

export function InboxPage({ className }: InboxPageProps): React.JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>("list")
  const [items, setItems] = useState<InboxItem[]>(sampleInboxItems)
  const [deletedItems, setDeletedItems] = useState<DeletedItem[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])

  // Empty state tracking
  const [itemsProcessedToday, setItemsProcessedToday] = useState(0)
  // Simulated filing history - in a real app, this would come from persisted data
  const [hasFilingHistory, setHasFilingHistory] = useState(false)

  // Animation states for transitions
  const [exitingItemIds, setExitingItemIds] = useState<Set<string>>(new Set())
  const [isEmptyStateExiting, setIsEmptyStateExiting] = useState(false)
  const [showEmptyState, setShowEmptyState] = useState(items.length === 0)

  // Selection state for bulk mode
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [dismissedSuggestionKeys, setDismissedSuggestionKeys] = useState<Set<string>>(new Set())

  // Filing panel state
  const [isFilingPanelOpen, setIsFilingPanelOpen] = useState(false)
  const [activeItemForFiling, setActiveItemForFiling] = useState<InboxItem | null>(null)

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

  // Get the item being previewed
  const previewingItem = useMemo(() => {
    if (!previewingItemId) return null
    return items.find((item) => item.id === previewingItemId) || null
  }, [previewingItemId, items])

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
  const hasStaleItems = staleItems.length > 0

  // Generate unique toast ID
  const generateToastId = (): string => {
    return `toast-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
  }

  // Add a toast notification
  const addToast = useCallback((toast: Omit<Toast, "id">): string => {
    const id = generateToastId()
    setToasts((prev) => [...prev, { ...toast, id }])
    return id
  }, [])

  // Remove a toast notification
  const removeToast = useCallback((id: string): void => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  // Global keyboard shortcuts handler
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent): void => {
      // Skip if modal is open or typing in an input
      if (isShortcutsModalOpen || isFilingPanelOpen || isBulkFilePanelOpen) return

      // ? or Cmd+/ opens keyboard shortcuts help
      if (e.key === "?" || ((e.metaKey || e.ctrlKey) && e.key === "/")) {
        e.preventDefault()
        setIsShortcutsModalOpen(true)
        return
      }

      // Skip other shortcuts if in an input field
      if (isInputFocused()) return

      // V toggles view mode
      if (e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setViewMode((prev) => (prev === "list" ? "card" : "list"))
        return
      }

      // R refreshes the inbox (placeholder - would fetch new data in real app)
      if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        // In a real app, this would fetch new data
        addToast({
          message: "Inbox refreshed",
          type: "success",
        })
        return
      }

      // Delete/Backspace for deleting focused or selected items
      if (e.key === "Delete" || e.key === "Backspace") {
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

            // After animation, remove item
            setTimeout(() => {
              const itemIndex = items.findIndex((i) => i.id === focusedItemId)
              setDeletedItems((prev) => [...prev, { item: focusedItem, index: itemIndex }])
              setItems((prev) => prev.filter((i) => i.id !== focusedItemId))
              setExitingItemIds((prev) => {
                const next = new Set(prev)
                next.delete(focusedItemId)
                return next
              })

              // Update focus to next item
              if (nextItem) {
                setFocusedItemId(nextItem.id)
              }

              // Show undo toast
              addToast({
                message: `"${focusedItem.title}" deleted`,
                type: "success",
                onUndo: () => {
                  setItems((prev) => {
                    const newItems = [...prev]
                    newItems.splice(itemIndex, 0, focusedItem)
                    return newItems
                  })
                  setDeletedItems((prev) => prev.filter((d) => d.item.id !== focusedItem.id))
                },
              })
            }, 200)
          }
        }
        return
      }

      // O opens the original link for the focused item
      if (e.key.toLowerCase() === "o" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (focusedItemId) {
          const focusedItem = items.find((i) => i.id === focusedItemId)
          if (focusedItem?.url) {
            e.preventDefault()
            window.open(focusedItem.url, "_blank", "noopener,noreferrer")
          }
        }
        return
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown)
    return () => window.removeEventListener("keydown", handleGlobalKeyDown)
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
    addToast,
  ])

  const handleViewChange = (value: string): void => {
    if (value === "list" || value === "card") {
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
  const handleFile = useCallback((id: string): void => {
    const item = items.find((i) => i.id === id)
    if (item) {
      // Close preview panel if open
      setIsPreviewPanelOpen(false)
      setPreviewingItemId(null)

      // Open filing panel
      setActiveItemForFiling(item)
      setIsFilingPanelOpen(true)
    }
  }, [items])

  // Handle filing panel close
  const handleFilingPanelClose = useCallback((): void => {
    setIsFilingPanelOpen(false)
    setActiveItemForFiling(null)
  }, [])

  // Handle filing complete with animation
  const handleFilingComplete = useCallback(
    (itemId: string, folderId: string, _tags: string[], _linkedNoteIds: string[]): void => {
      const itemIndex = items.findIndex((item) => item.id === itemId)
      if (itemIndex === -1) return

      const filedItem = items[itemIndex]
      const folder = sampleFolders.find((f) => f.id === folderId)
      const willBeEmpty = items.length === 1

      // Start exit animation
      setExitingItemIds((prev) => new Set(prev).add(itemId))

      // After exit animation, remove item
      setTimeout(() => {
        // Remove item from inbox
        setItems((prev) => prev.filter((item) => item.id !== itemId))

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
        if (willBeEmpty) {
          setTimeout(() => {
            setShowEmptyState(true)
          }, 200)
        }

        // Store filed item for potential undo
        const fileRecord: FiledItem = { item: filedItem, index: itemIndex, folderId }

        // Show toast with undo option
        addToast({
          message: `Filed to ${folder?.name || "folder"}`,
          type: "success",
          onUndo: () => {
            // If empty state is showing, animate it out first
            if (willBeEmpty) {
              setIsEmptyStateExiting(true)
              setTimeout(() => {
                setShowEmptyState(false)
                setIsEmptyStateExiting(false)
                setItems((prev) => {
                  const newItems = [...prev]
                  newItems.splice(fileRecord.index, 0, fileRecord.item)
                  return newItems
                })
              }, 150)
            } else {
              setItems((prev) => {
                const newItems = [...prev]
                newItems.splice(fileRecord.index, 0, fileRecord.item)
                return newItems
              })
            }
            // Decrement the processed counter on undo
            setItemsProcessedToday((prev) => Math.max(0, prev - 1))
          },
        })
      }, 200)
    },
    [items, addToast]
  )

  // Handle Quick-File (inline keyboard filing from List View) with animation
  const handleQuickFile = useCallback(
    (itemId: string, folderId: string): void => {
      const itemIndex = items.findIndex((item) => item.id === itemId)
      if (itemIndex === -1) return

      const filedItem = items[itemIndex]
      const folder = sampleFolders.find((f) => f.id === folderId)
      const willBeEmpty = items.length === 1

      // Start exit animation
      setExitingItemIds((prev) => new Set(prev).add(itemId))

      // After exit animation, remove item
      setTimeout(() => {
        // Remove item from inbox
        setItems((prev) => prev.filter((item) => item.id !== itemId))

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
        if (willBeEmpty) {
          setTimeout(() => {
            setShowEmptyState(true)
          }, 200)
        }

        // Store filed item for potential undo
        const fileRecord: FiledItem = { item: filedItem, index: itemIndex, folderId }

        // Show toast with undo option
        addToast({
          message: `Filed to ${folder?.name || "folder"}`,
          type: "success",
          onUndo: () => {
            // If empty state is showing, animate it out first
            if (willBeEmpty) {
              setIsEmptyStateExiting(true)
              setTimeout(() => {
                setShowEmptyState(false)
                setIsEmptyStateExiting(false)
                setItems((prev) => {
                  const newItems = [...prev]
                  newItems.splice(fileRecord.index, 0, fileRecord.item)
                  return newItems
                })
              }, 150)
            } else {
              setItems((prev) => {
                const newItems = [...prev]
                newItems.splice(fileRecord.index, 0, fileRecord.item)
                return newItems
              })
            }
            // Decrement the processed counter on undo
            setItemsProcessedToday((prev) => Math.max(0, prev - 1))
          },
        })
      }, 200)
    },
    [items, addToast]
  )

  // Handle preview action - toggle preview panel
  const handlePreview = useCallback((id: string): void => {
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
  }, [isFilingPanelOpen, isPreviewPanelOpen, previewingItemId])

  // Handle preview panel close
  const handlePreviewPanelClose = useCallback((): void => {
    setIsPreviewPanelOpen(false)
    setPreviewingItemId(null)
  }, [])

  // Handle focused item change (for navigation while preview is open)
  const handleFocusedItemChange = useCallback((id: string | null): void => {
    setFocusedItemId(id)

    // If preview panel is open, update the preview to show the newly focused item
    if (isPreviewPanelOpen && id) {
      setPreviewingItemId(id)
    }
  }, [isPreviewPanelOpen])

  // Handle delete action with undo support and animation
  const handleDelete = useCallback((id: string): void => {
    const itemIndex = items.findIndex((item) => item.id === id)
    if (itemIndex === -1) return

    const deletedItem = items[itemIndex]
    const willBeEmpty = items.length === 1

    // Start exit animation
    setExitingItemIds((prev) => new Set(prev).add(id))

    // If we're deleting the previewed item, close the preview
    if (previewingItemId === id) {
      setIsPreviewPanelOpen(false)
      setPreviewingItemId(null)
    }

    // After exit animation (200ms), remove item and show empty state if needed
    setTimeout(() => {
      // Remove item from list
      setItems((prev) => prev.filter((item) => item.id !== id))

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
        }, 200) // 200ms pause before showing empty state
      }

      // Store deleted item for potential undo
      const deleteRecord: DeletedItem = { item: deletedItem, index: itemIndex }
      setDeletedItems((prev) => [...prev, deleteRecord])

      // Show toast with undo option
      addToast({
        message: "Item deleted",
        type: "success",
        onUndo: () => {
          // If empty state is showing, animate it out first
          if (willBeEmpty) {
            setIsEmptyStateExiting(true)
            setTimeout(() => {
              setShowEmptyState(false)
              setIsEmptyStateExiting(false)
              // Restore item to original position
              setItems((prev) => {
                const newItems = [...prev]
                newItems.splice(deleteRecord.index, 0, deleteRecord.item)
                return newItems
              })
            }, 150) // Empty state exit animation
          } else {
            // Restore item to original position
            setItems((prev) => {
              const newItems = [...prev]
              newItems.splice(deleteRecord.index, 0, deleteRecord.item)
              return newItems
            })
          }
          // Remove from deleted items
          setDeletedItems((prev) =>
            prev.filter((d) => d.item.id !== deleteRecord.item.id)
          )
          // Decrement the processed counter on undo
          setItemsProcessedToday((prev) => Math.max(0, prev - 1))
        },
      })
    }, 200) // Item exit animation duration
  }, [items, addToast, previewingItemId])

  // === BULK ACTION HANDLERS ===

  // Handle bulk file all
  const handleBulkFileAll = useCallback((): void => {
    setIsBulkFilePanelOpen(true)
  }, [])

  // Handle bulk file complete
  const handleBulkFileComplete = useCallback(
    (itemIds: string[], folderId: string, tags: string[]): void => {
      const folder = sampleFolders.find((f) => f.id === folderId)
      const processedCount = itemIds.length

      // Store items for undo
      const filedItemsWithIndexes = itemIds.map((id) => {
        const index = items.findIndex((item) => item.id === id)
        const item = items[index]
        return { item, index }
      }).filter((record) => record.item !== undefined)

      // Remove items from inbox
      setItems((prev) => prev.filter((item) => !itemIds.includes(item.id)))

      // Clear selection
      setSelectedItemIds(new Set())

      // Increment items processed counter and mark filing history
      setItemsProcessedToday((prev) => prev + processedCount)
      setHasFilingHistory(true)

      // Show toast with undo option
      addToast({
        message: `Filed ${itemIds.length} items to ${folder?.name || "folder"}`,
        type: "success",
        onUndo: () => {
          // Restore all items to their original positions (in reverse order to maintain indexes)
          setItems((prev) => {
            const newItems = [...prev]
            filedItemsWithIndexes
              .sort((a, b) => a.index - b.index)
              .forEach(({ item, index }) => {
                newItems.splice(index, 0, item)
              })
            return newItems
          })
          // Decrement the processed counter on undo
          setItemsProcessedToday((prev) => Math.max(0, prev - processedCount))
        },
      })
    },
    [items, addToast]
  )

  // Handle bulk tag all
  const handleBulkTagAll = useCallback((): void => {
    setIsBulkTagPopoverOpen(true)
  }, [])

  // Handle bulk tag apply
  const handleBulkTagApply = useCallback(
    (tags: string[]): void => {
      // In a real app, this would update the tags on each selected item
      // For now, we just show a success toast
      addToast({
        message: `Applied ${tags.length} tag${tags.length !== 1 ? "s" : ""} to ${selectedCount} item${selectedCount !== 1 ? "s" : ""}`,
        type: "success",
      })

      // Keep selection - tagging doesn't remove items from inbox
    },
    [addToast, selectedCount]
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

    // Store items for undo
    const deletedItemsWithIndexes = idsToDelete.map((id) => {
      const index = items.findIndex((item) => item.id === id)
      const item = items[index]
      return { item, index }
    }).filter((record) => record.item !== undefined)

    // Close dialog immediately
    setIsDeleteDialogOpen(false)

    // Start exit animation for all items
    setExitingItemIds(new Set(idsToDelete))

    // Close the preview if any deleted item was being previewed
    if (previewingItemId && idsToDelete.includes(previewingItemId)) {
      setIsPreviewPanelOpen(false)
      setPreviewingItemId(null)
    }

    // After exit animation, remove items
    setTimeout(() => {
      // Remove items from inbox
      setItems((prev) => prev.filter((item) => !idsToDelete.includes(item.id)))

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

      // Show toast with undo option
      addToast({
        message: `Deleted ${idsToDelete.length} item${idsToDelete.length !== 1 ? "s" : ""}`,
        type: "success",
        onUndo: () => {
          // If empty state is showing, animate it out first
          if (willBeEmpty) {
            setIsEmptyStateExiting(true)
            setTimeout(() => {
              setShowEmptyState(false)
              setIsEmptyStateExiting(false)
              // Restore all items to their original positions
              setItems((prev) => {
                const newItems = [...prev]
                deletedItemsWithIndexes
                  .sort((a, b) => a.index - b.index)
                  .forEach(({ item, index }) => {
                    newItems.splice(index, 0, item)
                  })
                return newItems
              })
            }, 150)
          } else {
            // Restore all items to their original positions
            setItems((prev) => {
              const newItems = [...prev]
              deletedItemsWithIndexes
                .sort((a, b) => a.index - b.index)
                .forEach(({ item, index }) => {
                  newItems.splice(index, 0, item)
                })
              return newItems
            })
          }
          // Decrement the processed counter on undo
          setItemsProcessedToday((prev) => Math.max(0, prev - processedCount))
        },
      })
    }, 200)
  }, [selectedItemIds, items, previewingItemId, addToast])

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

  // === STALE ITEMS HANDLERS ===

  // Handle "File all to Unsorted" action for stale items
  const handleFileAllStaleToUnsorted = useCallback((): void => {
    if (staleItems.length === 0) return

    const unsortedFolder = sampleFolders.find((f) => f.id === UNSORTED_FOLDER_ID)
    const processedCount = staleItems.length

    // Store items with their original indexes for undo
    const staleItemsWithIndexes = staleItems.map((item) => {
      const index = items.findIndex((i) => i.id === item.id)
      return { item, index }
    })

    // Start exit animation for all stale items
    setExitingItemIds(new Set(staleItems.map((i) => i.id)))

    // After animation, remove items
    setTimeout(() => {
      // Remove stale items from inbox
      setItems((prev) => prev.filter((item) => !staleItems.some((s) => s.id === item.id)))

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

      // Show toast with undo option
      addToast({
        message: `Filed ${processedCount} items to ${unsortedFolder?.name || "Unsorted"}`,
        type: "success",
        onUndo: () => {
          // Restore all stale items to their original positions
          setItems((prev) => {
            const newItems = [...prev]
            staleItemsWithIndexes
              .sort((a, b) => a.index - b.index)
              .forEach(({ item, index }) => {
                newItems.splice(index, 0, item)
              })
            return newItems
          })
          // Decrement the processed counter
          setItemsProcessedToday((prev) => Math.max(0, prev - processedCount))
        },
      })
    }, 200)
  }, [staleItems, items, addToast])

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

  // Calculate today's items count for header
  const todayItemsCount = useMemo(() => {
    const today = new Date()
    return items.filter((item) => {
      const itemDate = item.timestamp
      return (
        itemDate.getDate() === today.getDate() &&
        itemDate.getMonth() === today.getMonth() &&
        itemDate.getFullYear() === today.getFullYear()
      )
    }).length
  }, [items])

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header: Title + Badge + View Toggle OR Bulk Selection Header */}
      <div className="flex items-center justify-between mb-6">
        {isInBulkMode ? (
          // Bulk Selection Header
          <>
            <div className="flex items-center gap-2">
              <Check className="size-5 text-[var(--primary)]" aria-hidden="true" />
              <h1 className="text-2xl font-semibold text-foreground">
                {selectedCount} selected
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeselectAll}
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                Deselect all
              </Button>
              <ToggleGroup
                type="single"
                value={viewMode}
                onValueChange={handleViewChange}
                className="gap-1"
              >
                <ToggleGroupItem value="list" aria-label="List view">
                  <List className="size-4" />
                </ToggleGroupItem>
                <ToggleGroupItem value="card" aria-label="Grid view">
                  <Grid className="size-4" />
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </>
        ) : (
          // Normal Header
          <>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-foreground">Inbox</h1>
              <Badge variant="secondary" className="text-muted-foreground">
                {items.length} items{todayItemsCount > 0 && ` · ${todayItemsCount} from today`}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {items.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSelectAll}
                  className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  Select all
                </Button>
              )}
              <ToggleGroup
                type="single"
                value={viewMode}
                onValueChange={handleViewChange}
                className="gap-1"
              >
                <ToggleGroupItem value="list" aria-label="List view">
                  <List className="size-4" />
                </ToggleGroupItem>
                <ToggleGroupItem value="card" aria-label="Grid view">
                  <Grid className="size-4" />
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </>
        )}
      </div>

      {/* Content: Scrollable area with view-based rendering or empty state */}
      <div className={cn("flex-1 overflow-y-auto px-1", isInBulkMode && "pb-32")}>
        {showEmptyState ? (
          <EmptyState
            itemsProcessedToday={itemsProcessedToday}
            hasFilingHistory={hasFilingHistory}
            isExiting={isEmptyStateExiting}
          />
        ) : viewMode === "list" ? (
          <ListView
            items={nonStaleItems}
            staleItems={staleItems}
            selectedItemIds={selectedItemIds}
            exitingItemIds={exitingItemIds}
            onFile={handleFile}
            onPreview={handlePreview}
            onDelete={handleDelete}
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
