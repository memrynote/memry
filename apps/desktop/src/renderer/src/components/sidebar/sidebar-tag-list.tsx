/**
 * SidebarTagList Component
 * Displays a list of tags in the sidebar with colors and counts.
 * Clicking a tag filters the current view by that tag.
 */

import * as React from 'react'

import { cn } from '@/lib/utils'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { getTagColors } from '@/components/note/tags-row/tag-colors'

interface SidebarTagListProps {
  /** Maximum number of tags to show before "Show more" */
  maxVisible?: number
  /** Callback when a tag is clicked (tag name and color) */
  onTagClick?: (tag: string, color: string) => void
  /** Currently selected tag (for highlighting) */
  selectedTag?: string | null
  /** Custom class name */
  className?: string
}

export function SidebarTagList({
  maxVisible = 8,
  onTagClick,
  selectedTag,
  className
}: SidebarTagListProps): React.JSX.Element {
  const { tags, isLoading, error } = useNoteTagsQuery()
  const [showAll, setShowAll] = React.useState(false)

  // Sort tags by count (descending) and filter out empty tags
  const sortedTags = React.useMemo(() => {
    return [...tags].filter((t) => t.count > 0).sort((a, b) => b.count - a.count)
  }, [tags])

  const visibleTags = showAll ? sortedTags : sortedTags.slice(0, maxVisible)
  const hasMore = sortedTags.length > maxVisible

  const handleTagClick = (tagName: string, tagColor: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    onTagClick?.(tagName, tagColor)
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

  if (sortedTags.length === 0) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-muted-foreground">No tags yet</span>
      </div>
    )
  }

  return (
    <div className={cn('pl-5 pr-2.5 flex flex-wrap gap-1.5', className)}>
      {visibleTags.map((tag) => {
        const colors = getTagColors(tag.color)

        return (
          <button
            key={tag.tag}
            type="button"
            onClick={handleTagClick(tag.tag, tag.color)}
            title={`${tag.tag} (${tag.count})`}
            className={cn(
              'rounded-xl py-0.5 px-2.5 text-[11px] font-medium leading-3.5',
              'transition-opacity hover:opacity-80',
              selectedTag === tag.tag && 'ring-1 ring-current'
            )}
            style={{
              backgroundColor: `${colors.text}1A`,
              color: colors.text
            }}
          >
            {tag.tag}
          </button>
        )
      })}

      {hasMore && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="rounded-xl py-0.5 px-2.5 text-[11px] font-medium leading-3.5 text-sidebar-muted hover:text-sidebar-foreground transition-colors"
        >
          {showAll ? 'Show less' : `+${sortedTags.length - maxVisible} more`}
        </button>
      )}
    </div>
  )
}

export default SidebarTagList
