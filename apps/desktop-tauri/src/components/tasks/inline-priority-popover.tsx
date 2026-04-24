import * as React from 'react'

import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui/picker'
import { priorityConfig, type Priority } from '@/data/sample-tasks'
import { PriorityBars, PriorityIcon } from './task-icons'

const PRIORITY_OPTIONS: { value: Priority; label: string; shortcut: string }[] = [
  { value: 'urgent', label: priorityConfig.urgent.label ?? 'Urgent', shortcut: '1' },
  { value: 'high', label: priorityConfig.high.label ?? 'High', shortcut: '2' },
  { value: 'medium', label: priorityConfig.medium.label ?? 'Medium', shortcut: '3' },
  { value: 'low', label: priorityConfig.low.label ?? 'Low', shortcut: '4' },
  { value: 'none', label: priorityConfig.none.label ?? 'None', shortcut: '5' }
]

interface InlinePriorityPopoverProps {
  priority: Priority
  onPriorityChange: (priority: Priority) => void
  disabled?: boolean
}

export const InlinePriorityPopover = ({
  priority,
  onPriorityChange,
  disabled = false
}: InlinePriorityPopoverProps): React.JSX.Element => {
  const config = priorityConfig[priority]

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      const option = PRIORITY_OPTIONS.find((o) => o.shortcut === e.key)
      if (option) {
        e.preventDefault()
        onPriorityChange(option.value)
      }
    },
    [onPriorityChange]
  )

  return (
    <Picker value={priority} onValueChange={(v) => onPriorityChange(v as Priority)}>
      <Picker.Trigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'shrink-0 rounded-sm p-0.5 transition-colors cursor-pointer',
            'hover:bg-accent/80',
            'focus-visible:outline-none',
            disabled && 'pointer-events-none'
          )}
          aria-label={`Priority: ${config.label || 'none'}. Click to change.`}
        >
          <PriorityBars priority={priority} />
        </button>
      </Picker.Trigger>
      <Picker.Content width="auto" align="start" sideOffset={4} onKeyDown={handleKeyDown}>
        <Picker.List>
          {PRIORITY_OPTIONS.map((option) => {
            const isNone = option.value === 'none'
            const pc = priorityConfig[option.value]
            return (
              <Picker.Item
                key={option.value}
                value={option.value}
                label={option.label}
                icon={
                  <PriorityIcon
                    priority={option.value}
                    className={cn(isNone && 'text-text-tertiary')}
                  />
                }
                indicator={isNone ? 'none' : 'check'}
                indicatorColor={pc.color ?? undefined}
                shortcut={option.shortcut}
              />
            )
          })}
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
}
