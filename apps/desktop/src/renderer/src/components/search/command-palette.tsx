import { useCallback, useEffect } from 'react'
import { Command } from 'cmdk'
import { Search, Loader2 } from 'lucide-react'
import type {
  SearchResultItem as SearchResultItemType,
  ContentType,
  DateRange
} from '@memry/contracts/search-api'
import { useTabs } from '@/contexts/tabs'
import { useSearch } from '@/hooks/use-search'
import { SearchResultGroup } from './search-result-group'
import { SearchFilters } from './search-filters'
import { RecentSearches } from './recent-searches'

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
    recentSearches,
    loadRecentSearches,
    clearRecentSearches,
    reset
  } = useSearch()

  useEffect(() => {
    if (open) loadRecentSearches()
  }, [open, loadRecentSearches])

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

  const handleSelect = useCallback(
    (item: SearchResultItemType) => {
      handleClose()

      switch (item.metadata.type) {
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
        case 'journal':
          openTab({
            type: 'journal',
            title: `Journal — ${item.metadata.date}`,
            icon: 'book-open',
            path: `/journal/${item.metadata.date}`,
            entityId: item.id,
            isPinned: false,
            isModified: false,
            isPreview: true,
            isDeleted: false
          })
          break
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
              projectId: item.metadata.projectId
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
    [handleClose, openTab]
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
          className="w-full max-w-xl bg-white dark:bg-gray-900 rounded-xl shadow-2xl
            border border-gray-200 dark:border-gray-700 overflow-hidden"
        >
          <div className="flex items-center gap-3 px-4 border-b border-gray-100 dark:border-gray-800">
            {loading ? (
              <Loader2 className="size-4 shrink-0 text-gray-400 animate-spin" />
            ) : (
              <Search className="size-4 shrink-0 text-gray-400" />
            )}
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search notes, tasks, journal, inbox..."
              autoFocus
              className="flex-1 h-12 bg-transparent border-0 text-sm text-gray-900 dark:text-gray-100
                placeholder:text-gray-400 focus:outline-none focus:ring-0"
            />
            {hasQuery && (
              <kbd
                className="hidden sm:inline-flex text-[10px] text-gray-400 border border-gray-200
                dark:border-gray-700 rounded px-1.5 py-0.5"
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
              <Command.Empty className="py-12 text-center text-sm text-gray-400">
                No results for &ldquo;{query}&rdquo;
              </Command.Empty>
            )}

            {error && (
              <div className="py-8 text-center text-sm text-red-500 dark:text-red-400">{error}</div>
            )}

            {!hasQuery && (
              <RecentSearches
                searches={recentSearches}
                onSelect={setQuery}
                onClear={clearRecentSearches}
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
              <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500 text-right tabular-nums border-t border-gray-100 dark:border-gray-800 mt-1">
                {totalCount} result{totalCount !== 1 ? 's' : ''}
              </div>
            )}
          </Command.List>
        </div>
      </div>
    </Command.Dialog>
  )
}
