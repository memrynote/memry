import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { Status } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface StatusSelectProps {
  value: string
  onChange: (value: string) => void
  statuses: Status[]
  className?: string
  compact?: boolean
}

// ============================================================================
// STATUS DOT COMPONENT
// ============================================================================

const StatusDot = ({
  color,
  className,
  compact = false
}: {
  color: string
  className?: string
  compact?: boolean
}): React.JSX.Element => {
  return (
    <span
      className={cn('shrink-0 rounded-full', compact ? 'size-2' : 'size-3', className)}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  )
}

// ============================================================================
// STATUS SELECT COMPONENT
// ============================================================================

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
              <StatusDot color={currentStatus.color} compact={compact} />
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
              <StatusDot color={status.color} />
              <span className="truncate">{status.name}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export default StatusSelect
