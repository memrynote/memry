import { Check, ChevronDown } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { FilterFooter } from '@/components/ui/filter-footer'
import { Picker } from '@/components/ui/picker'
import { cn } from '@/lib/utils'
import { type Priority } from '@/data/sample-tasks'

interface PriorityFilterProps {
  selectedPriorities: Priority[]
  onChange: (priorities: Priority[]) => void
  taskCountByPriority?: Record<Priority, number>
  className?: string
}

const PRIORITY_DISPLAY: Record<
  Priority,
  { label: string; dot: string; checkBorder: string; checkBg: string; checkStroke: string }
> = {
  urgent: {
    label: 'Urgent',
    dot: 'var(--task-priority-urgent)',
    checkBorder: 'var(--task-priority-urgent)',
    checkBg: 'var(--task-priority-urgent-bg)',
    checkStroke: 'var(--task-priority-urgent)'
  },
  high: {
    label: 'High',
    dot: 'var(--task-priority-high)',
    checkBorder: 'var(--task-priority-high)',
    checkBg: 'var(--task-priority-high-bg)',
    checkStroke: 'var(--task-priority-high)'
  },
  medium: {
    label: 'Medium',
    dot: 'var(--task-complete)',
    checkBorder: 'var(--border)',
    checkBg: 'var(--card)',
    checkStroke: 'var(--task-complete)'
  },
  low: {
    label: 'Low',
    dot: 'var(--task-progress)',
    checkBorder: 'var(--border)',
    checkBg: 'var(--card)',
    checkStroke: 'var(--task-progress)'
  },
  none: {
    label: 'None',
    dot: 'var(--border)',
    checkBorder: 'var(--border)',
    checkBg: 'var(--card)',
    checkStroke: 'var(--border)'
  }
}

const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

export const PriorityFilter = ({
  selectedPriorities,
  onChange,
  taskCountByPriority = {} as Record<Priority, number>,
  className
}: PriorityFilterProps): React.JSX.Element => {
  const hasSelection = selectedPriorities.length > 0

  const handleToggle = (value: string): void => {
    const p = value as Priority
    const next = selectedPriorities.includes(p)
      ? selectedPriorities.filter((x) => x !== p)
      : [...selectedPriorities, p]
    onChange(next)
  }

  return (
    <Picker mode="multi" value={selectedPriorities} onValueChange={handleToggle}>
      <Picker.Trigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 gap-2', hasSelection && 'border-primary bg-primary/5', className)}
          aria-label="Filter by priority"
        >
          <span>Priority</span>
          {hasSelection && (
            <span className="bg-primary text-primary-foreground text-xs px-1.5 py-0.5 rounded-full min-w-5 text-center">
              {selectedPriorities.length}
            </span>
          )}
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </Picker.Trigger>
      <Picker.Content width={240} align="start">
        <Picker.List>
          {PRIORITY_ORDER.map((priority) => {
            const display = PRIORITY_DISPLAY[priority]
            const isSelected = selectedPriorities.includes(priority)
            const taskCount = taskCountByPriority[priority] || 0

            return (
              <Picker.Item
                key={priority}
                value={priority}
                label={display.label}
                icon={
                  <>
                    <div
                      className="flex items-center justify-center rounded-sm shrink-0 size-4"
                      style={{
                        borderWidth: '1.5px',
                        borderStyle: 'solid',
                        borderColor: isSelected ? display.checkBorder : 'var(--border)',
                        backgroundColor: isSelected ? display.checkBg : 'var(--card)'
                      }}
                    >
                      {isSelected && (
                        <Check size={10} strokeWidth={3} style={{ color: display.checkStroke }} />
                      )}
                    </div>
                    <div
                      className="shrink-0 rounded-full size-2"
                      style={{ backgroundColor: display.dot }}
                    />
                  </>
                }
                trailing={
                  <span className="text-[11px] text-text-tertiary leading-[14px] tabular-nums">
                    {taskCount}
                  </span>
                }
                className={cn(
                  'gap-2.5 py-2 px-4',
                  priority === 'none' &&
                    !isSelected &&
                    '[&_[class*=text-muted]]:text-muted-foreground'
                )}
              />
            )
          })}
        </Picker.List>
        <Picker.Footer>
          <FilterFooter
            onClear={() => onChange([])}
            onApply={() => {}}
            clearLabel="Clear"
            applyLabel="Apply"
          />
        </Picker.Footer>
      </Picker.Content>
    </Picker>
  )
}

export default PriorityFilter
