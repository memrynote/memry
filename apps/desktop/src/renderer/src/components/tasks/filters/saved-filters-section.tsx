import { useState, useCallback } from 'react'

import { Star, Trash } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { SavedFilter } from '@/data/tasks-data'

interface SavedFiltersSectionProps {
  savedFilters: SavedFilter[]
  activeSavedFilterId?: string | null
  hasActiveFilters: boolean
  onApply: (filter: SavedFilter) => void
  onDelete: (filterId: string) => void
  onToggleStar: (filterId: string) => void
  onSave: (name: string) => void
}

export const SavedFiltersSection = ({
  savedFilters,
  activeSavedFilterId,
  hasActiveFilters,
  onApply,
  onDelete,
  onToggleStar,
  onSave
}: SavedFiltersSectionProps): React.JSX.Element => {
  const [filterName, setFilterName] = useState('')

  const handleSave = useCallback(() => {
    const trimmed = filterName.trim()
    if (!trimmed) return
    onSave(trimmed)
    setFilterName('')
  }, [filterName, onSave])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSave()
      }
    },
    [handleSave]
  )

  return (
    <div className="flex flex-col">
      {/* Save input */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-border">
        <div className="flex-1 flex items-center gap-1.5 rounded-[5px] bg-surface px-2 py-1 border border-border">
          <input
            type="text"
            value={filterName}
            onChange={(e) => setFilterName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={hasActiveFilters ? 'Save current filter...' : 'Set filters first'}
            disabled={!hasActiveFilters}
            aria-label="Filter name"
            className="flex-1 min-w-0 bg-transparent text-[12px] leading-4 text-foreground placeholder:text-text-tertiary outline-none disabled:opacity-40"
          />
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!filterName.trim() || !hasActiveFilters}
          aria-label="Save filter"
          className={cn(
            'shrink-0 rounded-[5px] px-2 py-1 text-[11px] font-medium leading-4 transition-colors',
            filterName.trim() && hasActiveFilters
              ? 'bg-foreground text-background hover:bg-foreground/80'
              : 'bg-foreground/10 text-text-tertiary cursor-not-allowed'
          )}
        >
          Save
        </button>
      </div>

      {/* Saved filters list */}
      {savedFilters.length > 0 && (
        <div className="flex flex-col py-1 border-t border-border">
          {savedFilters.map((filter) => {
            const isActive = activeSavedFilterId === filter.id
            return (
              <div
                key={filter.id}
                className={cn(
                  'group/filter flex items-center py-1 px-2 gap-1 transition-colors',
                  isActive ? 'bg-accent' : 'hover:bg-accent'
                )}
              >
                {/* Star toggle */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleStar(filter.id)
                  }}
                  aria-label={filter.starred ? `Unstar ${filter.name}` : `Star ${filter.name}`}
                  className="shrink-0 p-0.5 rounded-sm transition-colors hover:bg-foreground/10"
                >
                  <Star
                    size={12}
                    className={cn(
                      'transition-colors',
                      filter.starred
                        ? 'text-task-star fill-task-star'
                        : 'text-text-tertiary group-hover/filter:text-text-secondary'
                    )}
                    fill={filter.starred ? 'currentColor' : 'none'}
                  />
                </button>

                {/* Filter name — click to apply */}
                <button
                  type="button"
                  onClick={() => onApply(filter)}
                  className="flex-1 min-w-0 text-left focus:outline-none"
                >
                  <span
                    className={cn(
                      'text-[12px] leading-4 truncate block',
                      isActive ? 'text-foreground font-medium' : 'text-text-secondary'
                    )}
                  >
                    {filter.name}
                  </span>
                </button>

                {/* Delete */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(filter.id)
                  }}
                  aria-label={`Delete ${filter.name}`}
                  className="shrink-0 p-0.5 rounded-sm opacity-0 group-hover/filter:opacity-100 focus:opacity-100 transition-all text-text-tertiary hover:text-destructive"
                >
                  <Trash size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
