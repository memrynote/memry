import * as React from 'react'

import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui/picker'
import { priorityConfig, type Priority } from '@/data/task-model'
import { useT } from '@memry/i18n/renderer'
import type { PriorityBadgeVariant } from './task-badges'
import { PriorityIcon } from './task-icons'

/**
 * Values + shortcuts only. Labels are resolved during render: this module is
 * imported from `main.tsx` before `createRendererI18n` runs, so reading
 * `priorityConfig[...].label` out here would freeze the English fallback for
 * the whole session.
 */
const PRIORITY_ORDER: { value: Priority; shortcut: string }[] = [
  { value: 'urgent', shortcut: '1' },
  { value: 'high', shortcut: '2' },
  { value: 'medium', shortcut: '3' },
  { value: 'low', shortcut: '4' },
  { value: 'none', shortcut: '5' }
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
  // Subscribe to the active language so the lazy `priorityConfig` labels below
  // re-resolve when the locale changes (this component renders no other copy).
  useT('tasks')
  const config = priorityConfig[priority]
  const displayLabel = compact ? COMPACT_LABELS[priority] : config.label || 'None'
  const priorityOptions = PRIORITY_ORDER.map(({ value, shortcut }) => ({
    value,
    shortcut,
    label: priorityConfig[value].label ?? value
  }))

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      const option = PRIORITY_ORDER.find((o) => o.shortcut === e.key)
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
          {priorityOptions.map((option) => {
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
