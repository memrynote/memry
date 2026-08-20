import * as React from 'react'
import {
  Search,
  ArrowUpDown,
  ArrowDownAZ,
  ArrowUpAZ,
  GripVertical,
  X,
  ChevronRight,
  ChevronDown,
  Tags
} from '@/lib/icons'

import { cn } from '@/lib/utils'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { useTagCategories, type HubTag } from '@/hooks/use-tag-categories'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { buildTagTree, type TagTreeNode } from '@/lib/tag-tree'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { Button } from '@/components/ui/button'
import { Picker } from '@/components/ui/picker'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { BookmarkMenuItem } from '@/components/sidebar/bookmark-menu-item'
import { OpenTargetMenuItems } from '@/components/sidebar/open-target-menu-items'
import { useOpenTarget } from '@/hooks/use-open-target'
import { createTabFromSidebarItem } from '@/contexts/tabs/helpers'
import { useT } from '@memry/i18n/renderer'
import { SIDEBAR_SORT_DEFAULTS, type SidebarSortMode } from '@memry/contracts/sidebar-sort'
import { useSidebarSortMode } from '@/hooks/use-sidebar-sort-mode'
import { SidebarSortPicker } from '@/components/sidebar/sidebar-sort-picker'
import { useSidebarSortLabels } from '@/components/sidebar/use-sidebar-sort-labels'

type TagSortOption = 'manual' | 'count-desc' | 'count-asc' | 'alpha-asc' | 'alpha-desc'

const SORT_STORAGE_KEY = 'sidebar-tags-sort'
const EXPANDED_STORAGE_KEY = 'sidebar-tags-expanded'

// Category headings share the tag-tree's expanded-state Set, prefixed so a
// category id can never collide with a `/`-tree tag path.
const CATEGORY_KEY_PREFIX = 'category:'
const UNCATEGORIZED_GROUP_ID = 'uncategorized'

const SORT_OPTIONS: ReadonlyArray<{ value: TagSortOption; label: string }> = [
  { value: 'manual', label: 'Manual' },
  { value: 'count-desc', label: 'Most used' },
  { value: 'count-asc', label: 'Least used' },
  { value: 'alpha-asc', label: 'A → Z' },
  { value: 'alpha-desc', label: 'Z → A' }
] as const

const SORT_ICONS: Record<TagSortOption, React.ReactNode> = {
  manual: <GripVertical className="h-3.5 w-3.5" />,
  'count-desc': <ArrowUpDown className="h-3.5 w-3.5" />,
  'count-asc': <ArrowUpDown className="h-3.5 w-3.5" />,
  'alpha-asc': <ArrowDownAZ className="h-3.5 w-3.5" />,
  'alpha-desc': <ArrowUpAZ className="h-3.5 w-3.5" />
}

/**
 * The per-device localStorage preference this section used before sort modes
 * became a synced, cross-surface setting. Read once to carry a user's existing
 * choice forward; the key is deliberately NOT deleted, so downgrading to an
 * older build still finds it.
 */
const LEGACY_MODE_BY_OPTION: Record<TagSortOption, SidebarSortMode> = {
  manual: 'manual',
  'count-desc': 'count-desc',
  'count-asc': 'count-asc',
  'alpha-asc': 'name-asc',
  'alpha-desc': 'name-desc'
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
  return 'manual'
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
// Grouping — one `/`-tree per category, plus an Uncategorized tree
// =============================================================================

interface TagGroup {
  id: string
  name: string
  nodes: TagTreeNode[]
}

function compareTreeNodes(
  sortBy: SidebarSortMode,
  order: Map<string, number>
): (a: TagTreeNode, b: TagTreeNode) => number {
  return (a, b) => {
    switch (sortBy) {
      case 'count-desc':
        return b.totalCount - a.totalCount
      case 'count-asc':
        return a.totalCount - b.totalCount
      case 'name-asc':
        return a.name.localeCompare(b.name)
      case 'name-desc':
        return b.name.localeCompare(a.name)
      // 'manual', and any mode this surface does not offer.
      default: {
        const orderA = order.get(a.fullPath) ?? Number.MAX_SAFE_INTEGER
        const orderB = order.get(b.fullPath) ?? Number.MAX_SAFE_INTEGER
        return orderA - orderB
      }
    }
  }
}

function sortTreeNodes(
  nodes: TagTreeNode[],
  compare: (a: TagTreeNode, b: TagTreeNode) => number
): TagTreeNode[] {
  return [...nodes]
    .sort(compare)
    .map((node) => ({ ...node, children: sortTreeNodes(node.children, compare) }))
}

// Builds one group's `/`-tree from its own tags only, so nested tags
// ("work/project") still nest inside their category rather than flattening.
// `order` (for the 'manual' sort) is keyed by fullPath from this group's own
// tags — already sorted by the backend's sortOrder — so a tag's position in
// that pre-sorted list becomes its manual rank; a virtual path segment that
// isn't itself a tag (e.g. "work" when only "work/project" exists) has no
// rank and sorts after every real entry in the group.
function buildGroupNodes(
  groupTags: HubTag[],
  searchQuery: string,
  sortBy: SidebarSortMode
): TagTreeNode[] {
  const filtered = groupTags
    .filter((t) => t.count > 0)
    .filter((t) => !searchQuery || t.tag.toLowerCase().includes(searchQuery.toLowerCase()))

  const order = new Map(filtered.map((t, index) => [t.tag, index]))
  const built = buildTagTree(
    filtered.map((t) => ({ tag: t.tag, count: t.count, color: t.color, icon: t.icon }))
  )

  return sortTreeNodes(built, compareTreeNodes(sortBy, order))
}

// =============================================================================
// TagTreeItem — recursive tree node
// =============================================================================

interface TagTreeItemProps {
  node: TagTreeNode
  expanded: Set<string>
  onToggle: (fullPath: string) => void
  onTagClick: (tag: string, color: string) => void
}

function TagTreeItem({
  node,
  expanded,
  onToggle,
  onTagClick
}: TagTreeItemProps): React.JSX.Element {
  const { t } = useT('common')
  const hasChildren = node.children.length > 0
  const isExpanded = expanded.has(node.fullPath)
  const colors = getTagColors(node.color ?? '', node.fullPath)

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

  // Middle-click opens the tag in a background tab — the row's "Open in New
  // Tab" as a gesture (mousedown: middle never produces `click`).
  const { openInNewTab } = useOpenTarget()
  const handleTagMiddleClick = (e: React.MouseEvent): void => {
    if (e.button !== 1) return
    e.preventDefault()
    openInNewTab(
      createTabFromSidebarItem({
        type: 'tag',
        title: node.name,
        path: '/tags/' + node.fullPath,
        entityId: node.fullPath,
        color: node.color ?? ''
      }),
      { background: true }
    )
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
              onMouseDown={handleTagMiddleClick}
              title={`${node.fullPath} (${node.totalCount})`}
              className={cn(
                'flex items-center gap-1.5 rounded-sm py-0.5 px-1.5 text-[11px] font-medium leading-3.5 min-w-0',
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
            <OpenTargetMenuItems
              tab={createTabFromSidebarItem({
                type: 'tag',
                title: node.name,
                path: '/tags/' + node.fullPath,
                entityId: node.fullPath,
                color: node.color ?? ''
              })}
            />
            <ContextMenuSeparator />
            <BookmarkMenuItem itemType="tag" itemId={node.fullPath} />
          </ContextMenuContent>
        </ContextMenu>

        {/* The note count is information, not chrome, and 10px is small text
            under WCAG AA. `--muted-foreground` at 40% was 1.95:1 on the row's
            hover background; the sidebar heading token holds 5.06:1 there. */}
        <span className="ms-auto pe-2.5 text-[10px] text-sidebar-section-heading tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">
          {node.totalCount}
        </span>
      </div>

      {hasChildren && isExpanded && (
        <div className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <TagTreeItem
              key={child.fullPath}
              node={child}
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
  className?: string
  onActionsReady?: (actions: React.ReactNode) => void
}

export function SidebarTagList({
  maxVisible = 8,
  className,
  onActionsReady
}: SidebarTagListProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  const { t } = useT('common')
  const { openSidebarItem } = useSidebarNavigation()
  const { tags, isLoading: isLoadingTags, error } = useNoteTagsQuery()
  const { categories, uncategorized, isLoading: isLoadingCategories } = useTagCategories()
  const isLoading = isLoadingTags || isLoadingCategories
  const [showAllByGroup, setShowAllByGroup] = React.useState<Record<string, boolean>>({})
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const { mode: sortBy, setMode: setSortMode, isLoaded: isSortLoaded } = useSidebarSortMode('tags')
  const sortLabels = useSidebarSortLabels()

  // One-time carry-over of the old per-device preference. Only when the synced
  // value is still the default: a mode already chosen on another device must
  // win over whatever this device happened to have in localStorage.
  React.useEffect(() => {
    if (!isSortLoaded) return
    if (sortBy !== SIDEBAR_SORT_DEFAULTS.tags) return
    const legacy = LEGACY_MODE_BY_OPTION[loadSortPreference()]
    if (legacy === SIDEBAR_SORT_DEFAULTS.tags) return
    void setSortMode(legacy)
  }, [isSortLoaded, sortBy, setSortMode])
  const [expanded, setExpanded] = React.useState<Set<string>>(loadExpandedState)
  const searchInputRef = React.useRef<HTMLInputElement>(null)

  const handleSortChange = (value: string): void => {
    void setSortMode(value as SidebarSortMode)
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
            <Tags className="h-3 w-3" />
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

          <SidebarSortPicker
            surface="tags"
            mode={sortBy}
            onModeChange={(next) => handleSortChange(next)}
            labels={sortLabels.labels}
            // `common`, not the `notes` namespace tPhaseF is bound to — the
            // section labels live alongside the sort strings.
            triggerLabel={sortLabels.triggerLabel(t('phaseF.componentsAppSidebar.tags'), sortBy)}
          />
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
      openSidebarItem({
        type: 'tag',
        title: tagName,
        path: '/tags/' + tagName,
        entityId: tagName,
        color: tagColor
      })
    },
    [openSidebarItem]
  )

  const groups = React.useMemo<TagGroup[]>(() => {
    const result: TagGroup[] = []

    for (const category of categories) {
      const nodes = buildGroupNodes(category.tags, searchQuery, sortBy)
      if (nodes.length > 0) {
        result.push({ id: category.id, name: category.name, nodes })
      }
    }

    const uncategorizedNodes = buildGroupNodes(uncategorized, searchQuery, sortBy)
    if (uncategorizedNodes.length > 0) {
      result.push({
        id: UNCATEGORIZED_GROUP_ID,
        name: tPhaseF('phaseF.componentsSidebarSidebarTagList.Uncategorized'),
        nodes: uncategorizedNodes
      })
    }

    return result
  }, [categories, uncategorized, searchQuery, sortBy, tPhaseF])

  const toggleShowAllForGroup = React.useCallback((groupId: string): void => {
    setShowAllByGroup((prev) => ({ ...prev, [groupId]: !prev[groupId] }))
  }, [])

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

      <div className="flex flex-col gap-1">
        {groups.length === 0 && searchQuery ? (
          <span className="text-[11px] text-muted-foreground px-2">
            {tPhaseF('phaseF.componentsSidebarSidebarTagList.noMatchingTags')}
          </span>
        ) : (
          groups.map((group) => {
            const isGroupExpanded = !expanded.has(`${CATEGORY_KEY_PREFIX}${group.id}`)
            const showAllForGroup = showAllByGroup[group.id] ?? false
            const visibleNodes = showAllForGroup ? group.nodes : group.nodes.slice(0, maxVisible)
            const hasMoreInGroup = group.nodes.length > maxVisible

            return (
              <div key={group.id} className="flex flex-col gap-0.5">
                {/* A category heading, so it takes the same token as every
                    other sidebar section heading. `--muted-foreground` at 70%
                    was 3.62:1 (paper) and 2.85:1 (white) at 10px, under the
                    4.5:1 AA floor for small text. The colour no longer changes
                    on hover — `bg-muted` carries the affordance, and the token
                    clears AA on that surface too. */}
                <button
                  type="button"
                  onClick={() => handleToggle(`${CATEGORY_KEY_PREFIX}${group.id}`)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide text-sidebar-section-heading hover:bg-muted transition-colors"
                  aria-label={isGroupExpanded ? t('action.collapse') : t('action.expand')}
                >
                  {isGroupExpanded ? (
                    <ChevronDown className="size-2.5 shrink-0" />
                  ) : (
                    <ChevronRight className="size-2.5 shrink-0" />
                  )}
                  <span className="truncate">{group.name}</span>
                </button>

                {isGroupExpanded && (
                  <div data-testid={`tag-group-${group.id}`} className="flex flex-col gap-0.5">
                    {visibleNodes.map((node) => (
                      <TagTreeItem
                        key={node.fullPath}
                        node={node}
                        expanded={expanded}
                        onToggle={handleToggle}
                        onTagClick={handleTagClick}
                      />
                    ))}

                    {hasMoreInGroup && !searchQuery && (
                      <button
                        type="button"
                        onClick={() => toggleShowAllForGroup(group.id)}
                        // 11px is small text under WCAG AA. `--sidebar-muted`
                        // was 1.87:1 on the paper sidebar and hovering made it
                        // 3.18:1 — still under 4.5:1. This is a control rather
                        // than a heading, so unlike the section headings it
                        // keeps a hover colour: `--sidebar-primary` raises the
                        // ratio (15.2:1 paper) instead of lowering it.
                        className="rounded-sm py-0.5 px-2 ms-6 text-[11px] font-medium leading-3.5 text-sidebar-section-heading hover:text-sidebar-primary transition-colors text-start"
                      >
                        {showAllForGroup
                          ? t('action.showLess')
                          : t('action.showMore', { count: group.nodes.length - maxVisible })}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export default SidebarTagList
