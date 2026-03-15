import * as React from 'react'
import { Repeat } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  formatDueDate,
  getDaysOverdue,
  getOverdueTier,
  overdueTierStyles,
  type DueDateStatus
} from '@/lib/task-utils'
import { priorityConfig, type Priority } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePickerCalendar } from './date-picker-calendar'

// ============================================================================
// PROJECT BADGE
// ============================================================================

interface ProjectBadgeProps {
  project: Project
  /** Use fixed width for grid alignment */
  fixedWidth?: boolean
  className?: string
}

export const ProjectBadge = ({
  project,
  fixedWidth = false,
  className
}: ProjectBadgeProps): React.JSX.Element => {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs',
        'bg-muted text-text-secondary',
        fixedWidth && 'w-[120px] justify-start',
        className
      )}
    >
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: project.color }}
        aria-hidden="true"
      />
      <span className="truncate">{project.name}</span>
    </span>
  )
}

// ============================================================================
// PRIORITY BADGE
// ============================================================================

export type PriorityBadgeVariant = 'dot' | 'label' | 'full'

/** Short labels for compact display in grid columns */
const priorityShortLabels: Record<Priority, string | null> = {
  none: null,
  low: 'Low',
  medium: 'Med',
  high: 'High',
  urgent: 'Urgent'
}

interface PriorityBadgeProps {
  priority: Priority
  variant?: PriorityBadgeVariant
  size?: 'sm' | 'md'
  showTooltip?: boolean
  /** Use compact short labels (Med instead of Medium) */
  compact?: boolean
  /** Use fixed width for grid alignment */
  fixedWidth?: boolean
  className?: string
}

export const PriorityBadge = ({
  priority,
  variant = 'full',
  size = 'md',
  showTooltip = false,
  compact = false,
  fixedWidth = false,
  className
}: PriorityBadgeProps): React.JSX.Element | null => {
  const config = priorityConfig[priority]

  // Don't render anything for "none" priority
  if (priority === 'none' || !config.color) {
    // Return empty placeholder if fixedWidth to maintain grid alignment
    if (fixedWidth) {
      return <span className="w-[70px]" aria-hidden="true" />
    }
    return null
  }

  const displayLabel = compact ? priorityShortLabels[priority] : config.label

  const content = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5',
        size === 'sm' && 'text-xs',
        size === 'md' && 'text-xs',
        fixedWidth && 'w-[70px] justify-start',
        className
      )}
      aria-label={`${config.label} priority`}
    >
      {/* Priority dot */}
      {(variant === 'dot' || variant === 'full') && (
        <span
          className={cn(
            'shrink-0 rounded-full',
            size === 'sm' && 'size-1.5',
            size === 'md' && 'size-2'
          )}
          style={{ backgroundColor: config.color }}
          aria-hidden="true"
        />
      )}

      {/* Priority label */}
      {(variant === 'label' || variant === 'full') && (
        <span
          className={cn('font-medium', size === 'sm' && 'text-[10px]', size === 'md' && 'text-xs')}
          style={{ color: config.color }}
        >
          {displayLabel}
        </span>
      )}
    </span>
  )

  // Wrap with tooltip if needed (only useful for dot variant or compact mode)
  if (showTooltip && (variant === 'dot' || compact)) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {config.label} priority
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return content
}

// ============================================================================
// DUE DATE BADGE
// ============================================================================

interface DueDateBadgeProps {
  dueDate: Date | null
  dueTime: string | null
  isRepeating?: boolean
  variant?: 'default' | 'compact'
  /** Use fixed width for grid alignment */
  fixedWidth?: boolean
  className?: string
}

const dueDateStatusStyles: Record<DueDateStatus, string> = {
  overdue: 'text-red-600 dark:text-red-400',
  today: 'text-amber-600 dark:text-amber-500',
  tomorrow: 'text-blue-600 dark:text-blue-400',
  upcoming: 'text-foreground',
  later: 'text-muted-foreground',
  none: 'text-muted-foreground'
}

const dueDateBackgroundStyles: Record<DueDateStatus, string> = {
  overdue: 'bg-red-50 dark:bg-red-950/50',
  today: 'bg-amber-50 dark:bg-amber-950/50',
  tomorrow: '',
  upcoming: '',
  later: '',
  none: ''
}

export const DueDateBadge = ({
  dueDate,
  dueTime,
  isRepeating = false,
  variant = 'default',
  fixedWidth = false,
  className
}: DueDateBadgeProps): React.JSX.Element => {
  const formatted = formatDueDate(dueDate, dueTime)

  if (!formatted) {
    return (
      <span
        className={cn(
          'text-xs text-muted-foreground',
          fixedWidth && 'w-[110px] text-right',
          className
        )}
      >
        —
      </span>
    )
  }

  const isOverdue = formatted.status === 'overdue'
  const isToday = formatted.status === 'today'
  const showBackground = isOverdue || isToday

  const daysOver = isOverdue ? getDaysOverdue(dueDate) : 0
  const tier = isOverdue ? getOverdueTier(daysOver) : null
  const tierStyle = tier ? overdueTierStyles[tier] : null

  const badgeContent = (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        dueDateStatusStyles[formatted.status],
        showBackground &&
          variant === 'default' &&
          cn('rounded-sm px-1.5 py-0.5', dueDateBackgroundStyles[formatted.status])
      )}
    >
      {isRepeating && <Repeat className="size-3 shrink-0" aria-label="Repeating task" />}
      <span className="truncate">{formatted.label}</span>
      {isOverdue && variant === 'default' && tierStyle && (
        <span
          className={cn(
            'text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0',
            tierStyle.chipBg
          )}
        >
          {daysOver}d
        </span>
      )}
    </span>
  )

  // If fixedWidth, wrap in a container for grid alignment
  if (fixedWidth) {
    return <span className={cn('w-[110px] flex justify-end', className)}>{badgeContent}</span>
  }

  return <span className={className}>{badgeContent}</span>
}

// ============================================================================
// TASK CHECKBOX
// ============================================================================

interface TaskCheckboxProps {
  checked: boolean
  onChange: () => void
  disabled?: boolean
  priority?: Priority
  size?: 'sm' | 'md'
  className?: string
}

export const TaskCheckbox = ({
  checked,
  onChange,
  disabled = false,
  priority: _priority,
  size = 'md',
  className
}: TaskCheckboxProps): React.JSX.Element => {
  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!disabled) {
      onChange()
    }
  }

  const isSm = size === 'sm'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={cn(
        'shrink-0 rounded-full transition-all duration-200',
        isSm ? 'size-3.5' : 'size-4',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className
      )}
      aria-label={checked ? 'Mark as incomplete' : 'Mark as complete'}
    >
      {checked ? (
        <div className="size-full rounded-full bg-[#7B9E87] flex items-center justify-center">
          {isSm ? (
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
              <path
                d="M1.5 4L3.2 5.8L6.5 2.2"
                stroke="#FFFFFF"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M2 5l2.5 2.5L8 3"
                stroke="#FAFAF8"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      ) : (
        <div
          className={cn(
            'size-full rounded-full border-[1.5px] transition-colors',
            isSm ? 'border-[#D1D0CB]' : 'border-[#DAD9D4]',
            'hover:border-text-tertiary'
          )}
        />
      )}
    </button>
  )
}

// ============================================================================
// STATUS BADGE
// ============================================================================

interface StatusBadgeProps {
  label: string
  color: string
  type?: 'todo' | 'in_progress' | 'done'
  className?: string
}

export const StatusBadge = ({
  label,
  color,
  type,
  className
}: StatusBadgeProps): React.JSX.Element => {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        type === 'done' && 'opacity-70',
        className
      )}
      style={{
        backgroundColor: `${color}20`,
        color: color
      }}
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <span>{label}</span>
    </span>
  )
}

// ============================================================================
// INTERACTIVE PROJECT BADGE (with dropdown popover)
// ============================================================================

interface InteractiveProjectBadgeProps {
  project: Project
  projects: Project[]
  onProjectChange: (projectId: string) => void
  /** Use fixed width for grid alignment */
  fixedWidth?: boolean
  className?: string
}

export const InteractiveProjectBadge = ({
  project,
  projects,
  onProjectChange,
  fixedWidth = false,
  className
}: InteractiveProjectBadgeProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = React.useState(false)
  const [projectSearch, setProjectSearch] = React.useState('')

  const activeProjects = projects.filter((p) => !p.isArchived)
  const filteredProjects = projectSearch
    ? activeProjects.filter((p) => p.name.toLowerCase().includes(projectSearch.toLowerCase()))
    : activeProjects

  // Safety check - if projects not provided, render static badge
  if (!projects || projects.length === 0) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs',
          'bg-muted text-text-secondary',
          fixedWidth && 'w-[120px] justify-start',
          className
        )}
      >
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: project.color }}
          aria-hidden="true"
        />
        <span className="truncate">{project.name}</span>
      </span>
    )
  }

  const handleSelect = (projectId: string): void => {
    onProjectChange(projectId)
    setIsOpen(false)
    setProjectSearch('')
  }

  const handleTriggerClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild onClick={handleTriggerClick}>
        <button
          type="button"
          className={cn(
            'flex items-center rounded-sm py-0.5 px-2 gap-1 cursor-pointer transition-opacity',
            'hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            fixedWidth && 'w-[120px] justify-start',
            className
          )}
          style={{ backgroundColor: `${project.color}0F` }}
          aria-label={`Project: ${project.name}. Click to change.`}
        >
          <div
            className="w-[5px] h-[5px] rounded-full shrink-0"
            style={{ backgroundColor: project.color }}
          />
          <div
            className="text-[11px] font-['DM_Sans',system-ui,sans-serif] font-medium leading-3.5 truncate"
            style={{ color: project.color }}
          >
            {project.name}
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[200px] p-0 rounded-[10px] bg-popover border-border shadow-lg"
        align="start"
        sideOffset={4}
        onClick={handleTriggerClick}
      >
        <div className="flex flex-col p-1 [font-synthesis:none] antialiased">
          <div className="flex items-center mb-1 py-2 px-3 gap-1.5 border-b border-border">
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              className="text-text-tertiary"
            >
              <circle cx="5.5" cy="5.5" r="3.5" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M8.5 8.5L11 11"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
            <input
              type="text"
              value={projectSearch}
              onChange={(e) => setProjectSearch(e.target.value)}
              placeholder="Search projects..."
              className="flex-1 text-[12px] bg-transparent border-none outline-none placeholder:text-text-tertiary text-text-secondary leading-4"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          {filteredProjects.map((p) => {
            const isSelected = p.id === project.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelect(p.id)}
                className={cn(
                  'flex items-center rounded-[7px] py-2 px-3 gap-2 transition-colors',
                  'hover:bg-accent focus:outline-none'
                )}
                style={isSelected ? { backgroundColor: `${p.color}0F` } : undefined}
              >
                <div
                  className="rounded-xs shrink-0 size-1.5"
                  style={{ backgroundColor: p.color }}
                />
                <div
                  className={cn(
                    'text-[13px] leading-4',
                    isSelected ? 'font-medium' : 'text-text-secondary'
                  )}
                  style={isSelected ? { color: p.color } : undefined}
                >
                  {p.name}
                </div>
                {isSelected && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    style={{ marginLeft: 'auto' }}
                  >
                    <path
                      d="M3 6l2 2 4-4"
                      stroke={p.color}
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// INTERACTIVE PRIORITY BADGE (popover dropdown)
// ============================================================================

const PRIORITY_OPTIONS: { value: Priority; label: string; color: string; shortcut: string }[] = [
  { value: 'urgent', label: 'Urgent', color: '#EF4444', shortcut: '1' },
  { value: 'high', label: 'High', color: '#F97316', shortcut: '2' },
  { value: 'medium', label: 'Medium', color: '#F59E0B', shortcut: '3' },
  { value: 'low', label: 'Low', color: '#6B7280', shortcut: '4' },
  { value: 'none', label: 'None', color: '', shortcut: '5' }
]

interface InteractivePriorityBadgeProps {
  priority: Priority
  onPriorityChange: (priority: Priority) => void
  variant?: PriorityBadgeVariant
  size?: 'sm' | 'md'
  compact?: boolean
  fixedWidth?: boolean
  className?: string
}

export const InteractivePriorityBadge = ({
  priority,
  onPriorityChange,
  variant: _variant = 'full',
  size: _size = 'md',
  compact = false,
  fixedWidth = false,
  className
}: InteractivePriorityBadgeProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = React.useState(false)
  const config = priorityConfig[priority]
  const colorValue = config.color || '#9ca3af'

  const compactLabels: Record<Priority, string> = {
    none: 'None',
    low: 'Low',
    medium: 'Med',
    high: 'High',
    urgent: 'Urgent'
  }
  const displayLabel = compact ? compactLabels[priority] : config.label || 'None'

  const handleSelect = (newPriority: Priority): void => {
    onPriorityChange(newPriority)
    setIsOpen(false)
  }

  const handleTriggerClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    const option = PRIORITY_OPTIONS.find((o) => o.shortcut === e.key)
    if (option) {
      e.preventDefault()
      handleSelect(option.value)
    }
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild onClick={handleTriggerClick}>
        <button
          type="button"
          className={cn(
            'flex items-center rounded-sm py-0.5 px-2 gap-1 cursor-pointer transition-opacity',
            'hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            fixedWidth && 'w-[70px] justify-start',
            className
          )}
          style={{ backgroundColor: `${colorValue}14` }}
          aria-label={`Priority: ${config.label || 'none'}. Click to change.`}
        >
          <div
            className="w-[5px] h-[5px] rounded-full shrink-0"
            style={{ backgroundColor: colorValue }}
          />
          <div
            className="text-[11px] font-['DM_Sans',system-ui,sans-serif] font-medium leading-3.5"
            style={{ color: colorValue }}
          >
            {displayLabel}
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 rounded-[10px] bg-popover border-border shadow-lg"
        align="start"
        sideOffset={4}
        onClick={handleTriggerClick}
        onKeyDown={handleKeyDown}
      >
        <div className="flex flex-col p-1 [font-synthesis:none] antialiased">
          {PRIORITY_OPTIONS.map((option) => {
            const isSelected = option.value === priority
            const isNone = option.value === 'none'
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => handleSelect(option.value)}
                className={cn(
                  'flex items-center rounded-[7px] py-2 px-3 gap-2 transition-colors',
                  'hover:bg-accent focus:outline-none'
                )}
                style={isSelected && !isNone ? { backgroundColor: `${option.color}0F` } : undefined}
              >
                {isNone ? (
                  <div className="rounded-full border border-border shrink-0 size-1.5" />
                ) : (
                  <div
                    className="rounded-full shrink-0 size-1.5"
                    style={{ backgroundColor: option.color }}
                  />
                )}
                <div
                  className={cn(
                    'text-[13px] leading-4',
                    isNone
                      ? 'text-text-tertiary'
                      : !isSelected
                        ? 'text-text-secondary'
                        : 'font-medium'
                  )}
                  style={isSelected && !isNone ? { color: option.color } : undefined}
                >
                  {option.label}
                </div>
                {isSelected && !isNone && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    style={{ marginLeft: 'auto' }}
                  >
                    <path
                      d="M3 6l2 2 4-4"
                      stroke={option.color}
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                <div
                  className={cn(
                    "text-[10px] text-text-tertiary font-['JetBrains_Mono',monospace] leading-3",
                    !(isSelected && !isNone) && 'ml-auto'
                  )}
                >
                  {option.shortcut}
                </div>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// INTERACTIVE STATUS BADGE (popover dropdown)
// ============================================================================

interface InteractiveStatusBadgeProps {
  statusId: string
  statuses: Status[]
  onStatusChange: (statusId: string) => void
  className?: string
}

export const InteractiveStatusBadge = ({
  statusId,
  statuses,
  onStatusChange,
  className
}: InteractiveStatusBadgeProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = React.useState(false)

  const currentStatus = statuses.find((s) => s.id === statusId)
  const statusColor = currentStatus?.color || '#6B7280'
  const statusName = currentStatus?.name || 'Unknown'

  const handleSelect = (newStatusId: string): void => {
    onStatusChange(newStatusId)
    setIsOpen(false)
  }

  const handleTriggerClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild onClick={handleTriggerClick}>
        <button
          type="button"
          className={cn(
            'flex items-center rounded-sm py-0.5 px-2 gap-1 cursor-pointer transition-opacity',
            'hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            className
          )}
          style={{ backgroundColor: `${statusColor}14` }}
          aria-label={`Status: ${statusName}. Click to change.`}
        >
          <div
            className="w-[5px] h-[5px] rounded-full shrink-0"
            style={{ backgroundColor: statusColor }}
          />
          <div
            className="text-[11px] font-['DM_Sans',system-ui,sans-serif] font-medium leading-3.5"
            style={{ color: statusColor }}
          >
            {statusName}
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 rounded-[10px] bg-popover border-border shadow-lg"
        align="start"
        sideOffset={4}
        onClick={handleTriggerClick}
      >
        <div className="flex flex-col p-1 [font-synthesis:none] antialiased">
          {statuses.map((status) => {
            const isSelected = status.id === statusId
            return (
              <button
                key={status.id}
                type="button"
                onClick={() => handleSelect(status.id)}
                className={cn(
                  'flex items-center rounded-[7px] py-2 px-3 gap-2 transition-colors',
                  'hover:bg-accent focus:outline-none'
                )}
                style={isSelected ? { backgroundColor: `${status.color}0F` } : undefined}
              >
                <div
                  className="rounded-full shrink-0 size-1.5"
                  style={{ backgroundColor: status.color }}
                />
                <div
                  className={cn(
                    'text-[13px] leading-4',
                    isSelected ? 'font-medium' : 'text-text-secondary'
                  )}
                  style={isSelected ? { color: status.color } : undefined}
                >
                  {status.name}
                </div>
                {isSelected && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    style={{ marginLeft: 'auto' }}
                  >
                    <path
                      d="M3 6l2 2 4-4"
                      stroke={status.color}
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// INTERACTIVE DUE DATE BADGE (with calendar popover)
// ============================================================================

interface InteractiveDueDateBadgeProps {
  dueDate: Date | null
  dueTime: string | null
  onDateChange: (date: Date | null) => void
  isRepeating?: boolean
  variant?: 'default' | 'compact'
  /** Use fixed width for grid alignment */
  fixedWidth?: boolean
  className?: string
}

export const InteractiveDueDateBadge = ({
  dueDate,
  dueTime,
  onDateChange,
  isRepeating = false,
  variant: _variant = 'default',
  fixedWidth = false,
  className
}: InteractiveDueDateBadgeProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = React.useState(false)

  const formatted = formatDueDate(dueDate, dueTime)

  const handleTriggerClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  const handleDateSelect = (date: Date | undefined): void => {
    onDateChange(date || null)
    setIsOpen(false)
  }

  // Quick date options
  const handleQuickDate =
    (days: number) =>
    (e: React.MouseEvent): void => {
      e.stopPropagation()
      const targetDate = new Date()
      targetDate.setDate(targetDate.getDate() + days)
      targetDate.setHours(0, 0, 0, 0)
      onDateChange(targetDate)
      setIsOpen(false)
    }

  const handleRemoveDate = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onDateChange(null)
    setIsOpen(false)
  }

  const isOverdue = formatted?.status === 'overdue'
  const isToday = formatted?.status === 'today'

  const dateColorClass = isOverdue
    ? 'text-red-600 dark:text-red-400'
    : isToday
      ? 'text-amber-600 dark:text-amber-500'
      : 'text-text-tertiary'

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild onClick={handleTriggerClick}>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1 cursor-pointer transition-opacity rounded-sm',
            'hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            dateColorClass,
            fixedWidth && 'w-[110px] flex justify-end',
            className
          )}
          aria-label={`Due: ${formatted?.label || 'no date'}. Click to change.`}
        >
          {isRepeating && <Repeat className="size-3 shrink-0" />}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
            <path
              d="M4 1v2M8 1v2M1.5 5h9M2 2.5h8a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div className="text-[11px] leading-3.5">{formatted?.label || 'No date'}</div>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[296px] p-3" align="end" onClick={handleTriggerClick}>
        <div className="flex flex-col gap-2">
          {/* Quick date buttons */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleQuickDate(0)}
              className={cn(
                'flex-1 rounded-sm py-1.5 text-xs font-medium transition-colors',
                'hover:bg-accent',
                isToday ? 'bg-accent text-foreground' : 'text-muted-foreground'
              )}
            >
              Today
            </button>
            <button
              type="button"
              onClick={handleQuickDate(1)}
              className={cn(
                'flex-1 rounded-sm py-1.5 text-xs font-medium transition-colors',
                'hover:bg-accent',
                formatted?.status === 'tomorrow'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground'
              )}
            >
              Tomorrow
            </button>
            <button
              type="button"
              onClick={handleQuickDate(7)}
              className="flex-1 rounded-sm py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
            >
              +1 Week
            </button>
          </div>

          <div className="h-px bg-border" />

          {/* Calendar */}
          <DatePickerCalendar selected={dueDate || undefined} onSelect={handleDateSelect} />

          {/* Remove date button */}
          {dueDate && (
            <>
              <div className="h-px bg-border" />
              <button
                type="button"
                onClick={handleRemoveDate}
                className="w-full rounded-sm py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
              >
                Remove due date
              </button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  ProjectBadge,
  PriorityBadge,
  DueDateBadge,
  TaskCheckbox,
  StatusBadge,
  InteractiveProjectBadge,
  InteractivePriorityBadge,
  InteractiveStatusBadge,
  InteractiveDueDateBadge
}
