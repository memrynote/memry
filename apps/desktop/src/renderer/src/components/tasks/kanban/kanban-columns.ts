import { priorityConfig, type Task, type Priority } from '@/data/sample-tasks'
import type { Project, SortField, StatusType } from '@/data/tasks-data'
import { groupByPriority, groupByDueDate } from '@/lib/task-grouping'

export interface KanbanColumnDef {
  id: string
  title: string
  statusType: StatusType | 'custom'
  color?: string
  project?: Project
}

export type ColumnMode = 'canonical' | 'project' | 'priority' | 'dueDate' | 'byProject' | 'status'

export interface ColumnConfig {
  mode: ColumnMode
  columns: KanbanColumnDef[]
  tasksByColumn: Map<string, Task[]>
}

const CANONICAL_COLUMNS: KanbanColumnDef[] = [
  { id: 'todo', title: 'To Do', statusType: 'todo' },
  { id: 'in_progress', title: 'In Progress', statusType: 'in_progress' },
  { id: 'done', title: 'Done', statusType: 'done' }
]

const PRIORITY_COLUMN_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const PRIORITY_COLUMN_LABELS: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No Priority'
}

const DUE_DATE_COLUMNS: { key: string; title: string; color?: string }[] = [
  { key: 'overdue', title: 'Overdue', color: '#ef4444' },
  { key: 'today', title: 'Today', color: '#E5993E' },
  { key: 'tomorrow', title: 'Tomorrow', color: '#3B82F6' },
  { key: 'upcoming', title: 'This Week', color: '#50505A' },
  { key: 'later', title: 'Later' },
  { key: 'noDueDate', title: 'No Due Date', color: '#50505A' }
]

const getStatusTypeForTask = (task: Task, projects: Project[]): StatusType => {
  const project = projects.find((p) => p.id === task.projectId)
  const status = project?.statuses.find((s) => s.id === task.statusId)
  return status?.type || 'todo'
}

const resolveSelectedProject = (
  projects: Project[],
  _selectedType: 'view' | 'project',
  selectedProjectId: string | null
): Project | null => {
  if (selectedProjectId) {
    return projects.find((p) => p.id === selectedProjectId) ?? null
  }
  return null
}

const buildStatusColumns = (
  project: Project
): { columns: KanbanColumnDef[]; tasksByColumn: Map<string, Task[]> } => {
  const sortedStatuses = [...project.statuses].sort((a, b) => a.order - b.order)
  const columns: KanbanColumnDef[] = sortedStatuses.map((s) => ({
    id: s.id,
    title: s.name,
    statusType: s.type,
    color: s.color,
    project
  }))
  const tasksByColumn = new Map<string, Task[]>()
  columns.forEach((col) => tasksByColumn.set(col.id, []))
  return { columns, tasksByColumn }
}

export const buildColumnConfig = (
  tasks: Task[],
  projects: Project[],
  selectedType: 'view' | 'project',
  selectedProjectId: string | null,
  sortField: SortField
): ColumnConfig => {
  const selectedProject = resolveSelectedProject(projects, selectedType, selectedProjectId)

  // --- Status sort: scope to selected project's statuses, or canonical 3 ---
  if (sortField === 'status') {
    if (selectedProject) {
      const { columns, tasksByColumn } = buildStatusColumns(selectedProject)
      tasks.forEach((task) => {
        if (task.projectId === selectedProject.id) {
          tasksByColumn.get(task.statusId)?.push(task)
        }
      })
      return { mode: 'status', columns, tasksByColumn }
    }

    // No project selected — use canonical 3 columns aggregated by statusType
    const tasksByColumn = new Map<string, Task[]>()
    CANONICAL_COLUMNS.forEach((col) => tasksByColumn.set(col.id, []))
    tasks.forEach((task) => {
      const statusType = getStatusTypeForTask(task, projects)
      tasksByColumn.get(statusType)?.push(task)
    })
    return { mode: 'canonical', columns: CANONICAL_COLUMNS, tasksByColumn }
  }

  // --- Priority sort ---
  if (sortField === 'priority') {
    const groups = groupByPriority(tasks)
    const allColumns: KanbanColumnDef[] = PRIORITY_COLUMN_ORDER.map((p) => ({
      id: `priority-${p}`,
      title: PRIORITY_COLUMN_LABELS[p],
      statusType: 'custom' as const,
      color: priorityConfig[p].color ?? undefined
    }))
    const tasksByColumn = new Map<string, Task[]>()
    allColumns.forEach((col) => tasksByColumn.set(col.id, []))
    groups.forEach((g) => {
      tasksByColumn.set(`priority-${g.key}`, g.tasks)
    })
    return { mode: 'priority', columns: allColumns, tasksByColumn }
  }

  // --- Project sort ---
  if (sortField === 'project') {
    const activeProjects = projects.filter((p) => !p.isArchived)
    const columns: KanbanColumnDef[] = activeProjects.map((p) => ({
      id: `project-${p.id}`,
      title: p.name,
      statusType: 'custom' as const,
      color: p.color,
      project: p
    }))
    const tasksByColumn = new Map<string, Task[]>()
    columns.forEach((col) => tasksByColumn.set(col.id, []))
    tasks.forEach((task) => {
      tasksByColumn.get(`project-${task.projectId}`)?.push(task)
    })
    return { mode: 'byProject', columns, tasksByColumn }
  }

  // --- Due date sort ---
  if (sortField === 'dueDate') {
    const groups = groupByDueDate(tasks)
    const groupMap = new Map(groups.map((g) => [g.key, g.tasks]))
    const columns: KanbanColumnDef[] = DUE_DATE_COLUMNS.map((c) => ({
      id: `due-${c.key}`,
      title: c.title,
      statusType: 'custom' as const,
      color: c.color
    }))
    const tasksByColumn = new Map<string, Task[]>()
    columns.forEach((col) => tasksByColumn.set(col.id, []))
    DUE_DATE_COLUMNS.forEach((c) => {
      tasksByColumn.set(`due-${c.key}`, groupMap.get(c.key) || [])
    })
    return { mode: 'dueDate', columns, tasksByColumn }
  }

  // --- Default: project-specific statuses or canonical ---
  if (selectedProject) {
    const { columns, tasksByColumn } = buildStatusColumns(selectedProject)
    tasks.forEach((task) => {
      if (task.projectId === selectedProject.id) {
        tasksByColumn.get(task.statusId)?.push(task)
      }
    })
    return { mode: 'project', columns, tasksByColumn }
  }

  // All projects — canonical 3 columns
  const tasksByColumn = new Map<string, Task[]>()
  CANONICAL_COLUMNS.forEach((col) => tasksByColumn.set(col.id, []))
  tasks.forEach((task) => {
    const statusType = getStatusTypeForTask(task, projects)
    tasksByColumn.get(statusType)?.push(task)
  })
  return { mode: 'canonical', columns: CANONICAL_COLUMNS, tasksByColumn }
}
