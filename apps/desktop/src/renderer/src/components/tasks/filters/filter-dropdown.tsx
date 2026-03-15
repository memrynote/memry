import { useState, useMemo, useCallback } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type {
  TaskFilters,
  SavedFilter,
  Project,
  Status,
  DueDateFilterType
} from '@/data/tasks-data'
import type { Priority, Task } from '@/data/sample-tasks'
import { defaultStatuses } from '@/data/tasks-data'

interface FilterDropdownProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  filters: TaskFilters
  onUpdateFilters: (updates: Partial<TaskFilters>) => void
  onClearFilters: () => void
  tasks: Task[]
  projects: Project[]
  savedFilters: SavedFilter[]
  onDeleteSavedFilter: (filterId: string) => void
  onApplySavedFilter: (filter: SavedFilter) => void
  onSaveFilter: (name: string) => void
  showStatusFilter?: boolean
  statuses?: Status[]
  children: React.ReactNode
}

type ActivePanel = null | 'priority' | 'status' | 'dueDate' | 'project'

const FONT = "font-['Inter',system-ui,sans-serif]"
const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority'
}
const DAY_HEADERS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

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

const CheckMark = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    className="ml-auto shrink-0 text-foreground"
  >
    <path
      d="M3 6l2 2 4-4"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

type CalendarDay = { day: number; isCurrentMonth: boolean }

const getCalendarWeeks = (year: number, month: number): CalendarDay[][] => {
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  const startOffset = (firstDay.getDay() + 6) % 7

  const days: CalendarDay[] = []
  const prevMonthLastDay = new Date(year, month, 0).getDate()
  for (let i = startOffset - 1; i >= 0; i--) {
    days.push({ day: prevMonthLastDay - i, isCurrentMonth: false })
  }
  for (let d = 1; d <= lastDay.getDate(); d++) {
    days.push({ day: d, isCurrentMonth: true })
  }
  let nextDay = 1
  while (days.length % 7 !== 0) days.push({ day: nextDay++, isCurrentMonth: false })

  const weeks: CalendarDay[][] = []
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))
  return weeks
}

const getNextMonday = (): Date => {
  const d = new Date()
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7))
  d.setHours(0, 0, 0, 0)
  return d
}

export const FilterDropdown = ({
  open,
  onOpenChange,
  filters,
  onUpdateFilters,
  onClearFilters: _onClearFilters,
  tasks: _tasks,
  projects,
  savedFilters: _savedFilters,
  onDeleteSavedFilter: _onDeleteSavedFilter,
  onApplySavedFilter: _onApplySavedFilter,
  onSaveFilter: _onSaveFilter,
  showStatusFilter: _showStatusFilter,
  statuses: statusesProp = [],
  children
}: FilterDropdownProps): React.JSX.Element => {
  const [activePanel, setActivePanel] = useState<ActivePanel>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })

  const statuses = statusesProp.length > 0 ? statusesProp : defaultStatuses

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setActivePanel(null)
        setSearchQuery('')
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

  const navigateTo = useCallback((panel: ActivePanel) => {
    setActivePanel(panel)
    setSearchQuery('')
  }, [])

  const goBack = useCallback(() => {
    setActivePanel(null)
    setSearchQuery('')
  }, [])

  const togglePriority = useCallback(
    (p: Priority) => {
      const next = filters.priorities.includes(p)
        ? filters.priorities.filter((x) => x !== p)
        : [...filters.priorities, p]
      onUpdateFilters({ priorities: next })
    },
    [filters.priorities, onUpdateFilters]
  )

  const toggleStatus = useCallback(
    (statusId: string) => {
      const next = filters.statusIds.includes(statusId)
        ? filters.statusIds.filter((id) => id !== statusId)
        : [...filters.statusIds, statusId]
      onUpdateFilters({ statusIds: next })
    },
    [filters.statusIds, onUpdateFilters]
  )

  const selectDueDate = useCallback(
    (type: DueDateFilterType) => {
      onUpdateFilters({ dueDate: { type, customStart: null, customEnd: null } })
    },
    [onUpdateFilters]
  )

  const selectCalendarDate = useCallback(
    (day: number) => {
      const date = new Date(calendarMonth.year, calendarMonth.month, day)
      onUpdateFilters({ dueDate: { type: 'custom', customStart: date, customEnd: date } })
    },
    [calendarMonth, onUpdateFilters]
  )

  const clearDueDate = useCallback(() => {
    onUpdateFilters({ dueDate: { type: 'any', customStart: null, customEnd: null } })
  }, [onUpdateFilters])

  const toggleProject = useCallback(
    (projectId: string) => {
      const next = filters.projectIds.includes(projectId)
        ? filters.projectIds.filter((id) => id !== projectId)
        : [...filters.projectIds, projectId]
      onUpdateFilters({ projectIds: next })
    },
    [filters.projectIds, onUpdateFilters]
  )

  const clearProjectFilter = useCallback(() => {
    onUpdateFilters({ projectIds: [] })
  }, [onUpdateFilters])

  const visibleProjects = useMemo(() => projects.filter((p) => !p.isArchived), [projects])

  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  const calendarWeeks = useMemo(
    () => getCalendarWeeks(calendarMonth.year, calendarMonth.month),
    [calendarMonth]
  )

  const selectedCalendarDate = useMemo(() => {
    if (filters.dueDate.type === 'today') {
      return { year: today.getFullYear(), month: today.getMonth(), day: today.getDate() }
    }
    if (filters.dueDate.type === 'tomorrow') {
      const tmrw = new Date(today)
      tmrw.setDate(tmrw.getDate() + 1)
      return { year: tmrw.getFullYear(), month: tmrw.getMonth(), day: tmrw.getDate() }
    }
    if (filters.dueDate.type === 'custom' && filters.dueDate.customStart) {
      const d =
        filters.dueDate.customStart instanceof Date
          ? filters.dueDate.customStart
          : new Date(filters.dueDate.customStart)
      return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() }
    }
    return null
  }, [filters.dueDate, today])

  const dueDatePresets = useMemo(() => {
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const nextMon = getNextMonday()
    const fmt = (d: Date): string =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return [
      { label: 'Today', date: fmt(today), type: 'today' as DueDateFilterType },
      { label: 'Tomorrow', date: fmt(tomorrow), type: 'tomorrow' as DueDateFilterType },
      { label: 'Next week', date: fmt(nextMon), type: 'next-week' as DueDateFilterType }
    ]
  }, [today])

  const categories = useMemo(() => {
    const items: { key: NonNullable<ActivePanel>; label: string; icon: React.ReactNode }[] = [
      {
        key: 'priority',
        label: 'Priority',
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            className="text-muted-foreground"
          >
            <rect x="1.5" y="8" width="2.5" height="4.5" rx="0.5" fill="currentColor" />
            <rect x="5.5" y="5" width="2.5" height="7.5" rx="0.5" fill="currentColor" />
            <rect x="9.5" y="2" width="2.5" height="10.5" rx="0.5" fill="currentColor" />
          </svg>
        )
      },
      {
        key: 'dueDate',
        label: 'Due date',
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            className="text-muted-foreground"
          >
            <rect
              x="2"
              y="2.5"
              width="10"
              height="9.5"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.1"
            />
            <path d="M2 5.5h10" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        )
      },
      {
        key: 'project',
        label: 'Project',
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            className="text-muted-foreground"
          >
            <path
              d="M2 4.5V11a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 12 11V5.5A1.5 1.5 0 0 0 10.5 4H7L5.5 2H3.5A1.5 1.5 0 0 0 2 3.5v1z"
              stroke="currentColor"
              strokeWidth="1.1"
            />
          </svg>
        )
      }
    ]
    if (statuses.length > 0) {
      items.splice(1, 0, {
        key: 'status',
        label: 'Status',
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            className="text-muted-foreground"
          >
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )
      })
    }
    return items
  }, [statuses])

  const filteredCategories = useMemo(() => {
    if (!searchQuery) return categories
    const q = searchQuery.toLowerCase()
    return categories.filter((c) => c.label.toLowerCase().includes(q))
  }, [categories, searchQuery])

  const filteredPriorities = useMemo(() => {
    if (!searchQuery) return PRIORITY_ORDER
    const q = searchQuery.toLowerCase()
    return PRIORITY_ORDER.filter((p) => PRIORITY_LABELS[p].toLowerCase().includes(q))
  }, [searchQuery])

  const prevMonth = useCallback(() => {
    setCalendarMonth((prev) => {
      const d = new Date(prev.year, prev.month - 1, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }, [])

  const nextMonth = useCallback(() => {
    setCalendarMonth((prev) => {
      const d = new Date(prev.year, prev.month + 1, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }, [])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className="w-[220px] p-0 rounded-lg overflow-clip bg-popover border-border shadow-[var(--shadow-card-hover)] max-h-[calc(100vh-120px)] overflow-y-auto"
        align="end"
        sideOffset={8}
      >
        <div
          className={`flex flex-col text-[12px] leading-4 [font-synthesis:none] antialiased ${FONT}`}
        >
          {/* ── MAIN MENU ── */}
          {activePanel === null && (
            <>
              <div className="flex items-center py-2 px-3 gap-2 border-b border-border">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 13 13"
                  fill="none"
                  className="shrink-0 text-text-tertiary"
                >
                  <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.1" />
                  <path
                    d="M8.5 8.5l2.5 2.5"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                  />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter by..."
                  className={`flex-1 min-w-0 bg-transparent text-[12px] ${FONT} text-foreground placeholder:text-text-tertiary outline-none leading-4`}
                />
              </div>
              <div className="flex flex-col p-1">
                {filteredCategories.map((cat) => (
                  <button
                    key={cat.key}
                    type="button"
                    onClick={() => navigateTo(cat.key)}
                    className="flex items-center rounded-[5px] py-1.5 px-2 gap-2 hover:bg-accent transition-colors"
                  >
                    {cat.icon}
                    <span className="text-[12px] text-text-secondary leading-4">{cat.label}</span>
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      className="ml-auto text-text-tertiary"
                    >
                      <path
                        d="M3.5 5l3 0"
                        stroke="currentColor"
                        strokeWidth="1.1"
                        strokeLinecap="round"
                      />
                      <path
                        d="M5.5 3L7.5 5 5.5 7"
                        stroke="currentColor"
                        strokeWidth="1.1"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* ── PRIORITY PANEL ── */}
          {activePanel === 'priority' && (
            <>
              <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
                <BackButton onClick={goBack} />
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
              <div className="flex items-center py-1.5 px-3 gap-2 border-b border-border">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  className="shrink-0 text-text-tertiary"
                >
                  <circle cx="5" cy="5" r="3.5" stroke="currentColor" />
                  <path d="M7.5 7.5l2.5 2.5" stroke="currentColor" strokeLinecap="round" />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search..."
                  className={`flex-1 min-w-0 bg-transparent text-[12px] ${FONT} text-foreground placeholder:text-text-tertiary outline-none leading-4`}
                />
              </div>
              <div className="flex flex-col p-1">
                {filteredPriorities.map((p) => {
                  const checked = filters.priorities.includes(p)
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => togglePriority(p)}
                      className={cn(
                        'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                        checked ? 'bg-accent' : 'hover:bg-accent'
                      )}
                    >
                      <span className={cn(p === 'none' && 'text-text-tertiary')}>
                        {PRIORITY_ICONS[p]}
                      </span>
                      <span
                        className={cn(
                          'text-[12px] leading-4',
                          checked ? 'text-foreground' : 'text-text-secondary',
                          p === 'none' && !checked && 'text-text-tertiary'
                        )}
                      >
                        {PRIORITY_LABELS[p]}
                      </span>
                      {checked && <CheckMark />}
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center justify-between py-2 px-3 border-t border-border">
                <span className="text-[11px] text-text-tertiary leading-3.5">
                  {filters.priorities.length} selected
                </span>
                <button
                  type="button"
                  onClick={() => handleOpenChange(false)}
                  className="flex items-center rounded-sm py-[3px] px-2.5 bg-foreground hover:bg-foreground/80 transition-colors"
                >
                  <span className="text-[11px] text-background font-medium leading-3.5">Apply</span>
                </button>
              </div>
            </>
          )}

          {/* ── STATUS PANEL ── */}
          {activePanel === 'status' && (
            <>
              <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
                <BackButton onClick={goBack} />
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
                  const selected = filters.statusIds.includes(status.id)
                  return (
                    <button
                      key={status.id}
                      type="button"
                      onClick={() => toggleStatus(status.id)}
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
                      {selected && <CheckMark />}
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {/* ── DUE DATE PANEL ── */}
          {activePanel === 'dueDate' && (
            <>
              <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
                <BackButton onClick={goBack} />
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  className="text-muted-foreground"
                >
                  <rect
                    x="2"
                    y="2.5"
                    width="10"
                    height="9.5"
                    rx="1.5"
                    stroke="currentColor"
                    strokeWidth="1.1"
                  />
                  <path d="M2 5.5h10" stroke="currentColor" strokeWidth="1.1" />
                </svg>
                <span className="text-[12px] text-foreground font-medium leading-4">Due date</span>
              </div>
              <div className="flex flex-col p-1 border-b border-border">
                {dueDatePresets.map((preset) => {
                  const active = filters.dueDate.type === preset.type
                  return (
                    <button
                      key={preset.type}
                      type="button"
                      onClick={() => selectDueDate(preset.type)}
                      className={cn(
                        'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                        active ? 'bg-accent' : 'hover:bg-accent'
                      )}
                    >
                      <span
                        className={cn(
                          'text-[12px] leading-4',
                          active ? 'text-foreground' : 'text-text-secondary'
                        )}
                      >
                        {preset.label}
                      </span>
                      <span className="text-[11px] ml-auto text-text-tertiary leading-3.5">
                        {preset.date}
                      </span>
                    </button>
                  )
                })}
                <button
                  type="button"
                  onClick={clearDueDate}
                  className="flex items-center rounded-[5px] py-1.5 px-2 gap-2 hover:bg-accent transition-colors"
                >
                  <span className="text-[12px] text-destructive leading-4">Remove date</span>
                </button>
              </div>
              <div className="flex flex-col pt-2 pb-3 gap-1.5 px-3">
                <div className="flex items-center justify-between py-0.5">
                  <button
                    type="button"
                    onClick={prevMonth}
                    className="p-0.5 hover:bg-accent rounded transition-colors text-text-tertiary"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M8.5 3.5L5 7l3.5 3.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <span className="text-[12px] text-foreground font-medium leading-4">
                    {MONTH_NAMES[calendarMonth.month]} {calendarMonth.year}
                  </span>
                  <button
                    type="button"
                    onClick={nextMonth}
                    className="p-0.5 hover:bg-accent rounded transition-colors text-text-tertiary"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M5.5 3.5L9 7l-3.5 3.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
                <div className="flex items-center">
                  {DAY_HEADERS.map((dh) => (
                    <div
                      key={dh}
                      className="text-[10px] w-7 text-center text-text-tertiary font-medium leading-3 shrink-0"
                    >
                      {dh}
                    </div>
                  ))}
                </div>
                {calendarWeeks.map((week, wi) => (
                  <div key={wi} className="flex items-center">
                    {week.map((cell, di) => {
                      if (!cell.isCurrentMonth) {
                        return (
                          <div
                            key={di}
                            className="w-7 h-[26px] flex items-center justify-center shrink-0 text-[11px] text-border leading-3.5"
                          >
                            {cell.day}
                          </div>
                        )
                      }
                      const date = new Date(calendarMonth.year, calendarMonth.month, cell.day)
                      const isToday = date.getTime() === today.getTime()
                      const isPast = date < today
                      const isSelected =
                        selectedCalendarDate !== null &&
                        selectedCalendarDate.year === calendarMonth.year &&
                        selectedCalendarDate.month === calendarMonth.month &&
                        selectedCalendarDate.day === cell.day

                      return (
                        <button
                          key={di}
                          type="button"
                          onClick={() => selectCalendarDate(cell.day)}
                          className={cn(
                            'w-7 h-[26px] flex items-center justify-center shrink-0 rounded-[5px] transition-colors',
                            isSelected && 'bg-foreground',
                            isToday && !isSelected && 'border border-ring',
                            !isSelected && !isToday && 'hover:bg-accent'
                          )}
                        >
                          <span
                            className={cn(
                              'text-[11px] leading-3.5',
                              isSelected && 'text-background font-semibold',
                              isToday && !isSelected && 'text-foreground font-medium',
                              !isSelected && !isToday && isPast && 'text-text-tertiary',
                              !isSelected && !isToday && !isPast && 'text-muted-foreground'
                            )}
                          >
                            {cell.day}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── PROJECT PANEL ── */}
          {activePanel === 'project' && (
            <>
              <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
                <BackButton onClick={goBack} />
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  className="text-muted-foreground"
                >
                  <path
                    d="M2 4.5V11a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 12 11V5.5A1.5 1.5 0 0 0 10.5 4H7L5.5 2H3.5A1.5 1.5 0 0 0 2 3.5v1z"
                    stroke="currentColor"
                    strokeWidth="1.1"
                  />
                </svg>
                <span className="text-[12px] text-foreground font-medium leading-4">Project</span>
              </div>
              <div className="flex flex-col p-1">
                <button
                  type="button"
                  onClick={clearProjectFilter}
                  className={cn(
                    'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                    filters.projectIds.length === 0 ? 'bg-accent' : 'hover:bg-accent'
                  )}
                >
                  <div className="shrink-0 rounded-[3px] border-[1.2px] border-solid border-border size-2.5" />
                  <span className="text-[12px] text-text-tertiary leading-4">No project</span>
                  {filters.projectIds.length === 0 && <CheckMark />}
                </button>
                {visibleProjects.map((project) => {
                  const selected = filters.projectIds.includes(project.id)
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => toggleProject(project.id)}
                      className={cn(
                        'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                        selected ? 'bg-accent' : 'hover:bg-accent'
                      )}
                    >
                      <div
                        className="shrink-0 rounded-[3px] size-2.5"
                        style={{ backgroundColor: project.color }}
                      />
                      <span
                        className={cn(
                          'text-[12px] leading-4',
                          selected ? 'text-foreground' : 'text-text-secondary'
                        )}
                      >
                        {project.name}
                      </span>
                      {selected && <CheckMark />}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
