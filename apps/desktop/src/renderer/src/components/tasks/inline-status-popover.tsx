import * as React from 'react'

import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui/picker'
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
  const currentStatus = statuses.find((s) => s.id === statusId)
  const statusColor = currentStatus?.color || '#6B7280'
  const effectiveType = isCompleted ? 'done' : (currentStatus?.type ?? 'todo')

  const handleSelect = React.useCallback(
    (newStatusId: string) => {
      if (newStatusId === statusId) return

      const newStatus = statuses.find((s) => s.id === newStatusId)
      onStatusChange(newStatusId)

      if (newStatus?.type === 'done' && !isCompleted) {
        onToggleComplete()
      }
    },
    [statusId, statuses, onStatusChange, isCompleted, onToggleComplete]
  )

  return (
    <Picker value={statusId} onValueChange={handleSelect}>
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
          aria-label={`Status: ${currentStatus?.name || 'Unknown'}. Click to change.`}
        >
          <StatusIcon type={effectiveType} color={statusColor} size="lg" />
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
