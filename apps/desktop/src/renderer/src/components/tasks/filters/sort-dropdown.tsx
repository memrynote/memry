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

const FONT = "font-['DM_Sans_Variable',system-ui,sans-serif]"

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
            'flex items-center rounded-sm p-1.5 border transition-colors',
            isOpen || isNonDefault
              ? 'border-foreground/20 bg-foreground/5 text-text-primary'
              : 'border-border text-text-secondary hover:bg-accent/50',
            className
          )}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M3 4l2-2 2 2M5 2v10M11 10l-2 2-2-2M9 12V2"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-text-tertiary"
            />
          </svg>
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[260px] p-0 rounded-xl overflow-clip shadow-[0_2px_12px_rgba(0,0,0,0.06)] max-h-[calc(100vh-120px)] overflow-y-auto"
        align="end"
        sideOffset={8}
      >
        <div className="[font-synthesis:none] text-[12px] leading-4 flex flex-col antialiased">
          {/* Header */}
          <div className="flex items-center py-2.5 px-4 gap-1.5 bg-[#F5F3EF] border-b border-[#E8E5E0]">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#1A1A1A"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6l3-3 3 3" />
              <path d="M6 3v18" />
              <path d="M21 18l-3 3-3-3" />
              <path d="M18 21V3" />
            </svg>
            <span className={`text-[13px] leading-4 text-[#1A1A1A] ${FONT} font-semibold`}>
              Sort
            </span>
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
                    isSelected ? 'bg-[#F9F8F6]' : 'hover:bg-[#F9F8F6]'
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
                        ? 'bg-[#1A1A1A15] border-[1.5px] border-[#1A1A1A]'
                        : 'border-[1.5px] border-[#D4D1CA]'
                    )}
                  >
                    {isSelected && <div className="rounded-full bg-[#1A1A1A] shrink-0 size-2" />}
                  </button>

                  {/* Label */}
                  <button
                    type="button"
                    onClick={() => handleSelectField(field)}
                    className={cn(
                      `text-[13px] leading-4 grow shrink basis-0 text-left ${FONT}`,
                      isSelected ? 'text-[#1A1A1A] font-medium' : 'text-[#1A1A1A]'
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
                          sort.direction === 'asc' ? 'bg-[#1A1A1A]' : 'hover:bg-[#E8E5E0]'
                        )}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke={sort.direction === 'asc' ? '#FFFFFF' : '#8A8A8A'}
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
                          sort.direction === 'desc' ? 'bg-[#1A1A1A]' : 'hover:bg-[#E8E5E0]'
                        )}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke={sort.direction === 'desc' ? '#FFFFFF' : '#8A8A8A'}
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
          <div className="w-[228px] h-px shrink-0 self-center bg-[#E8E5E0]" />
          <button
            type="button"
            onClick={handleReset}
            className={cn(
              'flex items-center py-2.5 px-4 transition-colors hover:bg-[#F9F8F6]',
              `text-[12px] leading-4 ${FONT}`,
              isNonDefault ? 'text-[#1A1A1A]' : 'text-[#8A8A8A]'
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
