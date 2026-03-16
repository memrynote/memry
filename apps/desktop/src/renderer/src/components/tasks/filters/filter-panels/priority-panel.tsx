import { useMemo } from 'react'

import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
import { FilterFooter } from '@/components/ui/filter-footer'
import type { Priority } from '@/data/sample-tasks'

const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority'
}

const V = {
  destructive: 'var(--destructive)',
  orange: 'var(--accent-orange)',
  fg: 'var(--foreground)',
  tertiary: 'var(--text-tertiary)',
  border: 'var(--border)'
} as const

const PRIORITY_ICONS: Record<Priority, React.ReactNode> = {
  urgent: (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1" y="7" width="2.2" height="4" rx="0.5" style={{ fill: V.destructive }} />
      <rect x="5" y="4.5" width="2.2" height="6.5" rx="0.5" style={{ fill: V.destructive }} />
      <rect x="9" y="2" width="2.2" height="9" rx="0.5" style={{ fill: V.destructive }} />
    </svg>
  ),
  high: (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1" y="5.5" width="2.2" height="5.5" rx="0.5" style={{ fill: V.orange }} />
      <rect x="5" y="3" width="2.2" height="8" rx="0.5" style={{ fill: V.orange }} />
      <rect x="9" y="1" width="2.2" height="10" rx="0.5" style={{ fill: V.border }} />
    </svg>
  ),
  medium: (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1" y="5.5" width="2.2" height="5.5" rx="0.5" style={{ fill: V.fg }} />
      <rect x="5" y="3" width="2.2" height="8" rx="0.5" style={{ fill: V.border }} />
      <rect x="9" y="1" width="2.2" height="10" rx="0.5" style={{ fill: V.border }} />
    </svg>
  ),
  low: (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect
        x="1"
        y="5.5"
        width="2.2"
        height="5.5"
        rx="0.5"
        style={{ fill: V.tertiary, opacity: 0.6 }}
      />
      <rect x="5" y="3" width="2.2" height="8" rx="0.5" style={{ fill: V.border }} />
      <rect x="9" y="1" width="2.2" height="10" rx="0.5" style={{ fill: V.border }} />
    </svg>
  ),
  none: (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M3 6.5h7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

const BackButton = ({ onClick }: { onClick: () => void }): React.JSX.Element => (
  <button type="button" onClick={onClick} className="shrink-0 p-0.5 -ml-0.5 text-text-tertiary">
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M7 3L4 6l3 3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </button>
)

interface PriorityPanelProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  selectedPriorities: Priority[]
  onTogglePriority: (priority: Priority) => void
  onClose: () => void
  onGoBack: () => void
}

export function PriorityPanel({
  searchQuery,
  onSearchChange,
  selectedPriorities,
  onTogglePriority,
  onClose,
  onGoBack
}: PriorityPanelProps): React.JSX.Element {
  const filteredPriorities = useMemo(() => {
    if (!searchQuery) return PRIORITY_ORDER
    const q = searchQuery.toLowerCase()
    return PRIORITY_ORDER.filter((p) => PRIORITY_LABELS[p].toLowerCase().includes(q))
  }, [searchQuery])

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
        <span className="text-[12px] text-foreground font-medium leading-4">Priority</span>
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
              <span className={cn(p === 'none' && 'text-text-tertiary')}>{PRIORITY_ICONS[p]}</span>
              <span
                className={cn(
                  'text-[12px] leading-4',
                  checked ? 'text-foreground' : 'text-text-secondary',
                  p === 'none' && !checked && 'text-text-tertiary'
                )}
              >
                {PRIORITY_LABELS[p]}
              </span>
              {checked && <CheckMark className="ml-auto text-foreground" />}
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

export { BackButton, PRIORITY_ICONS }
