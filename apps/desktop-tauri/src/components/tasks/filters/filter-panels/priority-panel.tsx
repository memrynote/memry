import { useMemo } from 'react'

import { ChevronLeft } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
import { FilterFooter } from '@/components/ui/filter-footer'
import type { Priority, Task } from '@/data/sample-tasks'
import { PriorityIcon } from '@/components/tasks/task-icons'

const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority'
}

const BackButton = ({ onClick }: { onClick: () => void }): React.JSX.Element => (
  <button type="button" onClick={onClick} className="shrink-0 p-0.5 -ml-0.5 text-text-tertiary">
    <ChevronLeft size={12} />
  </button>
)

interface PriorityPanelProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  selectedPriorities: Priority[]
  onTogglePriority: (priority: Priority) => void
  onClose: () => void
  onGoBack: () => void
  tasks: Task[]
}

export function PriorityPanel({
  searchQuery,
  onSearchChange,
  selectedPriorities,
  onTogglePriority,
  onClose,
  onGoBack,
  tasks
}: PriorityPanelProps): React.JSX.Element {
  const filteredPriorities = useMemo(() => {
    if (!searchQuery) return PRIORITY_ORDER
    const q = searchQuery.toLowerCase()
    return PRIORITY_ORDER.filter((p) => PRIORITY_LABELS[p].toLowerCase().includes(q))
  }, [searchQuery])

  const countsByPriority = useMemo(() => {
    const counts: Record<Priority, number> = { urgent: 0, high: 0, medium: 0, low: 0, none: 0 }
    for (const task of tasks) {
      counts[task.priority]++
    }
    return counts
  }, [tasks])

  return (
    <>
      <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
        <BackButton onClick={onGoBack} />
        <svg
          width="13"
          height="13"
          viewBox="0 0 13 13"
          fill="none"
          className="text-muted-foreground"
        >
          <rect x="1" y="7" width="2.5" height="4.5" rx="0.5" fill="currentColor" />
          <rect x="5" y="4.5" width="2.5" height="7" rx="0.5" fill="currentColor" />
          <rect x="9" y="2" width="2.5" height="9.5" rx="0.5" fill="currentColor" />
        </svg>
        <span className="text-[13px] text-foreground font-medium leading-4">Priority</span>
        <span className="text-[11px] ml-auto text-foreground leading-3.5">is</span>
      </div>
      <FilterSearchHeader
        value={searchQuery}
        onChange={onSearchChange}
        placeholder="Search..."
        className="py-1.5"
      />
      <div className="flex flex-col p-1">
        {filteredPriorities.map((p) => {
          const checked = selectedPriorities.includes(p)
          return (
            <button
              key={p}
              type="button"
              onClick={() => onTogglePriority(p)}
              className={cn(
                'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                checked ? 'bg-accent' : 'hover:bg-accent'
              )}
            >
              <PriorityIcon priority={p} className={cn(p === 'none' && 'text-text-tertiary')} />
              <span
                className={cn(
                  'text-[13px] leading-4',
                  checked ? 'text-foreground' : 'text-muted-foreground',
                  p === 'none' && !checked && 'text-muted-foreground/60'
                )}
              >
                {PRIORITY_LABELS[p]}
              </span>
              <span
                className={cn(
                  'ml-auto text-[11px] leading-3.5 tabular-nums',
                  checked ? 'text-text-secondary' : 'text-text-tertiary'
                )}
              >
                {countsByPriority[p]}
              </span>
              {checked && <CheckMark className="text-foreground" />}
            </button>
          )
        })}
      </div>
      <FilterFooter
        onClear={() => {}}
        onApply={onClose}
        info={
          <span className="text-[11px] text-text-tertiary leading-3.5">
            {selectedPriorities.length} selected
          </span>
        }
        className="py-2 px-3"
      />
    </>
  )
}

export { BackButton }
