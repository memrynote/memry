import { useState, useCallback } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { TaskSort, SortField, SortDirection } from '@/data/tasks-data'
import { defaultSort } from '@/data/tasks-data'

interface SortDropdownProps {
  sort: TaskSort
  onChange: (sort: TaskSort) => void
  className?: string
}

const SORT_FIELD_LABELS: Record<SortField, string> = {
  dueDate: 'Due Date',
  priority: 'Priority',
  createdAt: 'Created',
  title: 'Title (A–Z)',
  project: 'Project',
  completedAt: 'Completed'
}

const VISIBLE_FIELDS: SortField[] = ['dueDate', 'priority', 'createdAt', 'title', 'project']

export const SortDropdown = ({
  sort,
  onChange,
  className
}: SortDropdownProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)

  const handleSelectField = useCallback(
    (field: SortField) => {
      onChange({ ...sort, field })
    },
    [sort, onChange]
  )

  const handleSetDirection = useCallback(
    (direction: SortDirection) => {
      onChange({ ...sort, direction })
    },
    [sort, onChange]
  )

  const handleReset = useCallback(() => {
    onChange(defaultSort)
  }, [onChange])

  const isNonDefault = sort.field !== defaultSort.field || sort.direction !== defaultSort.direction

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Sort options"
          className={cn(
            'flex items-center shrink-0 rounded-[5px] py-1 px-2 gap-1 border transition-colors',
            isOpen || isNonDefault
              ? 'border-foreground/20 bg-foreground/5 text-text-primary'
              : 'border-border text-text-secondary hover:bg-surface-active/50',
            className
          )}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path
              d="M4 3v7M4 10l-1.5-1.5M4 10l1.5-1.5M9 10V3M9 3l-1.5 1.5M9 3l1.5 1.5"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="text-[11px] leading-3.5">Sort</span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[260px] p-0 rounded-xl overflow-clip shadow-[0_2px_12px_rgba(0,0,0,0.06)] max-h-[calc(100vh-120px)] overflow-y-auto"
        align="end"
        sideOffset={8}
      >
        <div className="[font-synthesis:none] text-[12px] leading-4 flex flex-col antialiased">
          {/* Header */}
          <div className="flex items-center py-2.5 px-4 gap-1.5 bg-surface border-b border-border">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-foreground"
            >
              <path d="M3 6l3-3 3 3" />
              <path d="M6 3v18" />
              <path d="M21 18l-3 3-3-3" />
              <path d="M18 21V3" />
            </svg>
            <span className="text-[13px] leading-4 text-foreground font-semibold">Sort</span>
          </div>

          {/* Sort options */}
          <div className="flex flex-col py-2">
            {VISIBLE_FIELDS.map((field) => {
              const isSelected = sort.field === field
              const label = SORT_FIELD_LABELS[field]

              return (
                <div
                  key={field}
                  className={cn(
                    'flex items-center py-2 px-4 gap-2.5 transition-colors',
                    isSelected ? 'bg-accent' : 'hover:bg-accent'
                  )}
                >
                  {/* Radio circle */}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    aria-label={label}
                    onClick={() => handleSelectField(field)}
                    className={cn(
                      'flex items-center justify-center shrink-0 rounded-full size-4',
                      isSelected
                        ? 'bg-foreground/10 border-[1.5px] border-foreground'
                        : 'border-[1.5px] border-border'
                    )}
                  >
                    {isSelected && <div className="rounded-full bg-foreground shrink-0 size-2" />}
                  </button>

                  {/* Label */}
                  <button
                    type="button"
                    onClick={() => handleSelectField(field)}
                    className={cn(
                      'text-[13px] leading-4 grow shrink basis-0 text-left',
                      isSelected ? 'text-foreground font-medium' : 'text-foreground'
                    )}
                  >
                    {label}
                  </button>

                  {/* Direction arrows (only for selected) */}
                  {isSelected && (
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        aria-label="Ascending"
                        onClick={() => handleSetDirection('asc')}
                        className={cn(
                          'flex items-center justify-center w-[22px] h-[22px] rounded-sm shrink-0 transition-colors',
                          sort.direction === 'asc' ? 'bg-foreground' : 'hover:bg-surface-active'
                        )}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke={
                            sort.direction === 'asc'
                              ? 'var(--primary-foreground)'
                              : 'var(--text-tertiary)'
                          }
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 19V5" />
                          <path d="M5 12l7-7 7 7" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label="Descending"
                        onClick={() => handleSetDirection('desc')}
                        className={cn(
                          'flex items-center justify-center w-[22px] h-[22px] rounded-sm shrink-0 transition-colors',
                          sort.direction === 'desc' ? 'bg-foreground' : 'hover:bg-surface-active'
                        )}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke={
                            sort.direction === 'desc'
                              ? 'var(--primary-foreground)'
                              : 'var(--text-tertiary)'
                          }
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 5v14" />
                          <path d="M19 12l-7 7-7-7" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Divider + Reset */}
          <div className="w-[228px] h-px shrink-0 self-center bg-border" />
          <button
            type="button"
            onClick={handleReset}
            className={cn(
              'flex items-center py-2.5 px-4 transition-colors hover:bg-accent',
              'text-[12px] leading-4',
              isNonDefault ? 'text-foreground' : 'text-text-tertiary'
            )}
          >
            Reset to default
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default SortDropdown
