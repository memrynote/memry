# Task Backend Integration Gaps

This document catalogs all task-related UI actions in the Memry app and their backend integration status. Actions marked as **NOT IMPLEMENTED** require backend integration work.

## Summary

| Category | Implemented | Not Implemented | Unused |
|----------|-------------|-----------------|--------|
| Core CRUD | 6 | 0 | 0 |
| Repeat/Recurring | 0 | 5 | 0 |
| Completion/Archive | 1 | 4 | 5 |
| Bulk Operations | 4 | 2 | 0 |
| Subtasks | 0 | 5 | 0 |
| Drag & Drop | 0 | 3 | 0 |
| **Total** | **11** | **19** | **5** |

---

## 1. Core Task CRUD Operations

### IMPLEMENTED

| Action | Handler | File | Backend Method |
|--------|---------|------|----------------|
| Create Task | `handleAddTaskFromModal` | `pages/tasks.tsx:651` | `contextAddTask()` → `tasksService.create()` |
| Quick Add Task | `handleQuickAdd` | `pages/tasks.tsx:674` | `contextAddTask()` → `tasksService.create()` |
| Update Task | `handleUpdateTask` | `pages/tasks.tsx:854` | `contextUpdateTask()` → `tasksService.update()` |
| Delete Task | `handleDeleteTask` | `pages/tasks.tsx:859` | `contextDeleteTask()` → `tasksService.delete()` |
| Duplicate Task | `handleDuplicateTask` | `pages/tasks.tsx:882` | `contextAddTask()` → `tasksService.create()` |
| Toggle Complete | `handleToggleComplete` | `pages/tasks.tsx:726` | `contextUpdateTask()` → `tasksService.update()` |

---

## 2. Repeat/Recurring Task Operations

### NOT IMPLEMENTED - Priority: HIGH

These operations exist in UI but only update local state, not database.

#### T-GAP-001: Skip Occurrence
- **Handler**: `handleSkipOccurrence`
- **Location**: `pages/tasks.tsx:800-818`
- **Current Behavior**: Uses `setTasks()` to update local state only
- **Expected Behavior**: Should persist next due date to database
- **Implementation**:
  ```typescript
  // Current (broken)
  setTasks(prev => prev.map(t => t.id === taskId ? { ...t, dueDate: nextDate } : t))

  // Should be
  contextUpdateTask(taskId, { dueDate: nextDate })
  ```

#### T-GAP-002: Stop Repeating (Keep Task)
- **Handler**: `handleStopRepeating` with option "keep"
- **Location**: `pages/tasks.tsx:820-842`
- **Current Behavior**: Uses `setTasks()` to remove repeat config locally
- **Expected Behavior**: Should persist `isRepeating: false, repeatConfig: null` to database
- **Implementation**:
  ```typescript
  contextUpdateTask(taskId, { isRepeating: false, repeatConfig: null })
  ```
- **Backend Gap**: `repeatConfig` field not exposed in update handler

#### T-GAP-003: Stop Repeating (Delete Task)
- **Handler**: `handleStopRepeating` with option "delete"
- **Location**: `pages/tasks.tsx:820-842`
- **Current Behavior**: Uses `setTasks()` to filter out task locally
- **Expected Behavior**: Should call `contextDeleteTask(taskId)`
- **Implementation**: Change to use `contextDeleteTask(taskId)`

#### T-GAP-004: Create Repeat Config on Task Creation
- **Location**: `add-task-modal.tsx`, `contexts/tasks/index.tsx`
- **Current Behavior**: `repeatConfig` not sent to backend during create
- **Expected Behavior**: Should persist repeat configuration
- **Backend Gap**: `tasks:create` handler doesn't accept `repeatConfig`
- **Implementation**: Add `repeatConfig` to create contract and handler

#### T-GAP-005: Update Repeat Config
- **Location**: `task-detail-panel.tsx`, `custom-repeat-dialog.tsx`
- **Current Behavior**: Repeat config changes not persisted
- **Expected Behavior**: Should update `repeatConfig` in database
- **Backend Gap**: `tasks:update` handler doesn't accept `repeatConfig`
- **Implementation**: Add `repeatConfig` to update contract and handler

---

## 3. Completion & Archive Operations

### IMPLEMENTED

| Action | Handler | Backend Method |
|--------|---------|----------------|
| Toggle Complete | `handleToggleComplete` | `contextUpdateTask()` with `statusId`, `completedAt` |

### NOT IMPLEMENTED - Priority: MEDIUM

#### T-GAP-006: Uncomplete Task (Standalone)
- **Handler**: `_handleUncompleteTask` (unused, underscore prefix)
- **Location**: `pages/tasks.tsx:922-943`
- **Current Behavior**: Marked as unused, uses `setTasks()`
- **Expected Behavior**: Should use `tasksService.uncomplete()` which exists
- **Status**: Handler exists in tasksService but not wired up

#### T-GAP-007: Archive Single Task
- **Handler**: `_handleArchiveTask` (unused)
- **Location**: `pages/tasks.tsx:945-971`
- **Current Behavior**: Uses `setTasks()` locally
- **Expected Behavior**: Should use `tasksService.archive()`
- **Implementation**: Wire up to `tasksService.archive(taskId)`

#### T-GAP-008: Unarchive Task
- **Handler**: `_handleUnarchiveTask` (unused)
- **Location**: `pages/tasks.tsx:973-986`
- **Current Behavior**: Uses `setTasks()` locally
- **Expected Behavior**: Should use `tasksService.unarchive()`
- **Implementation**: Wire up to `tasksService.unarchive(taskId)`

#### T-GAP-009: Bulk Archive Completed Tasks
- **Handler**: `handleConfirmArchive`
- **Location**: `pages/tasks.tsx:1042-1066`
- **Current Behavior**: Uses `setTasks()` to update `archivedAt` locally
- **Expected Behavior**: Should use `tasksService.bulkArchive()`
- **Implementation**:
  ```typescript
  const taskIdsToArchive = completedTasks.map(t => t.id)
  await tasksService.bulkArchive(taskIdsToArchive)
  ```

#### T-GAP-010: Bulk Delete Completed/Archived Tasks
- **Handler**: `handleConfirmDeleteCompleted`
- **Location**: `pages/tasks.tsx:1085-1096`
- **Current Behavior**: Uses `setTasks()` to filter locally
- **Expected Behavior**: Should use `tasksService.bulkDelete()`
- **Implementation**:
  ```typescript
  const taskIdsToDelete = tasksToDelete.map(t => t.id)
  await tasksService.bulkDelete(taskIdsToDelete)
  ```

---

## 4. Bulk Operations

### IMPLEMENTED (via useBulkActions hook)

| Action | Handler | Backend Method |
|--------|---------|----------------|
| Bulk Change Priority | `handleBulkChangePriority` | `tasksService.bulkUpdate()` |
| Bulk Change Due Date | `handleBulkChangeDueDate` | `tasksService.bulkUpdate()` |
| Bulk Move to Project | `handleBulkMoveToProject` | `tasksService.bulkMove()` |
| Bulk Change Status | `handleBulkChangeStatus` | `tasksService.bulkUpdate()` |

### NOT IMPLEMENTED - Priority: MEDIUM

#### T-GAP-011: Bulk Complete
- **Location**: `bulk-action-toolbar.tsx`
- **Current Behavior**: May use local state updates
- **Expected Behavior**: Should use `tasksService.bulkComplete()`
- **Verification Needed**: Check `useBulkActions` hook implementation

#### T-GAP-012: Bulk Delete (Selected Tasks)
- **Handler**: `handleBulkDeleteConfirm`
- **Location**: `pages/tasks.tsx:1180-1183`
- **Current Behavior**: Calls `bulkActions.bulkDelete()`
- **Verification Needed**: Confirm hook uses `tasksService.bulkDelete()`

---

## 5. Subtask Operations

### NOT IMPLEMENTED - Priority: HIGH

#### T-GAP-013: Add Subtask
- **Component**: `add-subtask-input.tsx`
- **Current Behavior**: Calls `onAdd(parentId, title)` callback
- **Parent Handler**: Creates subtask via `contextAddTask()` with `parentId`
- **Issue**: Parent's `subtaskIds` array not updated in database
- **Implementation**: After creating subtask, update parent task's `subtaskIds`

#### T-GAP-014: Delete Subtask
- **Component**: `subtask-actions-menu.tsx`, `subtask-detail-item.tsx`
- **Current Behavior**: Calls `onDelete(subtaskId)` callback
- **Issue**: Parent's `subtaskIds` array not updated after delete
- **Implementation**: After deleting subtask, remove from parent's `subtaskIds`

#### T-GAP-015: Promote Subtask to Task
- **Component**: `subtask-actions-menu.tsx`
- **Handler**: `handlePromote`
- **Current Behavior**: May use local state only
- **Expected Behavior**: Should use `tasksService.convertToTask(subtaskId)`
- **Implementation**: Call service method and update parent's `subtaskIds`

#### T-GAP-016: Reorder Subtasks
- **Component**: `sortable-subtask-list.tsx`
- **Current Behavior**: Drag-drop reorders locally via @dnd-kit
- **Expected Behavior**: Should persist new order to database
- **Implementation**: On drag end, call `tasksService.reorder()` for subtasks

#### T-GAP-017: Load Subtasks on Task Load
- **Location**: `contexts/tasks/index.tsx:132`
- **Current Behavior**: `subtaskIds: []` hardcoded, marked with `// T007: Loaded separately`
- **Expected Behavior**: Should call `tasksService.getSubtasks()` per task or load all
- **Implementation**: Either eager load subtasks or lazy load when parent expanded

---

## 6. Drag & Drop / Reordering

### NOT IMPLEMENTED - Priority: MEDIUM

#### T-GAP-018: Task Reorder in List View
- **Component**: `drag-drop/sortable-task-row.tsx`
- **Current Behavior**: Reorder updates local state via `taskOrder.reorderByDrag()`
- **Expected Behavior**: Should persist position to database
- **Implementation**: After reorder, call `tasksService.reorder()`

#### T-GAP-019: Task Reorder in Kanban
- **Component**: `kanban/kanban-column.tsx`
- **Current Behavior**: Drag between columns updates status locally
- **Expected Behavior**: Should persist status and position
- **Implementation**: Call `tasksService.move()` with new `statusId` and position

#### T-GAP-020: Move Task to Different Project (via Drag)
- **Location**: `hooks/use-drag-handlers.ts`
- **Current Behavior**: May update `projectId` locally
- **Expected Behavior**: Should persist via `tasksService.move()`
- **Verification Needed**: Check if hook calls context methods

---

## 7. Backend Schema Gaps

### T-GAP-021: RepeatConfig Field Not Exposed
- **Schema**: `repeatConfig` exists in tasks table (JSON field)
- **Issue**: Not accepted in `create` or `update` IPC handlers
- **Files to Modify**:
  - `src/shared/contracts/tasks-api.ts` - Add to create/update schemas
  - `src/main/ipc/tasks-handlers.ts` - Accept in handlers
  - `src/main/database/queries/tasks.ts` - Include in insert/update

### T-GAP-022: Priority Level Mismatch
- **UI**: Supports 5 levels (none=0, low=1, medium=2, high=3, urgent=4)
- **Backend**: Only validates 0-3
- **Files to Modify**:
  - `src/shared/contracts/tasks-api.ts` - Extend priority validation to 0-4
  - `src/main/ipc/tasks-handlers.ts` - Accept priority 4

---

## 8. Implementation Priority

### Phase 1: Critical (Blocks Core Functionality)
1. T-GAP-001: Skip Occurrence
2. T-GAP-002: Stop Repeating (Keep)
3. T-GAP-003: Stop Repeating (Delete)
4. T-GAP-021: RepeatConfig Field Exposure
5. T-GAP-022: Priority Level Fix

### Phase 2: Important (Data Loss Risk)
6. T-GAP-009: Bulk Archive
7. T-GAP-010: Bulk Delete Completed
8. T-GAP-018: Task Reorder Persistence
9. T-GAP-019: Kanban Reorder Persistence

### Phase 3: Enhancement (Subtask Support)
10. T-GAP-013: Add Subtask (parent update)
11. T-GAP-014: Delete Subtask (parent update)
12. T-GAP-015: Promote Subtask
13. T-GAP-016: Reorder Subtasks
14. T-GAP-017: Load Subtasks

### Phase 4: Cleanup (Wire Up Existing)
15. T-GAP-006: Uncomplete Task
16. T-GAP-007: Archive Single Task
17. T-GAP-008: Unarchive Task

---

## 9. Files Reference

### Frontend (Renderer)
- `src/renderer/src/pages/tasks.tsx` - Main page with most handlers
- `src/renderer/src/contexts/tasks/index.tsx` - Context with DB operations
- `src/renderer/src/services/tasks-service.ts` - Service wrapper
- `src/renderer/src/hooks/use-bulk-actions.ts` - Bulk operations hook
- `src/renderer/src/hooks/use-drag-handlers.ts` - Drag-drop handlers

### Backend (Main)
- `src/main/ipc/tasks-handlers.ts` - IPC handlers
- `src/main/database/queries/tasks.ts` - Database queries
- `src/shared/contracts/tasks-api.ts` - API contracts/schemas
- `src/shared/db/schema/tasks.ts` - Database schema

---

## 10. Testing Checklist

After implementing each gap:
- [ ] Create task with repeat config → verify persists
- [ ] Skip occurrence → verify new date persists
- [ ] Stop repeating → verify repeat config removed
- [ ] Archive completed tasks → verify archivedAt set in DB
- [ ] Delete archived tasks → verify removed from DB
- [ ] Reorder tasks → verify position persists after refresh
- [ ] Add subtask → verify parent's subtaskIds updated
- [ ] Promote subtask → verify parentId cleared
