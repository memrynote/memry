import { useState, useCallback } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CheckMark } from '@/components/ui/check-mark'
import { cn } from '@/lib/utils'
import type { TaskSort, SortField, SortDirection } from '@/data/tasks-data'
import { defaultSort } from '@/data/tasks-data'

interface SortDropdownProps {
  sort: TaskSort
  onChange: (sort: TaskSort) => void
  className?: string
}

const SORT_FIELD_LABELS: Record<SortField, string> = {
  dueDate: 'Due date',
  priority: 'Priority',
  createdAt: 'Created',
  title: 'Title',
  project: 'Project',
  completedAt: 'Completed'
}

const VISIBLE_FIELDS: SortField[] = ['priority', 'dueDate', 'createdAt', 'title', 'project']

const DIRECTION_LABELS: Record<SortDirection, string> = {
  asc: 'Ascending',
  desc: 'Descending'
}

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
        className="w-auto min-w-[180px] p-0 rounded-lg overflow-clip border-border shadow-[var(--shadow-card-hover)]"
        align="end"
        sideOffset={8}
      >
        <div className="[font-synthesis:none] text-[12px] leading-4 flex flex-col antialiased">
          <div className="flex flex-col p-1">
            {VISIBLE_FIELDS.map((field) => {
              const isSelected = sort.field === field

              return (
                <button
                  key={field}
                  type="button"
                  onClick={() => handleSelectField(field)}
                  className={cn(
                    'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                    isSelected ? 'bg-accent' : 'hover:bg-accent'
                  )}
                >
                  <span
                    className={cn(
                      'text-[12px] leading-4',
                      isSelected ? 'text-foreground' : 'text-text-secondary'
                    )}
                  >
                    {SORT_FIELD_LABELS[field]}
                  </span>
                  {isSelected && <CheckMark color="var(--primary)" className="ml-auto" />}
                </button>
              )
            })}
          </div>

          {/* Direction toggle */}
          <div className="border-t border-border p-1">
            <div className="flex items-center justify-between rounded-[5px] py-1.5 px-2">
              <span className="text-[12px] text-text-secondary leading-4">
                {DIRECTION_LABELS[sort.direction]}
              </span>
              <div className="flex items-center rounded-sm overflow-clip border border-border">
                <button
                  type="button"
                  aria-label="Sort ascending"
                  onClick={() => handleSetDirection('asc')}
                  className={cn(
                    'flex items-center justify-center w-[22px] h-5 shrink-0 transition-colors',
                    sort.direction === 'asc' ? 'bg-foreground/8' : 'hover:bg-foreground/5'
                  )}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                      d="M5 8V2M5 2L3 4M5 2l2 2"
                      stroke={
                        sort.direction === 'asc' ? 'var(--foreground)' : 'var(--text-tertiary)'
                      }
                      strokeWidth="1.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label="Sort descending"
                  onClick={() => handleSetDirection('desc')}
                  className={cn(
                    'flex items-center justify-center w-[22px] h-5 shrink-0 transition-colors',
                    sort.direction === 'desc' ? 'bg-foreground/8' : 'hover:bg-foreground/5'
                  )}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                      d="M5 2v6M5 8L3 6M5 8l2-2"
                      stroke={
                        sort.direction === 'desc' ? 'var(--foreground)' : 'var(--text-tertiary)'
                      }
                      strokeWidth="1.1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default SortDropdown
