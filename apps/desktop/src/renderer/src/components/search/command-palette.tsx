import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Command } from 'cmdk'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Search,
  ArrowUp,
  ArrowDown,
  Folder,
  FileText,
  Clock,
  Check,
  X,
  CornerDownLeft,
  Tag,
  File
} from 'lucide-react'
import { parseSearchQuery } from '@/lib/search-query-parser'
import { groupByDateWithLabels, formatRelativeDate } from '@/lib/date-grouping'
import {
  searchService,
  type AdvancedSearchResultNote,
  type AdvancedSearchInput
} from '@/services/search-service'
import { notesService, type NoteListItem } from '@/services/notes-service'
import { useRecentSearches } from '@/hooks/use-search'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'
import { subDays, startOfDay } from 'date-fns'

const log = createLogger('Component:CommandPalette')

const OPERATOR_SUGGESTIONS = [
  { prefix: 'path:', label: 'path:', description: 'Search in folder', icon: Folder },
  { prefix: 'tag:', label: 'tag:', description: 'Filter by tag', icon: Tag },
  { prefix: 'file:', label: 'file:', description: 'Match filename', icon: File }
]

function sanitizeSnippet(html: string): string {
  return html.replace(/<(?!\/?mark\b)[^>]*>/gi, '')
}

function highlightOperators(text: string): React.ReactNode[] {
  if (!text) return []

  const operatorRegex = /(path:|tag:|file:|\[[^\]]+\]:)(\S*)/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match

  while ((match = operatorRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const operator = match[1]
    const value = match[2]
    parts.push(
      <span key={match.index} className="text-primary">
        {operator}
        {value}
      </span>
    )
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts
}

function getOperatorSuggestions(query: string) {
  if (!query) return []

  const words = query.split(/\s+/)
  const lastWord = words[words.length - 1]?.toLowerCase() || ''

  if (!lastWord || lastWord.includes(':')) return []

  return OPERATOR_SUGGESTIONS.filter(
    (op) => op.prefix.startsWith(lastWord) && op.prefix !== lastWord
  )
}

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  onSelectNote: (noteId: string, path: string) => void
  onSelectNoteNewTab?: (noteId: string, path: string) => void
}

type SortOption = 'relevance' | 'modified' | 'created' | 'title'
type DateFilterOption = 'any' | 'today' | 'week' | 'month'

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(handler)
  }, [value, delay])
  return debouncedValue
}

export function CommandPalette({
  isOpen,
  onClose,
  onSelectNote,
  onSelectNoteNewTab
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const actualDebouncedQuery = useDebounce(query, 150)

  const [sortBy, setSortBy] = useState<SortOption>('modified')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [titleOnly, setTitleOnly] = useState(true)
  const [folder, setFolder] = useState<string>('')
  const [dateFilter, setDateFilter] = useState<DateFilterOption>('any')

  const [results, setResults] = useState<AdvancedSearchResultNote[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [folders, setFolders] = useState<string[]>([])
  const [recentNotes, setRecentNotes] = useState<NoteListItem[]>([])
  const [isLoadingRecent, setIsLoadingRecent] = useState(false)

  const { recent, addRecent } = useRecentSearches()

  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isOpen) return

    window.api.notes
      .getFolders()
      .then(setFolders)
      .catch((err) => log.error('Failed to load folders', err))

    setIsLoadingRecent(true)
    notesService
      .list({ sortBy: 'modified', sortOrder: 'desc', limit: 50 })
      .then((response) => setRecentNotes(response.notes))
      .catch((error) => {
        log.error('Failed to load recent notes', error)
        setRecentNotes([])
      })
      .finally(() => setIsLoadingRecent(false))
  }, [isOpen])

  useEffect(() => {
    const performSearch = async () => {
      // Note: titleOnly is a search modifier, not a filter that triggers search
      const hasFilters = folder || dateFilter !== 'any'

      if (!actualDebouncedQuery.trim() && !hasFilters) {
        setResults([])
        return
      }

      setIsLoading(true)

      try {
        const parsed = parseSearchQuery(actualDebouncedQuery)

        let dateFrom: string | undefined
        const now = new Date()
        if (dateFilter === 'today') dateFrom = startOfDay(now).toISOString()
        else if (dateFilter === 'week') dateFrom = subDays(now, 7).toISOString()
        else if (dateFilter === 'month') dateFrom = subDays(now, 30).toISOString()

        const searchInput: AdvancedSearchInput = {
          text: parsed.text,
          operators: parsed.operators,
          titleOnly,
          sortBy,
          sortDirection,
          folder: folder || parsed.operators.path,
          dateFrom,
          limit: 50
        }

        const notes = await searchService.advancedSearch(searchInput)
        setResults(notes)
      } catch (error) {
        log.error('Search failed', error)
        setResults([])
      } finally {
        setIsLoading(false)
      }
    }

    performSearch()
  }, [actualDebouncedQuery, sortBy, sortDirection, titleOnly, folder, dateFilter])

  useEffect(() => {
    if (!isOpen) {
      setQuery('')
      setResults([])
      setRecentNotes([])
    }
  }, [isOpen])

  const handleSelect = useCallback(
    (noteId: string, path: string) => {
      addRecent(query || path)
      onSelectNote(noteId, path)
      onClose()
    },
    [query, addRecent, onSelectNote, onClose]
  )

  const groupedResults = useMemo(() => {
    return groupByDateWithLabels(results, (item) => item.modified)
  }, [results])

  // Show recent notes when no query and no active filters
  const showRecentNotes = !query.trim() && !folder && dateFilter === 'any'

  const groupedRecentNotes = useMemo(() => {
    if (!showRecentNotes) return []
    return groupByDateWithLabels(recentNotes, (item) => item.modified)
  }, [recentNotes, showRecentNotes])

  const operatorSuggestions = useMemo(() => {
    return getOperatorSuggestions(query)
  }, [query])

  const insertOperator = useCallback(
    (operator: string) => {
      const words = query.split(/\s+/)
      words[words.length - 1] = operator
      setQuery(words.join(' '))
      inputRef.current?.focus()
    },
    [query]
  )

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="p-0 gap-0 max-w-3xl overflow-hidden bg-popover text-popover-foreground shadow-2xl border-none ring-0 outline-none">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Search for notes, tasks, and more. Use arrow keys to navigate and Enter to select.
        </DialogDescription>
        <Command className="flex flex-col h-[65vh] w-full bg-transparent" shouldFilter={false} loop>
          <div className="flex flex-col border-b border-border/40 bg-background/50 backdrop-blur-sm">
            <div className="flex items-center px-4 py-3 gap-3">
              <Search className="h-5 w-5 text-muted-foreground shrink-0" />
              <div className="flex-1 relative">
                <div
                  className="absolute inset-0 text-lg pointer-events-none whitespace-pre text-transparent"
                  aria-hidden="true"
                >
                  {highlightOperators(query)}
                </div>
                <Command.Input
                  ref={inputRef}
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search... try path: tag: file:"
                  className="w-full bg-transparent text-lg outline-none placeholder:text-muted-foreground/70 caret-foreground"
                  style={{ color: query ? 'inherit' : undefined }}
                />
              </div>
              {isLoading && (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              )}
            </div>

            <div className="flex items-center gap-2 px-4 pb-3 overflow-x-auto scrollbar-hide">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs font-normal border border-transparent hover:border-border/50 hover:bg-muted/50 data-[state=open]:bg-muted"
                  >
                    <span className="text-muted-foreground mr-1">Sort:</span>
                    <span className="font-medium flex items-center gap-1">
                      {sortBy === 'relevance'
                        ? 'Best match'
                        : sortBy === 'modified'
                          ? 'Last edited'
                          : sortBy === 'created'
                            ? 'Created'
                            : 'Title'}
                    </span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-48 p-1" align="start">
                  <div className="flex flex-col gap-1">
                    <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                      Sort by
                    </div>
                    {[
                      { value: 'relevance', label: 'Best match' },
                      { value: 'modified', label: 'Last edited' },
                      { value: 'created', label: 'Created time' },
                      { value: 'title', label: 'Title' }
                    ].map((opt) => (
                      <div
                        key={opt.value}
                        role="option"
                        tabIndex={0}
                        aria-selected={sortBy === opt.value}
                        className={cn(
                          'flex items-center justify-between px-2 py-1.5 text-sm rounded-sm cursor-pointer hover:bg-accent hover:text-accent-foreground',
                          sortBy === opt.value && 'bg-accent/50'
                        )}
                        onClick={() => setSortBy(opt.value as SortOption)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setSortBy(opt.value as SortOption)
                          }
                        }}
                      >
                        {opt.label}
                        {sortBy === opt.value && <Check className="h-3 w-3" />}
                      </div>
                    ))}
                    <div className="h-px bg-border my-1" />
                    <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                      Order
                    </div>
                    <div
                      role="option"
                      tabIndex={0}
                      aria-selected={sortDirection === 'asc'}
                      className="flex items-center justify-between px-2 py-1.5 text-sm rounded-sm cursor-pointer hover:bg-accent hover:text-accent-foreground"
                      onClick={() => setSortDirection('asc')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSortDirection('asc')
                        }
                      }}
                    >
                      Ascending{' '}
                      <ArrowUp
                        className={cn(
                          'h-3 w-3',
                          sortDirection === 'asc' ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </div>
                    <div
                      role="option"
                      tabIndex={0}
                      aria-selected={sortDirection === 'desc'}
                      className="flex items-center justify-between px-2 py-1.5 text-sm rounded-sm cursor-pointer hover:bg-accent hover:text-accent-foreground"
                      onClick={() => setSortDirection('desc')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSortDirection('desc')
                        }
                      }}
                    >
                      Descending{' '}
                      <ArrowDown
                        className={cn(
                          'h-3 w-3',
                          sortDirection === 'desc' ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </div>
                  </div>
                </PopoverContent>
              </Popover>

              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-7 px-2 text-xs font-normal border border-transparent hover:border-border/50 hover:bg-muted/50',
                  titleOnly && 'bg-primary/10 text-primary hover:bg-primary/20 border-primary/20'
                )}
                onClick={() => setTitleOnly(!titleOnly)}
              >
                Title only
              </Button>

              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs font-normal border border-transparent hover:border-border/50 hover:bg-muted/50 data-[state=open]:bg-muted"
                  >
                    <span className="text-muted-foreground mr-1">In:</span>
                    <span className="font-medium max-w-[100px] truncate">
                      {folder ? folder.split('/').pop() : 'All folders'}
                    </span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[200px] p-0" align="start">
                  <Command>
                    <Command.Input
                      placeholder="Filter folders..."
                      className="h-9 px-2 text-xs border-b outline-none"
                    />
                    <Command.List className="max-h-[200px] overflow-y-auto p-1">
                      <Command.Item
                        onSelect={() => setFolder('')}
                        className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer hover:bg-accent aria-selected:bg-accent"
                      >
                        <Folder className="h-3 w-3 text-muted-foreground" />
                        <span>All folders</span>
                        {!folder && <Check className="ml-auto h-3 w-3" />}
                      </Command.Item>
                      {folders.map((f) => (
                        <Command.Item
                          key={f}
                          value={f}
                          onSelect={() => setFolder(f)}
                          className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer hover:bg-accent aria-selected:bg-accent"
                        >
                          <Folder className="h-3 w-3 text-muted-foreground" />
                          <span className="truncate">{f}</span>
                          {folder === f && <Check className="ml-auto h-3 w-3" />}
                        </Command.Item>
                      ))}
                    </Command.List>
                  </Command>
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs font-normal border border-transparent hover:border-border/50 hover:bg-muted/50 data-[state=open]:bg-muted"
                  >
                    <span className="text-muted-foreground mr-1">Date:</span>
                    <span className="font-medium">
                      {dateFilter === 'any'
                        ? 'Any time'
                        : dateFilter === 'today'
                          ? 'Today'
                          : dateFilter === 'week'
                            ? 'Past week'
                            : 'Past 30 days'}
                    </span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-40 p-1" align="start">
                  {[
                    { value: 'any', label: 'Any time' },
                    { value: 'today', label: 'Today' },
                    { value: 'week', label: 'Past week' },
                    { value: 'month', label: 'Past 30 days' }
                  ].map((opt) => (
                    <div
                      key={opt.value}
                      role="option"
                      tabIndex={0}
                      aria-selected={dateFilter === opt.value}
                      className={cn(
                        'flex items-center justify-between px-2 py-1.5 text-sm rounded-sm cursor-pointer hover:bg-accent hover:text-accent-foreground',
                        dateFilter === opt.value && 'bg-accent/50'
                      )}
                      onClick={() => setDateFilter(opt.value as DateFilterOption)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setDateFilter(opt.value as DateFilterOption)
                        }
                      }}
                    >
                      {opt.label}
                      {dateFilter === opt.value && <Check className="h-3 w-3" />}
                    </div>
                  ))}
                </PopoverContent>
              </Popover>

              {(folder || dateFilter !== 'any' || titleOnly) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground ml-auto"
                  onClick={() => {
                    setFolder('')
                    setDateFilter('any')
                    setTitleOnly(false)
                    setSortBy('modified')
                  }}
                  title="Clear filters"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>

          <Command.List className="flex-1 overflow-y-auto p-2 scroll-py-2 bg-background/30">
            {operatorSuggestions.length > 0 && (
              <Command.Group heading="Operators" className="mb-2">
                {operatorSuggestions.map((op) => (
                  <Command.Item
                    key={op.prefix}
                    value={`operator-${op.prefix}`}
                    onSelect={() => insertOperator(op.prefix)}
                    className="flex items-center gap-3 px-3 py-2 rounded-md aria-selected:bg-accent aria-selected:text-accent-foreground cursor-pointer"
                  >
                    <op.icon className="h-4 w-4 text-primary" />
                    <span className="text-primary font-medium">{op.label}</span>
                    <span className="text-muted-foreground text-sm">{op.description}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Empty state: only show when not loading, no results, no recent notes to display */}
            {!isLoading &&
              !isLoadingRecent &&
              results.length === 0 &&
              operatorSuggestions.length === 0 &&
              (!showRecentNotes || recentNotes.length === 0) && (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  {query ? 'No results found.' : 'No recent notes yet'}
                </div>
              )}

            {/* Recent searches: show only when no query, no results, no recent notes, but have recent searches */}
            {!query &&
              !results.length &&
              recent.length > 0 &&
              (!showRecentNotes || recentNotes.length === 0) && (
                <Command.Group heading="Recent Searches" className="mb-2">
                  {recent.map((r) => (
                    <Command.Item
                      key={r}
                      value={`recent-${r}`}
                      onSelect={() => setQuery(r)}
                      className="flex items-center gap-2 px-3 py-2 rounded-md aria-selected:bg-accent aria-selected:text-accent-foreground cursor-pointer group"
                    >
                      <Clock className="h-4 w-4 text-muted-foreground/50 group-aria-selected:text-muted-foreground" />
                      <span className="flex-1">{r}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

            {/* Recent notes: show when no query and no filters */}
            {showRecentNotes &&
              groupedRecentNotes.map((group) => (
                <Command.Group
                  key={`recent-${group.group}`}
                  heading={group.label}
                  className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {group.items.map((note) => (
                    <Command.Item
                      key={note.id}
                      value={note.id}
                      onSelect={() => handleSelect(note.id, note.path)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          e.stopPropagation()
                          onSelectNoteNewTab?.(note.id, note.path)
                          onClose()
                        }
                      }}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-md aria-selected:bg-accent aria-selected:text-accent-foreground cursor-pointer group transition-colors"
                    >
                      <div className="flex items-center justify-center h-8 w-8 rounded-md bg-muted/50 text-muted-foreground group-aria-selected:bg-background group-aria-selected:text-foreground transition-colors text-lg">
                        {note.emoji || <FileText className="h-4 w-4" />}
                      </div>

                      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm truncate">{note.title}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground group-aria-selected:text-muted-foreground/80">
                          <span className="truncate max-w-[200px] opacity-70">{note.path}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                        <span>{formatRelativeDate(note.modified)}</span>
                      </div>
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}

            {/* Search results */}
            {groupedResults.map((group) => (
              <Command.Group
                key={group.group}
                heading={group.label}
                className="mb-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {group.items.map((note) => (
                  <Command.Item
                    key={note.id}
                    value={note.id}
                    onSelect={() => handleSelect(note.id, note.path)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        e.stopPropagation()
                        onSelectNoteNewTab?.(note.id, note.path)
                        onClose()
                      }
                    }}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-md aria-selected:bg-accent aria-selected:text-accent-foreground cursor-pointer group transition-colors"
                  >
                    <div className="flex items-center justify-center h-8 w-8 rounded-md bg-muted/50 text-muted-foreground group-aria-selected:bg-background group-aria-selected:text-foreground transition-colors text-lg">
                      {note.emoji || <FileText className="h-4 w-4" />}
                    </div>

                    <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{note.title}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground group-aria-selected:text-muted-foreground/80">
                        <span className="truncate max-w-[200px] opacity-70">{note.path}</span>
                        {note.snippet && (
                          <>
                            <span className="w-1 h-1 rounded-full bg-border" />
                            <span
                              className="truncate max-w-[300px]"
                              dangerouslySetInnerHTML={{ __html: sanitizeSnippet(note.snippet) }}
                            />
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                      <span>{formatRelativeDate(note.modified)}</span>
                    </div>
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>

          <div className="flex items-center justify-between px-4 py-2 border-t bg-muted/20 text-xs text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <ArrowUp className="h-3 w-3" />
                <ArrowDown className="h-3 w-3" />
                <span>Select</span>
              </span>
              <span className="flex items-center gap-1">
                <CornerDownLeft className="h-3 w-3" />
                <span>Open</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="font-sans">⌘</span>
                <CornerDownLeft className="h-3 w-3" />
                <span>New tab</span>
              </span>
            </div>
            <div>
              {results.length > 0 && <span>{results.length} results</span>}
              {showRecentNotes && recentNotes.length > 0 && results.length === 0 && (
                <span>{recentNotes.length} recent notes</span>
              )}
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
