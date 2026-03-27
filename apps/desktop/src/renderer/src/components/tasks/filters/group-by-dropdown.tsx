import { useCallback } from 'react'

import { Layers, ArrowUp, ArrowDown } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
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
  const isNonDefault = sort.field !== defaultSort.field || sort.direction !== defaultSort.direction

  const handleSelectField = useCallback(
    (field: string) => {
      onChange({ ...sort, field: field as SortField })
    },
    [sort, onChange]
  )

  const handleSetDirection = useCallback(
    (direction: SortDirection) => {
      onChange({ ...sort, direction })
    },
    [sort, onChange]
  )

  return (
    <Picker value={sort.field} onValueChange={handleSelectField} closeOnSelect={false}>
      <Picker.Trigger asChild>
        <button
          type="button"
          aria-label="Group by options"
          className={cn(
            'flex items-center shrink-0 rounded-[5px] py-1 px-2 gap-1 border transition-colors',
            isNonDefault
              ? 'border-foreground/20 bg-foreground/5 text-foreground/90'
              : 'border-border text-muted-foreground hover:bg-surface-active/50',
            className
          )}
        >
          <Layers size={13} />
          <span className="text-[12px]">Group by</span>
        </button>
      </Picker.Trigger>
      <Picker.Content width="auto" align="end" sideOffset={8}>
        <Picker.List>
          {VISIBLE_FIELDS.map((field) => (
            <Picker.Item
              key={field}
              value={field}
              label={GROUP_FIELD_LABELS[field]}
              indicator="check"
              indicatorColor="var(--primary)"
            />
          ))}
        </Picker.List>
        <Picker.Footer>
          <div className="p-1">
            <div className="flex items-center justify-between rounded-[5px] py-1.5 px-2">
              <span className="text-[13px] text-muted-foreground leading-4">
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
        </Picker.Footer>
      </Picker.Content>
    </Picker>
  )
}

export default GroupByDropdown
