/**
 * ListView Component
 *
 * List-based display for inbox items with editorial styling,
 * warm amber accents, and multi-selection support.
 * Uses InboxListSection and InboxListItem components.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'

import { InboxListSection, InboxListItem } from '@/components/inbox'
import { StaleSection } from '@/components/stale/stale-section'
import { getFilteredFolders } from '@/components/quick-file-dropdown'
import { groupItemsByTimePeriod } from '@/lib/inbox-utils'
import { useRetryTranscription } from '@/hooks/use-inbox'
import type { InboxItemListItem, Folder } from '@/types'

type InboxItem = InboxItemListItem

interface ListViewProps {
  items: InboxItem[]
  staleItems?: InboxItem[]
  selectedItemIds: Set<string>
  exitingItemIds?: Set<string>
  onFile: (id: string) => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
  onSnooze?: (id: string, snoozeUntil: string) => void
  onQuickFile: (itemId: string, folderId: string) => void
  onSelectionChange: (selectedIds: Set<string>) => void
  onFileAllStale?: () => void
  onReviewStale?: () => void
  focusedItemId?: string | null
  onFocusedItemChange?: (id: string | null) => void
  isPreviewOpen?: boolean
}

const ListView = ({
  items,
  staleItems = [],
  selectedItemIds,
  exitingItemIds = new Set(),
  onFile,
  onPreview,
  onDelete,
  onSnooze,
  onQuickFile,
  onSelectionChange,
  onFileAllStale,
  onReviewStale,
  focusedItemId: controlledFocusedItemId,
  onFocusedItemChange,
  isPreviewOpen = false
}: ListViewProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null)
  const groupedItems = groupItemsByTimePeriod(items)

  // Hook for retrying failed transcriptions
  const retryTranscription = useRetryTranscription()

  const handleRetryTranscription = useCallback(
    (itemId: string) => {
      retryTranscription.mutate(itemId)
    },
    [retryTranscription]
  )

  // Flatten all items (stale + regular) for keyboard navigation
  const flatItems = [...staleItems, ...groupedItems.flatMap((group) => group.items)]

  // Track last selected item for shift-click range selection
  const lastSelectedIdRef = useRef<string | null>(null)

  // Fetch real folders from vault for quick-file feature
  const { data: vaultFolders = [] } = useQuery({
    queryKey: ['vault', 'folders'],
    queryFn: async () => {
      const paths = await window.api.notes.getFolders()
      const folders: Folder[] = [{ id: '', name: 'Notes (root)', path: '' }]
      for (const path of paths) {
        if (path) {
          folders.push({
            id: path,
            name: path.split('/').pop() || path,
            path: path,
            parent: path.includes('/') ? path.split('/').slice(0, -1).join('/') : undefined
          })
        }
      }
      return folders
    }
  })

  // State - use controlled focus if provided, otherwise internal state
  const [internalFocusedItemId, setInternalFocusedItemId] = useState<string | null>(
    flatItems[0]?.id || null
  )
  const focusedItemId =
    controlledFocusedItemId !== undefined ? controlledFocusedItemId : internalFocusedItemId

  const setFocusedItemId = useCallback(
    (id: string | null): void => {
      if (controlledFocusedItemId === undefined) {
        setInternalFocusedItemId(id)
      }
      onFocusedItemChange?.(id)
    },
    [controlledFocusedItemId, onFocusedItemChange]
  )

  const [quickFileItemId, setQuickFileItemId] = useState<string | null>(null)
  const [quickFileQuery, setQuickFileQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  const isInBulkMode = selectedItemIds.size > 0

  // Reset focus when items change
  useEffect(() => {
    if (flatItems.length > 0 && !flatItems.find((i) => i.id === focusedItemId)) {
      const newFocusId = flatItems[0]?.id || null
      setFocusedItemId(newFocusId)
    }
  }, [flatItems, focusedItemId, setFocusedItemId])

  // Get filtered folders for current query
  const filteredFolders = getFilteredFolders(vaultFolders, quickFileQuery, 5)

  // Reset highlighted index when query changes
  useEffect(() => {
    setHighlightedIndex(0)
  }, [quickFileQuery])

  // Handle selection toggle with shift-click support
  const handleSelectionToggle = useCallback(
    (id: string, shiftKey: boolean): void => {
      const newSelection = new Set(selectedItemIds)

      if (shiftKey && lastSelectedIdRef.current) {
        const lastIndex = flatItems.findIndex((i) => i.id === lastSelectedIdRef.current)
        const currentIndex = flatItems.findIndex((i) => i.id === id)

        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex)
          const end = Math.max(lastIndex, currentIndex)

          for (let i = start; i <= end; i++) {
            newSelection.add(flatItems[i].id)
          }
        }
      } else {
        if (newSelection.has(id)) {
          newSelection.delete(id)
        } else {
          newSelection.add(id)
        }
      }

      lastSelectedIdRef.current = id
      onSelectionChange(newSelection)
    },
    [selectedItemIds, flatItems, onSelectionChange]
  )

  // Quick-File folder select handler
  const handleQuickFileFolderSelect = useCallback(
    (folder: Folder): void => {
      if (quickFileItemId) {
        onQuickFile(quickFileItemId, folder.id)

        const currentIndex = flatItems.findIndex((i) => i.id === quickFileItemId)
        const nextItem = flatItems[currentIndex + 1] || flatItems[currentIndex - 1]
        if (nextItem) {
          setFocusedItemId(nextItem.id)
        }

        setQuickFileItemId(null)
        setQuickFileQuery('')
      }
    },
    [quickFileItemId, onQuickFile, flatItems, setFocusedItemId]
  )

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      const currentIndex = flatItems.findIndex((i) => i.id === focusedItemId)

      switch (e.key) {
        case ' ':
          e.preventDefault()
          if (focusedItemId && !quickFileItemId) {
            onPreview(focusedItemId)
          }
          break

        case 'x':
        case 'X':
          if (focusedItemId) {
            e.preventDefault()
            handleSelectionToggle(focusedItemId, e.shiftKey)
          }
          break

        case 'ArrowDown':
        case 'j':
          e.preventDefault()
          if (quickFileItemId) return
          if (currentIndex < flatItems.length - 1) {
            const nextId = flatItems[currentIndex + 1].id
            setFocusedItemId(nextId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(nextId, false)
            }
          }
          break

        case 'ArrowUp':
        case 'k':
          e.preventDefault()
          if (quickFileItemId) return
          if (currentIndex > 0) {
            const prevId = flatItems[currentIndex - 1].id
            setFocusedItemId(prevId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(prevId, false)
            }
          }
          break

        case 'Home':
          e.preventDefault()
          if (quickFileItemId) return
          if (flatItems.length > 0) {
            setFocusedItemId(flatItems[0].id)
          }
          break

        case 'End':
          e.preventDefault()
          if (quickFileItemId) return
          if (flatItems.length > 0) {
            setFocusedItemId(flatItems[flatItems.length - 1].id)
          }
          break

        case 'PageDown':
          e.preventDefault()
          if (quickFileItemId) return
          if (flatItems.length > 0) {
            const targetIndex = Math.min(currentIndex + 10, flatItems.length - 1)
            setFocusedItemId(flatItems[targetIndex].id)
          }
          break

        case 'PageUp':
          e.preventDefault()
          if (quickFileItemId) return
          if (flatItems.length > 0) {
            const targetIndex = Math.max(currentIndex - 10, 0)
            setFocusedItemId(flatItems[targetIndex].id)
          }
          break

        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          if (quickFileItemId) return
          if (focusedItemId) {
            onDelete(focusedItemId)
          }
          break

        case 'o':
        case 'O':
          if (focusedItemId && !quickFileItemId) {
            const focusedItem = flatItems.find((i) => i.id === focusedItemId)
            if (focusedItem?.type === 'link' && focusedItem.sourceUrl) {
              e.preventDefault()
              window.open(focusedItem.sourceUrl, '_blank', 'noopener,noreferrer')
            }
          }
          break

        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
          if (quickFileItemId && filteredFolders.length > 0) {
            const index = parseInt(e.key, 10) - 1
            if (index < filteredFolders.length) {
              e.preventDefault()
              handleQuickFileFolderSelect(filteredFolders[index])
            }
          }
          break

        case '.':
        case 'f':
        case 'F':
          if (focusedItemId && !quickFileItemId && !isInBulkMode) {
            e.preventDefault()
            setQuickFileItemId(focusedItemId)
            setQuickFileQuery('')
            setHighlightedIndex(0)
          }
          break

        case 'Enter':
          if (isPreviewOpen && focusedItemId) {
            e.preventDefault()
            onFile(focusedItemId)
          }
          break

        case 'Escape':
          if (quickFileItemId) {
            e.preventDefault()
            setQuickFileItemId(null)
            setQuickFileQuery('')
          } else if (isInBulkMode) {
            e.preventDefault()
            onSelectionChange(new Set())
          }
          break

        case 'a':
        case 'A':
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            const allIds = new Set(flatItems.map((i) => i.id))
            onSelectionChange(allIds)
          }
          break
      }
    },
    [
      flatItems,
      focusedItemId,
      quickFileItemId,
      filteredFolders,
      onPreview,
      onFile,
      onDelete,
      isPreviewOpen,
      setFocusedItemId,
      handleSelectionToggle,
      handleQuickFileFolderSelect,
      isInBulkMode,
      onSelectionChange
    ]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Click outside to cancel Quick-File
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (quickFileItemId && containerRef.current) {
        const target = e.target as HTMLElement
        const itemRow = target.closest(`[data-item-id="${quickFileItemId}"]`)
        if (!itemRow) {
          setQuickFileItemId(null)
          setQuickFileQuery('')
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [quickFileItemId])

  // Quick-File handlers
  const handleQuickFileQueryChange = useCallback((query: string): void => {
    setQuickFileQuery(query)
  }, [])

  const handleQuickFileSubmit = useCallback((): void => {
    if (quickFileItemId && filteredFolders[highlightedIndex]) {
      const folder = filteredFolders[highlightedIndex]
      onQuickFile(quickFileItemId, folder.id)

      const currentIndex = flatItems.findIndex((i) => i.id === quickFileItemId)
      const nextItem = flatItems[currentIndex + 1] || flatItems[currentIndex - 1]
      if (nextItem) {
        setFocusedItemId(nextItem.id)
      }

      setQuickFileItemId(null)
      setQuickFileQuery('')
    }
  }, [quickFileItemId, filteredFolders, highlightedIndex, onQuickFile, flatItems, setFocusedItemId])

  const handleQuickFileCancel = useCallback((): void => {
    setQuickFileItemId(null)
    setQuickFileQuery('')
  }, [])

  const handleQuickFileArrowDown = useCallback((): void => {
    if (filteredFolders.length > 0) {
      setHighlightedIndex((prev) => (prev < filteredFolders.length - 1 ? prev + 1 : prev))
    }
  }, [filteredFolders.length])

  const handleQuickFileArrowUp = useCallback((): void => {
    if (filteredFolders.length > 0) {
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev))
    }
  }, [filteredFolders.length])

  const handleItemFocus = useCallback(
    (id: string): void => {
      setFocusedItemId(id)
      if (quickFileItemId && quickFileItemId !== id) {
        setQuickFileItemId(null)
        setQuickFileQuery('')
      }
    },
    [quickFileItemId, setFocusedItemId]
  )

  return (
    <div ref={containerRef} className="space-y-6" role="list" aria-label="Inbox items">
      {/* Stale Items Section - appears at top when there are stale items */}
      {staleItems.length > 0 && onFileAllStale && onReviewStale && (
        <StaleSection
          items={staleItems}
          viewMode="list"
          selectedItemIds={selectedItemIds}
          exitingItemIds={exitingItemIds}
          focusedItemId={focusedItemId}
          onFile={onFile}
          onPreview={onPreview}
          onDelete={onDelete}
          onFocus={handleItemFocus}
          onSelectionToggle={handleSelectionToggle}
          onFileAllToUnsorted={onFileAllStale}
          onReviewOneByOne={onReviewStale}
        />
      )}

      {/* Regular time-grouped items using InboxListSection */}
      {groupedItems.map((group, groupIndex) => (
        <InboxListSection
          key={group.period}
          title={group.period}
          count={group.items.length}
          selectedIds={selectedItemIds}
          focusedId={focusedItemId}
          onSelect={handleSelectionToggle}
          onFocus={handleItemFocus}
        >
          {group.items.map((item) => (
            <InboxListItem
              key={item.id}
              item={item}
              period={group.period}
              isExiting={exitingItemIds.has(item.id)}
              isQuickFileActive={quickFileItemId === item.id}
              quickFileQuery={quickFileQuery}
              quickFileHighlightedIndex={highlightedIndex}
              folders={vaultFolders}
              onFile={onFile}
              onPreview={onPreview}
              onDelete={onDelete}
              onSnooze={onSnooze}
              onQuickFileQueryChange={handleQuickFileQueryChange}
              onQuickFileSubmit={handleQuickFileSubmit}
              onQuickFileCancel={handleQuickFileCancel}
              onQuickFileArrowDown={handleQuickFileArrowDown}
              onQuickFileArrowUp={handleQuickFileArrowUp}
              onQuickFileFolderSelect={handleQuickFileFolderSelect}
              onRetryTranscription={handleRetryTranscription}
            />
          ))}

          {/* Visual separator between sections (except last) */}
          {groupIndex < groupedItems.length - 1 && (
            <div className="h-px bg-gradient-to-r from-border/30 to-transparent mt-4" aria-hidden="true" />
          )}
        </InboxListSection>
      ))}
    </div>
  )
}

export { ListView, type ListViewProps }
