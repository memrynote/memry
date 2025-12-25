import { useState, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { Link2, ChevronDown, ChevronRight } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { BacklinkCard } from './BacklinkCard'
import { BacklinksEmptyState } from './BacklinksEmptyState'
import { BacklinksLoadingState } from './BacklinksLoadingState'
import type { BacklinksSectionProps, BacklinkSortOption, Backlink } from './types'

const SORT_LABELS: Record<BacklinkSortOption, string> = {
  recent: 'Recent',
  alphabetical: 'A-Z',
  mentions: 'Most mentions'
}

// Demo data for development
const DEMO_BACKLINKS: Backlink[] = [
  {
    id: 'bl-1',
    noteId: 'note-123',
    noteTitle: 'Film Analysis Project',
    folder: 'Projects',
    date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    mentions: [
      {
        id: 'm-1',
        snippet:
          "...studying the cinematography of [[The Godfather]] reveals Coppola's masterful use of low-key lighting...",
        linkStart: 32,
        linkEnd: 48
      }
    ]
  },
  {
    id: 'bl-2',
    noteId: 'note-456',
    noteTitle: 'Team Meeting Dec 5',
    folder: 'Meetings',
    date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    mentions: [
      {
        id: 'm-2',
        snippet:
          '...decided to use [[The Godfather]] as our case study for the presentation next week...',
        linkStart: 19,
        linkEnd: 35
      }
    ]
  },
  {
    id: 'bl-3',
    noteId: 'note-789',
    noteTitle: 'Classic Cinema Notes',
    folder: 'Research',
    date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    mentions: [
      {
        id: 'm-3',
        snippet:
          '...alongside Citizen Kane, [[The Godfather]] represents a turning point in American filmmaking...',
        linkStart: 27,
        linkEnd: 43
      },
      {
        id: 'm-4',
        snippet:
          "...the baptism scene in [[The Godfather]] is often cited as one of cinema's greatest...",
        linkStart: 23,
        linkEnd: 39
      }
    ]
  }
]

export function BacklinksSection({
  backlinks: propBacklinks,
  isLoading = false,
  initialCount = 5,
  collapsible = true,
  defaultCollapsed = false,
  sortBy: propSortBy,
  onSortChange: propOnSortChange,
  onBacklinkClick: propOnBacklinkClick,
  onShowMore: propOnShowMore
}: Partial<BacklinksSectionProps>) {
  // Internal state for demo mode
  const [internalSortBy, setInternalSortBy] = useState<BacklinkSortOption>('recent')
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)
  const [visibleCount, setVisibleCount] = useState(initialCount)

  // Use props or internal state
  const backlinks = propBacklinks ?? DEMO_BACKLINKS
  const sortBy = propSortBy ?? internalSortBy

  // Sort backlinks
  const sortedBacklinks = useMemo(() => {
    const sorted = [...backlinks]
    switch (sortBy) {
      case 'recent':
        sorted.sort((a, b) => b.date.getTime() - a.date.getTime())
        break
      case 'alphabetical':
        sorted.sort((a, b) => a.noteTitle.localeCompare(b.noteTitle))
        break
      case 'mentions':
        sorted.sort((a, b) => b.mentions.length - a.mentions.length)
        break
    }
    return sorted
  }, [backlinks, sortBy])

  const visibleBacklinks = sortedBacklinks.slice(0, visibleCount)
  const hasMore = visibleCount < sortedBacklinks.length
  const remainingCount = sortedBacklinks.length - visibleCount

  // Handlers
  const handleSortChange = (sort: BacklinkSortOption) => {
    if (propOnSortChange) {
      propOnSortChange(sort)
    } else {
      setInternalSortBy(sort)
    }
  }

  const handleBacklinkClick = (noteId: string) => {
    if (propOnBacklinkClick) {
      propOnBacklinkClick(noteId)
    } else {
      console.log('Navigate to note:', noteId)
    }
  }

  const handleShowMore = () => {
    if (propOnShowMore) {
      propOnShowMore()
    } else {
      setVisibleCount((prev) => prev + initialCount)
    }
  }

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed)
  }

  return (
    <section
      className={cn('mt-12 pt-6 border-t border-stone-200')}
      role="region"
      aria-label={`Backlinks section with ${backlinks.length} ${backlinks.length === 1 ? 'link' : 'links'}`}
      aria-busy={isLoading}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={collapsible ? toggleCollapse : undefined}
          className={cn(
            'flex items-center gap-2',
            collapsible && 'cursor-pointer hover:opacity-80 transition-opacity'
          )}
          aria-expanded={!isCollapsed}
          aria-controls="backlinks-content"
          aria-label={isCollapsed ? 'Expand backlinks section' : 'Collapse backlinks section'}
          disabled={!collapsible}
        >
          {collapsible && (
            <span className="text-stone-400" aria-hidden="true">
              {isCollapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </span>
          )}
          <Link2 className="h-4 w-4 text-stone-400" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            Backlinks
          </span>
          {backlinks.length > 0 && (
            <span className="text-xs text-stone-400" aria-hidden="true">
              ({backlinks.length})
            </span>
          )}
        </button>

        {/* Sort dropdown - only show when not collapsed and has backlinks */}
        {!isCollapsed && backlinks.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-1',
                  'text-xs text-stone-500',
                  'hover:text-stone-700 hover:bg-stone-100 rounded',
                  'transition-colors duration-150'
                )}
                aria-label={`Sort backlinks by ${SORT_LABELS[sortBy]}`}
              >
                {SORT_LABELS[sortBy]}
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[140px]">
              {(Object.keys(SORT_LABELS) as BacklinkSortOption[]).map((option) => (
                <DropdownMenuItem
                  key={option}
                  onClick={() => handleSortChange(option)}
                  className={cn(sortBy === option && 'bg-stone-100')}
                >
                  {SORT_LABELS[option]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div id="backlinks-content" aria-live="polite" role="list" aria-label="Backlinks list">
          {isLoading ? (
            <BacklinksLoadingState />
          ) : backlinks.length === 0 ? (
            <BacklinksEmptyState />
          ) : (
            <div className="space-y-2">
              {visibleBacklinks.map((backlink) => (
                <BacklinkCard key={backlink.id} backlink={backlink} onClick={handleBacklinkClick} />
              ))}

              {/* Show More Button */}
              {hasMore && remainingCount > 0 && (
                <div className="pt-2">
                  <button
                    onClick={handleShowMore}
                    className={cn(
                      'w-full py-3',
                      'text-[13px] text-stone-500',
                      'hover:text-stone-700 hover:underline',
                      'transition-colors duration-150',
                      'cursor-pointer'
                    )}
                    aria-label={`Show ${remainingCount} more backlink${remainingCount > 1 ? 's' : ''}`}
                  >
                    Show {remainingCount} more backlink
                    {remainingCount > 1 ? 's' : ''}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
