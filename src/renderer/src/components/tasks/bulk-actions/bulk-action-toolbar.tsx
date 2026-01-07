import { Check, Flag, Calendar, FolderOpen, Columns3, Archive, Trash2, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { SelectionCheckbox } from './selection-checkbox'
import { BulkActionButton } from './bulk-action-button'
import { BulkActionDropdown, type BulkActionOption } from './bulk-action-dropdown'
import { priorityConfig, type Priority } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface BulkActionToolbarProps {
  /** Number of selected tasks */
  selectedCount: number
  /** Whether all visible tasks are selected */
  allSelected: boolean
  /** Whether some (but not all) visible tasks are selected */
  someSelected: boolean
  /** Toggle select all */
  onToggleSelectAll: () => void
  /** Complete selected tasks */
  onComplete: () => void
  /** Change priority for selected tasks */
  onChangePriority: (priority: Priority) => void
  /** Change due date for selected tasks */
  onChangeDueDate: (option: string) => void
  /** Move selected tasks to project */
  onMoveToProject: (projectId: string) => void
  /** Change status for selected tasks (Kanban) */
  onChangeStatus?: (statusId: string) => void
  /** Archive selected tasks */
  onArchive: () => void
  /** Delete selected tasks */
  onDelete: () => void
  /** Cancel/clear selection */
  onCancel: () => void
  /** Available projects for move action */
  projects: Project[]
  /** Available statuses for status action (Kanban only) */
  statuses?: Status[]
  /** Whether to show status action (Kanban view) */
  showStatusAction?: boolean
  /** Additional class names */
  className?: string
}

// ============================================================================
// OPTION CONFIGS
// ============================================================================

const priorityOptions: BulkActionOption<Priority>[] = [
  {
    value: 'urgent',
    label: 'Urgent',
    icon: (
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: priorityConfig.urgent.color || undefined }}
      />
    ),
    color: priorityConfig.urgent.color || undefined
  },
  {
    value: 'high',
    label: 'High',
    icon: (
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: priorityConfig.high.color || undefined }}
      />
    ),
    color: priorityConfig.high.color || undefined
  },
  {
    value: 'medium',
    label: 'Medium',
    icon: (
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: priorityConfig.medium.color || undefined }}
      />
    ),
    color: priorityConfig.medium.color || undefined
  },
  {
    value: 'low',
    label: 'Low',
    icon: (
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: priorityConfig.low.color || undefined }}
      />
    ),
    color: priorityConfig.low.color || undefined
  },
  { value: 'none', label: 'None', isSeparator: false },
  { value: 'none', label: 'Remove priority', isSeparator: false }
]

const dueDateOptions: BulkActionOption<string>[] = [
  { value: 'today', label: 'Today', icon: <Calendar className="size-4" /> },
  { value: 'tomorrow', label: 'Tomorrow', icon: <Calendar className="size-4" /> },
  { value: 'next-week', label: 'Next week', icon: <Calendar className="size-4" /> },
  { value: 'next-month', label: 'Next month', icon: <Calendar className="size-4" /> },
  { value: 'separator', label: '', isSeparator: true },
  { value: 'pick-date', label: 'Pick a date...', icon: <Calendar className="size-4" /> },
  { value: 'separator2', label: '', isSeparator: true },
  { value: 'remove', label: 'Remove due date', icon: <X className="size-4" /> }
]

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Toolbar that appears when tasks are selected, providing bulk action buttons
 */
export const BulkActionToolbar = ({
  selectedCount,
  allSelected,
  someSelected,
  onToggleSelectAll,
  onComplete,
  onChangePriority,
  onChangeDueDate,
  onMoveToProject,
  onChangeStatus,
  onArchive,
  onDelete,
  onCancel,
  projects,
  statuses = [],
  showStatusAction = false,
  className
}: BulkActionToolbarProps): React.JSX.Element => {
  // Build project options
  const projectOptions: BulkActionOption<string>[] = projects
    .filter((p) => !p.isArchived)
    .map((project) => ({
      value: project.id,
      label: project.name,
      icon: <span className="size-2 rounded-full" style={{ backgroundColor: project.color }} />
    }))

  // Build status options (for Kanban)
  const statusOptions: BulkActionOption<string>[] = statuses.map((status) => ({
    value: status.id,
    label: status.name,
    icon: <span className="size-2 rounded-full" style={{ backgroundColor: status.color }} />,
    color: status.color
  }))

  return (
    <div
      className={cn(
        'flex items-center gap-4 border-b border-primary/20 bg-primary/5 px-4 py-3',
        className
      )}
      role="toolbar"
      aria-label="Bulk actions"
    >
      {/* Select all checkbox + count */}
      <div className="flex items-center gap-2">
        <SelectionCheckbox
          checked={allSelected}
          indeterminate={someSelected}
          onChange={onToggleSelectAll}
          aria-label={allSelected ? 'Deselect all' : 'Select all'}
        />
        <span className="font-medium text-primary">{selectedCount} selected</span>
      </div>

      {/* Divider */}
      <div className="h-6 w-px bg-primary/20" aria-hidden="true" />

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        {/* Complete */}
        <BulkActionButton
          icon={<Check className="size-4" />}
          label="Complete"
          onClick={onComplete}
        />

        {/* Priority dropdown */}
        <BulkActionDropdown
          icon={<Flag className="size-4" />}
          label="Priority"
          options={priorityOptions.filter((o) => !o.isSeparator || o.value !== 'none')}
          onSelect={onChangePriority}
          selectedCount={selectedCount}
        />

        {/* Due Date dropdown */}
        <BulkActionDropdown
          icon={<Calendar className="size-4" />}
          label="Due Date"
          options={dueDateOptions}
          onSelect={onChangeDueDate}
          selectedCount={selectedCount}
        />

        {/* Move to project dropdown */}
        <BulkActionDropdown
          icon={<FolderOpen className="size-4" />}
          label="Move to"
          options={projectOptions}
          onSelect={onMoveToProject}
          selectedCount={selectedCount}
        />

        {/* Status dropdown (Kanban only) */}
        {showStatusAction && statuses.length > 0 && onChangeStatus && (
          <BulkActionDropdown
            icon={<Columns3 className="size-4" />}
            label="Status"
            options={statusOptions}
            onSelect={onChangeStatus}
            selectedCount={selectedCount}
          />
        )}

        {/* Divider */}
        <div className="h-6 w-px bg-primary/20" aria-hidden="true" />

        {/* Archive */}
        <BulkActionButton
          icon={<Archive className="size-4" />}
          label="Archive"
          onClick={onArchive}
          variant="secondary"
        />

        {/* Delete */}
        <BulkActionButton
          icon={<Trash2 className="size-4" />}
          label="Delete"
          onClick={onDelete}
          variant="danger"
        />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Cancel button */}
      <button
        type="button"
        onClick={onCancel}
        className={cn(
          'flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm',
          'text-muted-foreground hover:text-foreground hover:bg-accent',
          'transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        aria-label="Cancel selection"
      >
        <X className="size-4" />
        <span className="hidden sm:inline">Cancel</span>
      </button>
    </div>
  )
}

export default BulkActionToolbar
