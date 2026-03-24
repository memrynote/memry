import * as React from 'react'

import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Status } from '@/data/tasks-data'
import { StatusIcon } from './status-icon'

interface InteractiveStatusBadgeProps {
  statusId: string
  statuses: Status[]
  onStatusChange: (statusId: string) => void
  className?: string
}

export const InteractiveStatusBadge = ({
  statusId,
  statuses,
  onStatusChange,
  className
}: InteractiveStatusBadgeProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = React.useState(false)

  const currentStatus = statuses.find((s) => s.id === statusId)
  const statusColor = currentStatus?.color || '#6B7280'
  const statusName = currentStatus?.name || 'Unknown'

  const handleSelect = (newStatusId: string): void => {
    onStatusChange(newStatusId)
    setIsOpen(false)
  }

  const handleTriggerClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild onClick={handleTriggerClick}>
        <button
          type="button"
          className={cn(
            'flex items-center rounded-sm py-0.5 px-2 gap-1 cursor-pointer transition-opacity',
            'hover:opacity-80 focus-visible:outline-none',
            className
          )}
          style={{ backgroundColor: `${statusColor}14` }}
          aria-label={`Status: ${statusName}. Click to change.`}
        >
          <StatusIcon type={currentStatus?.type ?? 'todo'} color={statusColor} />
          <div className="text-[11px] font-medium leading-3.5" style={{ color: statusColor }}>
            {statusName}
          </div>
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
