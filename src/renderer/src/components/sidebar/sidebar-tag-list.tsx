/**
 * SidebarTagList Component
 * Displays a list of tags in the sidebar with colors and counts.
 * Clicking a tag filters the current view by that tag.
 */

import * as React from 'react'
import { Tag } from 'lucide-react'

import { cn } from '@/lib/utils'
import { SidebarMenuItem, SidebarMenuButton } from '@/components/ui/sidebar'
import { useNoteTags } from '@/hooks/use-notes'
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
  const { tags, isLoading, error } = useNoteTags()
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
    <div className={className}>
      {visibleTags.map((tag) => {
        const colors = getTagColors(tag.color)
        const isSelected = selectedTag === tag.tag

        return (
          <SidebarMenuItem key={tag.tag}>
            <SidebarMenuButton
              tooltip={`${tag.tag} (${tag.count})`}
              isActive={isSelected}
              onClick={handleTagClick(tag.tag, tag.color)}
              className="group"
            >
              {/* Tag color dot */}
              <span
                className="size-2.5 rounded-full shrink-0"
                style={{ backgroundColor: colors.background, border: `1.5px solid ${colors.text}` }}
                aria-hidden="true"
              />

              {/* Tag name */}
              <span className="flex-1 truncate">{tag.tag}</span>

              {/* Count badge */}
              <span className="text-xs text-muted-foreground tabular-nums opacity-60 group-hover:opacity-100 transition-opacity">
                {tag.count}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )
      })}

      {/* Show more/less button */}
      {hasMore && (
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={() => setShowAll(!showAll)}
            className="text-muted-foreground hover:text-foreground"
          >
            <Tag className="size-3.5 opacity-50" />
            <span className="text-xs">
              {showAll ? 'Show less' : `+${sortedTags.length - maxVisible} more`}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
    </div>
  )
}

export default SidebarTagList
