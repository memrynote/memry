import { cn } from '@/lib/utils'
import { priorityConfig, type Priority } from '@/data/task-model'
import { useT } from '@memry/i18n/renderer'

interface PriorityBarsProps {
  priority: Priority
  className?: string
}

export const PriorityBars = ({ priority, className }: PriorityBarsProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  if (priority === 'none') {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        className={cn('shrink-0', className)}
        aria-label={tPhaseF('phaseF.componentsTasksTaskIcons.noPriority')}
      >
        <line
          x1="2"
          y1="7"
          x2="12"
          y2="7"
          stroke="var(--text-tertiary)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    )
  }

  const color = priorityConfig[priority].color!

  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={cn('shrink-0', className)}
      aria-label={`${priority} priority`}
    >
      {priority === 'urgent' ? (
        <>
          <rect x="1.5" y="8" width="2.5" height="4.5" rx="0.5" fill={color} />
          <rect x="5.5" y="5" width="2.5" height="7.5" rx="0.5" fill={color} />
          <rect x="9.5" y="2" width="2.5" height="10.5" rx="0.5" fill={color} />
        </>
      ) : priority === 'high' ? (
        <>
          <rect x="1.5" y="6" width="2.5" height="6.5" rx="0.5" fill={color} />
          <rect x="5.5" y="3.5" width="2.5" height="9" rx="0.5" fill={color} />
          <rect
            x="9.5"
            y="1"
            width="2.5"
            height="11.5"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.4}
          />
        </>
      ) : priority === 'medium' ? (
        <>
          <rect x="1.5" y="6" width="2.5" height="6.5" rx="0.5" fill="var(--text-primary)" />
          <rect
            x="5.5"
            y="3.5"
            width="2.5"
            height="9"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.4}
          />
          <rect
            x="9.5"
            y="1"
            width="2.5"
            height="11.5"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.4}
          />
        </>
      ) : (
        <>
          <rect
            x="1.5"
            y="6"
            width="2.5"
            height="6.5"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.6}
          />
          <rect
            x="5.5"
            y="3.5"
            width="2.5"
            height="9"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.25}
          />
          <rect
            x="9.5"
            y="1"
            width="2.5"
            height="11.5"
            rx="0.5"
            fill="var(--text-tertiary)"
            opacity={0.25}
          />
        </>
      )}
    </svg>
  )
}

export { PriorityStar } from './priority-star'

export { PriorityIcon } from './priority-icon'
