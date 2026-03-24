import * as React from 'react'

import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Status } from '@/data/tasks-data'
import { StatusIcon } from './status-icon'

interface InlineStatusPopoverProps {
  statusId: string
  statuses: Status[]
  isCompleted: boolean
  onStatusChange: (statusId: string) => void
  onToggleComplete: () => void
  disabled?: boolean
}

export const InlineStatusPopover = ({
  statusId,
  statuses,
  isCompleted,
  onStatusChange,
  onToggleComplete,
  disabled = false
}: InlineStatusPopoverProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = React.useState(false)

  const currentStatus = statuses.find((s) => s.id === statusId)
  const statusColor = currentStatus?.color || '#6B7280'
  const effectiveType = isCompleted ? 'done' : (currentStatus?.type ?? 'todo')

  const handleSelect = (newStatusId: string): void => {
    if (newStatusId === statusId) {
      setIsOpen(false)
      return
    }

    const newStatus = statuses.find((s) => s.id === newStatusId)
    onStatusChange(newStatusId)

    if (newStatus?.type === 'done' && !isCompleted) {
      onToggleComplete()
    }

    setIsOpen(false)
  }

  const handleTriggerClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  return (
    <Popover open={isOpen} onOpenChange={disabled ? undefined : setIsOpen}>
      <PopoverTrigger asChild onClick={handleTriggerClick}>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'shrink-0 rounded-sm p-0.5 transition-colors cursor-pointer',
            'hover:bg-accent/80',
            'focus-visible:outline-none',
            disabled && 'pointer-events-none'
          )}
          aria-label={`Status: ${currentStatus?.name || 'Unknown'}. Click to change.`}
        >
          <StatusIcon type={effectiveType} color={statusColor} size="lg" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 rounded-[10px] bg-popover border-border shadow-lg"
        align="start"
        sideOffset={4}
        onClick={handleTriggerClick}
      >
        <div className="flex flex-col p-1 [font-synthesis:none] antialiased">
          {statuses.map((status) => {
            const isSelected = status.id === statusId
            return (
              <button
                key={status.id}
                type="button"
                onClick={() => handleSelect(status.id)}
                className={cn(
                  'flex items-center rounded-[7px] py-2 px-3 gap-2 transition-colors',
                  'hover:bg-accent focus:outline-none'
                )}
                style={isSelected ? { backgroundColor: `${status.color}0F` } : undefined}
              >
                <StatusIcon type={status.type} color={status.color} />
                <div
                  className={cn(
                    'text-[13px] leading-4',
                    isSelected ? 'font-medium' : 'text-text-secondary'
                  )}
                  style={isSelected ? { color: status.color } : undefined}
                >
                  {status.name}
                </div>
                {isSelected && <CheckMark color={status.color} className="ml-auto" />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
