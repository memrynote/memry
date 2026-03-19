import { useMemo } from 'react'

import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import type { Status } from '@/data/tasks-data'
import type { Task } from '@/data/sample-tasks'
import { StatusIcon } from '@/components/tasks/status-icon'
import { BackButton } from './priority-panel'

interface StatusPanelProps {
  statuses: Status[]
  selectedStatusIds: string[]
  onToggleStatus: (statusId: string) => void
  onGoBack: () => void
  tasks: Task[]
}

export function StatusPanel({
  statuses,
  selectedStatusIds,
  onToggleStatus,
  onGoBack,
  tasks
}: StatusPanelProps): React.JSX.Element {
  const countsByStatus = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const task of tasks) {
      counts[task.statusId] = (counts[task.statusId] || 0) + 1
    }
    return counts
  }, [tasks])

  return (
    <>
      <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
        <BackButton onClick={onGoBack} />
        <StatusIcon type="todo" color="var(--muted-foreground)" size="md" />
        <span className="text-[12px] text-foreground font-medium leading-4">Status</span>
      </div>
      <div className="flex flex-col p-1">
        {statuses.map((status) => {
          const selected = selectedStatusIds.includes(status.id)
          const count = countsByStatus[status.id] ?? 0
          return (
            <button
              key={status.id}
              type="button"
              onClick={() => onToggleStatus(status.id)}
              className={cn(
                'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                selected ? 'bg-accent' : 'hover:bg-accent'
              )}
            >
              <StatusIcon type={status.type} color={status.color} />
              <span
                className={cn(
                  'text-[12px] leading-4',
                  selected ? 'text-foreground' : 'text-text-secondary'
                )}
              >
                {status.name}
              </span>
              <span
                className={cn(
                  'ml-auto text-[11px] leading-3.5 tabular-nums',
                  selected ? 'text-text-secondary' : 'text-text-tertiary'
                )}
              >
                {count}
              </span>
              {selected && <CheckMark className="text-foreground" />}
            </button>
          )
        })}
      </div>
    </>
  )
}
