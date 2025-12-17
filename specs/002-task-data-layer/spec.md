# Feature Specification: Task Management Data Layer

**Feature Branch**: `002-task-data-layer`
**Created**: 2025-12-17
**Status**: Draft
**Input**: User description: "Build the task management data layer that persists tasks, projects, and enables the existing UI components"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Persist Tasks Locally (Priority: P1)

As a user, I want my tasks persisted locally so they survive app restarts.

**Why this priority**: Without persistence, users cannot rely on Memry for task management. This is the foundational requirement that makes everything else possible.

**Independent Test**: Can be fully tested by creating tasks, closing the app completely, reopening it, and verifying all tasks appear exactly as saved.

**Acceptance Scenarios**:

1. **Given** I create a task titled "Buy groceries," **When** I close and reopen Memry, **Then** the task appears in my task list with all its details intact.
2. **Given** I have 50 tasks with various due dates and priorities, **When** the app restarts unexpectedly (crash), **Then** no tasks are lost.
3. **Given** I mark a task as complete, **When** I reopen the app, **Then** the task remains in the completed state.

---

### User Story 2 - Create Tasks with Full Details (Priority: P1)

As a user, I want to create tasks with title, description, due date, and priority.

**Why this priority**: Users need to capture task information to effectively manage their work. Without rich task data, the app provides minimal value over a simple text list.

**Independent Test**: Can be fully tested by creating a task with all fields populated and verifying each field is saved and displayed correctly.

**Acceptance Scenarios**:

1. **Given** I am creating a new task, **When** I enter a title, description, select a due date, and set priority to "High," **Then** all fields are saved and displayed correctly.
2. **Given** I create a task with only a title (minimal info), **When** I view the task, **Then** it appears with sensible defaults (no due date, no priority).
3. **Given** I edit an existing task's due date, **When** I save, **Then** the change persists and the task appears in the correct date group.

---

### User Story 3 - Organize Tasks into Projects with Custom Workflows (Priority: P1)

As a user, I want to organize tasks into projects with custom status workflows (e.g., Backlog → In Progress → Review → Done).

**Why this priority**: Projects allow users to organize related work, and custom workflows let them match their actual process rather than forcing a one-size-fits-all approach.

**Independent Test**: Can be fully tested by creating a project with custom statuses, adding tasks, and moving them through the workflow.

**Acceptance Scenarios**:

1. **Given** I create a project called "Website Redesign," **When** I add custom statuses (Backlog, Design, Development, Review, Done), **Then** tasks in this project can be moved through these statuses.
2. **Given** I have tasks in a project, **When** I view Kanban mode, **Then** I see columns matching my custom statuses with tasks in the correct columns.
3. **Given** I change a task's status from "Backlog" to "In Progress," **When** I view the project, **Then** the task appears in the "In Progress" column.

---

### User Story 4 - Mark Tasks Complete (Priority: P1)

As a user, I want to mark tasks as complete and see them in a completed view.

**Why this priority**: Completing tasks is the core satisfaction of a task manager. Users need clear feedback and a way to review what they've accomplished.

**Independent Test**: Can be fully tested by completing a task and verifying it moves to the completed view with a completion timestamp.

**Acceptance Scenarios**:

1. **Given** I have an active task, **When** I mark it complete, **Then** it moves out of my active list and appears in the completed view.
2. **Given** I accidentally marked a task complete, **When** I mark it incomplete, **Then** it returns to my active task list.
3. **Given** I view completed tasks, **When** I look at a task, **Then** I can see when it was completed.

---

### User Story 5 - Filter and Sort Tasks (Priority: P1)

As a user, I want to filter and sort tasks by various criteria (due date, priority, project, status).

**Why this priority**: With many tasks, users need to focus on what matters now. Filtering and sorting are essential for productivity.

**Independent Test**: Can be fully tested by creating diverse tasks and verifying each filter/sort combination shows the correct subset.

**Acceptance Scenarios**:

1. **Given** I have tasks with different priorities, **When** I filter by "High" priority, **Then** only high-priority tasks appear.
2. **Given** I filter by "Today," **When** I view results, **Then** only tasks due today appear.
3. **Given** I sort by due date, **When** I view my tasks, **Then** overdue tasks appear first, then today, then future dates.
4. **Given** I search for "meeting," **When** results appear, **Then** I see all tasks with "meeting" in the title or description.

---

### User Story 6 - Repeating Tasks (Priority: P2)

As a user, I want repeating tasks that automatically create the next occurrence when I complete one.

**Why this priority**: Many real-world tasks recur (weekly reviews, monthly reports). Without this, users must manually recreate tasks.

**Independent Test**: Can be fully tested by creating a daily repeating task, completing it, and verifying the next instance is created with the correct date.

**Acceptance Scenarios**:

1. **Given** I create a task "Daily standup" that repeats daily, **When** I complete today's instance, **Then** a new task appears for tomorrow.
2. **Given** I have a weekly repeating task, **When** I complete it, **Then** the next instance appears 7 days later.
3. **Given** a repeating task has an end date, **When** I complete the last instance, **Then** no new task is created and I see a message.
4. **Given** I want to stop a repeat, **When** I choose "Stop repeating," **Then** the current task becomes a one-time task.

---

### User Story 7 - Subtasks (Priority: P2)

As a user, I want subtasks to break down complex tasks into smaller steps.

**Why this priority**: Complex tasks become manageable when broken into steps. Subtasks help users track progress on larger work items.

**Independent Test**: Can be fully tested by creating a parent task with subtasks, completing subtasks, and verifying the parent task displays progress.

**Acceptance Scenarios**:

1. **Given** I have a task "Plan vacation," **When** I add subtasks (book flights, reserve hotel, plan activities), **Then** they appear indented under the parent.
2. **Given** I complete all subtasks, **When** I view the parent, **Then** the parent is NOT automatically completed (user decides when done).
3. **Given** I delete a parent task, **When** prompted, **Then** I can choose to delete all subtasks or promote them to standalone tasks.
4. **Given** I reorder subtasks, **When** I drag them, **Then** the new order persists.

---

### User Story 8 - Link Tasks to Notes (Priority: P2)

As a user, I want to link tasks to notes for additional context.

**Why this priority**: Tasks often need reference material. Linking to notes keeps everything connected without duplicating content.

**Independent Test**: Can be fully tested by linking a task to a note and verifying the link works bidirectionally.

**Acceptance Scenarios**:

1. **Given** I have a task "Prepare presentation," **When** I link it to my "Presentation outline" note, **Then** I can click the link to open the note.
2. **Given** I open a note that has linked tasks, **When** I view the note, **Then** I can see which tasks reference it.
3. **Given** I create a task from within a note, **When** the task is created, **Then** it's automatically linked to that note.

---

### User Story 9 - Archive Completed Tasks (Priority: P2)

As a user, I want to archive completed tasks to keep my views clean while preserving history.

**Why this priority**: Old completed tasks clutter the interface. Archiving keeps focus on current work while preserving records.

**Independent Test**: Can be fully tested by archiving tasks and verifying they're hidden from normal views but accessible in an archive.

**Acceptance Scenarios**:

1. **Given** I have many completed tasks, **When** I archive them, **Then** they disappear from the completed view but remain accessible in the archive.
2. **Given** I need to find an old task, **When** I search the archive, **Then** I can find and view the task details.
3. **Given** I archived a task by mistake, **When** I unarchive it, **Then** it returns to the completed view.

---

### User Story 10 - Undo Accidental Actions (Priority: P2)

As a user, I want undo support when I accidentally delete or complete a task.

**Why this priority**: Mistakes happen. Quick undo prevents frustration and data loss.

**Independent Test**: Can be fully tested by deleting a task, clicking undo within the timeout, and verifying the task is restored.

**Acceptance Scenarios**:

1. **Given** I delete a task, **When** I immediately click "Undo" in the toast notification, **Then** the task is restored.
2. **Given** I accidentally complete a task, **When** I click "Undo," **Then** the task returns to active state.
3. **Given** I bulk-delete 10 tasks, **When** I click "Undo," **Then** all 10 tasks are restored.
4. **Given** the undo timeout (10 seconds) expires, **When** I try to undo, **Then** the option is no longer available.

---

### User Story 11 - Duplicate Tasks (Priority: P3)

As a user, I want to duplicate tasks for similar recurring work.

**Why this priority**: Nice-to-have feature that saves time when creating similar tasks.

**Independent Test**: Can be fully tested by duplicating a task and verifying the copy has all details except completion state.

**Acceptance Scenarios**:

1. **Given** I have a task with subtasks, **When** I duplicate it, **Then** a new task appears with "Copy of" prefix and all subtasks.
2. **Given** I duplicate a completed task, **When** I view the copy, **Then** it's in an active (uncompleted) state.

---

### User Story 12 - Set Due Date with Time (Priority: P3)

As a user, I want to set specific times for due dates (not just dates).

**Why this priority**: Some tasks need specific time deadlines (meetings, appointments).

**Independent Test**: Can be fully tested by setting a due time and verifying it displays and sorts correctly.

**Acceptance Scenarios**:

1. **Given** I create a task due "Today at 3:00 PM," **When** I view it, **Then** the time is displayed.
2. **Given** I have two tasks due today at different times, **When** I sort by due date, **Then** earlier times appear first.

---

### User Story 13 - Natural Language Task Entry (Priority: P3)

As a user, I want to add tasks from anywhere with natural language ("Buy milk tomorrow !high").

**Why this priority**: Power users appreciate quick entry. Natural language reduces friction.

**Independent Test**: Can be fully tested by typing natural language and verifying the parser extracts correct date and priority.

**Acceptance Scenarios**:

1. **Given** I type "Buy milk tomorrow !high," **When** I press Enter, **Then** a task is created with title "Buy milk," due date tomorrow, priority high.
2. **Given** I type "Call mom next Monday," **When** I press Enter, **Then** the due date is set to next Monday.
3. **Given** I type "Pay rent on the 1st every month," **When** I press Enter, **Then** a monthly repeating task is created.

---

### User Story 14 - Drag Tasks in Kanban (Priority: P3)

As a user, I want to drag tasks between status columns in Kanban view.

**Why this priority**: Visual workflow management is intuitive and efficient.

**Independent Test**: Can be fully tested by dragging a task to a new column and verifying its status updates.

**Acceptance Scenarios**:

1. **Given** I'm in Kanban view, **When** I drag a task from "Backlog" to "In Progress," **Then** the task's status updates to "In Progress."
2. **Given** I drag a task to the "Done" column, **When** I drop it, **Then** the task is marked complete with a timestamp.

---

### Edge Cases

- What happens when deleting a project with tasks? User must choose to move tasks to another project or delete them.
- What happens when deleting a status with tasks in it? The deletion is blocked with a clear error message.
- What happens with circular subtask references? The system prevents creating a subtask that references its parent or ancestors.
- What happens when a repeating task's end date has passed? No new instance is created; user is notified.
- What happens when bulk-deleting many tasks? The operation completes without freezing the UI; undo restores all.
- What happens with a task that has 100 subtasks? The UI remains responsive using virtualization.
- What happens when moving a task to an archived project? The task is also archived automatically.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST persist all task data locally so it survives app restarts and crashes.
- **FR-002**: System MUST allow creating tasks with title (required) and optional description, due date, due time, and priority.
- **FR-003**: System MUST support five priority levels: none, low, medium, high, and urgent.
- **FR-004**: System MUST allow organizing tasks into projects, each with customizable status workflows.
- **FR-005**: System MUST ensure each project has at least one "todo" type status and one "done" type status.
- **FR-006**: System MUST support marking tasks as complete, recording the completion timestamp.
- **FR-007**: System MUST support marking completed tasks as incomplete, returning them to active status.
- **FR-008**: System MUST support repeating tasks with configurable frequency (daily, weekly, monthly, yearly).
- **FR-009**: System MUST automatically create the next instance of a repeating task when the current one is completed.
- **FR-010**: System MUST support end conditions for repeating tasks: never, after a date, or after N occurrences.
- **FR-011**: System MUST support subtasks with unlimited nesting depth.
- **FR-012**: System MUST prevent circular subtask references.
- **FR-013**: System MUST support linking tasks to notes using note identifiers.
- **FR-014**: System MUST support archiving tasks to hide them from active views while preserving history.
- **FR-015**: System MUST provide undo support for delete and complete actions within 10 seconds.
- **FR-016**: System MUST support bulk operations (select multiple, delete, complete, move).
- **FR-017**: System MUST support text search with fuzzy matching on task title and description.
- **FR-018**: System MUST support filtering by: project, priority, due date range, status, completion state, repeating/one-time.
- **FR-019**: System MUST support sorting by: due date, priority, created date, title, manual order.
- **FR-020**: System MUST maintain task ordering when manually sorted.
- **FR-021**: System MUST support duplicating tasks, preserving all details except completion state.
- **FR-022**: System MUST use soft delete with a 30-day trash retention period before permanent deletion.
- **FR-023**: System MUST support dragging tasks between status columns in Kanban view.
- **FR-024**: System MUST parse natural language task input for dates, times, and priority markers.
- **FR-025**: System MUST ensure one project is always marked as the default for quick task entry.
- **FR-026**: System MUST track unique identifiers for each task that never change, enabling references and syncing.

### Key Entities

- **Task**: A work item with title, optional description, due date/time, priority, status, and relationships to project, parent task, and linked notes. Can be marked complete or archived.

- **Project**: A container for related tasks with a unique name, color, icon, and custom status workflow. One project is always the default. Projects can be archived but not deleted if they contain tasks.

- **Status**: A workflow stage within a project (e.g., "Backlog," "In Progress," "Done"). Has a semantic type (todo, in_progress, done), display name, color, and order.

- **Repeat Configuration**: Defines how a task repeats including frequency, interval, optional day constraints, and end conditions.

- **Subtask**: A child task linked to a parent task, displayed hierarchically. Inherits project from parent.

### Assumptions

- Users have a reasonable number of tasks (under 10,000) for typical usage.
- The default project is created automatically on first launch.
- The default project has standard statuses: To Do, In Progress, Done.
- Completed tasks older than 30 days are eligible for auto-archiving (configurable).
- Natural language parsing supports English date formats and priority markers (!low, !med, !high, !urgent).
- Task titles are limited to 500 characters; descriptions have no practical limit.
- When a parent task is deleted, user is prompted to handle subtasks.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can create, edit, and delete tasks that persist across app restarts with zero data loss.
- **SC-002**: Creating 100 tasks completes in under 1 second.
- **SC-003**: Loading and displaying 500 tasks with smooth 60fps scrolling (virtualized list).
- **SC-004**: Filtering 10,000 tasks returns results in under 100 milliseconds.
- **SC-005**: Bulk operations on 50 tasks complete in under 500 milliseconds.
- **SC-006**: Undo action restores deleted/completed tasks 100% of the time when used within timeout.
- **SC-007**: Completing a repeating task creates the next instance with correct date within 100ms.
- **SC-008**: 95% of users can create and organize tasks without consulting documentation.
- **SC-009**: Natural language parser correctly interprets common date/time phrases at least 90% of the time.
- **SC-010**: Task data remains consistent across all views (list, kanban, calendar) with no synchronization issues.
