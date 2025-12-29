/**
 * CardView Component
 *
 * Card-based display for inbox items with editorial styling,
 * warm amber accents, and multi-selection support.
 * Uses InboxCardSection and InboxCard components.
 */

import { useState, useEffect, useCallback, useRef } from 'react'

import { InboxCardSection, InboxCard } from '@/components/inbox'
import { StaleSection } from '@/components/stale/stale-section'
import { groupItemsByTimePeriod } from '@/lib/inbox-utils'
import type { InboxItemListItem } from '@/types'

type InboxItem = InboxItemListItem

interface CardViewProps {
  items: InboxItem[]
  staleItems?: InboxItem[]
  selectedItemIds: Set<string>
  exitingItemIds?: Set<string>
  onFile: (id: string) => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
  onSnooze?: (id: string, snoozeUntil: string) => void
  onSelectionChange: (selectedIds: Set<string>) => void
  onFileAllStale?: () => void
  onReviewStale?: () => void
  focusedItemId?: string | null
  onFocusedItemChange?: (id: string | null) => void
  isPreviewOpen?: boolean
}

const CardView = ({
  items,
  staleItems = [],
  selectedItemIds,
  exitingItemIds = new Set(),
  onFile,
  onPreview,
  onDelete,
  onSnooze,
  onSelectionChange,
  onFileAllStale,
  onReviewStale,
  focusedItemId: controlledFocusedItemId,
  onFocusedItemChange,
  isPreviewOpen: _isPreviewOpen = false
}: CardViewProps): React.JSX.Element => {
  void _isPreviewOpen // Reserved for future use
  const containerRef = useRef<HTMLDivElement>(null)
  const groupedItems = groupItemsByTimePeriod(items)

  // Flatten all items (stale + regular) for keyboard navigation
  const flatItems = [...staleItems, ...groupedItems.flatMap((group) => group.items)]

  // Track last selected item for shift-click range selection
  const lastSelectedIdRef = useRef<string | null>(null)

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

  const isInBulkMode = selectedItemIds.size > 0

  // Reset focus when items change
  useEffect(() => {
    if (flatItems.length > 0 && !flatItems.find((i) => i.id === focusedItemId)) {
      const newFocusId = flatItems[0]?.id || null
      setFocusedItemId(newFocusId)
    }
  }, [flatItems, focusedItemId, setFocusedItemId])

  // Grid navigation - assume 3 columns on large screens, 2 on medium, 1 on small
  const getColumnsCount = (): number => {
    if (typeof window !== 'undefined') {
      if (window.innerWidth >= 1024) return 3
      if (window.innerWidth >= 640) return 2
      return 1
    }
    return 3
  }

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

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      const currentIndex = flatItems.findIndex((i) => i.id === focusedItemId)
      const columns = getColumnsCount()

      switch (e.key) {
        case ' ':
          e.preventDefault()
          if (focusedItemId) {
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
          if (currentIndex + columns < flatItems.length) {
            const nextId = flatItems[currentIndex + columns].id
            setFocusedItemId(nextId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(nextId, false)
            }
          } else if (currentIndex < flatItems.length - 1) {
            const nextId = flatItems[flatItems.length - 1].id
            setFocusedItemId(nextId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(nextId, false)
            }
          }
          break

        case 'ArrowUp':
        case 'k':
          e.preventDefault()
          if (currentIndex - columns >= 0) {
            const prevId = flatItems[currentIndex - columns].id
            setFocusedItemId(prevId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(prevId, false)
            }
          } else if (currentIndex > 0) {
            const prevId = flatItems[0].id
            setFocusedItemId(prevId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(prevId, false)
            }
          }
          break

        case 'ArrowRight':
        case 'l':
          e.preventDefault()
          if (currentIndex < flatItems.length - 1) {
            const nextId = flatItems[currentIndex + 1].id
            setFocusedItemId(nextId)
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(nextId, false)
            }
          }
          break

        case 'ArrowLeft':
        case 'h':
          e.preventDefault()
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
          if (flatItems.length > 0) {
            setFocusedItemId(flatItems[0].id)
          }
          break

        case 'End':
          e.preventDefault()
          if (flatItems.length > 0) {
            setFocusedItemId(flatItems[flatItems.length - 1].id)
          }
          break

        case 'PageDown':
          e.preventDefault()
          if (flatItems.length > 0) {
            const targetIndex = Math.min(currentIndex + 10, flatItems.length - 1)
            setFocusedItemId(flatItems[targetIndex].id)
          }
          break

        case 'PageUp':
          e.preventDefault()
          if (flatItems.length > 0) {
            const targetIndex = Math.max(currentIndex - 10, 0)
            setFocusedItemId(flatItems[targetIndex].id)
          }
          break

        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          if (focusedItemId) {
            onDelete(focusedItemId)
          }
          break

        case 'o':
        case 'O':
          if (focusedItemId) {
            const focusedItem = flatItems.find((i) => i.id === focusedItemId)
            if (focusedItem?.type === 'link' && focusedItem.sourceUrl) {
              e.preventDefault()
              window.open(focusedItem.sourceUrl, '_blank', 'noopener,noreferrer')
            }
          }
          break

        case 'Enter':
          if (focusedItemId) {
            e.preventDefault()
            onFile(focusedItemId)
          }
          break

        case 'Escape':
          if (isInBulkMode) {
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
      onPreview,
      onFile,
      onDelete,
      setFocusedItemId,
      handleSelectionToggle,
      isInBulkMode,
      onSelectionChange
    ]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const handleItemFocus = useCallback(
    (id: string): void => {
      setFocusedItemId(id)
    },
    [setFocusedItemId]
  )

  return (
    <div ref={containerRef} className="space-y-8" role="list" aria-label="Inbox items">
      {/* Stale Items Section - appears at top when there are stale items */}
      {staleItems.length > 0 && onFileAllStale && onReviewStale && (
        <StaleSection
          items={staleItems}
          viewMode="card"
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

      {/* Regular time-grouped items using InboxCardSection */}
      {groupedItems.map((group) => (
        <InboxCardSection
          key={group.period}
          title={group.period}
          count={group.items.length}
          selectedIds={selectedItemIds}
          focusedId={focusedItemId}
          onSelect={handleSelectionToggle}
          onFocus={handleItemFocus}
        >
          {group.items.map((item) => (
            <InboxCard
              key={item.id}
              item={item}
              period={group.period}
              isExiting={exitingItemIds.has(item.id)}
              onFile={onFile}
              onPreview={onPreview}
              onDelete={onDelete}
              onSnooze={onSnooze}
            />
          ))}
        </InboxCardSection>
      ))}
    </div>
  )
}

export { CardView, type CardViewProps }
