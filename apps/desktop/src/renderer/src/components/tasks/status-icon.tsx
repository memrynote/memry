import { cn } from '@/lib/utils'
import { CircleDashed, Progress, CheckCircle } from '@/lib/icons'
import type { StatusType } from '@/data/tasks-data'

const SIZE_MAP = { sm: 12, md: 14, lg: 16 } as const

type StatusIconSize = keyof typeof SIZE_MAP

interface StatusIconProps {
  type: StatusType
  color: string
  size?: StatusIconSize
  className?: string
}

const ICON_BY_TYPE = {
  todo: CircleDashed,
  in_progress: Progress,
  done: CheckCircle
} as const

export const StatusIcon = ({
  type,
  color,
  size = 'md',
  className
}: StatusIconProps): React.JSX.Element => {
  const Icon = ICON_BY_TYPE[type]
  const px = SIZE_MAP[size]

  return <Icon className={cn('shrink-0', className)} size={px} style={{ color }} />
}

interface InteractiveStatusIconProps {
  type: StatusType
  color: string
  isCompleted: boolean
  onClick: (e: React.MouseEvent) => void
  className?: string
}

export const InteractiveStatusIcon = ({
  type,
  color,
  isCompleted,
  onClick,
  className
}: InteractiveStatusIconProps): React.JSX.Element => {
  const effectiveType = isCompleted ? 'done' : type

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 cursor-pointer rounded-full',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className
      )}
      aria-label={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
    >
      <StatusIcon type={effectiveType} color={color} size="lg" />
    </button>
  )
}
