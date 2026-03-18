import { CheckSquare } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface SubtaskProgressIndicatorProps {
  completed: number
  total: number
  accentColor?: string
  className?: string
}

export const SubtaskProgressIndicator = ({
  completed,
  total,
  accentColor,
  className
}: SubtaskProgressIndicatorProps): React.JSX.Element | null => {
  if (total === 0) return null

  const percentage = Math.round((completed / total) * 100)

  return (
    <div className={cn('flex items-center gap-1.5 shrink-0', className)}>
      <CheckSquare className="size-3 text-text-tertiary" strokeWidth={2} />
      <span className="text-[11px]/3.5 text-text-tertiary tabular-nums">
        {completed}/{total}
      </span>
      <div className="w-8 h-1 rounded-full overflow-clip bg-border shrink-0">
        <div
          className="h-full rounded-full"
          style={{
            width: `${percentage}%`,
            backgroundColor: accentColor ?? 'var(--task-progress)'
          }}
        />
      </div>
    </div>
  )
}

export default SubtaskProgressIndicator
