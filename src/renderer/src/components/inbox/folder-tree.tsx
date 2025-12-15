/**
 * Folder Tree Component
 *
 * A hierarchical folder navigation tree with:
 * - Expandable/collapsible nodes
 * - Search filtering with highlight
 * - Keyboard navigation
 * - Visual selection state
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Search,
  Inbox,
  Archive,
  Briefcase,
  User,
  Microscope,
  FolderKanban,
  BookOpen,
  Users,
  Heart,
  Wallet,
  GraduationCap,
  Brain,
  Sparkles,
  Code2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Folder as FolderType } from '@/data/filing-types'
import { FOLDER_COLORS, DEFAULT_FOLDER_COLOR } from '@/data/filing-types'

// ============================================================================
// TYPES
// ============================================================================

export interface FolderTreeProps {
  /** All folders */
  folders: FolderType[]
  /** Currently selected folder ID */
  selectedId: string | null
  /** Recently used folder IDs */
  recentIds?: string[]
  /** AI-suggested folder IDs */
  suggestedIds?: string[]
  /** Callback when folder is selected */
  onSelect: (folderId: string) => void
  /** Whether to show the search input */
  showSearch?: boolean
  /** Placeholder for search input */
  searchPlaceholder?: string
  /** Additional class names */
  className?: string
}

interface FolderNodeData {
  folder: FolderType
  children: FolderNodeData[]
  depth: number
}

// ============================================================================
// ICON MAPPING
// ============================================================================

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Folder,
  FolderOpen,
  Inbox,
  Archive,
  Briefcase,
  User,
  Microscope,
  FolderKanban,
  BookOpen,
  Users,
  Heart,
  Wallet,
  GraduationCap,
  Brain,
  Sparkles,
  Code2,
}

function getFolderIcon(iconName?: string): React.ComponentType<{ className?: string }> {
  if (iconName && ICON_MAP[iconName]) {
    return ICON_MAP[iconName]
  }
  return Folder
}

// ============================================================================
// FOLDER ROW
// ============================================================================

interface FolderRowProps {
  folder: FolderType
  depth: number
  isExpanded: boolean
  isSelected: boolean
  isFocused: boolean
  hasChildren: boolean
  searchQuery: string
  onToggle: () => void
  onSelect: () => void
  onFocus: () => void
}

function FolderRow({
  folder,
  depth,
  isExpanded,
  isSelected,
  isFocused,
  hasChildren,
  searchQuery,
  onToggle,
  onSelect,
  onFocus,
}: FolderRowProps): React.JSX.Element {
  const colorConfig = FOLDER_COLORS[folder.color ?? DEFAULT_FOLDER_COLOR]
  const IconComponent = isExpanded && hasChildren
    ? FolderOpen
    : getFolderIcon(folder.icon)

  // Highlight matching text
  const highlightMatch = (text: string): React.ReactNode => {
    if (!searchQuery) return text

    const lowerText = text.toLowerCase()
    const lowerQuery = searchQuery.toLowerCase()
    const index = lowerText.indexOf(lowerQuery)

    if (index === -1) return text

    return (
      <>
        {text.slice(0, index)}
        <mark className="bg-amber-200 dark:bg-amber-800/60 text-inherit rounded-sm px-0.5">
          {text.slice(index, index + searchQuery.length)}
        </mark>
        {text.slice(index + searchQuery.length)}
      </>
    )
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      onFocus={onFocus}
      className={cn(
        'group flex w-full items-center gap-2 rounded-lg py-2 px-2 text-left',
        'transition-all duration-150',
        // Base state
        'text-foreground/80 hover:text-foreground',
        'hover:bg-accent/60',
        // Selected state
        isSelected && [
          'bg-primary/10 text-foreground',
          'border-l-2 border-primary',
          'pl-[6px]', // Compensate for border
        ],
        // Focused state (keyboard)
        isFocused && !isSelected && 'ring-2 ring-primary/50 ring-offset-1'
      )}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      {/* Expand/collapse chevron */}
      {hasChildren ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded',
            'text-muted-foreground hover:text-foreground',
            'hover:bg-accent transition-colors'
          )}
        >
          {isExpanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>
      ) : (
        <div className="size-5 shrink-0" />
      )}

      {/* Folder icon */}
      <div
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md',
          colorConfig.bg
        )}
      >
        <IconComponent className={cn('size-3.5', colorConfig.text)} />
      </div>

      {/* Folder name */}
      <span className="flex-1 truncate text-sm font-medium">
        {highlightMatch(folder.name)}
      </span>

      {/* Item count - show on hover */}
      {folder.itemCount > 0 && (
        <span
          className={cn(
            'text-xs tabular-nums text-muted-foreground',
            'opacity-0 group-hover:opacity-100 transition-opacity'
          )}
        >
          {folder.itemCount}
        </span>
      )}
    </button>
  )
}

// ============================================================================
// SECTION HEADER
// ============================================================================

interface SectionHeaderProps {
  title: string
  icon?: React.ReactNode
}

function SectionHeader({ title, icon }: SectionHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-2 py-2">
      {icon}
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
    </div>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function FolderTree({
  folders,
  selectedId,
  recentIds = [],
  suggestedIds = [],
  onSelect,
  showSearch = true,
  searchPlaceholder = 'Search folders...',
  className,
}: FolderTreeProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Build folder tree structure
  const { tree, folderMap } = useMemo(() => {
    const map = new Map<string, FolderType>(folders.map((f) => [f.id, f]))
    const nodes = new Map<string, FolderNodeData>()

    // Create nodes
    folders.forEach((folder) => {
      nodes.set(folder.id, {
        folder,
        children: [],
        depth: 0,
      })
    })

    // Build parent-child relationships
    const roots: FolderNodeData[] = []
    folders.forEach((folder) => {
      const node = nodes.get(folder.id)!
      if (folder.parentId === null) {
        roots.push(node)
      } else {
        const parent = nodes.get(folder.parentId)
        if (parent) {
          parent.children.push(node)
        }
      }
    })

    // Calculate depths
    function setDepths(nodeList: FolderNodeData[], depth: number): void {
      nodeList.forEach((node) => {
        node.depth = depth
        setDepths(node.children, depth + 1)
      })
    }
    setDepths(roots, 0)

    return { tree: roots, folderMap: map }
  }, [folders])

  // Filter folders by search
  const filteredFolders = useMemo(() => {
    if (!searchQuery.trim()) return null

    const query = searchQuery.toLowerCase()
    return folders.filter(
      (f) =>
        f.name.toLowerCase().includes(query) ||
        f.path.toLowerCase().includes(query)
    )
  }, [folders, searchQuery])

  // Get recent and suggested folders
  const recentFolders = useMemo(
    () => recentIds.map((id) => folderMap.get(id)).filter(Boolean) as FolderType[],
    [recentIds, folderMap]
  )

  const suggestedFolders = useMemo(
    () => suggestedIds.map((id) => folderMap.get(id)).filter(Boolean) as FolderType[],
    [suggestedIds, folderMap]
  )

  // Toggle folder expansion
  const toggleExpanded = useCallback((folderId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) {
        next.delete(folderId)
      } else {
        next.add(folderId)
      }
      return next
    })
  }, [])

  // Expand path to folder
  const expandPathTo = useCallback(
    (folderId: string) => {
      const folder = folderMap.get(folderId)
      if (!folder) return

      const idsToExpand: string[] = []
      let current = folder

      while (current.parentId) {
        idsToExpand.push(current.parentId)
        const parent = folderMap.get(current.parentId)
        if (!parent) break
        current = parent
      }

      setExpandedIds((prev) => new Set([...prev, ...idsToExpand]))
    },
    [folderMap]
  )

  // Auto-expand to selected folder
  useEffect(() => {
    if (selectedId) {
      expandPathTo(selectedId)
    }
  }, [selectedId, expandPathTo])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!containerRef.current?.contains(document.activeElement)) return

      const visibleFolders = filteredFolders || folders
      const currentIndex = focusedId
        ? visibleFolders.findIndex((f) => f.id === focusedId)
        : -1

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          if (currentIndex < visibleFolders.length - 1) {
            setFocusedId(visibleFolders[currentIndex + 1].id)
          }
          break
        case 'ArrowUp':
          e.preventDefault()
          if (currentIndex > 0) {
            setFocusedId(visibleFolders[currentIndex - 1].id)
          }
          break
        case 'ArrowRight':
          e.preventDefault()
          if (focusedId) {
            setExpandedIds((prev) => new Set([...prev, focusedId]))
          }
          break
        case 'ArrowLeft':
          e.preventDefault()
          if (focusedId) {
            setExpandedIds((prev) => {
              const next = new Set(prev)
              next.delete(focusedId)
              return next
            })
          }
          break
        case 'Enter':
          e.preventDefault()
          if (focusedId) {
            onSelect(focusedId)
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [focusedId, filteredFolders, folders, onSelect])

  // Render tree recursively
  const renderTree = (nodes: FolderNodeData[]): React.ReactNode => {
    return nodes.map((node) => {
      const isExpanded = expandedIds.has(node.folder.id)
      const hasChildren = node.children.length > 0

      return (
        <div key={node.folder.id}>
          <FolderRow
            folder={node.folder}
            depth={node.depth}
            isExpanded={isExpanded}
            isSelected={selectedId === node.folder.id}
            isFocused={focusedId === node.folder.id}
            hasChildren={hasChildren}
            searchQuery={searchQuery}
            onToggle={() => toggleExpanded(node.folder.id)}
            onSelect={() => onSelect(node.folder.id)}
            onFocus={() => setFocusedId(node.folder.id)}
          />
          {isExpanded && hasChildren && (
            <div className="animate-in slide-in-from-top-1 fade-in-0 duration-150">
              {renderTree(node.children)}
            </div>
          )}
        </div>
      )
    })
  }

  // Render flat list (for search results or special sections)
  const renderFlatList = (folderList: FolderType[]): React.ReactNode => {
    return folderList.map((folder) => (
      <FolderRow
        key={folder.id}
        folder={folder}
        depth={0}
        isExpanded={false}
        isSelected={selectedId === folder.id}
        isFocused={focusedId === folder.id}
        hasChildren={false}
        searchQuery={searchQuery}
        onToggle={() => {}}
        onSelect={() => onSelect(folder.id)}
        onFocus={() => setFocusedId(folder.id)}
      />
    ))
  }

  return (
    <div ref={containerRef} className={cn('flex flex-col', className)}>
      {/* Search input */}
      {showSearch && (
        <div className="px-1 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className={cn(
                'h-9 pl-9 pr-3',
                'bg-accent/30 border-transparent',
                'focus:bg-background focus:border-input',
                'placeholder:text-muted-foreground/60'
              )}
            />
          </div>
        </div>
      )}

      {/* Scrollable content */}
      <ScrollArea className="flex-1">
        <div className="space-y-1 pr-3">
          {/* Search results */}
          {filteredFolders ? (
            filteredFolders.length > 0 ? (
              <div>
                <SectionHeader
                  title={`${filteredFolders.length} results`}
                  icon={<Search className="size-3 text-muted-foreground" />}
                />
                {renderFlatList(filteredFolders)}
              </div>
            ) : (
              <div className="px-2 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No folders match "{searchQuery}"
                </p>
              </div>
            )
          ) : (
            <>
              {/* Suggested folders */}
              {suggestedFolders.length > 0 && (
                <div className="mb-4">
                  <SectionHeader
                    title="Suggested"
                    icon={<Sparkles className="size-3 text-amber-500" />}
                  />
                  {renderFlatList(suggestedFolders)}
                </div>
              )}

              {/* Recent folders */}
              {recentFolders.length > 0 && (
                <div className="mb-4">
                  <SectionHeader title="Recent" />
                  {renderFlatList(recentFolders)}
                </div>
              )}

              {/* All folders */}
              <div>
                <SectionHeader title="All Folders" />
                {renderTree(tree)}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
