import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Search, RefreshCw, ChevronDown } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { RelatedNoteCard } from './RelatedNoteCard'
import { ReferencesSection } from './ReferencesSection'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import type {
  RelatedNotesTabProps,
  SortOption,
  FilterOption,
  RelatedNote,
  ReferencedNote
} from './types'

// Demo data for development
const DEMO_RELATED_NOTES: RelatedNote[] = [
  {
    id: 'rel-1',
    noteId: 'note-456',
    title: 'Film Analysis Methods',
    icon: '📄',
    similarity: 92,
    reason: 'discusses cinematography techniques similar to those analyzed in this note',
    folder: 'Projects',
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  },
  {
    id: 'rel-2',
    noteId: 'note-789',
    title: '1970s Cinema Overview',
    icon: '🎬',
    similarity: 87,
    reason: 'covers the same era and directorial approaches mentioned here',
    folder: 'Research',
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
  },
  {
    id: 'rel-3',
    noteId: 'note-012',
    title: 'Crime Drama Genre Study',
    icon: '📝',
    similarity: 76,
    reason: 'explores genre conventions present in this film',
    folder: 'Analysis',
    updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  },
  {
    id: 'rel-4',
    noteId: 'note-345',
    title: 'Marlon Brando Biography',
    icon: '🎭',
    similarity: 64,
    reason: 'contains biographical details about the lead actor',
    folder: 'People',
    updatedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
  },
  {
    id: 'rel-5',
    noteId: 'note-678',
    title: 'Italian American Culture in Film',
    icon: '🇮🇹',
    similarity: 58,
    reason: 'discusses cultural themes relevant to this analysis',
    folder: 'Culture',
    updatedAt: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000)
  }
]

const DEMO_REFERENCED_NOTES: ReferencedNote[] = [
  { id: 'ref-1', noteId: 'note-abc', title: 'Coppola Bio', icon: '📄' },
  { id: 'ref-2', noteId: 'note-def', title: '70s Film', icon: '🎬' }
]

const SORT_LABELS: Record<SortOption, string> = {
  relevance: 'Relevance',
  recent: 'Recent',
  alphabetical: 'A-Z'
}

const FILTER_LABELS: Record<FilterOption, string> = {
  all: 'All',
  sameFolder: 'Same folder',
  tagged: 'Tagged similar',
  recent: 'Recent'
}

export function RelatedNotesTab({
  noteId: _noteId,
  relatedNotes: propRelatedNotes,
  referencedNotes: propReferencedNotes,
  isLoading: propIsLoading,
  sortBy: propSortBy,
  filterBy: propFilterBy,
  onNoteClick: propOnNoteClick,
  onAddReference: propOnAddReference,
  onRemoveReference: propOnRemoveReference,
  onHideSuggestion: propOnHideSuggestion,
  onRefresh: propOnRefresh,
  onSortChange: propOnSortChange,
  onFilterChange: propOnFilterChange,
  onShowMore: propOnShowMore,
  hasMore: propHasMore,
  totalCount: propTotalCount
}: Partial<RelatedNotesTabProps> & { noteId?: string }) {
  // Internal state for demo mode when props aren't provided
  const [internalLoading] = useState(false)
  const [internalSortBy, setInternalSortBy] = useState<SortOption>('relevance')
  const [internalFilterBy, setInternalFilterBy] = useState<FilterOption>('all')
  const [internalRelatedNotes, setInternalRelatedNotes] =
    useState<RelatedNote[]>(DEMO_RELATED_NOTES)
  const [internalReferencedNotes, setInternalReferencedNotes] =
    useState<ReferencedNote[]>(DEMO_REFERENCED_NOTES)
  const [visibleCount, setVisibleCount] = useState(3)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Use props or internal state
  const isLoading = propIsLoading ?? internalLoading
  const sortBy = propSortBy ?? internalSortBy
  const filterBy = propFilterBy ?? internalFilterBy
  const relatedNotes = propRelatedNotes ?? internalRelatedNotes
  const referencedNotes = propReferencedNotes ?? internalReferencedNotes

  // Handlers
  const handleNoteClick = (id: string) => {
    if (propOnNoteClick) {
      propOnNoteClick(id)
    } else {
      console.log('Navigate to note:', id)
    }
  }

  const handleAddReference = (id: string) => {
    if (propOnAddReference) {
      propOnAddReference(id)
    } else {
      // Demo mode: add to internal state
      const noteToAdd = relatedNotes.find((n) => n.noteId === id)
      if (noteToAdd && !referencedNotes.find((r) => r.noteId === id)) {
        setInternalReferencedNotes((prev) => [
          ...prev,
          {
            id: `ref-${Date.now()}`,
            noteId: noteToAdd.noteId,
            title: noteToAdd.title,
            icon: noteToAdd.icon
          }
        ])
      }
    }
  }

  const handleRemoveReference = (id: string) => {
    if (propOnRemoveReference) {
      propOnRemoveReference(id)
    } else {
      setInternalReferencedNotes((prev) => prev.filter((n) => n.noteId !== id))
    }
  }

  const handleHideSuggestion = (id: string) => {
    if (propOnHideSuggestion) {
      propOnHideSuggestion(id)
    } else {
      setInternalRelatedNotes((prev) => prev.filter((n) => n.noteId !== id))
    }
  }

  const handleRefresh = () => {
    if (propOnRefresh) {
      propOnRefresh()
    } else {
      setIsRefreshing(true)
      setTimeout(() => {
        setIsRefreshing(false)
        setInternalRelatedNotes(DEMO_RELATED_NOTES)
      }, 1500)
    }
  }

  const handleSortChange = (sort: SortOption) => {
    if (propOnSortChange) {
      propOnSortChange(sort)
    } else {
      setInternalSortBy(sort)
      // Sort internal notes
      setInternalRelatedNotes((prev) => {
        const sorted = [...prev]
        switch (sort) {
          case 'relevance':
            sorted.sort((a, b) => b.similarity - a.similarity)
            break
          case 'recent':
            sorted.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            break
          case 'alphabetical':
            sorted.sort((a, b) => a.title.localeCompare(b.title))
            break
        }
        return sorted
      })
    }
  }

  const handleFilterChange = (filter: FilterOption) => {
    if (propOnFilterChange) {
      propOnFilterChange(filter)
    } else {
      setInternalFilterBy(filter)
    }
  }

  const handleShowMore = () => {
    if (propOnShowMore) {
      propOnShowMore()
    } else {
      setVisibleCount((prev) => prev + 3)
    }
  }

  // Filtered and visible notes
  const visibleNotes = relatedNotes.slice(
    0,
    propHasMore !== undefined ? relatedNotes.length : visibleCount
  )
  const hasMore =
    propHasMore ?? visibleCount < relatedNotes.length
  const remainingCount = propTotalCount
    ? propTotalCount - relatedNotes.length
    : relatedNotes.length - visibleCount

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header Section */}
      <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-stone-100">
        <div className="flex items-center gap-2 mb-1">
          <Search className="h-4 w-4 text-stone-500" />
          <h3 className="text-[13px] font-medium text-stone-600">
            AI-discovered connections
          </h3>
        </div>
        <p className="text-xs text-stone-400">Based on content similarity</p>

        {/* Filter and Sort Controls */}
        <div className="flex items-center gap-2 mt-3">
          {/* Filter Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-1',
                  'text-xs text-stone-500 bg-stone-100 rounded',
                  'hover:bg-stone-200 transition-colors duration-150'
                )}
              >
                {FILTER_LABELS[filterBy]}
                <ChevronDown className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[140px]">
              {(Object.keys(FILTER_LABELS) as FilterOption[]).map((filter) => (
                <DropdownMenuItem
                  key={filter}
                  onClick={() => handleFilterChange(filter)}
                  className={cn(filterBy === filter && 'bg-stone-100')}
                >
                  {FILTER_LABELS[filter]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Sort Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-1',
                  'text-xs text-stone-500 bg-stone-100 rounded',
                  'hover:bg-stone-200 transition-colors duration-150'
                )}
              >
                {SORT_LABELS[sortBy]}
                <ChevronDown className="h-3 w-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[120px]">
              {(Object.keys(SORT_LABELS) as SortOption[]).map((sort) => (
                <DropdownMenuItem
                  key={sort}
                  onClick={() => handleSortChange(sort)}
                  className={cn(sortBy === sort && 'bg-stone-100')}
                >
                  {SORT_LABELS[sort]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            disabled={isLoading || isRefreshing}
            className={cn(
              'p-1.5 rounded',
              'text-stone-400 hover:text-stone-600 hover:bg-stone-100',
              'transition-colors duration-150',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            aria-label="Refresh analysis"
          >
            <RefreshCw
              className={cn('h-4 w-4', (isLoading || isRefreshing) && 'animate-spin')}
            />
          </button>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden">
        {isLoading || isRefreshing ? (
          <div aria-live="polite" aria-busy="true">
            <div className="px-4 py-2 text-xs text-stone-400">
              Analyzing note content...
            </div>
            <LoadingSkeleton />
          </div>
        ) : relatedNotes.length === 0 ? (
          <EmptyState onRefresh={handleRefresh} />
        ) : (
          <ScrollArea className="h-full">
            <div className="p-4 space-y-2.5" role="list">
              {visibleNotes.map((note) => (
                <RelatedNoteCard
                  key={note.id}
                  note={note}
                  onNoteClick={handleNoteClick}
                  onAddReference={handleAddReference}
                  onHideSuggestion={handleHideSuggestion}
                />
              ))}

              {/* Show More Button */}
              {hasMore && remainingCount > 0 && (
                <button
                  onClick={handleShowMore}
                  className={cn(
                    'w-full py-2.5 mt-2',
                    'text-sm text-stone-500 font-medium',
                    'hover:text-stone-700 hover:bg-stone-50 rounded-lg',
                    'transition-colors duration-150'
                  )}
                >
                  Show {remainingCount} more
                </button>
              )}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* References Section */}
      <ReferencesSection
        referencedNotes={referencedNotes}
        onRemoveReference={handleRemoveReference}
        onAddReference={handleAddReference}
        onNoteClick={handleNoteClick}
        recentNotes={relatedNotes.slice(0, 3).map((n) => ({
          id: n.id,
          noteId: n.noteId,
          title: n.title,
          icon: n.icon
        }))}
        suggestedNotes={relatedNotes.filter(
          (n) => !referencedNotes.find((r) => r.noteId === n.noteId)
        )}
      />
    </div>
  )
}
