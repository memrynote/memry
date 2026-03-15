import { useState, useMemo, useCallback } from 'react'
import {
  Activity,
  Calendar,
  MoreHorizontal,
  Star,
  ChevronDown,
  ChevronRight,
  Clock,
  RefreshCw
} from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type {
  TaskFilters,
  SavedFilter,
  Project,
  Status,
  DueDateFilterType,
  RepeatFilterType,
  HasTimeFilterType
} from '@/data/tasks-data'
import type { Priority, Task } from '@/data/sample-tasks'
import { hasActiveFilters, startOfDay } from '@/lib/task-utils'

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

type ExpandedSection = 'priority' | 'dueDate' | 'more' | 'saved' | null

const PRIORITIES: { key: Priority; label: string; dot: string }[] = [
  { key: 'urgent', label: 'Urgent', dot: '#E54D2E' },
  { key: 'high', label: 'High', dot: '#F59E0B' },
  { key: 'medium', label: 'Medium', dot: '#22C55E' },
  { key: 'low', label: 'Low', dot: '#3B82F6' },
  { key: 'none', label: 'None', dot: '#D4D1CA' }
]

const DUE_DATE_PRESETS: { value: DueDateFilterType; label: string; isOverdue?: boolean }[] = [
  { value: 'overdue', label: 'Overdue', isOverdue: true },
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'this-week', label: 'This Week' },
  { value: 'next-week', label: 'Next Week' },
  { value: 'none', label: 'No due date' }
]

const FONT = "font-['DM_Sans_Variable',system-ui,sans-serif]"

const FilterCheckbox = ({ checked, color }: { checked: boolean; color: string }) => (
  <div
    className="flex items-center justify-center rounded-sm shrink-0 size-4"
    style={{
      borderWidth: '1.5px',
      borderStyle: 'solid',
      borderColor: checked ? color : '#D4D1CA',
      backgroundColor: checked ? `${color}15` : '#FFFFFF'
    }}
  >
    {checked && (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )}
  </div>
)

const ToggleSwitch = ({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation()
      onToggle()
    }}
    className={cn(
      'w-8 h-[18px] ml-auto flex items-center rounded-[9px] shrink-0 p-0.5 transition-colors',
      enabled ? 'bg-[#1A1A1A] justify-end' : 'bg-[#D4D1CA]'
    )}
    role="switch"
    aria-checked={enabled}
  >
    <div className="rounded-full bg-white shrink-0 size-3.5" />
  </button>
)

const SectionHeader = ({
  icon: Icon,
  title,
  expanded,
  badge,
  onClick,
  isFirst
}: {
  icon: React.ComponentType<{ width?: number; height?: number; className?: string }>
  title: string
  expanded: boolean
  badge?: number
  onClick: () => void
  isFirst?: boolean
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'flex items-center w-full py-2.5 px-4 gap-1.5 bg-[#F5F3EF] transition-colors hover:bg-[#EFECE6]',
      !isFirst && 'border-t border-[#E8E5E0]',
      expanded && 'border-b border-[#E8E5E0]'
    )}
  >
    <Icon width={14} height={14} className="text-[#1A1A1A] shrink-0" />
    <span className={`text-[13px] text-[#1A1A1A] ${FONT} font-semibold leading-4`}>{title}</span>
    {badge != null && badge > 0 && !expanded && (
      <span className="ml-1 text-[10px] font-semibold bg-[#1A1A1A] text-white px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
        {badge}
      </span>
    )}
    <ChevronDown
      width={10}
      height={10}
      className={cn(
        'text-[#8A8A8A] ml-auto transition-transform duration-200',
        !expanded && '-rotate-90'
      )}
      strokeWidth={2.5}
    />
  </button>
)

const describeSavedFilter = (filter: SavedFilter, projects: Project[]): string => {
  const parts: string[] = []
  if (filter.filters.priorities.length > 0) {
    parts.push(filter.filters.priorities.map((p) => p[0].toUpperCase() + p.slice(1)).join(', '))
  }
  if (filter.filters.dueDate.type !== 'any') {
    const labels: Record<string, string> = {
      overdue: 'Overdue',
      today: 'Today',
      tomorrow: 'Tomorrow',
      'this-week': 'This Week',
      'next-week': 'Next Week',
      none: 'No due date',
      custom: 'Custom range'
    }
    parts.push(labels[filter.filters.dueDate.type] || filter.filters.dueDate.type)
  }
  if (filter.filters.projectIds.length > 0) {
    const names = filter.filters.projectIds
      .map((id) => projects.find((p) => p.id === id)?.name)
      .filter(Boolean)
    if (names.length > 0) parts.push(`Project: ${names.join(', ')}`)
  }
  return parts.join(' + ') || 'All tasks'
}

export const FilterDropdown = ({
  open,
  onOpenChange,
  filters,
  onUpdateFilters,
  onClearFilters,
  tasks,
  projects,
  savedFilters,
  onDeleteSavedFilter: _onDeleteSavedFilter,
  onApplySavedFilter,
  onSaveFilter,
  showStatusFilter = false,
  statuses = [],
  children
}: FilterDropdownProps): React.JSX.Element => {
  const [expanded, setExpanded] = useState<ExpandedSection>(null)
  const [showStatusPanel, setShowStatusPanel] = useState(false)
  const [saveFilterName, setSaveFilterName] = useState('')

  const taskCountByPriority = useMemo(() => {
    const counts: Record<Priority, number> = { urgent: 0, high: 0, medium: 0, low: 0, none: 0 }
    tasks.forEach((t) => counts[t.priority]++)
    return counts
  }, [tasks])

  const dueDateCounts = useMemo(() => {
    const now = startOfDay(new Date())
    const tmrw = new Date(now)
    tmrw.setDate(tmrw.getDate() + 1)
    const endWeek = new Date(now)
    endWeek.setDate(endWeek.getDate() + (7 - endWeek.getDay()))
    const endNextWeek = new Date(endWeek)
    endNextWeek.setDate(endNextWeek.getDate() + 7)

    const c: Record<string, number> = {
      overdue: 0,
      today: 0,
      tomorrow: 0,
      'this-week': 0,
      'next-week': 0,
      none: 0
    }
    tasks.forEach((t) => {
      if (!t.dueDate) {
        c['none']++
        return
      }
      const d = startOfDay(t.dueDate instanceof Date ? t.dueDate : new Date(t.dueDate))
      if (d < now) c['overdue']++
      else if (d.getTime() === now.getTime()) c['today']++
      else if (d.getTime() === tmrw.getTime()) c['tomorrow']++
      else if (d <= endWeek) c['this-week']++
      else if (d <= endNextWeek) c['next-week']++
    })
    return c
  }, [tasks])

  const taskCountByStatus = useMemo(() => {
    const counts: Record<string, number> = {}
    tasks.forEach((t) => {
      counts[t.statusId] = (counts[t.statusId] || 0) + 1
    })
    return counts
  }, [tasks])

  const moreActiveCount = useMemo(() => {
    let n = 0
    if (filters.statusIds.length > 0) n++
    if (filters.repeatType !== 'all') n++
    if (filters.hasTime !== 'all') n++
    return n
  }, [filters.statusIds, filters.repeatType, filters.hasTime])

  const isActive = hasActiveFilters(filters)

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setExpanded(null)
        setShowStatusPanel(false)
        setSaveFilterName('')
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

  const toggleSection = useCallback((section: ExpandedSection) => {
    setExpanded((prev) => {
      const next = prev === section ? null : section
      if (next !== 'more') setShowStatusPanel(false)
      return next
    })
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

  const toggleDueDate = useCallback(
    (value: DueDateFilterType) => {
      onUpdateFilters({
        dueDate: {
          type: filters.dueDate.type === value ? 'any' : value,
          customStart: null,
          customEnd: null
        }
      })
    },
    [filters.dueDate.type, onUpdateFilters]
  )

  const handleToggleStatus = useCallback(
    (statusId: string) => {
      const next = filters.statusIds.includes(statusId)
        ? filters.statusIds.filter((id) => id !== statusId)
        : [...filters.statusIds, statusId]
      onUpdateFilters({ statusIds: next })
    },
    [filters.statusIds, onUpdateFilters]
  )

  const handleApplySaved = useCallback(
    (filter: SavedFilter) => {
      onApplySavedFilter(filter)
      handleOpenChange(false)
    },
    [onApplySavedFilter, handleOpenChange]
  )

  const handleSaveCurrentFilter = useCallback(() => {
    const name = saveFilterName.trim()
    if (!name) return
    onSaveFilter(name)
    setSaveFilterName('')
  }, [saveFilterName, onSaveFilter])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className="w-[280px] p-0 rounded-xl overflow-clip shadow-[0_4px_24px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.04)] max-h-[calc(100vh-120px)] overflow-y-auto"
        align="end"
        sideOffset={8}
      >
        <div className="flex flex-col [font-synthesis:none] antialiased">
          {/* Priority */}
          <SectionHeader
            icon={Activity}
            title="Priority"
            expanded={expanded === 'priority'}
            badge={filters.priorities.length}
            onClick={() => toggleSection('priority')}
            isFirst
          />
          {expanded === 'priority' && (
            <div className="flex flex-col py-2">
              {PRIORITIES.map((p) => {
                const checked = filters.priorities.includes(p.key)
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => togglePriority(p.key)}
                    className={cn(
                      'flex items-center py-2 px-4 gap-2.5 transition-colors hover:bg-[#F9F8F6]',
                      checked && 'bg-[#F9F8F6]'
                    )}
                  >
                    <FilterCheckbox checked={checked} color={p.dot} />
                    <div
                      className="shrink-0 rounded-full size-2"
                      style={{ backgroundColor: p.dot }}
                    />
                    <span
                      className={cn(
                        `text-[13px] ${FONT} leading-4`,
                        p.key === 'none' ? 'text-[#6A6A6A]' : 'text-[#1A1A1A] font-medium'
                      )}
                    >
                      {p.label}
                    </span>
                    <span className={`text-[11px] ml-auto text-[#8A8A8A] ${FONT} leading-[14px]`}>
                      {taskCountByPriority[p.key]}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Due Date */}
          <SectionHeader
            icon={Calendar}
            title="Due Date"
            expanded={expanded === 'dueDate'}
            badge={filters.dueDate.type !== 'any' ? 1 : 0}
            onClick={() => toggleSection('dueDate')}
          />
          {expanded === 'dueDate' && (
            <div className="flex flex-col py-2">
              {DUE_DATE_PRESETS.map((preset) => {
                const checked = filters.dueDate.type === preset.value
                const isOd = preset.isOverdue
                return (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => toggleDueDate(preset.value)}
                    className={cn(
                      'flex items-center py-2 px-4 gap-2.5 transition-colors hover:bg-[#F9F8F6]',
                      checked && isOd && 'bg-[#FEF0EE]',
                      checked && !isOd && 'bg-[#F9F8F6]'
                    )}
                  >
                    <FilterCheckbox checked={checked} color={isOd ? '#E54D2E' : '#D4D1CA'} />
                    <span
                      className={cn(
                        `text-[13px] ${FONT} leading-4`,
                        checked && isOd
                          ? 'text-[#E54D2E] font-medium'
                          : preset.value === 'none'
                            ? 'text-[#6A6A6A]'
                            : 'text-[#1A1A1A]'
                      )}
                    >
                      {preset.label}
                    </span>
                    <span
                      className={cn(
                        `text-[11px] ml-auto ${FONT} leading-[14px]`,
                        checked && isOd ? 'text-[#C4392B]' : 'text-[#8A8A8A]'
                      )}
                    >
                      {dueDateCounts[preset.value] ?? ''}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* More */}
          <SectionHeader
            icon={MoreHorizontal}
            title="More"
            expanded={expanded === 'more'}
            badge={moreActiveCount}
            onClick={() => toggleSection('more')}
          />
          {expanded === 'more' && !showStatusPanel && (
            <div className="flex flex-col py-2">
              {showStatusFilter && statuses.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowStatusPanel(true)}
                  className="flex items-center py-[9px] px-4 gap-2.5 hover:bg-[#F9F8F6] transition-colors"
                >
                  <Clock width={14} height={14} className="text-[#8A8A8A]" />
                  <span className={`text-[13px] text-[#1A1A1A] ${FONT} leading-4`}>Status</span>
                  {filters.statusIds.length > 0 && (
                    <span className={`text-[11px] text-[#8A8A8A] ${FONT}`}>
                      ({filters.statusIds.length})
                    </span>
                  )}
                  <ChevronRight width={10} height={10} className="text-[#C4C0B8] ml-auto" />
                </button>
              )}
              <button
                type="button"
                className="flex items-center py-[9px] px-4 gap-2.5 hover:bg-[#F9F8F6] transition-colors"
              >
                <Calendar width={14} height={14} className="text-[#8A8A8A]" />
                <span className={`text-[13px] text-[#1A1A1A] ${FONT} leading-4`}>Has time set</span>
                <ToggleSwitch
                  enabled={filters.hasTime === 'with-time'}
                  onToggle={() =>
                    onUpdateFilters({
                      hasTime:
                        filters.hasTime === 'with-time'
                          ? ('all' as HasTimeFilterType)
                          : ('with-time' as HasTimeFilterType)
                    })
                  }
                />
              </button>
              <div className="h-px bg-[#F0EDE8] shrink-0 my-1 mx-4" />
              <button
                type="button"
                className="flex items-center py-[9px] px-4 gap-2.5 hover:bg-[#F9F8F6] transition-colors"
              >
                <RefreshCw width={14} height={14} className="text-[#8A8A8A]" />
                <span className={`text-[13px] text-[#1A1A1A] ${FONT} leading-4`}>
                  Recurring only
                </span>
                <ToggleSwitch
                  enabled={filters.repeatType === 'repeating'}
                  onToggle={() =>
                    onUpdateFilters({
                      repeatType:
                        filters.repeatType === 'repeating'
                          ? ('all' as RepeatFilterType)
                          : ('repeating' as RepeatFilterType)
                    })
                  }
                />
              </button>
            </div>
          )}
          {expanded === 'more' && showStatusPanel && (
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => setShowStatusPanel(false)}
                className="flex items-center py-2.5 px-4 gap-1.5 bg-[#F5F3EF] border-b border-[#E8E5E0]"
              >
                <ChevronDown width={10} height={10} className="text-[#8A8A8A] rotate-90" />
                <span className={`text-[13px] text-[#1A1A1A] ${FONT} font-semibold leading-4`}>
                  Status
                </span>
              </button>
              <div className="flex flex-col py-2">
                {statuses.map((status) => {
                  const selected = filters.statusIds.includes(status.id)
                  return (
                    <button
                      key={status.id}
                      type="button"
                      onClick={() => handleToggleStatus(status.id)}
                      className="flex items-center gap-2.5 py-2 px-4 hover:bg-[#F9F8F6] transition-colors"
                    >
                      <FilterCheckbox checked={selected} color={status.color} />
                      <div
                        className="shrink-0 rounded-full size-2"
                        style={{ backgroundColor: status.color }}
                      />
                      <span className={`text-[13px] text-[#1A1A1A] ${FONT} leading-4`}>
                        {status.name}
                      </span>
                      <span className={`text-[11px] ml-auto text-[#8A8A8A] ${FONT} leading-[14px]`}>
                        {taskCountByStatus[status.id] || 0}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Saved */}
          <SectionHeader
            icon={Star}
            title="Saved"
            expanded={expanded === 'saved'}
            badge={savedFilters.length}
            onClick={() => toggleSection('saved')}
          />
          {expanded === 'saved' && (
            <div className="flex flex-col">
              <div className="flex flex-col py-2">
                {savedFilters.length === 0 && !isActive && (
                  <div className={`py-3 px-4 text-[13px] text-[#8A8A8A] ${FONT} leading-4`}>
                    No saved filters yet
                  </div>
                )}
                {savedFilters.map((sf) => (
                  <button
                    key={sf.id}
                    type="button"
                    onClick={() => handleApplySaved(sf)}
                    className="flex items-center py-[9px] px-4 gap-2.5 hover:bg-[#F5F3EF] transition-colors"
                  >
                    <Star width={14} height={14} className="text-[#C4C0B8] shrink-0" fill="none" />
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className={`text-[13px] text-[#1A1A1A] ${FONT} leading-4 truncate`}>
                        {sf.name}
                      </span>
                      <span
                        className={`text-[11px] text-[#8A8A8A] ${FONT} leading-[14px] truncate`}
                      >
                        {describeSavedFilter(sf, projects)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              {isActive && (
                <>
                  <div className="h-px bg-[#E8E5E0] shrink-0" />
                  <div className="flex items-center gap-2 py-2.5 px-3">
                    <input
                      type="text"
                      value={saveFilterName}
                      onChange={(e) => setSaveFilterName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveCurrentFilter()
                      }}
                      placeholder="Save current filters"
                      className={`flex-1 min-w-0 text-[13px] ${FONT} leading-4 py-1.5 px-2.5 rounded-md border border-[#E8E5E0] bg-white text-[#1A1A1A] placeholder:text-[#AAAAAA] outline-none focus:border-[#1A1A1A] transition-colors`}
                    />
                    <button
                      type="button"
                      onClick={handleSaveCurrentFilter}
                      disabled={!saveFilterName.trim()}
                      className={cn(
                        'shrink-0 rounded-md py-[5px] px-3 text-[12px] font-semibold leading-4 transition-colors',
                        FONT,
                        saveFilterName.trim()
                          ? 'bg-[#1A1A1A] text-white hover:bg-[#333]'
                          : 'bg-[#E8E5E0] text-[#AAAAAA] cursor-not-allowed'
                      )}
                    >
                      Save
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Clear all footer */}
          {isActive && (
            <button
              type="button"
              onClick={() => {
                onClearFilters()
                handleOpenChange(false)
              }}
              className={cn(
                'flex items-center justify-center w-full py-2.5 px-4 border-t border-[#E8E5E0]',
                `text-[12px] text-[#E54D2E] ${FONT} font-medium leading-4`,
                'hover:bg-[#FEF0EE] transition-colors'
              )}
            >
              Clear all filters
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
