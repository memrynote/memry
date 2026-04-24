import { useState, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown } from '@/lib/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { BacklinkCard } from './BacklinkCard'
import { BacklinksLoadingState } from './BacklinksLoadingState'
import type { BacklinksSectionProps, BacklinkSortOption, Mention } from './types'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:BacklinksSection')

const SORT_LABELS: Record<BacklinkSortOption, string> = {
  recent: 'Recent',
  alphabetical: 'A-Z',
  mentions: 'Most mentions'
}

function BacklinksIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ flexShrink: 0 }}
    >
      <path
        d="M6 3L3 3a2 2 0 00-2 2v0a2 2 0 002 2h3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M8 11l3 0a2 2 0 002-2v0a2 2 0 00-2-2H8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="4.5"
        y1="7"
        x2="9.5"
        y2="7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

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
  const [internalSortBy, setInternalSortBy] = useState<BacklinkSortOption>('recent')
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)
  const [visibleCount, setVisibleCount] = useState(initialCount)

  const backlinks = propBacklinks ?? []
  const sortBy = propSortBy ?? internalSortBy

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

  const totalReferences = useMemo(
    () => backlinks.reduce((sum, bl) => sum + bl.mentions.length, 0),
    [backlinks]
  )

  if (!isLoading && backlinks.length === 0) return null

  const visibleBacklinks = sortedBacklinks.slice(0, visibleCount)
  const hasMore = visibleCount < sortedBacklinks.length
  const remainingCount = sortedBacklinks.length - visibleCount

  const handleSortChange = (sort: BacklinkSortOption) => {
    if (propOnSortChange) {
      propOnSortChange(sort)
    } else {
      setInternalSortBy(sort)
    }
  }

  const handleBacklinkClick = (noteId: string, mention?: Mention) => {
    if (propOnBacklinkClick) {
      propOnBacklinkClick(noteId, mention)
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
      className="flex flex-col gap-1"
      role="region"
      aria-label={`Backlinks section with ${backlinks.length} ${backlinks.length === 1 ? 'link' : 'links'}`}
      aria-busy={isLoading}
    >
      <div className="flex items-center justify-between">
        <button
          onClick={collapsible ? toggleCollapse : undefined}
          className={cn(
            'flex items-center gap-1.5',
            collapsible && 'cursor-pointer hover:opacity-80 transition-opacity'
          )}
          aria-expanded={!isCollapsed}
          aria-controls="backlinks-content"
          aria-label={isCollapsed ? 'Expand backlinks section' : 'Collapse backlinks section'}
          disabled={!collapsible}
        >
          {collapsible && (
            <ChevronDown
              className={cn(
                'h-3 w-3 text-text-tertiary flex-shrink-0 transition-transform duration-150',
                isCollapsed && '-rotate-90'
              )}
              aria-hidden="true"
            />
          )}
          <BacklinksIcon className="text-text-tertiary" />
          <span className="text-xs/4 font-medium text-text-tertiary">
            {backlinks.length} {backlinks.length === 1 ? 'note' : 'notes'}
            <span className="text-text-tertiary/50">
              {' '}
              &middot; {totalReferences} {totalReferences === 1 ? 'reference' : 'references'}
            </span>
          </span>
        </button>

        {!isCollapsed && backlinks.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'inline-flex items-center gap-1 px-1.5 py-0.5',
                  'text-[11px] text-text-tertiary',
                  'hover:text-muted-foreground hover:bg-surface-active/40 rounded',
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
                  className={cn(sortBy === option && 'bg-surface-active')}
                >
                  {SORT_LABELS[option]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {!isCollapsed && (
        <div id="backlinks-content" aria-live="polite" role="list" aria-label="Backlinks list">
          {isLoading ? (
            <BacklinksLoadingState />
          ) : (
            <>
              <div className="flex flex-col">
                {visibleBacklinks.map((backlink, index) => (
                  <BacklinkCard
                    key={backlink.id}
                    backlink={backlink}
                    defaultExpanded={index < 2}
                    onClick={handleBacklinkClick}
                  />
                ))}
              </div>

              {hasMore && remainingCount > 0 && (
                <button
                  onClick={handleShowMore}
                  className={cn(
                    'w-full py-1.5 mt-0.5',
                    'text-[11px] text-text-tertiary',
                    'hover:text-muted-foreground',
                    'transition-colors duration-150',
                    'cursor-pointer'
                  )}
                  aria-label={`Show ${remainingCount} more backlink${remainingCount > 1 ? 's' : ''}`}
                >
                  {remainingCount} more
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
