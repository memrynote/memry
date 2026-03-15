import { useMemo } from 'react'
import { Calendar, Clock, Repeat } from 'lucide-react'

import { FilterChip } from './filter-chip'
import { cn } from '@/lib/utils'
import type { TaskFilters, Project } from '@/data/tasks-data'
import type { Priority } from '@/data/sample-tasks'

interface ActiveFiltersBarProps {
  filters: TaskFilters
  projects: Project[]
  onUpdateFilters: (updates: Partial<TaskFilters>) => void
  onClearAll: () => void
  className?: string
}

interface ChipData {
  id: string
  label: string
  icon?: React.ReactNode
  dot?: string
  chipBg?: string
  chipText?: string
  chipBorder?: string
  onRemove: () => void
}

const PRIORITY_STYLES: Record<Priority, { bg: string; text: string; border: string; dot: string }> =
  {
    urgent: { bg: '#FEF0EE', text: '#C4392B', border: '#FCCDC6', dot: '#E54D2E' },
    high: { bg: '#FFF8EB', text: '#B45309', border: '#FDE68A', dot: '#F59E0B' },
    medium: { bg: '#ECFDF5', text: '#059669', border: '#A7F3D0', dot: '#22C55E' },
    low: { bg: '#EFF6FF', text: '#1D4ED8', border: '#BFDBFE', dot: '#3B82F6' },
    none: { bg: '#F5F5F5', text: '#737373', border: '#E5E5E5', dot: '#D4D1CA' }
  }

const DUE_DATE_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  overdue: { bg: '#FEF0EE', text: '#C4392B', border: '#FCCDC6' },
  today: { bg: '#FFF8EB', text: '#B45309', border: '#FDE68A' },
  tomorrow: { bg: '#EFF6FF', text: '#1D4ED8', border: '#BFDBFE' }
}

const DUE_DATE_LABELS: Record<string, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  'this-week': 'This Week',
  'next-week': 'Next Week',
  none: 'No due date',
  'this-month': 'This Month',
  custom: 'Custom'
}

const NEUTRAL_STYLE = { bg: '#F5F3EF', text: '#1A1A1A', border: '#E8E5E0' }

export const ActiveFiltersBar = ({
  filters,
  projects,
  onUpdateFilters,
  onClearAll,
  className
}: ActiveFiltersBarProps): React.JSX.Element | null => {
  const chips = useMemo((): ChipData[] => {
    const result: ChipData[] = []

    filters.priorities.forEach((priority) => {
      const s = PRIORITY_STYLES[priority]
      result.push({
        id: `priority-${priority}`,
        label: priority.charAt(0).toUpperCase() + priority.slice(1),
        dot: s.dot,
        chipBg: s.bg,
        chipText: s.text,
        chipBorder: s.border,
        onRemove: () =>
          onUpdateFilters({ priorities: filters.priorities.filter((p) => p !== priority) })
      })
    })

    if (filters.dueDate.type !== 'any') {
      const dueDateType = filters.dueDate.type
      let label = DUE_DATE_LABELS[dueDateType] || dueDateType

      if (dueDateType === 'custom' && filters.dueDate.customStart && filters.dueDate.customEnd) {
        const fmt = (d: Date): string =>
          d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        label = `${fmt(filters.dueDate.customStart)} – ${fmt(filters.dueDate.customEnd)}`
      }

      const s = DUE_DATE_STYLES[dueDateType] || NEUTRAL_STYLE
      result.push({
        id: 'dueDate',
        label,
        icon: <Calendar className="size-3.5" style={{ color: s.text }} strokeWidth={2} />,
        chipBg: s.bg,
        chipText: s.text,
        chipBorder: s.border,
        onRemove: () =>
          onUpdateFilters({ dueDate: { type: 'any', customStart: null, customEnd: null } })
      })
    }

    filters.projectIds.forEach((projectId) => {
      const project = projects.find((p) => p.id === projectId)
      result.push({
        id: `project-${projectId}`,
        label: project?.name ?? 'Deleted Project',
        dot: project?.color ?? '#9ca3af',
        chipBg: NEUTRAL_STYLE.bg,
        chipText: NEUTRAL_STYLE.text,
        chipBorder: NEUTRAL_STYLE.border,
        onRemove: () =>
          onUpdateFilters({
            projectIds: filters.projectIds.filter((id) => id !== projectId)
          })
      })
    })

    filters.statusIds.forEach((statusId) => {
      let statusName = statusId
      let statusColor = '#6b7280'
      for (const project of projects) {
        const status = project.statuses.find((s) => s.id === statusId)
        if (status) {
          statusName = status.name
          statusColor = status.color
          break
        }
      }
      result.push({
        id: `status-${statusId}`,
        label: statusName,
        dot: statusColor,
        chipBg: NEUTRAL_STYLE.bg,
        chipText: NEUTRAL_STYLE.text,
        chipBorder: NEUTRAL_STYLE.border,
        onRemove: () =>
          onUpdateFilters({ statusIds: filters.statusIds.filter((id) => id !== statusId) })
      })
    })

    if (filters.repeatType !== 'all') {
      result.push({
        id: 'repeatType',
        label: filters.repeatType === 'repeating' ? 'Repeating' : 'One-time',
        icon: <Repeat className="size-3.5" style={{ color: NEUTRAL_STYLE.text }} />,
        chipBg: NEUTRAL_STYLE.bg,
        chipText: NEUTRAL_STYLE.text,
        chipBorder: NEUTRAL_STYLE.border,
        onRemove: () => onUpdateFilters({ repeatType: 'all' })
      })
    }

    if (filters.hasTime !== 'all') {
      result.push({
        id: 'hasTime',
        label: filters.hasTime === 'with-time' ? 'With time' : 'No time',
        icon: <Clock className="size-3.5" style={{ color: NEUTRAL_STYLE.text }} />,
        chipBg: NEUTRAL_STYLE.bg,
        chipText: NEUTRAL_STYLE.text,
        chipBorder: NEUTRAL_STYLE.border,
        onRemove: () => onUpdateFilters({ hasTime: 'all' })
      })
    }

    if (filters.search) {
      result.push({
        id: 'search',
        label: `"${filters.search}"`,
        chipBg: NEUTRAL_STYLE.bg,
        chipText: NEUTRAL_STYLE.text,
        chipBorder: NEUTRAL_STYLE.border,
        onRemove: () => onUpdateFilters({ search: '' })
      })
    }

    return result
  }, [filters, projects, onUpdateFilters])

  if (chips.length === 0) return null

  return (
    <div className={cn('flex items-center gap-2 py-2', className)}>
      <div className="flex flex-wrap gap-2 flex-1 min-w-0">
        {chips.map((chip) => (
          <FilterChip
            key={chip.id}
            label={chip.label}
            icon={chip.icon}
            dot={chip.dot}
            chipBg={chip.chipBg}
            chipText={chip.chipText}
            chipBorder={chip.chipBorder}
            onRemove={chip.onRemove}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onClearAll}
        className="text-[12px] text-[#8A8A8A] font-['DM_Sans_Variable',system-ui,sans-serif] font-medium hover:text-[#1A1A1A] transition-colors shrink-0"
      >
        Clear all
      </button>
    </div>
  )
}

export default ActiveFiltersBar
