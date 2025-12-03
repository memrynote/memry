import { useState, useEffect, useCallback, useRef } from "react"
import { Link, FileText, Image, Mic } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { QuickActions } from "@/components/quick-actions"
import { InlineQuickFile } from "@/components/inline-quick-file"
import { QuickFileDropdown, getFilteredFolders } from "@/components/quick-file-dropdown"
import { StaleSection } from "@/components/stale/stale-section"
import { sampleFolders } from "@/data/filing-data"
import {
  groupItemsByTimePeriod,
  formatTimestamp,
  formatDuration,
  type TimePeriod,
} from "@/lib/inbox-utils"
import { cn } from "@/lib/utils"
import type { InboxItem, InboxItemType, Folder } from "@/types"

// Icon component based on item type
const TypeIcon = ({ type }: { type: InboxItemType }): React.JSX.Element => {
  const iconClass = "size-4 text-[var(--muted-foreground)]"

  switch (type) {
    case "link":
      return <Link className={iconClass} aria-hidden="true" />
    case "note":
      return <FileText className={iconClass} aria-hidden="true" />
    case "image":
      return <Image className={iconClass} aria-hidden="true" />
    case "voice":
      return <Mic className={iconClass} aria-hidden="true" />
  }
}

// Individual item row component
interface InboxItemRowProps {
  item: InboxItem
  period: TimePeriod
  isFocused: boolean
  isSelected: boolean
  isInBulkMode: boolean
  isQuickFileActive: boolean
  quickFileQuery: string
  quickFileHighlightedIndex: number
  isExiting?: boolean
  onFile: (id: string) => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
  onFocus: (id: string) => void
  onSelectionToggle: (id: string, shiftKey: boolean) => void
  onQuickFileQueryChange: (query: string) => void
  onQuickFileSubmit: () => void
  onQuickFileCancel: () => void
  onQuickFileArrowDown: () => void
  onQuickFileArrowUp: () => void
  onQuickFileFolderSelect: (folder: Folder) => void
}

const InboxItemRow = ({
  item,
  period,
  isFocused,
  isSelected,
  isInBulkMode,
  isQuickFileActive,
  quickFileQuery,
  quickFileHighlightedIndex,
  isExiting = false,
  onFile,
  onPreview,
  onDelete,
  onFocus,
  onSelectionToggle,
  onQuickFileQueryChange,
  onQuickFileSubmit,
  onQuickFileCancel,
  onQuickFileArrowDown,
  onQuickFileArrowUp,
  onQuickFileFolderSelect,
}: InboxItemRowProps): React.JSX.Element => {
  // Compute filtered folders for number key shortcuts
  const filteredFolders = getFilteredFolders(sampleFolders, quickFileQuery, 5)

  // Format title for voice memos
  const displayTitle =
    item.type === "voice" && item.duration
      ? `${item.title} · ${formatDuration(item.duration)}`
      : item.title

  const handleClick = (): void => {
    onFocus(item.id)
  }

  const handleCheckboxClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onSelectionToggle(item.id, e.shiftKey)
  }

  const handleCheckboxChange = (checked: boolean | "indeterminate"): void => {
    // This is called when clicking the checkbox directly
    // The actual toggle is handled in handleCheckboxClick for shift-key support
  }

  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 py-2 px-3 rounded-md cursor-pointer",
        // Smooth transitions using animation tokens
        "transition-[background-color,box-shadow,opacity,transform] duration-[var(--duration-instant)] ease-[var(--ease-out)]",
        // Exit animation with height collapse
        isExiting && "item-removing",
        // Selection/focus states with smooth transitions (using inset ring to prevent overflow)
        isSelected
          ? "bg-primary/10 ring-1 ring-inset ring-primary/30"
          : isFocused
            ? "bg-muted ring-2 ring-inset ring-primary/50"
            : "hover:bg-muted"
      )}
      role="listitem"
      tabIndex={isFocused ? 0 : -1}
      aria-label={`${item.type}: ${displayTitle}`}
      aria-selected={isSelected}
      onClick={handleClick}
      data-item-id={item.id}
    >
      {/* Checkbox - more visible in bulk mode or on hover/focus */}
      <Checkbox
        id={`item-${item.id}`}
        checked={isSelected}
        onCheckedChange={handleCheckboxChange}
        className={cn(
          "shrink-0 transition-opacity duration-[var(--duration-instant)] ease-[var(--ease-out)]",
          isSelected
            ? "opacity-100"
            : isInBulkMode
              ? "opacity-80"
              : isFocused
                ? "opacity-100"
                : "opacity-60 group-hover:opacity-100"
        )}
        aria-label={`Select ${displayTitle}`}
        onClick={handleCheckboxClick}
      />

      {/* Type Icon */}
      <TypeIcon type={item.type} />

      {/* Content area - shows title or Quick-File input */}
      {isQuickFileActive ? (
        <>
          {/* Truncated title */}
          <span className="text-sm text-[var(--foreground)] truncate max-w-[40%] shrink-0">
            {displayTitle}
          </span>

          {/* Inline Quick-File input */}
          <InlineQuickFile
            query={quickFileQuery}
            onQueryChange={onQuickFileQueryChange}
            onSubmit={onQuickFileSubmit}
            onCancel={onQuickFileCancel}
            onArrowDown={onQuickFileArrowDown}
            onArrowUp={onQuickFileArrowUp}
            filteredFolders={filteredFolders}
            onFolderSelect={onQuickFileFolderSelect}
          />

          {/* Dropdown */}
          <QuickFileDropdown
            folders={sampleFolders}
            query={quickFileQuery}
            highlightedIndex={quickFileHighlightedIndex}
            onSelect={onQuickFileFolderSelect}
          />
        </>
      ) : (
        <>
          {/* Title - truncates with ellipsis */}
          <span className="flex-1 text-sm text-[var(--foreground)] truncate min-w-0">
            {displayTitle}
          </span>

          {/* Timestamp - fades out on hover when actions show (unless in bulk mode) */}
          <span className={cn(
            "shrink-0 text-xs text-muted-foreground tabular-nums",
            "transition-opacity duration-[var(--duration-instant)] ease-[var(--ease-in)]",
            isInBulkMode ? "opacity-100" : "group-hover:opacity-0"
          )}>
            {formatTimestamp(item.timestamp, period)}
          </span>

          {/* Quick Actions - slide in from right on hover (hidden in bulk mode) */}
          {!isInBulkMode && (
            <div className="shrink-0 quick-actions-reveal">
              <QuickActions
                itemId={item.id}
                onFile={onFile}
                onPreview={onPreview}
                onDelete={onDelete}
                variant="row"
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Section header component
const SectionHeader = ({ period }: { period: TimePeriod }): React.JSX.Element => {
  return (
    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]/70 mb-1">
      {period}
    </h3>
  )
}

// Main ListView component
interface ListViewProps {
  items: InboxItem[]
  staleItems?: InboxItem[]
  selectedItemIds: Set<string>
  exitingItemIds?: Set<string>
  onFile: (id: string) => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
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
  onQuickFile,
  onSelectionChange,
  onFileAllStale,
  onReviewStale,
  focusedItemId: controlledFocusedItemId,
  onFocusedItemChange,
  isPreviewOpen = false,
}: ListViewProps): React.JSX.Element => {
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
  const focusedItemId = controlledFocusedItemId !== undefined ? controlledFocusedItemId : internalFocusedItemId

  const setFocusedItemId = useCallback((id: string | null): void => {
    if (controlledFocusedItemId === undefined) {
      setInternalFocusedItemId(id)
    }
    onFocusedItemChange?.(id)
  }, [controlledFocusedItemId, onFocusedItemChange])

  const [quickFileItemId, setQuickFileItemId] = useState<string | null>(null)
  const [quickFileQuery, setQuickFileQuery] = useState("")
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
  const filteredFolders = getFilteredFolders(sampleFolders, quickFileQuery, 5)

  // Reset highlighted index when query changes
  useEffect(() => {
    setHighlightedIndex(0)
  }, [quickFileQuery])

  // Handle selection toggle with shift-click support
  const handleSelectionToggle = useCallback((id: string, shiftKey: boolean): void => {
    const newSelection = new Set(selectedItemIds)

    if (shiftKey && lastSelectedIdRef.current) {
      // Range selection
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
      // Toggle single item
      if (newSelection.has(id)) {
        newSelection.delete(id)
      } else {
        newSelection.add(id)
      }
    }

    lastSelectedIdRef.current = id
    onSelectionChange(newSelection)
  }, [selectedItemIds, flatItems, onSelectionChange])

  // Quick-File folder select handler (moved before handleKeyDown for use in keyboard shortcuts)
  const handleQuickFileFolderSelect = useCallback(
    (folder: Folder): void => {
      if (quickFileItemId) {
        onQuickFile(quickFileItemId, folder.id)

        // Move focus to next item
        const currentIndex = flatItems.findIndex((i) => i.id === quickFileItemId)
        const nextItem = flatItems[currentIndex + 1] || flatItems[currentIndex - 1]
        if (nextItem) {
          setFocusedItemId(nextItem.id)
        }

        // Close Quick-File
        setQuickFileItemId(null)
        setQuickFileQuery("")
      }
    },
    [quickFileItemId, onQuickFile, flatItems, setFocusedItemId]
  )

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      // Ignore if typing in input (except for Quick-File input which handles its own keys)
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      const currentIndex = flatItems.findIndex((i) => i.id === focusedItemId)

      switch (e.key) {
        case " ": // Space key toggles preview
          e.preventDefault()
          if (focusedItemId && !quickFileItemId) {
            onPreview(focusedItemId)
          }
          break

        case "x":
        case "X":
          // Toggle selection on focused item
          if (focusedItemId) {
            e.preventDefault()
            handleSelectionToggle(focusedItemId, e.shiftKey)
          }
          break

        case "ArrowDown":
        case "j":
          e.preventDefault()
          if (quickFileItemId) return // Let Quick-File handle arrows when active
          if (currentIndex < flatItems.length - 1) {
            const nextId = flatItems[currentIndex + 1].id
            setFocusedItemId(nextId)
            // Extend selection if shift is held
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(nextId, false)
            }
          }
          break

        case "ArrowUp":
        case "k":
          e.preventDefault()
          if (quickFileItemId) return // Let Quick-File handle arrows when active
          if (currentIndex > 0) {
            const prevId = flatItems[currentIndex - 1].id
            setFocusedItemId(prevId)
            // Extend selection if shift is held
            if (e.shiftKey && isInBulkMode) {
              handleSelectionToggle(prevId, false)
            }
          }
          break

        case "Home":
          // Jump to first item (Cmd+Up also handled below)
          e.preventDefault()
          if (quickFileItemId) return
          if (flatItems.length > 0) {
            setFocusedItemId(flatItems[0].id)
          }
          break

        case "End":
          // Jump to last item (Cmd+Down also handled below)
          e.preventDefault()
          if (quickFileItemId) return
          if (flatItems.length > 0) {
            setFocusedItemId(flatItems[flatItems.length - 1].id)
          }
          break

        case "PageDown":
          // Jump 10 items down
          e.preventDefault()
          if (quickFileItemId) return
          if (flatItems.length > 0) {
            const targetIndex = Math.min(currentIndex + 10, flatItems.length - 1)
            setFocusedItemId(flatItems[targetIndex].id)
          }
          break

        case "PageUp":
          // Jump 10 items up
          e.preventDefault()
          if (quickFileItemId) return
          if (flatItems.length > 0) {
            const targetIndex = Math.max(currentIndex - 10, 0)
            setFocusedItemId(flatItems[targetIndex].id)
          }
          break

        case "Delete":
        case "Backspace":
          // Delete focused item (or selected items in bulk mode)
          e.preventDefault()
          if (quickFileItemId) return
          if (focusedItemId) {
            onDelete(focusedItemId)
          }
          break

        case "o":
        case "O":
          // Open link in new tab
          if (focusedItemId && !quickFileItemId) {
            const focusedItem = flatItems.find((i) => i.id === focusedItemId)
            if (focusedItem?.type === "link" && focusedItem.url) {
              e.preventDefault()
              window.open(focusedItem.url, "_blank", "noopener,noreferrer")
            }
          }
          break

        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
          // Number keys for Quick-File folder selection
          if (quickFileItemId && filteredFolders.length > 0) {
            const index = parseInt(e.key, 10) - 1
            if (index < filteredFolders.length) {
              e.preventDefault()
              handleQuickFileFolderSelect(filteredFolders[index])
            }
          }
          break

        case ".":
        case "f":
        case "F":
          // Activate Quick-File on focused item
          if (focusedItemId && !quickFileItemId && !isInBulkMode) {
            e.preventDefault()
            setQuickFileItemId(focusedItemId)
            setQuickFileQuery("")
            setHighlightedIndex(0)
          }
          break

        case "Enter":
          // If preview is open, close preview and open Filing Panel
          if (isPreviewOpen && focusedItemId) {
            e.preventDefault()
            onFile(focusedItemId)
          }
          break

        case "Escape":
          // Cancel Quick-File or deselect all
          if (quickFileItemId) {
            e.preventDefault()
            setQuickFileItemId(null)
            setQuickFileQuery("")
          } else if (isInBulkMode) {
            e.preventDefault()
            onSelectionChange(new Set())
          }
          break

        case "a":
        case "A":
          // Select all with Cmd/Ctrl+A
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            const allIds = new Set(flatItems.map((i) => i.id))
            onSelectionChange(allIds)
          }
          break
      }
    },
    [flatItems, focusedItemId, quickFileItemId, filteredFolders, onPreview, onFile, onDelete, isPreviewOpen, setFocusedItemId, handleSelectionToggle, handleQuickFileFolderSelect, isInBulkMode, onSelectionChange]
  )

  // Add keyboard listener
  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [handleKeyDown])

  // Click outside to cancel Quick-File
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (quickFileItemId && containerRef.current) {
        const target = e.target as HTMLElement
        const itemRow = target.closest(`[data-item-id="${quickFileItemId}"]`)
        if (!itemRow) {
          setQuickFileItemId(null)
          setQuickFileQuery("")
        }
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [quickFileItemId])

  // Quick-File handlers
  const handleQuickFileQueryChange = useCallback((query: string): void => {
    setQuickFileQuery(query)
  }, [])

  const handleQuickFileSubmit = useCallback((): void => {
    if (quickFileItemId && filteredFolders[highlightedIndex]) {
      const folder = filteredFolders[highlightedIndex]
      onQuickFile(quickFileItemId, folder.id)

      // Move focus to next item
      const currentIndex = flatItems.findIndex((i) => i.id === quickFileItemId)
      const nextItem = flatItems[currentIndex + 1] || flatItems[currentIndex - 1]
      if (nextItem) {
        setFocusedItemId(nextItem.id)
      }

      // Close Quick-File
      setQuickFileItemId(null)
      setQuickFileQuery("")
    }
  }, [quickFileItemId, filteredFolders, highlightedIndex, onQuickFile, flatItems, setFocusedItemId])

  const handleQuickFileCancel = useCallback((): void => {
    setQuickFileItemId(null)
    setQuickFileQuery("")
  }, [])

  const handleQuickFileArrowDown = useCallback((): void => {
    if (filteredFolders.length > 0) {
      setHighlightedIndex((prev) =>
        prev < filteredFolders.length - 1 ? prev + 1 : prev
      )
    }
  }, [filteredFolders.length])

  const handleQuickFileArrowUp = useCallback((): void => {
    if (filteredFolders.length > 0) {
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev))
    }
  }, [filteredFolders.length])

  const handleItemFocus = useCallback((id: string): void => {
    setFocusedItemId(id)
    // Close Quick-File if clicking different item
    if (quickFileItemId && quickFileItemId !== id) {
      setQuickFileItemId(null)
      setQuickFileQuery("")
    }
  }, [quickFileItemId, setFocusedItemId])

  return (
    <div
      ref={containerRef}
      className="space-y-6"
      role="list"
      aria-label="Inbox items"
    >
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

      {/* Regular time-grouped items */}
      {groupedItems.map((group, groupIndex) => (
        <section key={group.period} aria-labelledby={`section-${group.period}`}>
          {/* Section Header */}
          <SectionHeader period={group.period} />

          {/* Items */}
          <div className="space-y-0.5">
            {group.items.map((item) => (
              <InboxItemRow
                key={item.id}
                item={item}
                period={group.period}
                isFocused={focusedItemId === item.id}
                isSelected={selectedItemIds.has(item.id)}
                isInBulkMode={isInBulkMode}
                isQuickFileActive={quickFileItemId === item.id}
                quickFileQuery={quickFileQuery}
                quickFileHighlightedIndex={highlightedIndex}
                isExiting={exitingItemIds.has(item.id)}
                onFile={onFile}
                onPreview={onPreview}
                onDelete={onDelete}
                onFocus={handleItemFocus}
                onSelectionToggle={handleSelectionToggle}
                onQuickFileQueryChange={handleQuickFileQueryChange}
                onQuickFileSubmit={handleQuickFileSubmit}
                onQuickFileCancel={handleQuickFileCancel}
                onQuickFileArrowDown={handleQuickFileArrowDown}
                onQuickFileArrowUp={handleQuickFileArrowUp}
                onQuickFileFolderSelect={handleQuickFileFolderSelect}
              />
            ))}
          </div>

          {/* Visual separator between sections (except last) */}
          {groupIndex < groupedItems.length - 1 && (
            <div className="h-px bg-[var(--border)]/50 mt-4" aria-hidden="true" />
          )}
        </section>
      ))}
    </div>
  )
}

export { ListView, type ListViewProps }
