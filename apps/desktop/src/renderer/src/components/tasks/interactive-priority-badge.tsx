import * as React from 'react'

import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { priorityConfig, type Priority } from '@/data/sample-tasks'
import type { PriorityBadgeVariant } from './task-badges'
import { PriorityIcon } from './task-icons'

const PRIORITY_OPTIONS: {
  value: Priority
  label: string
  color: string | null
  bg: string | null
  shortcut: string
}[] = [
  { value: 'urgent', ...pick(priorityConfig.urgent), shortcut: '1' },
  { value: 'high', ...pick(priorityConfig.high), shortcut: '2' },
  { value: 'medium', ...pick(priorityConfig.medium), shortcut: '3' },
  { value: 'low', ...pick(priorityConfig.low), shortcut: '4' },
  { value: 'none', ...pick(priorityConfig.none), shortcut: '5' }
]

function pick(c: { color: string | null; bgColor: string | null; label: string | null }) {
  return { label: c.label ?? 'None', color: c.color, bg: c.bgColor }
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
  const [isOpen, setIsOpen] = React.useState(false)
  const config = priorityConfig[priority]

  const compactLabels: Record<Priority, string> = {
    none: 'None',
    low: 'Low',
    medium: 'Med',
    high: 'High',
    urgent: 'Urgent'
  }
  const displayLabel = compact ? compactLabels[priority] : config.label || 'None'

  const handleSelect = (newPriority: Priority): void => {
    onPriorityChange(newPriority)
    setIsOpen(false)
  }

  const handleTriggerClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    const option = PRIORITY_OPTIONS.find((o) => o.shortcut === e.key)
    if (option) {
      e.preventDefault()
      handleSelect(option.value)
    }
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild onClick={handleTriggerClick}>
        <button
          type="button"
          className={cn(
            'flex items-center rounded-sm py-px px-[7px] gap-1 cursor-pointer transition-opacity [font-synthesis:none] antialiased',
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
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 rounded-[10px] bg-popover border-border shadow-lg"
        align="start"
        sideOffset={4}
        onClick={handleTriggerClick}
        onKeyDown={handleKeyDown}
      >
        <div className="flex flex-col p-1 [font-synthesis:none] antialiased">
          {PRIORITY_OPTIONS.map((option) => {
            const isSelected = option.value === priority
            const isNone = option.value === 'none'
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => handleSelect(option.value)}
                className={cn(
                  'flex items-center rounded-[7px] py-2 px-3 gap-2 transition-colors',
                  'hover:bg-accent focus:outline-none'
                )}
                style={
                  isSelected && !isNone && option.bg ? { backgroundColor: option.bg } : undefined
                }
              >
                <PriorityIcon
                  priority={option.value}
                  className={cn(isNone && 'text-text-tertiary')}
                />
                <div
                  className={cn(
                    'text-[13px] leading-4',
                    isNone
                      ? 'text-text-tertiary'
                      : !isSelected
                        ? 'text-text-secondary'
                        : 'font-medium'
                  )}
                  style={
                    isSelected && !isNone && option.color ? { color: option.color } : undefined
                  }
                >
                  {option.label}
                </div>
                {isSelected && !isNone && option.color && (
                  <CheckMark color={option.color} className="ml-auto" />
                )}
                <div
                  className={cn(
                    'text-[10px] text-text-tertiary font-[family-name:var(--font-mono)] leading-3',
                    !(isSelected && !isNone) && 'ml-auto'
                  )}
                >
                  {option.shortcut}
                </div>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
