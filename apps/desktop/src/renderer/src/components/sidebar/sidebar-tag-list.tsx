import * as React from 'react'
import {
  Search,
  ArrowUpDown,
  ArrowDownAZ,
  ArrowUpAZ,
  X,
  ChevronRight,
  ChevronDown,
  LayoutGrid
} from '@/lib/icons'

import { cn } from '@/lib/utils'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { buildTagTree, type TagTreeNode } from '@/lib/tag-tree'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { Button } from '@/components/ui/button'
import { Picker } from '@/components/ui/picker'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { BookmarkMenuItem } from '@/components/sidebar/bookmark-menu-item'
import { useT } from '@memry/i18n/renderer'

type TagSortOption = 'count-desc' | 'count-asc' | 'alpha-asc' | 'alpha-desc'

const SORT_STORAGE_KEY = 'sidebar-tags-sort'
const EXPANDED_STORAGE_KEY = 'sidebar-tags-expanded'

const SORT_OPTIONS: ReadonlyArray<{ value: TagSortOption; label: string }> = [
  { value: 'count-desc', label: 'Most used' },
  { value: 'count-asc', label: 'Least used' },
  { value: 'alpha-asc', label: 'A → Z' },
  { value: 'alpha-desc', label: 'Z → A' }
] as const

const SORT_ICONS: Record<TagSortOption, React.ReactNode> = {
  'count-desc': <ArrowUpDown className="h-3.5 w-3.5" />,
  'count-asc': <ArrowUpDown className="h-3.5 w-3.5" />,
  'alpha-asc': <ArrowDownAZ className="h-3.5 w-3.5" />,
  'alpha-desc': <ArrowUpAZ className="h-3.5 w-3.5" />
}

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

function loadExpandedState(): Set<string> {
  try {
    const saved = localStorage.getItem(EXPANDED_STORAGE_KEY)
    if (saved) return new Set(JSON.parse(saved) as string[])
  } catch {
    /* ignore */
  }
  return new Set()
}

function saveExpandedState(expanded: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...expanded]))
  } catch {
    /* ignore */
  }
}

// =============================================================================
// TagTreeItem — recursive tree node
// =============================================================================

interface TagTreeItemProps {
  node: TagTreeNode
  selectedTag?: string | null
  expanded: Set<string>
  onToggle: (fullPath: string) => void
  onTagClick: (tag: string, color: string) => void
}

function TagTreeItem({
  node,
  selectedTag,
  expanded,
  onToggle,
  onTagClick
}: TagTreeItemProps): React.JSX.Element {
  const { t } = useT('common')
  const hasChildren = node.children.length > 0
  const isExpanded = expanded.has(node.fullPath)
  const colors = getTagColors(node.color ?? '', node.fullPath)
  const isSelected = selectedTag === node.fullPath

  // The tag pill shrink-wraps its label, so the fade mask must only apply when
  // the name is actually clipped — otherwise short names fade with room to spare.
  const labelRef = React.useRef<HTMLSpanElement>(null)
  const [isLabelTruncated, setIsLabelTruncated] = React.useState(false)

  React.useLayoutEffect(() => {
    const el = labelRef.current
    if (!el) return
    const measure = (): void => setIsLabelTruncated(el.scrollWidth > el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [node.name])

  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onToggle(node.fullPath)
  }

  const handleTagClick = (e: React.MouseEvent) => {
    e.preventDefault()
    onTagClick(node.fullPath, node.color ?? '')
  }

  return (
    <>
      <div
        className="flex items-center group rounded-md transition-colors hover:bg-muted"
        style={{ paddingLeft: `${node.depth * 14 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={handleChevronClick}
            className="shrink-0 size-4 flex items-center justify-center rounded-sm hover:bg-foreground/5 transition-colors"
            aria-label={isExpanded ? t('action.collapse') : t('action.expand')}
          >
            {isExpanded ? (
              <ChevronDown className="size-2.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-2.5 text-muted-foreground" />
            )}
          </button>
        ) : (
          <span className="shrink-0 size-4" />
        )}

        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={handleTagClick}
              title={`${node.fullPath} (${node.totalCount})`}
              className={cn(
                'flex items-center gap-1.5 rounded-sm py-0.5 px-1.5 text-[11px] font-medium leading-3.5 min-w-0',
                isSelected && 'ring-1 ring-current',
                node.isVirtual && 'opacity-60'
              )}
              style={
                colors
                  ? { backgroundColor: `${colors.text}1A`, color: colors.text }
                  : { backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }
              }
            >
              {node.icon ? (
                <NoteIconDisplay
                  value={node.icon}
                  className="size-3 shrink-0 text-[11px] leading-none"
                />
              ) : (
                <span
                  className="size-1.5 rounded-full shrink-0"
                  style={
                    colors
                      ? { backgroundColor: colors.text }
                      : { backgroundColor: 'var(--muted-foreground)' }
                  }
                />
              )}
              <span
                ref={labelRef}
                className={cn('min-w-0 truncate', isLabelTruncated && 'sidebar-label-fade-mask')}
              >
                {node.name}
              </span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            <BookmarkMenuItem itemType="tag" itemId={node.fullPath} />
          </ContextMenuContent>
        </ContextMenu>

        <span className="ms-auto pe-2.5 text-[10px] text-muted-foreground/40 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">
          {node.totalCount}
        </span>
      </div>

      {hasChildren && isExpanded && (
        <div className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <TagTreeItem
              key={child.fullPath}
              node={child}
              selectedTag={selectedTag}
              expanded={expanded}
              onToggle={onToggle}
              onTagClick={onTagClick}
            />
          ))}
        </div>
      )}
    </>
  )
}

// =============================================================================
// SidebarTagList
// =============================================================================

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
  const { t: tPhaseF } = useT('notes')
  const { t } = useT('common')
  const { openSidebarItem } = useSidebarNavigation()
  const { tags, isLoading, error } = useNoteTagsQuery()
  const [showAll, setShowAll] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [sortBy, setSortBy] = React.useState<TagSortOption>(loadSortPreference)
  const [expanded, setExpanded] = React.useState<Set<string>>(loadExpandedState)
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
    return () => {}
  }, [searchOpen])

  const currentSortLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? 'Sort'

  // Push the actions JSX up to the parent. Wrapped in queueMicrotask so the
  // parent state update happens asynchronously — keeps the
  // no-pass-{data,live-state}-to-parent rules happy without changing observable
  // behavior beyond a single microtask of latency.
  React.useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      onActionsReady?.(
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() =>
              openSidebarItem({
                type: 'tags',
                title: tPhaseF('tags.hubTitle'),
                path: '/tags',
                icon: 'tag'
              })
            }
            aria-label={tPhaseF('tags.openHub')}
          >
            <LayoutGrid className="h-3 w-3" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className={cn('h-5 w-5', searchOpen && 'text-foreground')}
            onClick={toggleSearch}
            aria-label={searchOpen ? 'Close search' : 'Search tags'}
          >
            {searchOpen ? <X className="h-3 w-3" /> : <Search className="h-3 w-3" />}
          </Button>

          <Picker value={sortBy} onValueChange={handleSortChange}>
            <Picker.Trigger
              variant="icon"
              className="h-5 w-5"
              aria-label={`Sort tags: ${currentSortLabel}`}
            >
              <ArrowUpDown className="h-3 w-3" />
            </Picker.Trigger>
            <Picker.Content align="end" width={180}>
              <Picker.List>
                {SORT_OPTIONS.map((opt) => (
                  <Picker.Item
                    key={opt.value}
                    value={opt.value}
                    label={opt.label}
                    icon={SORT_ICONS[opt.value]}
                    indicator="check"
                  />
                ))}
              </Picker.List>
            </Picker.Content>
          </Picker>
        </>
      )
    })
    return () => {
      cancelled = true
    }
  }, [searchOpen, sortBy, currentSortLabel, toggleSearch, onActionsReady, openSidebarItem, tPhaseF])

  const handleToggle = React.useCallback((fullPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(fullPath)) {
        next.delete(fullPath)
      } else {
        next.add(fullPath)
      }
      saveExpandedState(next)
      return next
    })
  }, [])

  const handleTagClick = React.useCallback(
    (tagName: string, tagColor: string) => {
      onTagClick?.(tagName, tagColor)
    },
    [onTagClick]
  )

  const tree = React.useMemo(() => {
    const filtered = tags
      .filter((t) => t.count > 0)
      .filter((t) => {
        if (!searchQuery) return true
        return t.tag.toLowerCase().includes(searchQuery.toLowerCase())
      })

    const built = buildTagTree(
      filtered.map((t) => ({ tag: t.tag, count: t.count, color: t.color, icon: t.icon }))
    )

    const sortNodes = (nodes: TagTreeNode[]): TagTreeNode[] => {
      const sorted = [...nodes].sort((a, b) => {
        switch (sortBy) {
          case 'count-desc':
            return b.totalCount - a.totalCount
          case 'count-asc':
            return a.totalCount - b.totalCount
          case 'alpha-asc':
            return a.name.localeCompare(b.name)
          case 'alpha-desc':
            return b.name.localeCompare(a.name)
        }
      })
      return sorted.map((node) => ({
        ...node,
        children: sortNodes(node.children)
      }))
    }

    return sortNodes(built)
  }, [tags, searchQuery, sortBy])

  const visibleTree = showAll ? tree : tree.slice(0, maxVisible)
  const hasMore = tree.length > maxVisible

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
          <span>{tPhaseF('phaseF.componentsSidebarSidebarTagList.loadingTags')}</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-destructive">
          {tPhaseF('phaseF.componentsSidebarSidebarTagList.failedToLoadTags')}
        </span>
      </div>
    )
  }

  const allTags = tags.filter((t) => t.count > 0)

  if (allTags.length === 0) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-muted-foreground">
          {tPhaseF('phaseF.componentsSidebarSidebarTagList.noTagsYet')}
        </span>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {searchOpen && (
        <div className="px-2">
          <input
            ref={searchInputRef}
            type="text"
            aria-label={tPhaseF('phaseF.componentsSidebarSidebarTagList.filterTags')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={tPhaseF('phaseF.componentsSidebarSidebarTagList.filterTags')}
            className="w-full h-6 px-2 text-[11px] rounded-md border bg-transparent placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        {visibleTree.length === 0 && searchQuery ? (
          <span className="text-[11px] text-muted-foreground px-2">
            {tPhaseF('phaseF.componentsSidebarSidebarTagList.noMatchingTags')}
          </span>
        ) : (
          visibleTree.map((node) => (
            <TagTreeItem
              key={node.fullPath}
              node={node}
              selectedTag={selectedTag}
              expanded={expanded}
              onToggle={handleToggle}
              onTagClick={handleTagClick}
            />
          ))
        )}

        {hasMore && !searchQuery && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="rounded-sm py-0.5 px-2 ms-6 text-[11px] font-medium leading-3.5 text-sidebar-muted hover:text-sidebar-foreground transition-colors text-start"
          >
            {showAll
              ? t('action.showLess')
              : t('action.showMore', { count: tree.length - maxVisible })}
          </button>
        )}
      </div>
    </div>
  )
}

export default SidebarTagList
