import * as React from 'react'

import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui/picker'
import { priorityConfig, type Priority } from '@/data/sample-tasks'
import type { PriorityBadgeVariant } from './task-badges'
import { PriorityIcon } from './task-icons'

const PRIORITY_OPTIONS: { value: Priority; label: string; shortcut: string }[] = [
  { value: 'urgent', label: priorityConfig.urgent.label ?? 'Urgent', shortcut: '1' },
  { value: 'high', label: priorityConfig.high.label ?? 'High', shortcut: '2' },
  { value: 'medium', label: priorityConfig.medium.label ?? 'Medium', shortcut: '3' },
  { value: 'low', label: priorityConfig.low.label ?? 'Low', shortcut: '4' },
  { value: 'none', label: priorityConfig.none.label ?? 'None', shortcut: '5' }
]

const COMPACT_LABELS: Record<Priority, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  urgent: 'Urgent'
}

interface InteractivePriorityBadgeProps {
  priority: Priority
  onPriorityChange: (priority: Priority) => void
  variant?: PriorityBadgeVariant
  size?: 'sm' | 'md'
  compact?: boolean
  fixedWidth?: boolean
  className?: string
}

export const InteractivePriorityBadge = ({
  priority,
  onPriorityChange,
  variant: _variant = 'full',
  size: _size = 'md',
  compact = false,
  fixedWidth = false,
  className
}: InteractivePriorityBadgeProps): React.JSX.Element => {
  const config = priorityConfig[priority]
  const displayLabel = compact ? COMPACT_LABELS[priority] : config.label || 'None'

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
      <Picker.Trigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center rounded-sm py-px px-[7px] gap-1 cursor-pointer transition-opacity [font-synthesis:none]',
            'hover:opacity-80 focus-visible:outline-none',
            fixedWidth && 'w-[70px] justify-start',
            className
          )}
          style={config.bgColor ? { backgroundColor: config.bgColor } : undefined}
          aria-label={`Priority: ${config.label || 'none'}. Click to change.`}
        >
          <PriorityIcon priority={priority} />
          <div
            className="text-[11px] font-medium leading-3.5"
            style={{ color: config.color ?? 'var(--text-tertiary)' }}
          >
            {displayLabel}
          </div>
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
