import { useMemo } from 'react'
import { FolderKanban } from '@/lib/icons'
import { ProjectIcon } from '@/components/tasks/project-icon'
import { cn } from '@/lib/utils'
import { Picker, usePickerContext, usePickerSearch } from '@/components/ui/picker'
import { ProjectCreateFooter, useProjectQuickCreate } from './use-project-quick-create'
import type { Project } from '@/data/tasks-data'
import { useT } from '@memry/i18n/renderer'

// Sentinel value for the "All projects" option (mapped back to null on change).
const ALL_VALUE = '__all__'

export interface ProjectPickerProps {
  /** Selected project id; null = "All projects" scope (only meaningful with includeAllOption). */
  value: string | null
  /** Called with a project id on select, or null when the "All projects" option is chosen. */
  onChange: (projectId: string | null) => void
  projects: Project[]
  /** Render the leading "All projects" (null) option. Default false. */
  includeAllOption?: boolean
  /** Label for the all-option and the empty-trigger text. Default page.projectScope.allProjects. */
  allOptionLabel?: string
  /** Render a search header and filter the list by name. Default false. */
  searchable?: boolean
  /** Show per-project task counts (parent-computed). Default false. */
  showCounts?: boolean
  /** id -> count. Used when showCounts is set; the component does not compute counts. */
  taskCountByProject?: Record<string, number>
  /** Show the built-in create-project footer. Default true (no-op outside tasks context). */
  allowCreate?: boolean
  /** Trailing per-row actions slot (edit/archive/delete menu, edit-on-hover, …). */
  renderItemActions?: (project: Project) => React.ReactNode
  /** 'button' = bordered button+chevron; 'badge' = compact inline color badge (task rows). */
  triggerVariant?: 'button' | 'badge'
  /** Dropdown content width. Defaults to 'auto' for badge, 'trigger' for button. */
  contentWidth?: 'auto' | 'trigger' | number
  /** Trigger text when nothing selected (button variant). */
  placeholder?: string
  /** Greys out the trigger and stops it opening, e.g. while a form is saving. */
  disabled?: boolean
  className?: string
}

const ProjectIndicator = ({ project }: { project: Project }): React.JSX.Element => (
  <ProjectIcon
    icon={project.icon}
    className="size-4 shrink-0"
    color={project.color}
    fallback={
      <span
        className="size-3 shrink-0 rounded-full"
        style={{ backgroundColor: project.color }}
        aria-hidden="true"
      />
    }
  />
)

interface ProjectPickerListProps {
  projects: Project[]
  searchable: boolean
  includeAllOption: boolean
  allOptionLabel: string
  showCounts: boolean
  taskCountByProject?: Record<string, number>
  renderItemActions?: (project: Project) => React.ReactNode
}

// Rendered inside <Picker> so it can read the search query from context.
const ProjectPickerList = ({
  projects,
  searchable,
  includeAllOption,
  allOptionLabel,
  showCounts,
  taskCountByProject,
  renderItemActions
}: ProjectPickerListProps): React.JSX.Element => {
  const { t: tTasks } = useT('tasks')
  const { searchQuery } = usePickerContext()
  const filtered = usePickerSearch(projects, ['name'], searchable ? searchQuery : '')

  const itemTrailing = (project: Project): React.ReactNode => {
    const count = showCounts ? (taskCountByProject?.[project.id] ?? 0) : null
    const actions = renderItemActions?.(project)
    if (count == null && !actions) return undefined
    return (
      <div className="flex items-center gap-1">
        {count != null && count > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
        )}
        {actions}
      </div>
    )
  }

  if (filtered.length === 0 && !includeAllOption) {
    return (
      <Picker.Empty
        icon={<FolderKanban className="size-8" />}
        message={
          projects.length === 0
            ? tTasks('phaseF.componentsTasksProjectsProjectSelector.noProjectsYet')
            : undefined
        }
      />
    )
  }

  return (
    <Picker.List>
      {includeAllOption && (
        <Picker.Item
          value={ALL_VALUE}
          label={allOptionLabel}
          icon={
            <span className="size-2.5 shrink-0 rounded-full border-[1.2px] border-solid border-border" />
          }
          indicator="check"
        />
      )}
      {filtered.map((project) => (
        <Picker.Item
          key={project.id}
          value={project.id}
          label={project.name}
          icon={<ProjectIndicator project={project} />}
          indicator="check"
          indicatorColor={project.color}
          trailing={itemTrailing(project)}
          className="group"
        />
      ))}
    </Picker.List>
  )
}

export const ProjectPicker = ({
  value,
  onChange,
  projects,
  includeAllOption = false,
  allOptionLabel,
  searchable = false,
  showCounts = false,
  taskCountByProject,
  allowCreate = true,
  renderItemActions,
  triggerVariant = 'button',
  contentWidth,
  placeholder,
  disabled,
  className
}: ProjectPickerProps): React.JSX.Element => {
  const { t: tTasks } = useT('tasks')
  const availableProjects = useMemo(() => projects.filter((p) => !p.isArchived), [projects])
  const currentProject = value ? availableProjects.find((p) => p.id === value) : undefined

  const { canCreate, openCreate, dialog } = useProjectQuickCreate((id) => onChange(id))
  const showCreate = allowCreate && canCreate

  const resolvedAllLabel = allOptionLabel ?? tTasks('page.projectScope.allProjects')

  const pickerValue = value ?? (includeAllOption ? ALL_VALUE : null)

  const handleValueChange = (val: string): void => {
    const next = val === ALL_VALUE ? null : val
    if (next !== value) onChange(next)
  }

  const resolvedWidth = contentWidth ?? (triggerVariant === 'badge' ? 'auto' : 'trigger')

  const badgeColor = currentProject?.color || '#6B7280'
  const badgeName =
    currentProject?.name ||
    (includeAllOption
      ? resolvedAllLabel
      : tTasks('phaseF.componentsTasksProjectSelect.selectProject'))

  return (
    <>
      <Picker value={pickerValue} onValueChange={handleValueChange}>
        {triggerVariant === 'badge' ? (
          <Picker.Trigger asChild>
            <button
              type="button"
              className={cn(
                'flex items-center rounded-sm py-0.5 px-2 gap-1.5 cursor-pointer transition-opacity',
                'hover:opacity-80 focus-visible:outline-none',
                className
              )}
              style={{ backgroundColor: `${badgeColor}14` }}
              onClick={(e) => e.stopPropagation()}
              disabled={disabled}
              aria-label={`Project: ${badgeName}. Click to change.`}
            >
              <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: badgeColor }} />
              <div className="text-[11px] font-medium leading-3.5" style={{ color: badgeColor }}>
                {badgeName}
              </div>
            </button>
          </Picker.Trigger>
        ) : (
          <Picker.Trigger
            variant="button"
            chevron
            className={className}
            disabled={disabled}
            aria-label={tTasks('phaseF.componentsTasksProjectsProjectSelector.selectProject')}
          >
            {currentProject ? (
              <span className="flex items-center gap-2 min-w-0">
                <ProjectIndicator project={currentProject} />
                <span className="truncate">{currentProject.name}</span>
              </span>
            ) : includeAllOption ? (
              <span className="flex items-center gap-2 min-w-0">
                <span className="size-2.5 shrink-0 rounded-full border-[1.2px] border-solid border-border" />
                <span className="truncate text-muted-foreground">{resolvedAllLabel}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                {placeholder ??
                  tTasks('phaseF.componentsTasksProjectsProjectSelector.selectProject')}
              </span>
            )}
          </Picker.Trigger>
        )}
        <Picker.Content width={resolvedWidth} align="start">
          {searchable && <Picker.Search placeholder={tTasks('page.projectScope.searchProjects')} />}
          <ProjectPickerList
            projects={availableProjects}
            searchable={searchable}
            includeAllOption={includeAllOption}
            allOptionLabel={resolvedAllLabel}
            showCounts={showCounts}
            taskCountByProject={taskCountByProject}
            renderItemActions={renderItemActions}
          />
          {showCreate && <ProjectCreateFooter onStart={openCreate} />}
        </Picker.Content>
      </Picker>
      {showCreate && dialog}
    </>
  )
}

export default ProjectPicker
