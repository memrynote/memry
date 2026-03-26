import { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui/picker'
import { priorityConfig, type Priority } from '@/data/sample-tasks'

interface PrioritySelectProps {
  value: Priority
  onChange: (value: Priority) => void
  className?: string
  compact?: boolean
}

const PRIORITY_OPTIONS: {
  value: Priority
  label: string
  color: string | null
  shortcut: string
}[] = [
  { value: 'none', label: 'No priority', color: null, shortcut: '1' },
  { value: 'low', label: 'Low priority', color: priorityConfig.low.color, shortcut: '2' },
  { value: 'medium', label: 'Medium priority', color: priorityConfig.medium.color, shortcut: '3' },
  { value: 'high', label: 'High priority', color: priorityConfig.high.color, shortcut: '4' },
  { value: 'urgent', label: 'Urgent', color: priorityConfig.urgent.color, shortcut: '5' }
]

const PriorityDot = ({
  color,
  compact = false
}: {
  color: string | null
  compact?: boolean
}): React.JSX.Element => {
  if (!color) {
    return (
      <span
        className={cn(
          'shrink-0 rounded-full border-2 border-muted-foreground/40',
          compact ? 'size-2' : 'size-3'
        )}
        aria-hidden="true"
      />
    )
  }
  return (
    <span
      className={cn('shrink-0 rounded-full', compact ? 'size-2' : 'size-3')}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  )
}

export const PrioritySelect = ({
  value,
  onChange,
  className,
  compact = false
}: PrioritySelectProps): React.JSX.Element => {
  const currentOption = PRIORITY_OPTIONS.find((opt) => opt.value === value)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const option = PRIORITY_OPTIONS.find((o) => o.shortcut === e.key)
      if (option) {
        e.preventDefault()
        onChange(option.value)
      }
    },
    [onChange]
  )

  return (
    <Picker value={value} onValueChange={(v) => onChange(v as Priority)}>
      <Picker.Trigger
        variant="button"
        chevron
        className={cn('w-full', compact && 'h-9 text-sm', className)}
        aria-label="Select priority"
      >
        <span className="flex items-center gap-2">
          <PriorityDot color={currentOption?.color || null} compact={compact} />
          <span className={cn(compact && 'text-sm')}>{currentOption?.label || 'No priority'}</span>
        </span>
      </Picker.Trigger>
      <Picker.Content width={200} align="start" onKeyDown={handleKeyDown}>
        <Picker.List>
          {PRIORITY_OPTIONS.map((option) => (
            <Picker.Item
              key={option.value}
              value={option.value}
              label={option.label}
              icon={<PriorityDot color={option.color} />}
              indicator="check"
              indicatorColor={option.color ?? undefined}
              shortcut={option.shortcut}
            />
          ))}
        </Picker.List>
        <Picker.Footer>
          <div className="px-2 py-1.5 text-[10px] text-muted-foreground flex items-center gap-1">
            <kbd className="inline-flex h-4 items-center justify-center rounded border border-border bg-muted px-0.5 text-[10px]">
              ↑
            </kbd>
            <kbd className="inline-flex h-4 items-center justify-center rounded border border-border bg-muted px-0.5 text-[10px]">
              ↓
            </kbd>
            <span className="ml-1">navigate</span>
            <kbd className="ml-2 inline-flex h-4 items-center justify-center rounded border border-border bg-muted px-1 text-[10px]">
              ↵
            </kbd>
            <span className="ml-1">select</span>
          </div>
        </Picker.Footer>
      </Picker.Content>
    </Picker>
  )
}

export default PrioritySelect
