import { useState, useCallback } from 'react'

import { Layers, ArrowUp, ArrowDown } from '@/lib/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CheckMark } from '@/components/ui/check-mark'
import { cn } from '@/lib/utils'
import type { TaskSort, SortField, SortDirection } from '@/data/tasks-data'
import { defaultSort } from '@/data/tasks-data'

interface GroupByDropdownProps {
  sort: TaskSort
  onChange: (sort: TaskSort) => void
  className?: string
}

const GROUP_FIELD_LABELS: Record<SortField, string> = {
  dueDate: 'Due date',
  priority: 'Priority',
  status: 'Status',
  createdAt: 'Created',
  title: 'Title',
  project: 'Project',
  completedAt: 'Completed'
}

const VISIBLE_FIELDS: SortField[] = [
  'priority',
  'status',
  'dueDate',
  'createdAt',
  'title',
  'project'
]

const DIRECTION_LABELS: Record<SortDirection, string> = {
  asc: 'Ascending',
  desc: 'Descending'
}

export const GroupByDropdown = ({
  sort,
  onChange,
  className
}: GroupByDropdownProps): React.JSX.Element => {
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
          aria-label="Group by options"
          className={cn(
            'flex items-center shrink-0 rounded-[5px] py-1 px-2 gap-1 border transition-colors',
            isOpen || isNonDefault
              ? 'border-foreground/20 bg-foreground/5 text-text-primary'
              : 'border-border text-text-secondary hover:bg-surface-active/50',
            className
          )}
        >
          <Layers size={13} />
          <span className="text-[11px] leading-3.5">Group by</span>
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
                    {GROUP_FIELD_LABELS[field]}
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
                  <ArrowUp
                    size={10}
                    style={{
                      color: sort.direction === 'asc' ? 'var(--foreground)' : 'var(--text-tertiary)'
                    }}
                  />
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
                  <ArrowDown
                    size={10}
                    style={{
                      color:
                        sort.direction === 'desc' ? 'var(--foreground)' : 'var(--text-tertiary)'
                    }}
                  />
                </button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default GroupByDropdown
