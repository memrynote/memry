import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui/picker'
import { StatusIcon } from '@/components/tasks/status-icon'
import type { Status } from '@/data/tasks-data'

interface StatusSelectProps {
  value: string
  onChange: (value: string) => void
  statuses: Status[]
  className?: string
  compact?: boolean
}

export const StatusSelect = ({
  value,
  onChange,
  statuses,
  className,
  compact = false
}: StatusSelectProps): React.JSX.Element => {
  const sortedStatuses = useMemo(() => [...statuses].sort((a, b) => a.order - b.order), [statuses])
  const currentStatus = sortedStatuses.find((s) => s.id === value)

  return (
    <Picker value={value} onValueChange={onChange}>
      <Picker.Trigger
        variant="button"
        chevron
        className={cn('w-full', compact && 'h-9 text-sm', className)}
        aria-label="Select status"
      >
        {currentStatus ? (
          <span className="flex items-center gap-2 min-w-0">
            <StatusIcon
              type={currentStatus.type}
              color={currentStatus.color}
              size={compact ? 'sm' : 'md'}
            />
            <span className="truncate">{currentStatus.name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Select status</span>
        )}
      </Picker.Trigger>
      <Picker.Content width="trigger" align="start">
        <Picker.List>
          {sortedStatuses.map((status) => (
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

export default StatusSelect
