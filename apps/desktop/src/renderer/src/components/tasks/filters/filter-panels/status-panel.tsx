import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import type { Status } from '@/data/tasks-data'
import { BackButton } from './priority-panel'

const StatusIcon = ({ type, color }: { type: string; color: string }): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    {type === 'todo' && <circle cx="7" cy="7" r="5" stroke={color} strokeWidth="1.2" />}
    {type === 'in_progress' && (
      <>
        <circle cx="7" cy="7" r="5" stroke={color} strokeWidth="1.2" />
        <path d="M7 2A5 5 0 0 1 7 12" fill={color} />
      </>
    )}
    {type === 'done' && (
      <>
        <circle cx="7" cy="7" r="5" stroke={color} strokeWidth="1.2" fill={color} />
        <path
          d="M4.5 7l1.5 1.5L9.5 5"
          stroke="var(--background)"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    )}
  </svg>
)

interface StatusPanelProps {
  statuses: Status[]
  selectedStatusIds: string[]
  onToggleStatus: (statusId: string) => void
  onGoBack: () => void
}

export function StatusPanel({
  statuses,
  selectedStatusIds,
  onToggleStatus,
  onGoBack
}: StatusPanelProps): React.JSX.Element {
  return (
    <>
      <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
        <BackButton onClick={onGoBack} />
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="text-muted-foreground"
        >
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span className="text-[12px] text-foreground font-medium leading-4">Status</span>
      </div>
      <div className="flex flex-col p-1">
        {statuses.map((status) => {
          const selected = selectedStatusIds.includes(status.id)
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
              {selected && <CheckMark className="ml-auto text-foreground" />}
            </button>
          )
        })}
      </div>
    </>
  )
}
