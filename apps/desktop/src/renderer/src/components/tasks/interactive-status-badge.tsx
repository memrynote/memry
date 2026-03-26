import * as React from 'react'

import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui/picker'
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
  const currentStatus = statuses.find((s) => s.id === statusId)
  const statusColor = currentStatus?.color || '#6B7280'
  const statusName = currentStatus?.name || 'Unknown'

  return (
    <Picker value={statusId} onValueChange={onStatusChange}>
      <Picker.Trigger asChild>
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
      </Picker.Trigger>
      <Picker.Content width="auto" align="start" sideOffset={4}>
        <Picker.List>
          {statuses.map((status) => (
            <Picker.Item
              key={status.id}
              value={status.id}
              label={status.name}
              icon={<StatusIcon type={status.type} color={status.color} />}
              indicator="check"
              indicatorColor={status.color}
            />
          ))}
        </Picker.List>
      </Picker.Content>
    </Picker>
  )
}
