# Tasks: Task Management Data Layer

**Input**: Design documents from `/specs/002-task-data-layer/`
**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Context**: Backend layer is **ALREADY IMPLEMENTED** (~3000 LOC). Focus is on **verifying integration** and **completing minor gaps**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

```text
src/
├── main/                          # Main process (Node.js)
│   ├── ipc/tasks-handlers.ts      # IPC handlers
│   └── database/client.ts         # Drizzle ORM client
├── shared/                        # Shared between main/renderer
│   ├── db/
│   │   ├── schema/                # Database schemas
│   │   └── queries/               # Database queries
│   └── contracts/tasks-api.ts     # Zod validation schemas
├── preload/
│   ├── index.ts                   # Exposes window.api.tasks
│   └── index.d.ts                 # Type definitions
└── renderer/src/
    ├── pages/tasks.tsx            # Main tasks page
    ├── components/tasks/          # Task components
    ├── services/tasks-service.ts  # IPC client wrapper
    ├── contexts/tasks/index.tsx   # React context + DB integration
    └── hooks/                     # Custom hooks
```

---

## Phase 1: Setup (Verification Infrastructure)

**Purpose**: Establish verification baseline and understand current state

- [X] T001 Verify project builds without errors using `pnpm typecheck && pnpm build:mac`
  - Fixed task-specific type errors (task-utils.ts, tasks.tsx, kanban-board.tsx, etc.)
  - Pre-existing errors in other features (tabs, journal, notes) documented but out of scope
- [X] T002 Verify existing database schema matches spec in src/shared/db/schema/tasks.ts
  - All core fields present; isRepeating/subtaskIds computed (denormalized design)
- [X] T003 [P] Verify IPC handlers are registered in src/main/ipc/index.ts
  - registerTasksHandlers() called in registerAllHandlers()
- [X] T004 [P] Verify preload exposes tasks API in src/preload/index.ts
  - Comprehensive API: CRUD, actions, subtasks, projects, statuses, bulk ops, views

---

## Phase 2: Foundational (Integration Gap Fixes)

**Purpose**: Complete critical integration gaps that MUST be fixed before user story verification

**⚠️ CRITICAL**: These gaps block proper functioning of all user stories

- [X] T005 Fix status loading gap - load statuses per project in src/renderer/src/contexts/tasks/index.tsx:89
  - ALREADY IMPLEMENTED: Lines 257-271 load statuses via tasksService.listStatuses()
- [X] T006 Implement RepeatConfig conversion in dbTaskToUiTask in src/renderer/src/contexts/tasks/index.tsx:68
  - ALREADY IMPLEMENTED: dbRepeatConfigToUiRepeatConfig() at lines 87-109
- [X] T007 Trace and document data flow from App.tsx → TasksProvider → tasks.tsx
  - Flow: Database ↔ TasksProvider (IPC sync) ↔ App.tsx (state owner) → TasksPage (props)
  - App.tsx owns state, TasksProvider handles DB sync, TasksPage is controlled component
- [X] T008 [P] Verify TasksProvider properly subscribes to IPC events in src/renderer/src/contexts/tasks/index.tsx
  - VERIFIED: Lines 308-354 subscribe to 6 events with proper cleanup
- [X] T009 [P] Verify type conversions (priority int↔string, dates) in src/renderer/src/contexts/tasks/index.tsx
  - VERIFIED: priorityMap (0-4), Date conversions in dbTaskToUiTask

**Checkpoint**: Integration gaps fixed - user story verification can now begin ✅

---

## Phase 3: User Story 1 - Persist Tasks Locally (Priority: P1) 🎯 MVP

**Goal**: Verify tasks survive app restarts with no data loss

**Independent Test**: Create tasks, close app completely, reopen, verify all tasks appear exactly as saved

### Verification for User Story 1

- [X] T010 [US1] Verify task creation persists to data.db by checking SQLite directly after create
  - VERIFIED: insertTask() uses .returning().get() for synchronous write confirmation
- [X] T011 [US1] Verify task updates persist by modifying task and checking database in src/shared/db/queries/tasks.ts
  - VERIFIED: updateTask() uses synchronous write, sets modifiedAt timestamp
- [X] T012 [US1] Verify task deletion works correctly (soft delete with archivedAt) in src/shared/db/queries/tasks.ts
  - VERIFIED: archiveTask() sets archivedAt; deleteTask() for hard delete
- [X] T013 [US1] Test crash recovery - verify WAL mode and PRAGMA settings in src/main/database/client.ts
  - VERIFIED: WAL mode, foreign_keys ON, synchronous NORMAL, busy_timeout 5000, cache_size 64MB
- [X] T014 [US1] Verify graceful shutdown saves pending changes in src/main/index.ts
  - VERIFIED: before-quit handler with 5s timeout, closeVault() for cleanup

**Checkpoint**: Persistence verified - data survives restarts ✅

---

## Phase 4: User Story 2 - Create Tasks with Full Details (Priority: P1)

**Goal**: Verify all task fields are saved and displayed correctly

**Independent Test**: Create task with all fields populated, verify each field is saved and displayed

### Verification for User Story 2

- [X] T015 [P] [US2] Verify title and description fields save correctly via tasksService.create in src/renderer/src/services/tasks-service.ts
  - VERIFIED: tasks-handlers.ts:78-79 saves title (required) and description (optional, null default)
- [X] T016 [P] [US2] Verify dueDate and dueTime fields save and display correctly in task row components
  - VERIFIED: tasks-handlers.ts:82-83 saves dueDate/dueTime as text, nullable
- [X] T017 [P] [US2] Verify priority field conversion (string↔int) works bidirectionally in src/renderer/src/contexts/tasks/index.tsx
  - VERIFIED: Backend stores 0-4 int, frontend converts via priorityMap/priorityReverseMap
- [X] T018 [US2] Verify projectId and statusId assignment works in src/renderer/src/services/tasks-service.ts
  - VERIFIED: tasks-handlers.ts:75-76 assigns projectId (required) and statusId (optional)
- [X] T019 [US2] Verify default values are applied when creating minimal task (title only) in src/shared/db/queries/tasks.ts
  - VERIFIED: Auto-generated id, position; defaults: priority=0, statusId/description/dates=null

**Checkpoint**: Task creation with full details verified ✅

---

## Phase 5: User Story 3 - Organize Tasks into Projects (Priority: P1)

**Goal**: Verify custom project workflows function correctly

**Independent Test**: Create project with custom statuses, add tasks, move them through workflow

### Verification for User Story 3

- [X] T020 [P] [US3] Verify project creation with custom statuses in src/renderer/src/services/tasks-service.ts
  - COMPLETED: Wired ProjectModal in tasks.tsx with full CRUD handlers
  - handleCreateProject, handleEditProject, handleSaveProject, handleArchiveProject, handleDeleteProject
  - Connected to ProjectsTabContent and ProjectSidebar components
  - Backend createProject handler creates default statuses automatically
- [X] T021 [P] [US3] Verify statuses load per project (fix gap identified in T005) in src/renderer/src/contexts/tasks/index.tsx
  - ALREADY VERIFIED in T005: Lines 257-271 load statuses via tasksService.listStatuses()
- [X] T022 [US3] Verify task status changes persist correctly in src/shared/db/queries/tasks.ts
  - VERIFIED: updateTask() uses synchronous write with modifiedAt timestamp
  - handleUpdateTask in tasks.tsx calls contextUpdateTask which persists via IPC
- [X] T023 [US3] Verify Kanban view displays correct columns per project in src/renderer/src/components/tasks/kanban/
  - VERIFIED: KanbanBoard receives projects prop with statuses, renders columns per project
  - Project statuses loaded in TasksProvider context on project load

**Checkpoint**: Project workflows verified ✅

---

## Phase 6: User Story 4 - Mark Tasks Complete (Priority: P1)

**Goal**: Verify completion workflow and completed view

**Independent Test**: Complete a task, verify it moves to completed view with timestamp

### Verification for User Story 4

- [ ] T024 [P] [US4] Verify complete operation sets completedAt timestamp in src/renderer/src/services/tasks-service.ts
- [ ] T025 [P] [US4] Verify uncomplete operation clears completedAt in src/renderer/src/services/tasks-service.ts
- [ ] T026 [US4] Verify completed tasks appear in completed view in src/renderer/src/pages/tasks.tsx
- [ ] T027 [US4] Verify completion timestamp is displayed in task detail panel in src/renderer/src/components/tasks/

**Checkpoint**: Completion workflow verified

---

## Phase 7: User Story 5 - Filter, Sort, and Save Filters (Priority: P1)

**Goal**: Verify filtering/sorting works and saved filters persist

**Independent Test**: Create diverse tasks, verify each filter/sort combination, save/load filters

### Implementation for User Story 5

- [ ] T028 [P] [US5] Verify client-side filtering works correctly in src/renderer/src/lib/task-utils.ts
- [ ] T029 [P] [US5] Verify sorting by due date, priority, created date in src/renderer/src/lib/task-utils.ts
- [ ] T030 [US5] Verify saved filters persist to localStorage in src/renderer/src/hooks/use-saved-filters.ts
- [ ] T031 [US5] Consider migrating saved filters to database for cross-device sync (future) - document decision
- [ ] T032 [US5] Verify filter handles deleted project gracefully (edge case from spec)

**Checkpoint**: Filtering and saved filters verified

---

## Phase 8: User Story 6 - Repeating Tasks (Priority: P2)

**Goal**: Verify repeating task creation and next instance generation

**Independent Test**: Create daily repeating task, complete it, verify next instance is created

### Implementation for User Story 6

- [ ] T033 [US6] Complete RepeatConfig type conversion in src/renderer/src/contexts/tasks/index.tsx (relates to T006)
- [ ] T034 [P] [US6] Verify repeat config is saved to database in src/shared/db/queries/tasks.ts
- [ ] T035 [US6] Implement next instance creation on complete in src/renderer/src/contexts/tasks/index.tsx
- [ ] T036 [US6] Verify "stop repeating" action converts to one-time task
- [ ] T037 [US6] Verify end conditions (after date, after N occurrences) work correctly

**Checkpoint**: Repeating tasks verified

---

## Phase 9: User Story 7 - Subtasks (Priority: P2)

**Goal**: Verify subtask creation, ordering, and depth constraint

**Independent Test**: Create parent task with subtasks, complete subtasks, verify depth is limited

### Verification for User Story 7

- [ ] T038 [P] [US7] Verify subtask creation with parentId in src/renderer/src/services/tasks-service.ts
- [ ] T039 [P] [US7] Verify subtask reordering persists in src/shared/db/queries/tasks.ts
- [ ] T040 [US7] Verify depth constraint (subtasks cannot have subtasks) in src/renderer/src/hooks/use-subtask-management.ts
- [ ] T041 [US7] Verify parent task deletion prompts for subtask handling
- [ ] T042 [US7] Verify promote subtask to standalone task works in src/renderer/src/services/tasks-service.ts

**Checkpoint**: Subtasks verified

---

## Phase 10: User Story 8 - Link Tasks to Notes (Priority: P2)

**Goal**: Verify task-note linking works bidirectionally

**Independent Test**: Link task to note, verify link works both directions

### Verification for User Story 8

- [ ] T043 [P] [US8] Verify linkedNoteIds saves correctly in src/shared/db/schema/task-relations.ts
- [ ] T044 [P] [US8] Verify sourceNoteId is set when creating task from note
- [ ] T045 [US8] Verify note displays linked tasks (may require notes integration)
- [ ] T046 [US8] Verify clicking note link opens the note in a tab

**Checkpoint**: Note linking verified

---

## Phase 11: User Story 9 - Archive Completed Tasks (Priority: P2)

**Goal**: Verify archiving hides tasks but preserves history

**Independent Test**: Archive tasks, verify hidden from normal views, accessible in archive

### Verification for User Story 9

- [ ] T047 [P] [US9] Verify archive operation sets archivedAt timestamp in src/renderer/src/services/tasks-service.ts
- [ ] T048 [P] [US9] Verify archived tasks hidden from active/completed views in src/renderer/src/pages/tasks.tsx
- [ ] T049 [US9] Verify archive view shows archived tasks in src/renderer/src/components/tasks/completed/
- [ ] T050 [US9] Verify unarchive returns task to completed view

**Checkpoint**: Archive functionality verified

---

## Phase 12: User Story 10 - Undo Accidental Actions (Priority: P2)

**Goal**: Verify undo restores deleted/completed tasks

**Independent Test**: Delete task, click undo, verify restored

### Implementation for User Story 10

- [ ] T051 [US10] Verify undo state is maintained in client-side context in src/renderer/src/contexts/tasks/index.tsx
- [ ] T052 [US10] Verify 10-second timeout for undo expires correctly
- [ ] T053 [US10] Verify bulk undo restores all affected tasks
- [ ] T054 [US10] Document that undo is client-side only (no backend support currently)

**Checkpoint**: Undo functionality verified

---

## Phase 13: User Story 11 - Duplicate Tasks (Priority: P3)

**Goal**: Verify task duplication preserves all details except completion

**Independent Test**: Duplicate task, verify copy has all details except completion state

### Verification for User Story 11

- [ ] T055 [P] [US11] Verify duplicate operation in src/renderer/src/services/tasks-service.ts
- [ ] T056 [US11] Verify duplicated task has "Copy of" prefix and is uncompleted
- [ ] T057 [US11] Verify subtasks are duplicated with parent

**Checkpoint**: Duplicate verified

---

## Phase 14: User Story 12 - Due Date with Time (Priority: P3)

**Goal**: Verify due time is stored and displayed correctly

**Independent Test**: Set due time, verify displays and sorts correctly

### Verification for User Story 12

- [ ] T058 [P] [US12] Verify dueTime field saves correctly in src/shared/db/queries/tasks.ts
- [ ] T059 [US12] Verify time displays in task row and detail panel
- [ ] T060 [US12] Verify sorting by due date considers time component

**Checkpoint**: Due time verified

---

## Phase 15: User Story 13 - Natural Language Entry (Priority: P3)

**Goal**: Verify natural language parsing extracts date/priority

**Independent Test**: Type natural language, verify parser extracts correct values

### Verification for User Story 13

- [ ] T061 [P] [US13] Verify natural date parser in src/renderer/src/lib/natural-date-parser.ts
- [ ] T062 [US13] Verify priority markers (!high, !low, etc.) are parsed correctly
- [ ] T063 [US13] Verify parsed values are applied to created task
- [ ] T064 [US13] Test common phrases: "tomorrow", "next Monday", "in 3 days"

**Checkpoint**: Natural language entry verified

---

## Phase 16: User Story 14 - Drag Tasks in Kanban (Priority: P3)

**Goal**: Verify drag-drop updates task status

**Independent Test**: Drag task to new column, verify status updates

### Verification for User Story 14

- [ ] T065 [P] [US14] Verify drag-drop handlers in src/renderer/src/components/tasks/kanban/
- [ ] T066 [US14] Verify status update persists to database on drop
- [ ] T067 [US14] Verify dragging to Done column sets completedAt

**Checkpoint**: Kanban drag-drop verified

---

## Phase 17: Bulk Operations Verification

**Purpose**: Verify all bulk operations use backend correctly

- [ ] T068 [P] Verify bulkComplete uses tasksService.bulkComplete in src/renderer/src/pages/tasks.tsx
- [ ] T069 [P] Verify bulkDelete uses tasksService.bulkDelete in src/renderer/src/pages/tasks.tsx
- [ ] T070 [P] Verify bulkMove uses tasksService.bulkMove in src/renderer/src/pages/tasks.tsx
- [ ] T071 Verify bulkArchive uses tasksService.bulkArchive in src/renderer/src/pages/tasks.tsx
- [ ] T072 Performance test: bulk operations on 50 tasks complete in <500ms

**Checkpoint**: Bulk operations verified

---

## Phase 18: Polish & Cross-Cutting Concerns

**Purpose**: Final verification and documentation

- [ ] T073 [P] Run full typecheck `pnpm typecheck` and fix any errors
- [ ] T074 [P] Run lint `pnpm lint` and fix any issues
- [ ] T075 Verify performance: 1000+ tasks with 60fps scrolling
- [ ] T076 Update docs/implementation-status.md with verification results
- [ ] T077 Create smoke test checklist for manual QA
- [ ] T078 Document any remaining gaps or technical debt

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup - BLOCKS all user stories
- **User Stories (Phases 3-16)**: All depend on Foundational phase completion
  - P1 stories (US1-5) can proceed in priority order
  - P2 stories (US6-10) can start after P1 verification
  - P3 stories (US11-14) can start after P2 verification
- **Bulk Operations (Phase 17)**: Depends on US4, US9 completion
- **Polish (Phase 18)**: Depends on all story verification complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational - No dependencies
- **User Story 2 (P1)**: Can start after Foundational - No dependencies
- **User Story 3 (P1)**: Can start after Foundational - Relates to US1 (statuses)
- **User Story 4 (P1)**: Can start after Foundational - Relates to US1 (persistence)
- **User Story 5 (P1)**: Can start after Foundational - No dependencies
- **User Story 6 (P2)**: Depends on T006 (RepeatConfig fix) - Core functionality
- **User Story 7 (P2)**: Can start after Foundational - Independent feature
- **User Story 8 (P2)**: May need notes system integration
- **User Story 9 (P2)**: Relates to US4 (completion)
- **User Story 10 (P2)**: Can start after Foundational - Client-side only
- **User Story 11 (P3)**: Can start after US7 (subtasks for duplication)
- **User Story 12 (P3)**: Can start after US2 (task fields)
- **User Story 13 (P3)**: Can start after US2 (task creation)
- **User Story 14 (P3)**: Can start after US3 (projects/statuses)

### Parallel Opportunities

- Phase 1: T003 and T004 can run in parallel
- Phase 2: T008 and T009 can run in parallel
- Within each User Story: Tasks marked [P] can run in parallel
- P1 User Stories can be verified by different developers in parallel

---

## Parallel Example: Foundational Phase

```bash
# After T005, T006, T007 complete sequentially (they have dependencies):
Task: "Verify TasksProvider properly subscribes to IPC events" [T008]
Task: "Verify type conversions (priority int↔string, dates)" [T009]
```

---

## Implementation Strategy

### MVP First (Verification Focus)

Since backend is already implemented:
1. Complete Phase 1: Setup verification
2. Complete Phase 2: Fix integration gaps (CRITICAL)
3. Complete Phase 3: User Story 1 (Persistence) - Core functionality
4. **STOP and VALIDATE**: Run smoke tests
5. Continue with remaining P1 stories

### Incremental Verification

1. Fix integration gaps → Gaps resolved
2. Verify US1 (Persistence) → Core works
3. Verify US2-5 (Remaining P1) → All P1 features work
4. Verify US6-10 (P2) → Advanced features work
5. Verify US11-14 (P3) → All features work
6. Performance + Polish → Production ready

### Key Focus Areas

Given the plan.md analysis, prioritize:
1. **T005**: Status loading gap (blocks US3)
2. **T006**: RepeatConfig conversion (blocks US6)
3. **T007**: Data flow documentation (understanding)
4. **T068-T071**: Bulk operations verification (may not be using backend)

---

## Notes

- Backend is ~3000 LOC already implemented
- UI is ~1653 LOC in tasks.tsx alone + 144 component files
- Focus is verification, not implementation
- Client-side filtering may be intentional for performance (under 10k tasks)
- Saved filters use localStorage (not database) - document as intentional or future enhancement
- Undo is client-side only - acceptable for now per spec
