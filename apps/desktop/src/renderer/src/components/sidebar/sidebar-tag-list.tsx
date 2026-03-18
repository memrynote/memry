import * as React from 'react'
import { Search, ArrowUpDown, ArrowDownAZ, ArrowUpAZ, X } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

type TagSortOption = 'count-desc' | 'count-asc' | 'alpha-asc' | 'alpha-desc'

const SORT_STORAGE_KEY = 'sidebar-tags-sort'

const SORT_OPTIONS: ReadonlyArray<{ value: TagSortOption; label: string }> = [
  { value: 'count-desc', label: 'Count: High → Low' },
  { value: 'count-asc', label: 'Count: Low → High' },
  { value: 'alpha-asc', label: 'Name: A → Z' },
  { value: 'alpha-desc', label: 'Name: Z → A' }
] as const

function loadSortPreference(): TagSortOption {
  try {
    const saved = localStorage.getItem(SORT_STORAGE_KEY)
    if (saved && SORT_OPTIONS.some((o) => o.value === saved)) {
      return saved as TagSortOption
    }
  } catch {
    /* ignore */
  }
  return 'count-desc'
}

interface SidebarTagListProps {
  maxVisible?: number
  onTagClick?: (tag: string, color: string) => void
  selectedTag?: string | null
  className?: string
  onActionsReady?: (actions: React.ReactNode) => void
}

export function SidebarTagList({
  maxVisible = 8,
  onTagClick,
  selectedTag,
  className,
  onActionsReady
}: SidebarTagListProps): React.JSX.Element {
  const { tags, isLoading, error } = useNoteTagsQuery()
  const [showAll, setShowAll] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [sortBy, setSortBy] = React.useState<TagSortOption>(loadSortPreference)
  const searchInputRef = React.useRef<HTMLInputElement>(null)

  const handleSortChange = (value: string): void => {
    const next = value as TagSortOption
    setSortBy(next)
    try {
      localStorage.setItem(SORT_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }

  const toggleSearch = React.useCallback((): void => {
    setSearchOpen((prev) => {
      if (prev) setSearchQuery('')
      return !prev
    })
  }, [])

  React.useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
    }
  }, [searchOpen])

  const currentSortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? 'Sort'

  React.useEffect(() => {
    onActionsReady?.(
      <>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-5 w-5', searchOpen && 'text-foreground')}
          onClick={toggleSearch}
          aria-label={searchOpen ? 'Close search' : 'Search tags'}
        >
          {searchOpen ? <X className="h-3 w-3" /> : <Search className="h-3 w-3" />}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              aria-label={`Sort tags: ${currentSortLabel}`}
            >
              <ArrowUpDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuRadioGroup value={sortBy} onValueChange={handleSortChange}>
              <DropdownMenuRadioItem value="count-desc">Count: High → Low</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="count-asc">Count: Low → High</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="alpha-asc">
                <ArrowDownAZ className="h-3.5 w-3.5 mr-1.5" />
                Name: A → Z
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="alpha-desc">
                <ArrowUpAZ className="h-3.5 w-3.5 mr-1.5" />
                Name: Z → A
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    )
  }, [searchOpen, sortBy, currentSortLabel, toggleSearch, onActionsReady])

  const processedTags = React.useMemo(() => {
    const filtered = tags
      .filter((t) => t.count > 0)
      .filter((t) => {
        if (!searchQuery) return true
        return t.tag.toLowerCase().includes(searchQuery.toLowerCase())
      })

    const compareFn = (
      a: { tag: string; count: number },
      b: { tag: string; count: number }
    ): number => {
      switch (sortBy) {
        case 'count-desc':
          return b.count - a.count
        case 'count-asc':
          return a.count - b.count
        case 'alpha-asc':
          return a.tag.localeCompare(b.tag)
        case 'alpha-desc':
          return b.tag.localeCompare(a.tag)
      }
    }

    return [...filtered].sort(compareFn)
  }, [tags, searchQuery, sortBy])

  const visibleTags = showAll ? processedTags : processedTags.slice(0, maxVisible)
  const hasMore = processedTags.length > maxVisible

  const handleTagClick = (tagName: string, tagColor: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    onTagClick?.(tagName, tagColor)
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      setSearchOpen(false)
      setSearchQuery('')
    }
  }

  if (isLoading) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="size-3 rounded-full bg-muted animate-pulse" />
          <span>Loading tags...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-destructive">Failed to load tags</span>
      </div>
    )
  }

  const allTags = tags.filter((t) => t.count > 0)

  if (allTags.length === 0) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-muted-foreground">No tags yet</span>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {/* Search input — only visible when toggled */}
      {searchOpen && (
        <div className="px-5">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Filter tags..."
            className="w-full h-6 px-2 text-[11px] rounded-md border bg-transparent placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      )}

      {/* Tag pills */}
      <div className="pl-5 pr-2.5 flex flex-wrap gap-1.5">
        {visibleTags.length === 0 && searchQuery ? (
          <span className="text-[11px] text-muted-foreground">No matching tags</span>
        ) : (
          visibleTags.map((tag) => {
            const colors = getTagColors(tag.color)

            return (
              <button
                key={tag.tag}
                type="button"
                onClick={handleTagClick(tag.tag, tag.color)}
                title={`${tag.tag} (${tag.count})`}
                className={cn(
                  'flex items-center gap-1.5 rounded-sm py-0.5 px-2 text-[11px] font-medium leading-3.5',
                  'transition-opacity hover:opacity-80',
                  selectedTag === tag.tag && 'ring-1 ring-current'
                )}
                style={{
                  backgroundColor: `${colors.text}1A`,
                  color: colors.text
                }}
              >
                <span
                  className="size-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: colors.text }}
                />
                {tag.tag}
              </button>
            )
          })
        )}

        {hasMore && !searchQuery && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="rounded-sm py-0.5 px-2 text-[11px] font-medium leading-3.5 text-sidebar-muted hover:text-sidebar-foreground transition-colors"
          >
            {showAll ? 'Show less' : `+${processedTags.length - maxVisible} more`}
          </button>
        )}
      </div>
    </div>
  )
}

export default SidebarTagList
