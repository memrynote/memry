import * as React from 'react'

import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui/picker'
import { priorityConfig, type Priority } from '@/data/task-model'
import { useT } from '@memry/i18n/renderer'
import { PriorityBars, PriorityIcon } from './task-icons'

const stopTriggerPropagation = (event: React.SyntheticEvent): void => {
  event.stopPropagation()
}

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
  // Subscribe to the active language so the lazy `priorityConfig` labels below
  // re-resolve when the locale changes (this component renders no other copy).
  useT('tasks')
  const config = priorityConfig[priority]
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
          onClick={stopTriggerPropagation}
          onPointerDown={stopTriggerPropagation}
          onKeyDown={stopTriggerPropagation}
        >
          <PriorityBars priority={priority} />
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
