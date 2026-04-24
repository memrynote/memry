import * as React from 'react'
import { Repeat } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/ui/status-dot'
import { StatusIcon } from '@/components/tasks/status-icon'
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

export type PriorityBadgeVariant = 'dot' | 'label' | 'full'

// ============================================================================
// PROJECT BADGE
// ============================================================================

interface ProjectBadgeProps {
  project: Project
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
      <StatusDot color={project.color} />
      <span className="truncate">{project.name}</span>
    </span>
  )
}

// ============================================================================
// PRIORITY BADGE
// ============================================================================

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
  compact?: boolean
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

  if (priority === 'none' || !config.color) {
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
      {(variant === 'dot' || variant === 'full') && (
        <StatusDot color={config.color} size={size === 'sm' ? 'xs' : 'sm'} />
      )}
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
  fixedWidth?: boolean
  className?: string
}

const dueDateStatusStyles: Record<DueDateStatus, string> = {
  overdue: 'text-task-due-overdue',
  today: 'text-task-due-today',
  tomorrow: 'text-task-due-tomorrow',
  upcoming: 'text-foreground',
  later: 'text-muted-foreground',
  none: 'text-muted-foreground'
}

const dueDateBackgroundStyles: Record<DueDateStatus, string> = {
  overdue: 'bg-task-due-overdue-bg',
  today: 'bg-task-due-today-bg',
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
        'focus-visible:outline-none',
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
      <StatusIcon type={type ?? 'todo'} color={color} size="sm" />
      <span>{label}</span>
    </span>
  )
}

// ============================================================================
// RE-EXPORTS — Interactive badges (split into separate files)
// ============================================================================

export { InteractiveProjectBadge } from './interactive-project-badge'
export { InteractivePriorityBadge } from './interactive-priority-badge'
export { InteractiveStatusBadge } from './interactive-status-badge'
export { InteractiveDueDateBadge } from './interactive-due-date-badge'
