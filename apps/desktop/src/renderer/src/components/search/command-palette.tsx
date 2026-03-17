import { useCallback, useEffect } from 'react'
import { Command } from 'cmdk'
import { Search, Loader2 } from '@/lib/icons'
import type {
  SearchResultItem as SearchResultItemType,
  ContentType,
  DateRange,
  SearchReason
} from '@memry/contracts/search-api'
import { useTabs } from '@/contexts/tabs'
import { useSearch } from '@/hooks/use-search'
import { searchService } from '@/services/search-service'
import { SearchResultGroup } from './search-result-group'
import { SearchFilters } from './search-filters'
import { RecentReasons } from './recent-reasons'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const TYPE_SHORTCUT_MAP: Record<string, ContentType> = {
  '1': 'note',
  '2': 'journal',
  '3': 'task',
  '4': 'inbox'
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps): React.JSX.Element {
  const { openTab } = useTabs()
  const {
    query,
    setQuery,
    results,
    totalCount,
    loading,
    error,
    filters,
    setFilters,
    reasons,
    loadReasons,
    clearReasons,
    reset
  } = useSearch()

  useEffect(() => {
    if (open) loadReasons()
  }, [open, loadReasons])

  const handleClose = useCallback(() => {
    onOpenChange(false)
    setTimeout(reset, 200)
  }, [onOpenChange, reset])

  const handleToggleType = useCallback(
    (type: ContentType) => {
      setFilters({
        ...filters,
        types: filters.types.includes(type)
          ? filters.types.filter((t) => t !== type)
          : [...filters.types, type]
      })
    },
    [filters, setFilters]
  )

  const handleToggleTag = useCallback(
    (tag: string) => {
      setFilters({
        ...filters,
        tags: filters.tags.includes(tag)
          ? filters.tags.filter((t) => t !== tag)
          : [...filters.tags, tag]
      })
    },
    [filters, setFilters]
  )

  const handleSetDateRange = useCallback(
    (range: DateRange | null) => {
      setFilters({ ...filters, dateRange: range })
    },
    [filters, setFilters]
  )

  const handleClearFilters = useCallback(() => {
    setFilters({ types: [], tags: [], dateRange: null })
  }, [setFilters])

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const modifier = isMac ? e.metaKey : e.ctrlKey

      if (modifier && e.key in TYPE_SHORTCUT_MAP) {
        e.preventDefault()
        handleToggleType(TYPE_SHORTCUT_MAP[e.key])
        return
      }

      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        const groups = document.querySelectorAll('[cmdk-group]')
        if (groups.length < 2) return

        const selected = document.querySelector('[cmdk-item][data-selected="true"]')
        if (!selected) return

        const currentGroup = selected.closest('[cmdk-group]')
        const groupArray = Array.from(groups)
        const currentIdx = currentGroup ? groupArray.indexOf(currentGroup) : -1

        const nextIdx = e.shiftKey
          ? (currentIdx - 1 + groupArray.length) % groupArray.length
          : (currentIdx + 1) % groupArray.length

        const firstItem = groupArray[nextIdx]?.querySelector('[cmdk-item]')
        if (firstItem instanceof HTMLElement) firstItem.click()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, handleToggleType])

  const openItemTab = useCallback(
    (item: {
      id: string
      title: string
      type: ContentType
      metadata?: SearchResultItemType['metadata']
    }) => {
      switch (item.type) {
        case 'note':
          openTab({
            type: 'note',
            title: item.title,
            icon: 'file-text',
            path: `/note/${item.id}`,
            entityId: item.id,
            isPinned: false,
            isModified: false,
            isPreview: true,
            isDeleted: false
          })
          break
        case 'journal': {
          const date = item.metadata?.type === 'journal' ? item.metadata.date : item.id
          openTab({
            type: 'journal',
            title: `Journal — ${date}`,
            icon: 'book-open',
            path: `/journal/${date}`,
            entityId: item.id,
            isPinned: false,
            isModified: false,
            isPreview: true,
            isDeleted: false
          })
          break
        }
        case 'task':
          openTab({
            type: 'tasks',
            title: 'Tasks',
            icon: 'check-square',
            path: '/tasks',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false,
            viewState: {
              focusTaskId: item.id,
              projectId: item.metadata?.type === 'task' ? item.metadata.projectId : undefined
            }
          })
          break
        case 'inbox':
          openTab({
            type: 'inbox',
            title: 'Inbox',
            icon: 'inbox',
            path: '/inbox',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false,
            viewState: { highlightItemId: item.id }
          })
          break
      }
    },
    [openTab]
  )

  const handleSelect = useCallback(
    (item: SearchResultItemType) => {
      handleClose()
      openItemTab({
        id: item.id,
        title: item.title,
        type: item.metadata.type,
        metadata: item.metadata
      })

      const itemIcon = item.metadata.type === 'note' ? (item.metadata.emoji ?? null) : null

      searchService
        .addReason({
          itemId: item.id,
          itemType: item.metadata.type,
          itemTitle: item.title,
          itemIcon,
          searchQuery: query
        })
        .catch(() => {})
    },
    [handleClose, openItemTab, query]
  )

  const handleReasonSelect = useCallback(
    (reason: SearchReason) => {
      handleClose()
      openItemTab({
        id: reason.itemId,
        title: reason.itemTitle,
        type: reason.itemType
      })
    },
    [handleClose, openItemTab]
  )

  const hasQuery = query.trim().length > 0
  const hasResults = results.length > 0

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose()
        else onOpenChange(true)
      }}
      label="Search"
      shouldFilter={false}
      loop
      className="fixed inset-0 z-50"
    >
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" aria-hidden="true" />
      <div className="fixed inset-0 flex items-start justify-center pt-[15vh] px-4">
        <div
          className="w-full max-w-xl bg-background rounded-xl shadow-2xl
            border border-border overflow-hidden"
        >
          <div className="flex items-center gap-3 px-4 border-b border-border">
            {loading ? (
              <Loader2 className="size-4 shrink-0 text-text-tertiary animate-spin" />
            ) : (
              <Search className="size-4 shrink-0 text-text-tertiary" />
            )}
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search notes, tasks, journal, inbox..."
              autoFocus
              className="flex-1 h-12 bg-transparent border-0 text-sm text-foreground
                placeholder:text-text-tertiary focus:outline-none focus:ring-0"
            />
            {hasQuery && (
              <kbd
                className="hidden sm:inline-flex text-[10px] text-text-tertiary border border-border
                rounded px-1.5 py-0.5"
              >
                ESC
              </kbd>
            )}
          </div>

          <SearchFilters
            activeTypes={filters.types}
            activeTags={filters.tags}
            activeDateRange={filters.dateRange}
            onToggleType={handleToggleType}
            onToggleTag={handleToggleTag}
            onSetDateRange={handleSetDateRange}
            onClear={handleClearFilters}
          />

          <Command.List
            className="max-h-[50vh] overflow-y-auto overscroll-contain p-2
              [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            {hasQuery && !loading && !hasResults && !error && (
              <Command.Empty className="py-12 text-center text-sm text-text-tertiary">
                No results for &ldquo;{query}&rdquo;
              </Command.Empty>
            )}

            {error && (
              <div className="py-8 text-center text-sm text-red-500 dark:text-red-400">{error}</div>
            )}

            {!hasQuery && (
              <RecentReasons
                reasons={reasons}
                onSelect={handleReasonSelect}
                onClear={clearReasons}
              />
            )}

            {hasResults &&
              results.map((group) => (
                <SearchResultGroup
                  key={group.type}
                  group={group}
                  query={query}
                  onSelect={handleSelect}
                />
              ))}

            {hasQuery && hasResults && (
              <div className="px-3 py-2 text-xs text-text-tertiary text-right tabular-nums border-t border-border mt-1">
                {totalCount} result{totalCount !== 1 ? 's' : ''}
              </div>
            )}
          </Command.List>
        </div>
      </div>
    </Command.Dialog>
  )
}
