# Task Management Specification

Complete task management system with projects, statuses, and repeating tasks.

```
/speckit.specify

Build the task management data layer that persists tasks, projects, and enables the existing UI components:

## USER STORIES

### P1 - Critical
1. As a user, I want my tasks persisted locally so they survive app restarts
2. As a user, I want to create tasks with title, description, due date, and priority
3. As a user, I want to organize tasks into projects with custom status workflows (e.g., Backlog → In Progress → Review → Done)
4. As a user, I want to mark tasks as complete and see them in a completed view
5. As a user, I want to filter and sort tasks by various criteria (due date, priority, project, status)

### P2 - Important
6. As a user, I want repeating tasks that automatically create the next occurrence when I complete one
7. As a user, I want subtasks to break down complex tasks into smaller steps
8. As a user, I want to link tasks to notes for additional context
9. As a user, I want to archive completed tasks to keep my views clean while preserving history
10. As a user, I want undo support when I accidentally delete or complete a task

### P3 - Nice to Have
11. As a user, I want to duplicate tasks for similar recurring work
12. As a user, I want to set specific times for due dates (not just dates)
13. As a user, I want to add tasks from anywhere with natural language ("Buy milk tomorrow !high")
14. As a user, I want to drag tasks between status columns in Kanban view

## DATA MODELS

### Task
```typescript
interface Task {
  id: string                    // UUID
  title: string                 // Required, 1-500 chars
  description: string           // Optional, markdown supported
  projectId: string             // Required, references Project
  statusId: string              // Required, references Status in project
  priority: Priority            // "none" | "low" | "medium" | "high" | "urgent"

  // Due date
  dueDate: Date | null          // Date only (no time) or null
  dueTime: string | null        // "HH:MM" format if specific time needed

  // Repeating
  isRepeating: boolean
  repeatConfig: RepeatConfig | null

  // Hierarchy
  parentId: string | null       // For subtasks
  subtaskOrder: string[]        // Ordered list of subtask IDs

  // Linking
  linkedNoteIds: string[]       // References to note UUIDs
  sourceNoteId: string | null   // If created from a note

  // Timestamps
  createdAt: Date
  modifiedAt: Date
  completedAt: Date | null
  archivedAt: Date | null

  // Ordering
  sortOrder: number             // For manual ordering within lists
}

type Priority = "none" | "low" | "medium" | "high" | "urgent"
```

### RepeatConfig
```typescript
interface RepeatConfig {
  frequency: "daily" | "weekly" | "monthly" | "yearly"
  interval: number              // Every X days/weeks/months/years

  // Weekly options
  daysOfWeek?: number[]         // 0=Sun, 1=Mon, ..., 6=Sat

  // Monthly options
  monthlyType?: "dayOfMonth" | "weekPattern"
  dayOfMonth?: number           // 1-31
  weekOfMonth?: number          // 1-5 (5 = last)
  dayOfWeekForMonth?: number    // 0-6

  // End conditions
  endType: "never" | "date" | "count"
  endDate?: Date | null
  endCount?: number

  // Tracking
  completedCount: number
  createdAt: Date
}
```

### Project
```typescript
interface Project {
  id: string
  name: string                  // 1-100 chars
  description: string
  icon: string                  // Lucide icon name
  color: string                 // Hex color
  statuses: Status[]            // Ordered list of statuses
  isDefault: boolean            // One project is always default
  isArchived: boolean
  createdAt: Date
  modifiedAt: Date
  sortOrder: number             // For sidebar ordering
}
```

### Status
```typescript
interface Status {
  id: string
  name: string                  // 1-50 chars, unique within project
  color: string                 // Hex color
  type: "todo" | "in_progress" | "done"  // Semantic type
  order: number                 // Display order in project
}
```

## FUNCTIONAL REQUIREMENTS

### Task CRUD
- Create task with minimal info (title + project), defaults for rest
- Update any task field independently
- Delete task (soft delete to trash, hard delete after 30 days)
- Duplicate task (new ID, "Copy of" prefix, clear completion state)

### Task Completion
- Toggle complete: set completedAt timestamp, move to done status
- Toggle incomplete: clear completedAt, move to default todo status
- For repeating tasks on complete:
  1. Mark current instance as complete (clear repeatConfig)
  2. Calculate next occurrence date
  3. Create new task with next date (if not past end condition)

### Subtasks
- Create subtask: new task with parentId set
- Reorder subtasks: update parent's subtaskOrder array
- Complete subtask: normal completion (doesn't affect parent)
- Delete subtask: normal deletion
- Promote subtask: clear parentId, becomes standalone task

### Project Management
- Create project with name, choose icon/color
- Edit project details
- Archive project (hides from sidebar, keeps tasks)
- Delete project (only if no tasks, or move tasks first)
- Reorder projects in sidebar (update sortOrder)

### Status Management
- Each project has own status list
- Must have at least one "todo" type and one "done" type status
- Add/edit/remove statuses (can't remove if tasks use it)
- Reorder statuses (affects Kanban column order)

### Filtering (connect to existing FilterBar)
- Text search: fuzzy match on title and description
- Project filter: multi-select project IDs
- Priority filter: multi-select priorities
- Due date filter: Today, Tomorrow, This Week, Overdue, No Date, Custom Range
- Status filter: multi-select status IDs
- Completion filter: Active, Completed, All
- Repeat filter: All, Repeating Only, One-time Only

### Sorting
- By due date (nulls last or first, configurable)
- By priority (urgent first)
- By created date
- By title (alphabetical)
- By project
- Manual ordering (sortOrder field)

### Undo Support
- Delete task: keep in memory for 10 seconds, show undo toast
- Complete task: same pattern
- Bulk operations: undo restores all affected tasks

## NON-FUNCTIONAL REQUIREMENTS

### Performance
- Create 100 tasks in <1 second
- Load 500 tasks with smooth scrolling (virtualize list)
- Filter 10,000 tasks in <100ms
- Bulk operations (50 tasks) in <500ms

### Data Integrity
- Task must always have valid projectId and statusId
- Circular subtask references prevented
- Completed tasks preserve original due date
- sortOrder maintained without gaps on delete

## ACCEPTANCE CRITERIA

### Basic CRUD
- [ ] Create task appears in list immediately
- [ ] Edit task title updates everywhere it's shown
- [ ] Delete task shows undo toast, actually deletes after timeout
- [ ] Completing task moves to completed view, updates count

### Repeating Tasks
- [ ] Creating daily repeat shows "Repeats daily" badge
- [ ] Completing repeating task creates next occurrence
- [ ] Next occurrence has correct date based on config
- [ ] "Stop repeating" option removes repeat, keeps current task

### Subtasks
- [ ] Creating subtask indents under parent in list view
- [ ] Completing all subtasks doesn't auto-complete parent
- [ ] Deleting parent offers to delete or promote subtasks
- [ ] Reordering subtasks persists correctly

### Projects & Statuses
- [ ] New project appears in sidebar
- [ ] Changing task's project moves it correctly
- [ ] Adding status appears in Kanban as new column
- [ ] Deleting status with tasks shows error

### Filtering & Sorting
- [ ] Search "meeting" finds "Team Meeting Notes" task
- [ ] Filter by High priority shows only high priority tasks
- [ ] Sort by due date puts overdue first, then today, then future
- [ ] Saved filter can be loaded and applied

### Edge Cases
- [ ] Task with 100 subtasks renders without lag
- [ ] Completing task with no next repeat date shows message
- [ ] Moving task to archived project archives the task too
- [ ] Bulk delete 50 tasks completes without freeze
```
