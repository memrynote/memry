import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
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
  // Sort statuses by order
  const sortedStatuses = [...statuses].sort((a, b) => a.order - b.order)

  // Find current status
  const currentStatus = sortedStatuses.find((s) => s.id === value)

  const handleValueChange = (newValue: string): void => {
    onChange(newValue)
  }

  return (
    <Select value={value} onValueChange={handleValueChange}>
      <SelectTrigger
        className={cn('w-full', compact && 'h-9 text-sm', className)}
        aria-label="Select status"
      >
        <SelectValue>
          {currentStatus ? (
            <div className="flex items-center gap-2">
              <StatusIcon
                type={currentStatus.type}
                color={currentStatus.color}
                size={compact ? 'sm' : 'md'}
              />
              <span className={cn('truncate', compact && 'text-sm')}>{currentStatus.name}</span>
            </div>
          ) : (
            <span className={cn('text-muted-foreground', compact && 'text-sm')}>Select status</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {sortedStatuses.map((status) => (
          <SelectItem key={status.id} value={status.id} className="cursor-pointer">
            <div className="flex items-center gap-2">
              <StatusIcon type={status.type} color={status.color} />
              <span className="truncate">{status.name}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export default StatusSelect
