import { useState, useMemo, useCallback, useEffect } from "react"
import {
  Bell,
  ExternalLink,
  FileText,
  Folder,
  Image as ImageIcon,
  Link,
  Mic,
  Search,
  Trash2,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ToastContainer, type Toast } from "@/components/ui/toast"
import { FilingPanel } from "@/components/filing/filing-panel"
import { EmptyState } from "@/components/empty-state/empty-state"
import {
  groupItemsByTimePeriod,
  formatTimestamp,
  extractDomain,
  formatDuration,
  type TimePeriod,
} from "@/lib/inbox-utils"
import { cn } from "@/lib/utils"
import { sampleInboxItems } from "@/data/sample-inbox-items"
import type { InboxItem, InboxItemType } from "@/types"

interface Inbox2PageProps {
  className?: string
}

const PERIOD_LABELS: Record<TimePeriod, string> = {
  TODAY: "Today",
  YESTERDAY: "Yesterday",
  OLDER: "Older",
}

const TypeIcon = ({ type, className }: { type: InboxItemType; className?: string }): React.JSX.Element => {
  const iconClass = cn("size-4 text-muted-foreground", className)
  switch (type) {
    case "link":
      return <Link className={iconClass} aria-hidden="true" />
    case "note":
      return <FileText className={iconClass} aria-hidden="true" />
    case "image":
      return <ImageIcon className={iconClass} aria-hidden="true" />
    case "voice":
      return <Mic className={iconClass} aria-hidden="true" />
  }
}

const getSubtitle = (item: InboxItem): string => {
  switch (item.type) {
    case "link":
      return item.url ? extractDomain(item.url) : "Link"
    case "note":
      return item.content || "Note"
    case "image":
      return "Image"
    case "voice":
      return item.duration ? formatDuration(item.duration) : "Voice memo"
  }
}

interface RowProps {
  item: InboxItem
  period: TimePeriod
  isActive: boolean
  isSelected: boolean
  isSnoozed: boolean
  onActivate: (id: string) => void
  onToggleSelect: (id: string) => void
  onFile: (id: string) => void
  onSnooze: (id: string) => void
  onDelete: (id: string) => void
}

const Inbox2Row = ({
  item,
  period,
  isActive,
  isSelected,
  isSnoozed,
  onActivate,
  onToggleSelect,
  onFile,
  onSnooze,
  onDelete,
}: RowProps): React.JSX.Element => {
  const subtitle = getSubtitle(item)

  return (
    <div
      role="listitem"
      onClick={() => onActivate(item.id)}
      className={cn(
        "group flex items-start gap-3 px-3 py-2 rounded-md cursor-pointer",
        "transition-[background-color,box-shadow] duration-[var(--duration-instant)] ease-[var(--ease-out)]",
        isActive ? "bg-muted ring-1 ring-ring/40" : "hover:bg-muted/70"
      )}
    >
      <Checkbox
        checked={isSelected}
        onCheckedChange={() => onToggleSelect(item.id)}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select ${item.title}`}
        className="mt-0.5"
      />

      <TypeIcon type={item.type} className="mt-0.5" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-foreground truncate">
            {item.title}
          </span>
          {isSnoozed && (
            <Badge variant="secondary" className="text-[10px] text-muted-foreground">
              Snoozed
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground line-clamp-1">
          {subtitle}
        </p>
      </div>

      <div className="shrink-0 flex flex-col items-end gap-1">
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {formatTimestamp(item.timestamp, period)}
        </span>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation()
              onActivate(item.id)
              onFile(item.id)
            }}
            aria-label="File item"
          >
            <Folder className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation()
              onSnooze(item.id)
            }}
            aria-label="Snooze item"
          >
            <Bell className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(item.id)
            }}
            aria-label="Delete item"
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}

interface ReviewPanelProps {
  item: InboxItem
  isSnoozed: boolean
  onFile: (id: string) => void
  onSnooze: (id: string) => void
  onDelete: (id: string) => void
}

const ReviewPanel = ({
  item,
  isSnoozed,
  onFile,
  onSnooze,
  onDelete,
}: ReviewPanelProps): React.JSX.Element => {
  const openOriginal = (): void => {
    if (item.url) {
      window.open(item.url, "_blank", "noopener,noreferrer")
    }
  }

  const renderBody = (): React.JSX.Element => {
    switch (item.type) {
      case "link": {
        const excerpt = (item.previewContent as { excerpt?: string } | undefined)?.excerpt
        return (
          <div className="space-y-2">
            {item.url && (
              <button
                type="button"
                onClick={openOriginal}
                className="text-sm text-primary hover:underline underline-offset-4 break-all"
              >
                {item.url}
              </button>
            )}
            {excerpt && (
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {excerpt}
              </p>
            )}
          </div>
        )
      }
      case "note": {
        const fullText = (item.previewContent as { fullText?: string } | undefined)?.fullText
        const text = fullText || item.content || ""
        return (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {text || "Empty note"}
          </p>
        )
      }
      case "image": {
        const imageUrl = (item.previewContent as { imageUrl?: string } | undefined)?.imageUrl
        return imageUrl ? (
          <img
            src={imageUrl}
            alt={item.title}
            className="w-full rounded-md border object-cover"
          />
        ) : (
          <div className="w-full aspect-video rounded-md bg-muted flex items-center justify-center">
            <ImageIcon className="size-10 text-muted-foreground/50" aria-hidden="true" />
          </div>
        )
      }
      case "voice": {
        const transcription = (item.previewContent as { transcription?: string } | undefined)?.transcription
        return (
          <div className="space-y-2">
            {item.duration && (
              <div className="text-sm text-muted-foreground">
                Duration {formatDuration(item.duration)}
              </div>
            )}
            {transcription ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {transcription}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No transcription yet.
              </p>
            )}
          </div>
        )
      }
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-5 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          <TypeIcon type={item.type} className="size-5" />
          <h2 className="text-lg font-semibold text-foreground truncate">
            {item.title}
          </h2>
        </div>
        <div className="text-xs text-muted-foreground">
          Captured {item.timestamp.toLocaleString()}
          {isSnoozed && " · Snoozed"}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-5">
        {renderBody()}
      </div>

      <div className="p-4 border-t border-border flex items-center gap-2">
        <Button size="sm" onClick={() => onFile(item.id)}>
          <Folder className="size-4" aria-hidden="true" />
          File
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onSnooze(item.id)}>
          <Bell className="size-4" aria-hidden="true" />
          Snooze
        </Button>
        {item.url && (
          <Button variant="ghost" size="sm" onClick={openOriginal}>
            <ExternalLink className="size-4" aria-hidden="true" />
            Open
          </Button>
        )}
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onDelete(item.id)}
          className="ml-auto"
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Delete
        </Button>
      </div>
    </div>
  )
}

export function Inbox2Page({ className }: Inbox2PageProps): React.JSX.Element {
  const [items, setItems] = useState<InboxItem[]>(sampleInboxItems)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [activeItemId, setActiveItemId] = useState<string | null>(items[0]?.id || null)

  const [searchQuery, setSearchQuery] = useState("")
  const [typeFilter, setTypeFilter] = useState<InboxItemType | "all">("all")
  const [showSnoozed, setShowSnoozed] = useState(false)
  const [snoozedUntil, setSnoozedUntil] = useState<Record<string, number>>({})

  const [itemsProcessedToday, setItemsProcessedToday] = useState(0)
  const [hasFilingHistory, setHasFilingHistory] = useState(false)

  const [toasts, setToasts] = useState<Toast[]>([])
  const [isFilingPanelOpen, setIsFilingPanelOpen] = useState(false)
  const [filingItem, setFilingItem] = useState<InboxItem | null>(null)

  const selectedCount = selectedItemIds.size

  const generateToastId = (): string =>
    `toast-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`

  const addToast = useCallback((toast: Omit<Toast, "id">): void => {
    const id = generateToastId()
    setToasts((prev) => [...prev, { ...toast, id }])
  }, [])

  const removeToast = useCallback((id: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const getTomorrowMorningMs = (): number => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }

  const visibleItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return items
      .filter((item) => {
        const until = snoozedUntil[item.id]
        const isSnoozed = until !== undefined && until > Date.now()
        if (!showSnoozed && isSnoozed) return false
        if (typeFilter !== "all" && item.type !== typeFilter) return false
        if (!q) return true
        const haystack = [
          item.title,
          item.content,
          item.url ? extractDomain(item.url) : "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
        return haystack.includes(q)
      })
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }, [items, snoozedUntil, showSnoozed, typeFilter, searchQuery])

  const groupedItems = useMemo(
    () => groupItemsByTimePeriod(visibleItems),
    [visibleItems]
  )

  useEffect(() => {
    if (visibleItems.length === 0) {
      setActiveItemId(null)
      return
    }
    if (!activeItemId || !visibleItems.some((i) => i.id === activeItemId)) {
      setActiveItemId(visibleItems[0].id)
    }
  }, [visibleItems, activeItemId])

  const activeItem = useMemo(
    () => items.find((i) => i.id === activeItemId) || null,
    [items, activeItemId]
  )

  const isItemSnoozed = useCallback(
    (id: string): boolean => {
      const until = snoozedUntil[id]
      return until !== undefined && until > Date.now()
    },
    [snoozedUntil]
  )

  const toggleSelect = useCallback((id: string): void => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const clearSelection = useCallback((): void => {
    setSelectedItemIds(new Set())
  }, [])

  const openFiling = useCallback(
    (id: string): void => {
      const item = items.find((i) => i.id === id)
      if (!item) return
      setFilingItem(item)
      setIsFilingPanelOpen(true)
    },
    [items]
  )

  const handleDelete = useCallback(
    (id: string): void => {
      const itemToDelete = items.find((i) => i.id === id)
      if (!itemToDelete) return
      const index = items.findIndex((i) => i.id === id)
      const remaining = items.filter((i) => i.id !== id)

      setItems(remaining)
      setSelectedItemIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      if (activeItemId === id) {
        setActiveItemId(remaining[0]?.id || null)
      }
      setItemsProcessedToday((prev) => prev + 1)

      addToast({
        message: `"${itemToDelete.title}" deleted`,
        type: "success",
        onUndo: () => {
          setItems((prev) => {
            const next = [...prev]
            next.splice(index, 0, itemToDelete)
            return next
          })
          setItemsProcessedToday((prev) => Math.max(0, prev - 1))
        },
      })
    },
    [items, activeItemId, addToast]
  )

  const handleSnooze = useCallback(
    (id: string): void => {
      const untilMs = getTomorrowMorningMs()
      setSnoozedUntil((prev) => ({ ...prev, [id]: untilMs }))
      setSelectedItemIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      if (activeItemId === id) {
        const nextVisible = visibleItems.filter((i) => i.id !== id)
        setActiveItemId(nextVisible[0]?.id || null)
      }
      addToast({
        message: "Snoozed until tomorrow",
        type: "info",
      })
    },
    [activeItemId, visibleItems, addToast]
  )

  const handleFileComplete = useCallback(
    (itemId: string, _folderId: string, _tags: string[], _linkedNoteIds: string[]): void => {
      const itemToFile = items.find((i) => i.id === itemId)
      if (!itemToFile) return
      const index = items.findIndex((i) => i.id === itemId)
      const remaining = items.filter((i) => i.id !== itemId)

      setItems(remaining)
      setSelectedItemIds((prev) => {
        const next = new Set(prev)
        next.delete(itemId)
        return next
      })
      if (activeItemId === itemId) {
        setActiveItemId(remaining[0]?.id || null)
      }
      setItemsProcessedToday((prev) => prev + 1)
      setHasFilingHistory(true)

      addToast({
        message: `Filed "${itemToFile.title}"`,
        type: "success",
        onUndo: () => {
          setItems((prev) => {
            const next = [...prev]
            next.splice(index, 0, itemToFile)
            return next
          })
          setItemsProcessedToday((prev) => Math.max(0, prev - 1))
        },
      })
    },
    [items, activeItemId, addToast]
  )

  const handleBulkDelete = useCallback((): void => {
    const ids = Array.from(selectedItemIds)
    if (ids.length === 0) return

    const deletedRecords = ids
      .map((id) => {
        const index = items.findIndex((i) => i.id === id)
        return { item: items[index], index }
      })
      .filter((r) => r.item !== undefined)

    const remaining = items.filter((i) => !selectedItemIds.has(i.id))

    setItems(remaining)
    setSelectedItemIds(new Set())
    setItemsProcessedToday((prev) => prev + deletedRecords.length)
    if (activeItemId && selectedItemIds.has(activeItemId)) {
      setActiveItemId(remaining[0]?.id || null)
    }

    addToast({
      message: `Deleted ${deletedRecords.length} items`,
      type: "success",
      onUndo: () => {
        setItems((prev) => {
          const next = [...prev]
          deletedRecords
            .sort((a, b) => a.index - b.index)
            .forEach(({ item, index }) => {
              next.splice(index, 0, item)
            })
          return next
        })
        setItemsProcessedToday((prev) => Math.max(0, prev - deletedRecords.length))
      },
    })
  }, [selectedItemIds, items, activeItemId, addToast])

  const handleBulkSnooze = useCallback((): void => {
    const ids = Array.from(selectedItemIds)
    if (ids.length === 0) return
    const untilMs = getTomorrowMorningMs()

    setSnoozedUntil((prev) => {
      const next = { ...prev }
      ids.forEach((id) => {
        next[id] = untilMs
      })
      return next
    })
    setSelectedItemIds(new Set())

    addToast({
      message: `Snoozed ${ids.length} items until tomorrow`,
      type: "info",
    })
  }, [selectedItemIds, addToast])

  const handleBulkFile = useCallback((): void => {
    const firstId = Array.from(selectedItemIds)[0]
    if (firstId) {
      openFiling(firstId)
    }
  }, [selectedItemIds, openFiling])

  const handleTypeFilterChange = (value: string): void => {
    if (!value || value === "all") {
      setTypeFilter("all")
      return
    }
    setTypeFilter(value as InboxItemType)
  }

  return (
    <div className={cn("flex h-full", className)}>
      {/* Left: Feed */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-6 pt-6 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-foreground">Inbox 2</h1>
            <Badge variant="secondary" className="text-muted-foreground">
              {visibleItems.length} items
            </Badge>
          </div>

          {selectedCount > 0 && (
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              Clear selection
            </Button>
          )}
        </div>

        <div className="px-6 pb-3 flex items-center gap-3">
          <InputGroup className="max-w-md">
            <InputGroupAddon>
              <Search className="size-4" aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              placeholder="Search inbox…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search inbox"
            />
          </InputGroup>

          <Button
            variant={showSnoozed ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowSnoozed((prev) => !prev)}
          >
            <Bell className="size-4" aria-hidden="true" />
            Later
          </Button>
        </div>

        <div className="px-6 pb-4">
          <ToggleGroup
            type="single"
            value={typeFilter}
            onValueChange={handleTypeFilterChange}
            className="gap-1"
          >
            <ToggleGroupItem value="all" aria-label="All items">
              All
            </ToggleGroupItem>
            <ToggleGroupItem value="link" aria-label="Links">
              <Link className="size-3 mr-1" aria-hidden="true" />
              Links
            </ToggleGroupItem>
            <ToggleGroupItem value="note" aria-label="Notes">
              <FileText className="size-3 mr-1" aria-hidden="true" />
              Notes
            </ToggleGroupItem>
            <ToggleGroupItem value="image" aria-label="Images">
              <ImageIcon className="size-3 mr-1" aria-hidden="true" />
              Images
            </ToggleGroupItem>
            <ToggleGroupItem value="voice" aria-label="Voice memos">
              <Mic className="size-3 mr-1" aria-hidden="true" />
              Voice
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="flex-1 overflow-auto px-4 pb-6">
          {visibleItems.length === 0 ? (
            <EmptyState
              itemsProcessedToday={itemsProcessedToday}
              hasFilingHistory={hasFilingHistory}
            />
          ) : (
            <div role="list" className="space-y-4">
              {groupedItems.map((group) => (
                <div key={group.period}>
                  <h3 className="px-2 mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {PERIOD_LABELS[group.period]}
                  </h3>
                  <div className="space-y-1">
                    {group.items.map((item) => (
                      <Inbox2Row
                        key={item.id}
                        item={item}
                        period={group.period}
                        isActive={item.id === activeItemId}
                        isSelected={selectedItemIds.has(item.id)}
                        isSnoozed={isItemSnoozed(item.id)}
                        onActivate={setActiveItemId}
                        onToggleSelect={toggleSelect}
                        onFile={openFiling}
                        onSnooze={handleSnooze}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {selectedCount > 0 && (
          <div className="px-6 py-3 border-t border-border flex items-center gap-2 bg-background">
            <span className="text-sm text-muted-foreground">
              {selectedCount} selected
            </span>
            <Button size="sm" onClick={handleBulkFile}>
              File
            </Button>
            <Button variant="secondary" size="sm" onClick={handleBulkSnooze}>
              Snooze
            </Button>
            <Button variant="destructive" size="sm" onClick={handleBulkDelete}>
              Delete
            </Button>
            <div className="ml-auto text-xs text-muted-foreground">
              Capture first · Decide later
            </div>
          </div>
        )}
      </div>

      {/* Right: Review */}
      <aside className="w-[420px] border-l border-border bg-background/60 shrink-0">
        {activeItem ? (
          <ReviewPanel
            item={activeItem}
            isSnoozed={isItemSnoozed(activeItem.id)}
            onFile={openFiling}
            onSnooze={handleSnooze}
            onDelete={handleDelete}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
            <Bell className="size-10 mb-3 opacity-40" aria-hidden="true" />
            <p className="text-sm">
              Select something on the left to review and file.
            </p>
          </div>
        )}
      </aside>

      <FilingPanel
        isOpen={isFilingPanelOpen}
        item={filingItem}
        onClose={() => setIsFilingPanelOpen(false)}
        onFile={handleFileComplete}
      />

      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </div>
  )
}

