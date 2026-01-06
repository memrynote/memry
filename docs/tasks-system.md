# Tasks System Architecture

This document provides a comprehensive guide to the tasks implementation in Memry, enabling Claude to understand and work with task-related code effectively.

## Overview

The tasks system is the core feature of Memry, providing:
- Task CRUD operations with subtask hierarchy
- Project organization with customizable statuses (kanban-style)
- Due dates, priorities, and recurring tasks
- Tags and note linking
- Multi-select and bulk operations
- Real-time sync across windows

## Data Flow Architecture

```
DATABASE (data.db - SQLite)
    ↓ (Drizzle ORM queries)
Database Query Layer (src/shared/db/queries/)
    ↓ (via ipcMain.handle())
IPC Handlers Layer (src/main/ipc/tasks-handlers.ts)
    ↓ (emit events to windows)
IPC Channels (src/shared/ipc-channels.ts)
    ↓ (window.api.tasks methods)
Renderer Service Layer (src/renderer/src/services/tasks-service.ts)
    ↓ (event subscriptions)
React Context (src/renderer/src/contexts/tasks/)
    ↓ (state distribution)
Custom Hooks (src/renderer/src/hooks/use-task-*.ts)
    ↓
UI Components (src/renderer/src/components/tasks/)
```

## File Locations Quick Reference

| Layer | File Path |
|-------|-----------|
| **Schema** | `src/shared/db/schema/tasks.ts`, `projects.ts`, `statuses.ts`, `task-relations.ts` |
| **Contracts** | `src/shared/contracts/tasks-api.ts` |
| **Queries** | `src/shared/db/queries/tasks.ts`, `projects.ts` |
| **IPC Channels** | `src/shared/ipc-channels.ts` |
| **IPC Handlers** | `src/main/ipc/tasks-handlers.ts` |
| **Service** | `src/renderer/src/services/tasks-service.ts` |
| **Context** | `src/renderer/src/contexts/tasks/index.tsx` |
| **Hooks** | `src/renderer/src/hooks/use-task-*.ts` |
| **Utilities** | `src/renderer/src/lib/task-utils.ts`, `subtask-utils.ts` |
| **Components** | `src/renderer/src/components/tasks/` |

---

## 1. Database Schema Layer

### Tasks Table (`src/shared/db/schema/tasks.ts`)

```typescript
{
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  statusId: text('status_id').references(() => statuses.id, { onDelete: 'set null' }),
  parentId: text('parent_id'),  // Self-referential for subtask hierarchy

  title: text('title').notNull(),
  description: text('description'),
  priority: integer('priority').default(0),  // 0=none, 1=low, 2=medium, 3=high
  position: integer('position').notNull(),   // Ordering within list

  dueDate: text('due_date'),     // Format: YYYY-MM-DD
  dueTime: text('due_time'),     // Format: HH:MM
  startDate: text('start_date'), // Format: YYYY-MM-DD

  repeatConfig: text('repeat_config'),  // JSON for recurring tasks
  repeatFrom: text('repeat_from'),      // 'due' or 'completion'

  completedAt: text('completed_at'),    // ISO timestamp when completed
  archivedAt: text('archived_at'),      // Soft delete timestamp
  createdAt: text('created_at'),
  modifiedAt: text('modified_at'),
}
```

**Indexes:** project, status, parent, due_date, completed

### Projects Table (`src/shared/db/schema/projects.ts`)

```typescript
{
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color'),           // Hex format: #RRGGBB
  icon: text('icon'),
  position: integer('position'),
  isInbox: integer('is_inbox'),   // Boolean: special inbox project
  archivedAt: text('archived_at'),
}
```

### Statuses Table (`src/shared/db/schema/statuses.ts`)

```typescript
{
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color'),
  position: integer('position'),
  isDefault: integer('is_default'),  // New tasks get this status
  isDone: integer('is_done'),        // Marks task as complete when moved here
}
```

### Relation Tables (`src/shared/db/schema/task-relations.ts`)

```typescript
// Many-to-many: tasks to tags
taskTags: {
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  tag: text('tag').notNull(),
  // Composite PK: (taskId, tag)
}

// Many-to-many: tasks to notes
taskNotes: {
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  noteId: text('note_id').notNull(),
  // Composite PK: (taskId, noteId)
}
```

---

## 2. Contract & Validation Layer

**File:** `src/shared/contracts/tasks-api.ts`

All IPC inputs are validated with Zod schemas. Key schemas:

### Task Schemas

```typescript
TaskCreateSchema: {
  projectId: string,
  title: string,
  description?: string,
  priority?: 0 | 1 | 2 | 3,
  dueDate?: string,        // YYYY-MM-DD regex validated
  dueTime?: string,        // HH:MM regex validated
  startDate?: string,
  parentId?: string,
  statusId?: string,
  tags?: string[],
  linkedNoteIds?: string[],
  position?: number,
  repeatConfig?: RepeatConfigSchema,
  repeatFrom?: 'due' | 'completion',
}

TaskUpdateSchema: Partial of all task fields

TaskListSchema: {
  projectId?: string,
  statusId?: string,
  parentId?: string | null,
  completed?: boolean,
  dueBefore?: string,
  dueAfter?: string,
  tags?: string[],
  search?: string,
  sortBy?: 'position' | 'dueDate' | 'priority' | 'createdAt' | 'modifiedAt',
  sortOrder?: 'asc' | 'desc',
  limit?: number,
  offset?: number,
}

TaskMoveSchema: {
  id: string,
  projectId?: string,
  statusId?: string,
  parentId?: string | null,
  position?: number,
}

TaskReorderSchema: {
  items: Array<{ id: string, position: number }>,
}
```

### Repeat Config Schema

```typescript
RepeatConfigSchema: {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom',
  interval?: number,          // e.g., every 2 weeks
  weekDays?: number[],        // 0-6 for weekly
  monthDay?: number,          // 1-31 for monthly
  endDate?: string,
  endAfterOccurrences?: number,
}
```

### Project & Status Schemas

```typescript
ProjectCreateSchema: { name, description?, color?, icon? }
ProjectUpdateSchema: { id, name?, description?, color?, icon? }
StatusCreateSchema: { projectId, name, color?, isDefault?, isDone? }
StatusUpdateSchema: { id, name?, color?, position?, isDefault?, isDone? }
```

---

## 3. Database Query Layer

**File:** `src/shared/db/queries/tasks.ts` (711 lines)

### Core CRUD

```typescript
insertTask(db, task)           // Insert new task
updateTask(db, id, updates)    // Partial update
deleteTask(db, id)             // Hard delete
getTaskById(db, id)            // Single task lookup
taskExists(db, id)             // Existence check
```

### Listing & Filtering

```typescript
listTasks(db, filters)  // Complex query with:
  // - projectId, statusId, parentId matching
  // - Completed/archived exclusion
  // - Due date ranges (dueBefore, dueAfter)
  // - Tag-based filtering
  // - Sorting (position, dueDate, priority, created, modified)
  // - Pagination (limit, offset)

countTasks(db, filters)              // Count with filters
getTasksByProject(db, projectId)     // Active tasks in project
getSubtasks(db, parentId)            // Children of parent
countSubtasks(db, parentId)          // Subtask counts
```

### Task Views (Specialized Queries)

```typescript
getTodayTasks(db)                    // Due today, ordered by time
getOverdueTasks(db)                  // Past-due uncompleted
getUpcomingTasks(db, { days })       // Due within N days
```

### Task Actions

```typescript
completeTask(db, id, completedAt?)   // Set completedAt
uncompleteTask(db, id)               // Clear completedAt
archiveTask(db, id)                  // Soft delete
unarchiveTask(db, id)                // Restore
moveTask(db, id, { projectId?, statusId?, parentId?, position? })
reorderTasks(db, items: Array<{id, position}>)
duplicateTask(db, id)                // Clone with "(copy)" suffix
```

### Tags & Note Links

```typescript
setTaskTags(db, taskId, tags)        // Replace all tags
getTaskTags(db, taskId)              // Get task's tags
getAllTaskTags(db)                   // All tags with counts

setTaskNotes(db, taskId, noteIds)    // Replace linked notes
getTaskNoteIds(db, taskId)           // Get linked note IDs
getTasksLinkedToNote(db, noteId)     // Reverse lookup
```

### Bulk Operations

```typescript
bulkCompleteTasks(db, ids)
bulkDeleteTasks(db, ids)
bulkMoveTasks(db, ids, projectId)
bulkArchiveTasks(db, ids)
```

### Statistics

```typescript
getTaskStats(db): {
  total: number,
  completed: number,
  overdue: number,
  dueToday: number,
  dueThisWeek: number,
}
```

### Projects Query Layer (`src/shared/db/queries/projects.ts`)

```typescript
// CRUD
insertProject, updateProject, deleteProject, getProjectById, listProjects

// With stats
getProjectsWithStats(db): Array<{
  ...project,
  taskCount: number,
  completedCount: number,
  overdueCount: number,
}>

// Archive
archiveProject(db, id)    // Prevents inbox archival
unarchiveProject(db, id)

// Ordering
reorderProjects(db, items)
getNextProjectPosition(db)

// Statuses
createStatus, updateStatus, deleteStatus, listStatusesByProject
getDefaultStatus(db, projectId)
getDoneStatus(db, projectId)
setDefaultStatus(db, statusId)
setDoneStatus(db, statusId)
reorderStatuses(db, items)
```

---

## 4. IPC Communication Layer

**File:** `src/main/ipc/tasks-handlers.ts` (755 lines)

### Handler Pattern

```typescript
import { ipcMain } from 'electron'
import { createValidatedHandler } from './validate'
import { TaskCreateSchema } from '@shared/contracts/tasks-api'

ipcMain.handle('tasks:create', createValidatedHandler(TaskCreateSchema, async (input) => {
  const db = requireDatabase()
  const task = await taskQueries.insertTask(db, input)
  emitTaskEvent('tasks:created', task)
  return { success: true, data: task }
}))
```

### IPC Channels

**Task Operations:**
- `tasks:create`, `tasks:get`, `tasks:update`, `tasks:delete`, `tasks:list`
- `tasks:complete`, `tasks:uncomplete`
- `tasks:archive`, `tasks:unarchive`
- `tasks:move`, `tasks:reorder`, `tasks:duplicate`
- `tasks:get-subtasks`, `tasks:convert-to-subtask`, `tasks:convert-to-task`
- `tasks:get-tags`

**Project Operations:**
- `tasks:project-create`, `tasks:project-get`, `tasks:project-update`, `tasks:project-delete`
- `tasks:project-list`, `tasks:project-archive`, `tasks:project-reorder`

**Status Operations:**
- `tasks:status-create`, `tasks:status-update`, `tasks:status-delete`
- `tasks:status-reorder`, `tasks:status-list`

**Bulk Operations:**
- `tasks:bulk-complete`, `tasks:bulk-delete`, `tasks:bulk-move`, `tasks:bulk-archive`

**Stats & Views:**
- `tasks:get-stats`, `tasks:get-today`, `tasks:get-upcoming`, `tasks:get-overdue`

### Event Emission

```typescript
function emitTaskEvent(channel: string, data: unknown) {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send(channel, data)
  })
}
```

Events emitted: `tasks:created`, `tasks:updated`, `tasks:deleted`, `tasks:completed`, `tasks:moved`, `tasks:project-created`, `tasks:project-updated`, `tasks:project-deleted`

---

## 5. Renderer Service Layer

**File:** `src/renderer/src/services/tasks-service.ts`

Type-safe wrapper around `window.api.tasks`:

```typescript
export const tasksService = {
  // Tasks
  create: (input: TaskCreateInput) => window.api.tasks.create(input),
  get: (id: string) => window.api.tasks.get(id),
  update: (input: TaskUpdateInput) => window.api.tasks.update(input),
  delete: (id: string) => window.api.tasks.delete(id),
  list: (filters?: TaskListInput) => window.api.tasks.list(filters),
  complete: (id: string) => window.api.tasks.complete(id),
  // ... etc
}

// Event listeners (return unsubscribe function)
export const onTaskCreated = (callback: (task: Task) => void) => {
  const handler = (_event: unknown, task: Task) => callback(task)
  window.api.tasks.onCreated(handler)
  return () => window.api.tasks.offCreated(handler)
}
```

---

## 6. React Context & State Management

**File:** `src/renderer/src/contexts/tasks/index.tsx`

### Context Value Interface

```typescript
interface TasksContextValue {
  // Data
  tasks: Task[]
  projects: Project[]

  // Selection state
  taskSelectedId: string
  taskSelectedType: 'view' | 'task' | 'project'
  selectedTaskIds: Set<string>

  // Actions
  setTasks: (tasks: Task[]) => void
  setProjects: (projects: Project[]) => void
  addTask: (task: Task) => void
  updateTask: (id: string, updates: Partial<Task>) => void
  deleteTask: (id: string) => void
  addProject: (project: Project) => void
  updateProject: (id: string, updates: Partial<Project>) => void
  deleteProject: (id: string) => void
  setSelectedTaskIds: (ids: Set<string>) => void
}
```

### Data Loading

```typescript
// On vault open, loads all data
useEffect(() => {
  if (isVaultOpen) {
    loadProjects()
    loadTasks()
    subscribeToEvents()
  }
}, [isVaultOpen])
```

### Type Conversion

Database uses primitives (priority as 0-3, dates as YYYY-MM-DD strings).
UI uses rich types (priority enum, Date objects).

```typescript
function dbTaskToUiTask(dbTask: DbTask): UiTask {
  return {
    ...dbTask,
    priority: priorityFromInt(dbTask.priority),
    dueDate: dbTask.dueDate ? parseDate(dbTask.dueDate) : undefined,
    // ... etc
  }
}
```

---

## 7. Custom Hooks

### `use-task-filters.ts`

Filter/sort state with localStorage persistence per view:

```typescript
const { filters, setFilters, clearFilters, hasActiveFilters } = useTaskFilters('inbox')
```

### `use-task-order.ts`

Task position/reordering persistence.

### `use-task-selection.ts`

Multi-select for bulk operations:

```typescript
const {
  selectedIds,
  isSelected,
  select,
  toggle,
  selectRange,
  clearSelection
} = useTaskSelection()
```

### `use-task-settings.ts`

Task-specific settings management.

---

## 8. UI Components

### Core Display Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `task-row.tsx` | `/tasks/` | Individual task rendering |
| `task-list.tsx` | `/tasks/` | Task collection with grouping |
| `task-group.tsx` | `/tasks/` | Group tasks by status/date/project |
| `task-section.tsx` | `/tasks/` | Section wrapper with headers |

### Detail Panel

| Component | Location | Purpose |
|-----------|----------|---------|
| `task-detail-panel.tsx` | `/tasks/` | Right-side detail view |
| `task-properties-grid.tsx` | `/tasks/` | Grid of editable fields |
| `task-description.tsx` | `/tasks/` | Description editor |

### Subtask Components

Located in `/tasks/`:
- `subtask-row.tsx`, `sortable-subtask-row.tsx`
- `sortable-subtask-list.tsx`
- `add-subtask-input.tsx`
- `subtask-badge.tsx`, `subtask-progress-badge.tsx`, `subtask-dots.tsx`

### Interactive Badges

**File:** `task-badges.tsx`
- `TaskCheckbox` - Completion toggle
- `InteractiveProjectBadge` - Project selector dropdown
- `InteractivePriorityBadge` - Priority picker
- `InteractiveDueDateBadge` - Date picker

### Modals & Dialogs

- `add-task-modal.tsx` - New task form
- `project-modal.tsx` - New/edit project
- `delete-task-dialog.tsx`, `delete-project-dialog.tsx`
- `due-date-picker.tsx` - Calendar + time picker
- `custom-repeat-dialog.tsx` - Advanced repeat config

### View-Specific Components

```
/tasks/
├── calendar/      # Calendar view
├── kanban/        # Kanban board
├── today/         # Today's tasks view
├── upcoming/      # Upcoming tasks view
├── completed/     # Archive view
├── projects/      # Project sidebar
├── bulk-actions/  # Multi-task operations
├── filters/       # View-specific filtering
└── empty-states/  # No tasks messaging
```

---

## 9. Key Architectural Patterns

### Validation at Boundaries

```
Frontend → Zod schemas validate before IPC call
IPC Handler → createValidatedHandler() validates input
Database → Drizzle enforces types and constraints
```

### Real-Time Sync

All mutations emit IPC events → Context subscribes → Multi-window support

### Soft Deletes

Tasks and projects use `archivedAt` nullable field:
- Queries filter by `isNull(archivedAt)` by default
- Preserves audit trail and enables undo

### Subtask Hierarchy

- Self-referential `parentId` field
- Cascade delete (task deletion removes subtasks)
- Separate `getSubtasks()` query for efficient loading
- Completion counts tracked separately

### Pagination & Performance

- List queries support `limit` + `offset`
- View-specific queries (today, upcoming, overdue)
- Database indexes on filter columns

---

## 10. Example: Creating a Task

1. User opens `add-task-modal.tsx`
2. Form validates with Zod schema
3. Service calls `window.api.tasks.create(input)`
4. IPC handler validates with `TaskCreateSchema`
5. Handler calls `taskQueries.insertTask(db, task)`
6. Drizzle inserts into SQLite
7. Handler returns task and emits `tasks:created` event
8. Context receives event via `onTaskCreated()`
9. `TasksProvider` updates state: `setTasks(prev => [newTask, ...prev])`
10. Components re-render with new task

---

## 11. Adding New Task Features

### To add a new task field:

1. **Schema**: Add column to `src/shared/db/schema/tasks.ts`
2. **Migration**: Run `pnpm db:generate` and `pnpm db:push`
3. **Contract**: Add to schemas in `src/shared/contracts/tasks-api.ts`
4. **Queries**: Update relevant queries in `src/shared/db/queries/tasks.ts`
5. **IPC Handler**: Handle field in `src/main/ipc/tasks-handlers.ts`
6. **Service**: Update types in `src/renderer/src/services/tasks-service.ts`
7. **Context**: Update type conversion in `src/renderer/src/contexts/tasks/`
8. **UI**: Add to detail panel and/or task row

### To add a new task operation:

1. **Contract**: Add Zod schema in `src/shared/contracts/tasks-api.ts`
2. **Channel**: Add to `src/shared/ipc-channels.ts`
3. **Query**: Add function in `src/shared/db/queries/tasks.ts`
4. **Handler**: Add `ipcMain.handle()` in `src/main/ipc/tasks-handlers.ts`
5. **Preload**: Expose in `src/preload/index.ts`
6. **Types**: Add to `src/preload/index.d.ts`
7. **Service**: Add method in `src/renderer/src/services/tasks-service.ts`
8. **Hook/Context**: Integrate as needed

---

## 12. Testing Considerations

- Task queries can be tested with in-memory SQLite
- IPC handlers mock the database connection
- Context tests mock the service layer
- Component tests use React Testing Library

## 13. Common Gotchas

1. **Priority is 0-3 integer in DB**, converted to enum in UI
2. **Dates are strings (YYYY-MM-DD)** in DB, may be Date objects in UI
3. **Always validate** at IPC boundary with `createValidatedHandler()`
4. **Emit events** after mutations for multi-window sync
5. **Filter archived** tasks by default (`isNull(archivedAt)`)
6. **Inbox project** cannot be archived or deleted
7. **Status deletion** sets tasks' statusId to null (doesn't delete tasks)
