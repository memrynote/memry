import { cn } from '@/lib/utils'

interface SubtaskBadgeProps {
  completed: number
  total: number
  isExpanded?: boolean
  onClick?: () => void
  size?: 'sm' | 'md'
  className?: string
}

export const SubtaskBadge = ({
  completed,
  total,
  isExpanded: _isExpanded,
  onClick,
  size: _size = 'sm',
  className
}: SubtaskBadgeProps): React.JSX.Element | null => {
  if (total === 0) return null

  const percentage = Math.round((completed / total) * 100)

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onClick?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.key === 'Enter' || e.key === ' ') && onClick) {
      e.preventDefault()
      e.stopPropagation()
      onClick()
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={onClick ? 0 : -1}
      className={cn(
        'inline-flex items-center gap-[3px] shrink-0',
        'focus-visible:outline-none rounded',
        onClick ? 'cursor-pointer' : 'cursor-default',
        className
      )}
      aria-label={`${completed} of ${total} subtasks complete`}
    >
      <div className="w-5 h-[3px] rounded-sm overflow-clip bg-[#EDECE8]">
        <div className="h-full rounded-sm bg-[#7B9E87]" style={{ width: `${percentage}%` }} />
      </div>
      <span className="text-[9px] text-muted-foreground font-mono leading-3">
        {completed}/{total}
      </span>
    </button>
  )
}

export default SubtaskBadge
