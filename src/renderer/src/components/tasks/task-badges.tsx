import * as React from 'react'
import { Repeat, Check } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  formatDueDate,
  getDaysOverdue,
  getOverdueTier,
  overdueTierStyles,
  type DueDateStatus
} from '@/lib/task-utils'
import { priorityConfig, type Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePickerCalendar } from './date-picker-calendar'
import { Checkbox } from '@/components/ui/checkbox'

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
          cn('rounded-md px-1.5 py-0.5', dueDateBackgroundStyles[formatted.status])
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
  className?: string
}

export const TaskCheckbox = ({
  checked,
  onChange,
  disabled = false,
  priority,
  className
}: TaskCheckboxProps): React.JSX.Element => {
  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    // Trigger onChange on click since Radix Checkbox might not fire it properly
    if (!disabled) {
      onChange()
    }
  }

  // Get border color based on priority
  const getPriorityBorderColor = (): string | undefined => {
    if (checked) return undefined
    if (!priority || priority === 'none') return undefined
    return priorityConfig[priority]?.color ?? undefined
  }

  const priorityBorderColor = getPriorityBorderColor()

  return (
    <div
      className={cn(
        'group/checkbox relative',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      )}
      onClick={handleClick}
    >
      {/* Invisible overlay to capture all clicks - ensures clicks work even when Radix internal elements override pointer-events */}
      <div className="absolute inset-0 z-10" aria-hidden="true" />
      <Checkbox
        checked={checked}
        disabled={disabled}
        className={cn(
          'size-[18px] rounded-[4px] border-[1.5px] transition-all duration-200 pointer-events-none',
          'data-[state=unchecked]:border-muted-foreground/40',
          'data-[state=unchecked]:hover:border-primary/70 data-[state=unchecked]:hover:bg-primary/8',
          'data-[state=checked]:border-primary data-[state=checked]:bg-primary',
          // Add hover effect for checked state too
          'data-[state=checked]:hover:opacity-80',
          className
        )}
        style={priorityBorderColor ? { borderColor: priorityBorderColor } : undefined}
        aria-label={checked ? 'Mark as incomplete' : 'Mark as complete'}
      />
      {/* Hover state - soft checkmark preview (only for unchecked) */}
      {!checked && !disabled && (
        <Check
          className="absolute inset-0 m-auto size-3 text-primary/25 opacity-0 group-hover/checkbox:opacity-100 transition-opacity duration-200 pointer-events-none"
          strokeWidth={3}
        />
      )}
    </div>
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

  const activeProjects = projects.filter((p) => !p.isArchived)

  const handleSelect = (projectId: string): void => {
    onProjectChange(projectId)
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
            'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs',
            'bg-muted text-text-secondary',
            'hover:bg-accent hover:ring-1 hover:ring-primary/30 transition-all cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            fixedWidth && 'w-[120px] justify-start',
            className
          )}
          aria-label={`Change project from ${project.name}`}
        >
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: project.color }}
            aria-hidden="true"
          />
          <span className="truncate">{project.name}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[180px] p-1" align="start" onClick={handleTriggerClick}>
        <div className="space-y-0.5">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">
            Move to Project
          </div>
          {activeProjects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handleSelect(p.id)}
              className={cn(
                'w-full flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
                'hover:bg-accent focus:outline-none',
                p.id === project.id && 'bg-accent font-medium'
              )}
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: p.color }}
                aria-hidden="true"
              />
              <span className="truncate">{p.name}</span>
              {p.id === project.id && <Check className="size-4 ml-auto text-primary" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// INTERACTIVE PRIORITY BADGE (cycles through priorities on click)
// ============================================================================

/** Priority order for cycling */
const priorityOrder: Priority[] = ['none', 'low', 'medium', 'high', 'urgent']

interface InteractivePriorityBadgeProps {
  priority: Priority
  onPriorityChange: (priority: Priority) => void
  variant?: PriorityBadgeVariant
  size?: 'sm' | 'md'
  /** Use compact short labels (Med instead of Medium) */
  compact?: boolean
  /** Use fixed width for grid alignment */
  fixedWidth?: boolean
  className?: string
}

export const InteractivePriorityBadge = ({
  priority,
  onPriorityChange,
  variant = 'full',
  size = 'md',
  compact = false,
  fixedWidth = false,
  className
}: InteractivePriorityBadgeProps): React.JSX.Element => {
  const config = priorityConfig[priority]

  /** Short labels for compact display */
  const priorityShortLabels: Record<Priority, string | null> = {
    none: 'None',
    low: 'Low',
    medium: 'Med',
    high: 'High',
    urgent: 'Urgent'
  }

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const currentIndex = priorityOrder.indexOf(priority)
    const nextIndex = (currentIndex + 1) % priorityOrder.length
    onPriorityChange(priorityOrder[nextIndex])
  }

  const displayLabel = compact ? priorityShortLabels[priority] : config.label || 'None'
  const colorValue = config.color || '#9ca3af' // Gray for none

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'inline-flex items-center gap-1.5',
        'hover:bg-accent hover:ring-1 hover:ring-primary/30 rounded-full px-1.5 py-0.5 transition-all cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        size === 'sm' && 'text-xs',
        size === 'md' && 'text-xs',
        fixedWidth && 'w-[70px] justify-start',
        className
      )}
      aria-label={`Change priority from ${config.label || 'none'}`}
    >
      {/* Priority dot */}
      {(variant === 'dot' || variant === 'full') && (
        <span
          className={cn(
            'shrink-0 rounded-full',
            size === 'sm' && 'size-1.5',
            size === 'md' && 'size-2'
          )}
          style={{ backgroundColor: colorValue }}
          aria-hidden="true"
        />
      )}

      {/* Priority label */}
      {(variant === 'label' || variant === 'full') && (
        <span
          className={cn('font-medium', size === 'sm' && 'text-[10px]', size === 'md' && 'text-xs')}
          style={{ color: colorValue }}
        >
          {displayLabel}
        </span>
      )}
    </button>
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
  variant = 'default',
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
  const showBackground = isOverdue || isToday

  const badgeContent = (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        dueDateStatusStyles[formatted?.status || 'none'],
        showBackground &&
          variant === 'default' &&
          cn('rounded-md px-1.5 py-0.5', dueDateBackgroundStyles[formatted?.status || 'none'])
      )}
    >
      {isRepeating && <Repeat className="size-3 shrink-0" aria-label="Repeating task" />}
      <span className="truncate">{formatted?.label || 'No date'}</span>
      {isOverdue && variant === 'default' && (
        <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80 shrink-0">
          Overdue
        </span>
      )}
    </span>
  )

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild onClick={handleTriggerClick}>
        <button
          type="button"
          className={cn(
            'hover:bg-accent hover:ring-1 hover:ring-primary/30 rounded-md px-1 py-0.5 transition-all cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            fixedWidth && 'w-[110px] flex justify-end',
            className
          )}
          aria-label={`Change due date from ${formatted?.label || 'no date'}`}
        >
          {badgeContent}
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
                'flex-1 rounded-md py-1.5 text-xs font-medium transition-colors',
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
                'flex-1 rounded-md py-1.5 text-xs font-medium transition-colors',
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
              className="flex-1 rounded-md py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
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
                className="w-full rounded-md py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
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
  InteractiveDueDateBadge
}
