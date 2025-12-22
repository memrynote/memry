# 002-Task-Data-Layer Smoke Test Checklist

**Purpose**: Manual QA validation before release
**Created**: 2024-12-22

## Prerequisites

- [ ] Open the app with a vault selected
- [ ] Ensure database is initialized (check for `.memry/data.db`)

---

## 1. Task CRUD Operations

### Create Task
- [ ] Create a task from inbox quick-add
- [ ] Create a task with title, description, priority
- [ ] Create a task with due date
- [ ] Create a task with due date AND time
- [ ] Task appears in list immediately
- [ ] Task persists after app restart

### Read Task
- [ ] Click task to open detail panel
- [ ] All fields display correctly (title, description, priority, dates)
- [ ] Subtasks display correctly if present

### Update Task
- [ ] Edit task title inline
- [ ] Edit task description in detail panel
- [ ] Change priority from detail panel
- [ ] Change due date from detail panel
- [ ] Add/change due time
- [ ] Changes persist after app restart

### Delete Task
- [ ] Delete task from context menu
- [ ] Undo deletion (within 10 seconds)
- [ ] Task removed from list
- [ ] Task removed from database

---

## 2. Project Operations

### Create Project
- [ ] Create new project from sidebar
- [ ] Set project name, color, icon
- [ ] Project appears in sidebar
- [ ] Project has default statuses (To Do, Done)

### Update Project
- [ ] Rename project
- [ ] Change project color
- [ ] Change project icon

### Delete Project
- [ ] Delete project (with tasks)
- [ ] Confirm deletion dialog appears
- [ ] Tasks are deleted/moved appropriately

---

## 3. Status/Column Operations

### Kanban View
- [ ] Switch to Kanban view
- [ ] All columns display correctly
- [ ] Tasks appear in correct columns

### Status Changes
- [ ] Create new status column
- [ ] Rename status column
- [ ] Delete status column (with tasks)
- [ ] Reorder status columns

---

## 4. Drag-Drop Operations

### Kanban Drag
- [ ] Drag task between columns
- [ ] Task status updates correctly
- [ ] Dragging to Done column sets completedAt
- [ ] Dragging away from Done clears completedAt
- [ ] Changes persist after app restart

### List Drag
- [ ] Reorder tasks within list
- [ ] Position persists after app restart

### Project Move
- [ ] Drag task to different project (sidebar)
- [ ] Task moves correctly with appropriate status mapping

---

## 5. Bulk Operations

### Selection
- [ ] Enable selection mode (checkbox column appears)
- [ ] Select multiple tasks
- [ ] Select all tasks
- [ ] Deselect all

### Bulk Complete
- [ ] Select 3+ incomplete tasks
- [ ] Click bulk complete
- [ ] All selected tasks marked done
- [ ] Undo works (within 10 seconds)

### Bulk Delete
- [ ] Select 3+ tasks
- [ ] Click bulk delete
- [ ] Confirmation dialog appears
- [ ] All selected tasks deleted

### Bulk Move
- [ ] Select 3+ tasks
- [ ] Move to different project
- [ ] All tasks moved correctly

### Bulk Archive
- [ ] Select 3+ tasks
- [ ] Click bulk archive
- [ ] All tasks archived
- [ ] Undo works (within 10 seconds)

---

## 6. Subtask Operations

### Create Subtask
- [ ] Add subtask to parent task
- [ ] Subtask appears indented under parent
- [ ] Parent shows subtask count

### Convert To/From Subtask
- [ ] Convert regular task to subtask
- [ ] Convert subtask to regular task

### Parent-Child Behavior
- [ ] Completing parent shows dialog about subtasks
- [ ] Deleting parent deletes subtasks

---

## 7. Duplicate Task

- [ ] Duplicate task from context menu
- [ ] Duplicate has "[Copy]" suffix
- [ ] All properties copied (priority, dates, description)
- [ ] Subtasks NOT copied (documented behavior)

---

## 8. Repeat/Recurring Tasks

- [ ] Set task to repeat daily
- [ ] Complete task
- [ ] Next occurrence created automatically
- [ ] Stop repeating (just this / all future)

---

## 9. Natural Language Entry

Test in quick-add input:

- [ ] "Buy groceries tomorrow" - parses tomorrow date
- [ ] "Meeting next Monday" - parses next Monday
- [ ] "Call mom in 3 days" - parses relative date
- [ ] "Review docs !!high" - parses high priority
- [ ] "Email team @work" - parses project/tag (if supported)

---

## 10. Filters & Views

### Filter Tasks
- [ ] Filter by priority
- [ ] Filter by status
- [ ] Filter by due date range
- [ ] Filter by project
- [ ] Clear all filters

### Views
- [ ] Switch to List view
- [ ] Switch to Kanban view
- [ ] Switch to Calendar view
- [ ] Switch to Today view
- [ ] Switch to Upcoming view

---

## 11. Performance Testing

### Seed Test Data
1. Open browser console (Cmd+Option+I)
2. Run: `window.api.tasks.seedPerformanceTest()`
3. Should create "Test" project with 1200 tasks

### Verify Performance
- [ ] Task list scrolls smoothly (60fps)
- [ ] Filtering responds in <100ms
- [ ] Bulk operations complete in <500ms
- [ ] No UI freezing during operations

### Cleanup
- [ ] Delete "Test" project after testing

---

## 12. Data Persistence

- [ ] Create several tasks and projects
- [ ] Quit app completely (Cmd+Q)
- [ ] Reopen app
- [ ] All data persists correctly
- [ ] Task positions preserved
- [ ] Project order preserved

---

## Test Results

| Section | Pass | Fail | Notes |
|---------|------|------|-------|
| 1. Task CRUD | | | |
| 2. Project Operations | | | |
| 3. Status Operations | | | |
| 4. Drag-Drop | | | |
| 5. Bulk Operations | | | |
| 6. Subtasks | | | |
| 7. Duplicate | | | |
| 8. Recurring | | | |
| 9. Natural Language | | | |
| 10. Filters & Views | | | |
| 11. Performance | | | |
| 12. Persistence | | | |

---

## Known Issues / Expected Behavior

1. **Pre-existing TypeScript errors**: There are ~50 TypeScript errors in non-task-related files (tabs, journal, notes). These are documented and out of scope for this feature.

2. **Subtask duplication**: When duplicating a task, subtasks are NOT duplicated. This is documented behavior.

3. **Bulk undo**: Undo for bulk operations has a 10-second timeout as per spec.

4. **Completed tasks**: Completed tasks may be filtered out by default in some views.
