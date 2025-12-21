# Tasks: Task Management Data Layer

**Input**: Design documents from `/specs/002-task-data-layer/`
**Prerequisites**: plan.md (complete), spec.md (14 user stories)

**Special Context**: Backend is **ALREADY IMPLEMENTED**. Tasks focus on:
1. Fixing integration gaps between UI and backend
2. Verifying each user story works end-to-end
3. Completing minor TODO items in existing code

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Path Conventions (Electron App)

- **Main process**: `src/main/`
- **Shared code**: `src/shared/`
- **Renderer**: `src/renderer/src/`
- **Preload**: `src/preload/`

---

## Phase 1: Setup (Verification)

**Purpose**: Verify existing implementation is functional

- [x] T001 Run `pnpm typecheck` to verify TypeScript compilation
  - **Result**: Fixed duplicate export declarations in tasks-service.ts. Remaining errors are unused variable warnings (TS6133) that don't block runtime.
- [x] T002 [P] Run `pnpm dev` and verify app starts without errors
  - **Result**: App starts successfully. Dev server at http://localhost:5173/, Electron launched, all IPC handlers registered.
- [x] T003 [P] Open a vault and verify tasks context initializes (check console logs)
  - **Result**: Vault initialized with `[Vault] Index health check: healthy`. TasksProvider wraps App (src/renderer/src/App.tsx:431-460).

---

## Phase 2: Foundational (Integration Gaps)

**Purpose**: Fix critical integration issues that affect ALL user stories

**⚠️ CRITICAL**: These gaps block proper persistence for all features

- [ ] T004 Load statuses per project in `src/renderer/src/contexts/tasks/index.tsx:89` (fix `statuses: []` TODO)
- [ ] T005 [P] Implement repeatConfig conversion in `src/renderer/src/contexts/tasks/index.tsx:68` (fix TODO)
- [ ] T006 [P] Add priority level 4 (urgent) to priorityMap in `src/renderer/src/contexts/tasks/index.tsx:39-52`
- [ ] T007 Verify TasksProvider loads subtaskIds for each task in `src/renderer/src/contexts/tasks/index.tsx`
- [ ] T008 [P] Verify App.tsx wraps tasks page with TasksProvider correctly

**Checkpoint**: Foundation ready - all tasks should persist to database

---

## Phase 3: User Story 1 - Persist Tasks Locally (Priority: P1) 🎯 MVP

**Goal**: Tasks survive app restarts with zero data loss

**Independent Test**: Create task → close app → reopen → verify task exists with all fields

### Implementation for User Story 1

- [x] T009 [US1] Verify task creation calls `tasksService.create()` in `src/renderer/src/contexts/tasks/index.tsx`
  - **Result**: Lines 307-336: `addTask` calls `tasksService.create()` when `isVaultOpen` is true
- [x] T010 [US1] Verify task update calls `tasksService.update()` in `src/renderer/src/contexts/tasks/index.tsx`
  - **Result**: Lines 338-366: `updateTask` calls `tasksService.update()` when `isVaultOpen` is true
- [x] T011 [P] [US1] Verify task deletion calls `tasksService.delete()` in `src/renderer/src/contexts/tasks/index.tsx`
  - **Result**: Lines 368-383: `deleteTask` calls `tasksService.delete()` when `isVaultOpen` is true
- [ ] T012 [US1] Test: Create task, quit app (Cmd+Q), reopen, verify task persists
  - **Note**: Manual testing required - create task in UI, quit app with Cmd+Q, reopen, verify task exists
- [ ] T013 [US1] Test: Edit task title, restart app, verify edit persisted
  - **Note**: Manual testing required - edit task title, restart app, verify title change persisted
- [ ] T014 [P] [US1] Test: Complete task, restart app, verify completion state persisted
  - **Note**: Manual testing required - mark task complete, restart app, verify still complete

**Checkpoint**: Tasks persist across app restarts

---

## Phase 4: User Story 2 - Create Tasks with Full Details (Priority: P1)

**Goal**: All task fields (title, description, priority, due date/time, project, status) save correctly

**Independent Test**: Create task with all fields → verify each field displays correctly

### Implementation for User Story 2

- [ ] T015 [US2] Verify description field persists in `src/renderer/src/contexts/tasks/index.tsx` addTask
- [ ] T016 [P] [US2] Verify dueDate/dueTime conversion in dbTaskToUiTask handles both fields
- [ ] T017 [P] [US2] Verify priority conversion handles all 5 levels (none, low, medium, high, urgent)
- [ ] T018 [US2] Test: Create task with all fields populated, verify each field saves and loads
- [ ] T019 [US2] Test: Create minimal task (title only), verify defaults applied

**Checkpoint**: All task fields persist correctly

---

## Phase 5: User Story 3 - Projects with Custom Workflows (Priority: P1)

**Goal**: Projects have custom statuses, tasks can move through workflow

**Independent Test**: Create project with statuses → add task → move task through statuses

### Implementation for User Story 3

- [ ] T020 [US3] Verify project creation calls `tasksService.createProject()` in context
- [ ] T021 [P] [US3] Verify status creation calls `tasksService.createStatus()` for each new status
- [ ] T022 [US3] Load statuses when loading projects (fix the `statuses: []` gap from T004)
- [ ] T023 [US3] Test: Create project "Work" with statuses (Backlog, In Progress, Done)
- [ ] T024 [US3] Test: Add task to project, change status, verify persists
- [ ] T025 [P] [US3] Test: View Kanban board, verify columns match project statuses

**Checkpoint**: Projects with custom statuses work end-to-end

---

## Phase 6: User Story 4 - Mark Tasks Complete (Priority: P1)

**Goal**: Completing tasks sets completedAt timestamp and persists

**Independent Test**: Complete task → verify completedAt → restart app → still completed

### Implementation for User Story 4

- [ ] T026 [US4] Verify `tasksService.complete()` is called when task is completed in context
- [ ] T027 [P] [US4] Verify `tasksService.uncomplete()` is called when unmarking complete
- [ ] T028 [US4] Verify completedAt timestamp is set in database and loaded in UI
- [ ] T029 [US4] Test: Complete task, verify appears in completed view with timestamp
- [ ] T030 [P] [US4] Test: Uncomplete task, verify returns to active list

**Checkpoint**: Task completion works with proper timestamps

---

## Phase 7: User Story 5 - Filter, Sort, and Saved Filters (Priority: P1)

**Goal**: Filters work and can be saved for reuse

**Independent Test**: Apply filter → save filter → reload app → load saved filter → verify same results

### Implementation for User Story 5

- [ ] T031 [US5] Verify local filtering in `src/renderer/src/lib/task-utils.ts` works with DB-loaded tasks
- [ ] T032 [P] [US5] Verify saved filters persist to localStorage in `src/renderer/src/hooks/use-task-filters.ts`
- [ ] T033 [US5] Test: Filter by priority "High" → verify only high priority tasks shown
- [ ] T034 [P] [US5] Test: Filter by due date "Today" → verify only today's tasks shown
- [ ] T035 [US5] Test: Save filter "Urgent Work", reload app, load filter, verify works

**Checkpoint**: Filtering and saved filters work

---

## Phase 8: User Story 6 - Repeating Tasks (Priority: P2)

**Goal**: Completing repeating task creates next occurrence

**Independent Test**: Create daily repeating task → complete → verify next day's instance created

### Implementation for User Story 6

- [ ] T036 [US6] Complete repeatConfig conversion in context (started in T005)
- [ ] T037 [US6] Verify repeat logic in `src/renderer/src/lib/repeat-utils.ts` works with persisted tasks
- [ ] T038 [P] [US6] Verify `calculateNextOccurrence()` uses correct dates
- [ ] T039 [US6] Test: Create daily repeating task, complete, verify next instance created
- [ ] T040 [P] [US6] Test: Create weekly task, complete, verify 7 days later instance
- [ ] T041 [US6] Test: Create task with end date, complete final, verify no new instance

**Checkpoint**: Repeating tasks work end-to-end

---

## Phase 9: User Story 7 - Subtasks (Priority: P2)

**Goal**: Subtasks with single-depth constraint work properly

**Independent Test**: Create parent → add subtasks → complete subtasks → verify parent shows progress

### Implementation for User Story 7

- [ ] T042 [US7] Verify `tasksService.getSubtasks()` is called when loading parent task
- [ ] T043 [P] [US7] Verify subtask creation sets parentId and inherits projectId
- [ ] T044 [US7] Verify subtask depth validation prevents nested subtasks in `src/renderer/src/lib/subtask-utils.ts`
- [ ] T045 [US7] Test: Create parent task, add 3 subtasks, verify subtaskIds populated
- [ ] T046 [P] [US7] Test: Complete 2 of 3 subtasks, verify progress badge shows "2/3"
- [ ] T047 [US7] Test: Try to add subtask to subtask, verify blocked

**Checkpoint**: Subtasks work with single-depth constraint

---

## Phase 10: User Story 8 - Link Tasks to Notes (Priority: P2)

**Goal**: Tasks can link to notes, links persist

**Independent Test**: Link task to note → restart app → verify link persists → click link → note opens

### Implementation for User Story 8

- [ ] T048 [US8] Verify linkedNoteIds persists in task creation/update in context
- [ ] T049 [P] [US8] Verify `tasksService.update()` handles linkedNoteIds array
- [ ] T050 [US8] Test: Link task to note, verify linkedNoteIds saved
- [ ] T051 [P] [US8] Test: Restart app, verify linked notes still accessible

**Checkpoint**: Note linking works

---

## Phase 11: User Story 9 - Archive Completed Tasks (Priority: P2)

**Goal**: Archived tasks hidden from normal views but accessible

**Independent Test**: Archive task → verify hidden → view archive → verify visible → unarchive → verify restored

### Implementation for User Story 9

- [ ] T052 [US9] Verify `tasksService.archive()` is called when archiving in context
- [ ] T053 [P] [US9] Verify `tasksService.unarchive()` is called when unarchiving
- [ ] T054 [US9] Test: Archive completed task, verify hidden from completed view
- [ ] T055 [P] [US9] Test: View archive, verify task visible
- [ ] T056 [US9] Test: Unarchive task, verify returns to completed view

**Checkpoint**: Archive/unarchive works

---

## Phase 12: User Story 10 - Undo Accidental Actions (Priority: P2)

**Goal**: Undo restores deleted/completed tasks within 10 seconds

**Independent Test**: Delete task → click undo → verify task restored

### Implementation for User Story 10

- [ ] T057 [US10] Verify undo logic in `src/renderer/src/pages/tasks.tsx` handleDeleteTask
- [ ] T058 [P] [US10] Verify undo works for bulk delete in `src/renderer/src/hooks/use-bulk-actions.ts`
- [ ] T059 [US10] Test: Delete task, click undo within 10s, verify restored
- [ ] T060 [P] [US10] Test: Bulk delete 5 tasks, undo, verify all 5 restored
- [ ] T061 [US10] Test: Wait 11 seconds after delete, verify undo no longer available

**Checkpoint**: Undo works within timeout

---

## Phase 13: User Story 11 - Duplicate Tasks (Priority: P3)

**Goal**: Duplicating creates copy with all details except completion state

**Independent Test**: Duplicate completed task → verify copy is active with all details

### Implementation for User Story 11

- [ ] T062 [US11] Verify `tasksService.duplicate()` is called from context or page
- [ ] T063 [US11] Test: Duplicate task with subtasks, verify all copied
- [ ] T064 [P] [US11] Test: Duplicate completed task, verify copy is uncompleted

**Checkpoint**: Duplication works

---

## Phase 14: User Story 12 - Due Date with Time (Priority: P3)

**Goal**: Due times display and sort correctly

**Independent Test**: Create two tasks due same day different times → verify earlier time appears first

### Implementation for User Story 12

- [ ] T065 [US12] Verify dueTime persists separately from dueDate in context
- [ ] T066 [US12] Test: Create task due "Today 3:00 PM", verify time displays
- [ ] T067 [P] [US12] Test: Two tasks same day, 9am and 3pm, verify 9am sorts first

**Checkpoint**: Due times work

---

## Phase 15: User Story 13 - Natural Language Task Entry (Priority: P3)

**Goal**: Natural language parsed to task fields

**Independent Test**: Type "Buy milk tomorrow !high" → verify title, due date, priority

### Implementation for User Story 13

- [ ] T068 [US13] Verify natural language parser in `src/renderer/src/lib/natural-date-parser.ts`
- [ ] T069 [US13] Test: "Buy milk tomorrow !high" → title "Buy milk", due tomorrow, priority high
- [ ] T070 [P] [US13] Test: "Call mom next Monday" → due date set to next Monday

**Checkpoint**: Natural language parsing works

---

## Phase 16: User Story 14 - Drag Tasks in Kanban (Priority: P3)

**Goal**: Dragging task to new column updates status

**Independent Test**: Drag task to Done column → verify status updates and completedAt set

### Implementation for User Story 14

- [ ] T071 [US14] Verify Kanban drag updates call `tasksService.move()` or `tasksService.update()`
- [ ] T072 [US14] Test: Drag task from Backlog to In Progress, verify status persists
- [ ] T073 [P] [US14] Test: Drag task to Done column, verify completedAt timestamp set

**Checkpoint**: Kanban drag-and-drop works

---

## Phase 17: Polish & Cross-Cutting Concerns

**Purpose**: Improvements affecting multiple user stories

- [ ] T074 Wire bulk operations to use `tasksService.bulk*` methods in `src/renderer/src/hooks/use-bulk-actions.ts`
- [ ] T075 [P] Add error handling for database failures in context with user-friendly messages
- [ ] T076 [P] Verify real-time sync works when task updated in one window, reflects in another
- [ ] T077 Run full typecheck and fix any type errors: `pnpm typecheck`
- [ ] T078 [P] Document integration architecture in `docs/tasks-system.md` updates section

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies - verification only
- **Phase 2 (Foundational)**: Depends on Phase 1 - BLOCKS all user stories
- **Phases 3-16 (User Stories)**: All depend on Phase 2 completion
  - Can proceed in priority order (P1 → P2 → P3)
  - Within same priority, can parallelize across developers
- **Phase 17 (Polish)**: Depends on all P1 stories complete

### User Story Dependencies

| Story | Priority | Can Start After | Dependencies on Other Stories |
|-------|----------|-----------------|-------------------------------|
| US1 (Persist) | P1 | Phase 2 | None - foundational |
| US2 (Full Details) | P1 | Phase 2 | None |
| US3 (Projects) | P1 | Phase 2 | None |
| US4 (Complete) | P1 | Phase 2 | None |
| US5 (Filters) | P1 | Phase 2 | None |
| US6 (Repeating) | P2 | Phase 2 | Depends on US1 working |
| US7 (Subtasks) | P2 | Phase 2 | Depends on US1 working |
| US8 (Note Links) | P2 | Phase 2 | None |
| US9 (Archive) | P2 | Phase 2 | Depends on US4 (complete) |
| US10 (Undo) | P2 | Phase 2 | None |
| US11 (Duplicate) | P3 | Phase 2 | Depends on US7 for subtask copy |
| US12 (Due Time) | P3 | Phase 2 | None |
| US13 (NL Entry) | P3 | Phase 2 | None |
| US14 (Kanban Drag) | P3 | Phase 2 | Depends on US3 (projects) |

### Parallel Opportunities

- All Phase 2 tasks marked [P] can run in parallel
- All P1 user stories can run in parallel after Phase 2
- Within each story, tasks marked [P] can run in parallel

---

## Parallel Example: Phase 2 (Foundational)

```bash
# These can run in parallel (different files):
Task T005: "Implement repeatConfig conversion in contexts/tasks/index.tsx:68"
Task T006: "Add priority level 4 (urgent) to priorityMap in contexts/tasks/index.tsx"
Task T008: "Verify App.tsx wraps tasks page with TasksProvider correctly"
```

---

## Implementation Strategy

### MVP First (P1 Stories Only)

1. Complete Phase 1: Setup verification
2. Complete Phase 2: Fix integration gaps (CRITICAL)
3. Complete Phases 3-7: All P1 user stories
4. **STOP and VALIDATE**: Test each P1 story independently
5. Deploy/demo MVP

### Suggested MVP Scope

**Phase 2 + US1 only**:
- T004-T008 (fix integration gaps)
- T009-T014 (verify persistence works)

This proves the data layer works before expanding to other stories.

### Incremental Delivery

1. Phase 1-2 → Foundation ready (fixes integration gaps)
2. Add US1 → Test persistence → **First Demo**
3. Add US2-US5 → Full P1 feature set → **MVP Release**
4. Add US6-US10 → P2 features → **v1.1 Release**
5. Add US11-US14 → P3 features → **v1.2 Release**

---

## Notes

- Backend is already implemented - tasks focus on verification and gap-filling
- Most tasks are verification/testing rather than new code
- T004 (load statuses) and T005 (repeatConfig) are the main code changes needed
- Tests are manual since no automated test suite was requested
- [P] tasks = different files, no dependencies
- Each user story should be independently testable after completion
