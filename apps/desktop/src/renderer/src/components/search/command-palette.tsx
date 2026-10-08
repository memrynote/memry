import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Command } from 'cmdk'
import { Calendar, Hash } from '@/lib/icons'
import type {
  ContentType,
  SearchReason,
  SearchResultItem as SearchResultItemType
} from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'
import { useSearch } from '@/hooks/use-search'
import { useVault } from '@/hooks/use-vault'
import { searchService } from '@/services/search-service'
import { trackTelemetry } from '@/lib/telemetry'
import { createLogger } from '@/lib/logger'
import { SearchInputBar, type SearchChip } from './search-input-bar'
import { RecentReasons, PICK_TAG_VALUE, reasonValue, scopeValue } from './recent-reasons'
import {
  DATE_LABEL_KEYS,
  SearchFilterMenu,
  filterMenuEntries,
  filterMenuValues
} from './search-filter-menu'
import { SearchTagPicker, matchingTags, tagValue, useSearchTags } from './search-tag-picker'
import { SearchResultGroup, groupValues } from './search-result-group'
import { resultValue } from './search-result-item'
import { SearchPreview } from './search-preview'
import { SearchEmptyState, emptyStateValues } from './search-empty-state'
import { SearchActionBar, type SearchAction } from './search-action-bar'
import { datePresetFor, datePresetRange, type DatePresetId } from './search-date-presets'
import { CONTENT_TYPES, TYPE_ICONS, TYPE_LABEL_KEYS, TYPE_SHORTCUTS } from './search-types'
import { useOpenSearchItem } from './use-open-search-item'
import { primaryActionKey } from './search-primary-action'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** `filters` follows a typed "/", `tags` a typed "#". Both narrow the query, not replace it. */
type Mode = 'search' | 'filters' | 'tags'

const log = createLogger('CommandPalette')

const TYPE_BY_SHORTCUT = Object.fromEntries(
  CONTENT_TYPES.map((type) => [TYPE_SHORTCUTS[type], type])
) as Record<string, ContentType>

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps): React.JSX.Element {
  const { t } = useT('common')
  const openItem = useOpenSearchItem()
  const {
    query,
    setQuery,
    results,
    totalCount,
    queryTimeMs,
    loading,
    error,
    filters,
    setFilters,
    reasons,
    loadReasons,
    clearReasons,
    reset
  } = useSearch()
  const { isIndexing, indexBuilt, indexTotal } = useVault()
  const rootRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<Mode>('search')
  const [menuQuery, setMenuQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [expanded, setExpanded] = useState<{ query: string; types: ContentType[] }>({
    query: '',
    types: []
  })
  const [itemCount, setItemCount] = useState<number | null>(null)
  const tags = useSearchTags(open && mode === 'tags')

  useEffect(() => {
    if (!open) return
    loadReasons()
    void trackTelemetry('command_palette_opened', { surface: 'search', action: 'opened' })
    searchService
      .getStats()
      .then((stats) => setItemCount(stats.totalIndexed))
      .catch((err) => log.warn('Failed to load search stats', err))
  }, [open, loadReasons])

  // First stage of the search funnel (search_opened -> search_performed ->
  // search_result_opened): a palette open only counts as search intent once the
  // user actually types a query — emitted at most once per open.
  const searchOpenedRef = useRef(false)
  useEffect(() => {
    if (!open) {
      searchOpenedRef.current = false
      return
    }
    if (!searchOpenedRef.current && query.trim().length > 0) {
      searchOpenedRef.current = true
      void trackTelemetry('search_opened', { surface: 'search', action: 'opened' })
    }
  }, [open, query])

  const back = useCallback(() => {
    setMode('search')
    setMenuQuery('')
  }, [])

  const handleClose = useCallback(() => {
    onOpenChange(false)
    setTimeout(() => {
      reset()
      back()
    }, 200)
  }, [onOpenChange, reset, back])

  const hasQuery = query.trim().length > 0
  const activeDate = datePresetFor(filters.dateRange)
  const hasFilters =
    filters.types.length > 0 || filters.tags.length > 0 || filters.dateRange !== null
  const expandedTypes = useMemo(
    () => (expanded.query === query ? expanded.types : []),
    [expanded, query]
  )

  const toggleType = useCallback(
    (type: ContentType) =>
      setFilters({
        ...filters,
        types: filters.types.includes(type)
          ? filters.types.filter((t) => t !== type)
          : [...filters.types, type]
      }),
    [filters, setFilters]
  )
  const toggleDate = (id: DatePresetId): void =>
    setFilters({ ...filters, dateRange: activeDate === id ? null : datePresetRange(id) })
  const removeTag = (tag: string): void =>
    setFilters({ ...filters, tags: filters.tags.filter((t) => t !== tag) })
  const pickTag = (tag: string): void => {
    setFilters({ ...filters, tags: [...filters.tags, tag] })
    back()
  }
  const enterTags = (): void => {
    setMode('tags')
    setMenuQuery('')
  }

  const removeLastChip = (): void => {
    if (filters.tags.length > 0) removeTag(filters.tags[filters.tags.length - 1])
    else if (filters.dateRange) setFilters({ ...filters, dateRange: null })
    else if (filters.types.length > 0) setFilters({ ...filters, types: filters.types.slice(0, -1) })
  }

  const handleSelect = (item: SearchResultItemType): void => {
    handleClose()
    openItem({ id: item.id, title: item.title, type: item.metadata.type, metadata: item.metadata })
    searchService
      .addReason({
        itemId: item.id,
        itemType: item.metadata.type,
        itemTitle: item.title,
        itemIcon: item.metadata.type === 'note' ? (item.metadata.emoji ?? null) : null,
        searchQuery: query
      })
      .catch((err) => log.warn('Failed to persist recent search', err))
  }

  const handleReasonSelect = (reason: SearchReason): void => {
    handleClose()
    openItem({ id: reason.itemId, title: reason.itemTitle, type: reason.itemType })
  }

  // ---- What the body shows, and the cmdk values in render order ----------

  const menuEntries = filterMenuEntries(menuQuery, (key) => t(key as never))
  const tagMatches = mode === 'tags' ? matchingTags(tags, menuQuery, filters.tags) : []
  const view =
    mode !== 'search'
      ? mode
      : !hasQuery
        ? 'open'
        : error
          ? 'error'
          : results.length > 0
            ? 'results'
            : loading
              ? 'loading'
              : 'empty'

  const values = ((): string[] => {
    switch (view) {
      case 'filters':
        return filterMenuValues(menuEntries)
      case 'tags':
        return tagMatches.map((tag) => tagValue(tag.name))
      case 'open':
        return [...reasons.map(reasonValue), ...CONTENT_TYPES.map(scopeValue), PICK_TAG_VALUE]
      case 'results':
        return results.flatMap((group) => groupValues(group, expandedTypes.includes(group.type)))
      case 'empty':
        return emptyStateValues(filters.types.length > 0, hasFilters)
      default:
        return []
    }
  })()

  // cmdk only auto-selects when nothing is selected, so a value that left the
  // list (new results, another mode) falls back to the first row here.
  const selectedValue = values.includes(selected) ? selected : (values[0] ?? '')
  const selectedResult =
    view === 'results'
      ? results.flatMap((g) => g.results).find((item) => resultValue(item) === selectedValue)
      : undefined

  // ---- Input ---------------------------------------------------------------

  const inputValue =
    mode === 'filters' ? `/${menuQuery}` : mode === 'tags' ? `${query}#${menuQuery}` : query

  const handleInputChange = (value: string): void => {
    if (mode === 'filters') {
      if (value.startsWith('/')) setMenuQuery(value.slice(1))
      else {
        // Deleting the "/" returns to the query it was typed over.
        back()
        if (value !== '') setQuery(value)
      }
      return
    }
    if (mode === 'tags') {
      if (value.startsWith(`${query}#`)) setMenuQuery(value.slice(query.length + 1))
      else {
        back()
        setQuery(value)
      }
      return
    }
    if (query === '' && value === '/') {
      setMode('filters')
      setMenuQuery('')
    } else if (value === `${query}#` && (query === '' || query.endsWith(' '))) {
      enterTags()
    } else {
      setQuery(value)
    }
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Backspace' && mode === 'search' && inputValue === '' && hasFilters) {
      e.preventDefault()
      removeLastChip()
    }
  }

  const chips: SearchChip[] = [
    ...filters.types.map((type) => {
      const Icon = TYPE_ICONS[type]
      return {
        key: `type:${type}`,
        icon: <Icon />,
        label: t(TYPE_LABEL_KEYS[type]),
        onRemove: () => toggleType(type)
      }
    }),
    ...(filters.dateRange
      ? [
          {
            key: 'date',
            icon: <Calendar />,
            label: activeDate ? t(DATE_LABEL_KEYS[activeDate]) : t('searchPalette.dates.custom'),
            onRemove: () => setFilters({ ...filters, dateRange: null })
          }
        ]
      : []),
    ...filters.tags.map((tag) => ({
      key: `tag:${tag}`,
      icon: <Hash />,
      label: tag,
      onRemove: () => removeTag(tag)
    }))
  ]

  // ---- Keyboard ------------------------------------------------------------

  const nextSection = useCallback(
    (direction: 1 | -1) => {
      const starts = results
        .map((group) => groupValues(group, expandedTypes.includes(group.type))[0])
        .filter(Boolean)
      if (starts.length < 2) return
      const current = results.findIndex((group) =>
        groupValues(group, expandedTypes.includes(group.type)).includes(selectedValue)
      )
      setSelected(starts[(current + direction + starts.length) % starts.length])
    },
    [results, expandedTypes, selectedValue]
  )

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key in TYPE_BY_SHORTCUT) {
        e.preventDefault()
        toggleType(TYPE_BY_SHORTCUT[e.key])
        return
      }
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        if (view === 'results') nextSection(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, toggleType, view, nextSection])

  // ---- Footer --------------------------------------------------------------

  const runSelected = (): void => {
    const node = rootRef.current?.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')
    node?.click()
  }
  const primaryKey = primaryActionKey(selectedValue, {
    results,
    activeTypes: filters.types,
    activeDate
  })
  const primary: SearchAction | null = primaryKey
    ? { label: t(primaryKey), keyLabel: '↵', onRun: runSelected }
    : null
  const leading: SearchAction =
    mode === 'search'
      ? {
          label: t('searchPalette.actions.filter'),
          keyLabel: '/',
          onRun: () => setMode('filters')
        }
      : { label: t('searchPalette.actions.back'), keyLabel: '⌫', onRun: back }
  const secondary: SearchAction | null =
    view === 'results' && results.length > 1
      ? {
          label: t('searchPalette.actions.nextSection'),
          keyLabel: '⇥',
          onRun: () => nextSection(1)
        }
      : null

  const status = isIndexing ? (
    <span role="status" className="flex items-center gap-2">
      {indexBuilt !== undefined && indexTotal !== undefined && indexTotal > 0 && (
        <span className="flex h-[3px] w-16 rounded-full bg-border" aria-hidden="true">
          <span
            className="h-[3px] rounded-full bg-text-tertiary"
            style={{ width: `${Math.min(100, (indexBuilt / indexTotal) * 100)}%` }}
          />
        </span>
      )}
      <span className="font-mono text-[11px] tabular-nums">
        {indexBuilt !== undefined && indexTotal !== undefined
          ? t('searchPalette.status.indexing', { done: indexBuilt, total: indexTotal })
          : t('searchPalette.status.indexingUnknown')}
      </span>
    </span>
  ) : view === 'filters' ? (
    t('searchPalette.status.filters')
  ) : view === 'tags' ? (
    t('searchPalette.status.tags')
  ) : view === 'results' ? (
    <span className="font-mono text-[11px] tabular-nums">
      {t('searchPalette.status.results', { count: totalCount, ms: Math.round(queryTimeMs) })}
    </span>
  ) : view === 'open' && itemCount !== null ? (
    t('searchPalette.status.items', { count: itemCount })
  ) : null

  // ---- Render --------------------------------------------------------------

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : handleClose())}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/20 dark:bg-black/50" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (mode === 'search') return
            e.preventDefault()
            back()
          }}
          className="fixed inset-x-0 top-[14vh] z-50 mx-auto w-[calc(100%-2rem)] max-w-[820px] focus:outline-none"
        >
          <DialogPrimitive.Title className="sr-only">
            {t('searchPalette.title')}
          </DialogPrimitive.Title>
          <Command
            ref={rootRef}
            label={t('searchPalette.title')}
            shouldFilter={false}
            loop
            value={selectedValue}
            onValueChange={setSelected}
            className="flex flex-col overflow-hidden rounded-xl border border-border bg-popover
              shadow-[0_24px_48px_-12px_rgb(0_0_0/0.18),0_2px_6px_rgb(0_0_0/0.06)]"
          >
            <SearchInputBar
              value={inputValue}
              onValueChange={handleInputChange}
              onKeyDown={handleInputKeyDown}
              placeholder={t('searchPalette.placeholder')}
              hint={
                mode !== 'search' && menuQuery === ''
                  ? t(mode === 'filters' ? 'searchPalette.filterHint' : 'searchPalette.tagHint')
                  : null
              }
              chips={chips}
              loading={loading}
            />
            <div className="flex h-[min(452px,60vh)]">
              <Command.List
                className={`min-w-0 overflow-y-auto overscroll-contain p-1.5 ${
                  view === 'results'
                    ? 'w-full min-[720px]:w-[352px] min-[720px]:shrink-0 min-[720px]:border-e min-[720px]:border-border'
                    : 'flex-1 [&>[cmdk-list-sizer]]:h-full'
                }`}
              >
                {view === 'open' && (
                  <RecentReasons
                    reasons={reasons}
                    onSelect={handleReasonSelect}
                    onClear={clearReasons}
                    onScope={toggleType}
                    onPickTag={enterTags}
                  />
                )}
                {view === 'filters' && (
                  <SearchFilterMenu
                    entries={menuEntries}
                    activeTypes={filters.types}
                    activeDate={activeDate}
                    onToggleType={(type) => {
                      toggleType(type)
                      setMenuQuery('')
                    }}
                    onToggleDate={(id) => {
                      toggleDate(id)
                      setMenuQuery('')
                    }}
                    onPickTag={enterTags}
                  />
                )}
                {view === 'tags' && (
                  <SearchTagPicker tags={tagMatches} menuQuery={menuQuery} onPick={pickTag} />
                )}
                {view === 'results' &&
                  results.map((group) => (
                    <SearchResultGroup
                      key={group.type}
                      group={group}
                      query={query}
                      expanded={expandedTypes.includes(group.type)}
                      onExpand={(type) => setExpanded({ query, types: [...expandedTypes, type] })}
                      onSelect={handleSelect}
                    />
                  ))}
                {view === 'empty' && (
                  <SearchEmptyState
                    query={query}
                    scopeLabels={filters.types.map((type) => t(TYPE_LABEL_KEYS[type]))}
                    hasFilters={hasFilters}
                    indexing={isIndexing}
                    onSearchEverywhere={() => setFilters({ ...filters, types: [] })}
                    onClearFilters={() => setFilters({ types: [], tags: [], dateRange: null })}
                  />
                )}
                {view === 'error' && (
                  <p className="py-8 text-center text-sm text-destructive">{error}</p>
                )}
              </Command.List>
              {selectedResult && (
                <div className="hidden min-w-0 flex-1 min-[720px]:flex">
                  <SearchPreview item={selectedResult} query={query} />
                </div>
              )}
            </div>
            <SearchActionBar
              leading={leading}
              status={status}
              secondary={secondary}
              primary={primary}
            />
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
