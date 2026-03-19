import { useState, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { Link2, ChevronDown } from '@/lib/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { BacklinkCard } from './BacklinkCard'
import { BacklinksLoadingState } from './BacklinksLoadingState'
import type { BacklinksSectionProps, BacklinkSortOption, Backlink } from './types'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:BacklinksSection')

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

  if (!isLoading && backlinks.length === 0) return null

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
      log.info('Navigate to note:', noteId)
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
      className="flex flex-col pt-5 gap-3 border-t border-border"
      role="region"
      aria-label={`Backlinks section with ${backlinks.length} ${backlinks.length === 1 ? 'link' : 'links'}`}
      aria-busy={isLoading}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
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
          <Link2 className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
          <span className="text-[11px] tracking-[0.06em] uppercase text-text-tertiary font-sans font-semibold leading-3.5">
            {backlinks.length} Backlinks
          </span>
        </button>

        {/* Sort dropdown */}
        {!isCollapsed && backlinks.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-1',
                  'text-xs text-text-tertiary',
                  'hover:text-muted-foreground hover:bg-surface rounded',
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
          ) : (
            <>
              <div className="flex gap-2.5">
                {visibleBacklinks.map((backlink) => (
                  <BacklinkCard
                    key={backlink.id}
                    backlink={backlink}
                    onClick={handleBacklinkClick}
                  />
                ))}
              </div>

              {/* Show More Button */}
              {hasMore && remainingCount > 0 && (
                <div className="pt-2">
                  <button
                    onClick={handleShowMore}
                    className={cn(
                      'w-full py-3',
                      'text-[13px] text-muted-foreground',
                      'hover:text-text-secondary hover:underline',
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
            </>
          )}
        </div>
      )}
    </section>
  )
}
