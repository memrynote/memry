# Implementation Plan: Task Management Data Layer

**Branch**: `002-task-data-layer` | **Date**: 2025-12-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-task-data-layer/spec.md`

## Summary

Build the task management data layer that persists tasks, projects, and enables the existing UI components. **Status: Backend is ALREADY IMPLEMENTED**. The focus is on verifying integration and completing minor gaps.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode)
**Primary Dependencies**: React 19, Drizzle ORM, better-sqlite3, electron-vite, shadcn/ui
**Storage**: SQLite (data.db for tasks/projects, source of truth)
**Testing**: Vitest (unit), Playwright (e2e)
**Target Platform**: Electron (macOS, Windows, Linux)
**Project Type**: Electron desktop app (main + renderer processes)
**Performance Goals**: <100ms task operations, 60fps scrolling with 1000+ tasks
**Constraints**: Offline-first, local-only storage, no cloud sync (yet)
**Scale/Scope**: ~10,000 tasks per vault, 144 UI components, ~3000 LOC backend

## Constitution Check

*GATE: ✅ PASSED*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Local-First | ✅ Pass | Data in SQLite in vault folder |
| II. E2EE | N/A | No sync yet |
| III. No Vendor Lock-In | ✅ Pass | SQLite exportable, markdown notes |
| IV. Privacy by Design | ✅ Pass | No telemetry |
| V. Offline-First | ✅ Pass | Works without network |
| VI. File System Source of Truth | ✅ Pass (notes) | Tasks use DB as source of truth per VII |
| VII. Database for Structured Data | ✅ Pass | Tasks/projects in SQLite |
| VIII. External Edit Detection | N/A | DB is app-controlled |
| IX. Rename Tracking | ✅ Pass | Tasks use stable IDs |
| X. Single Source of Truth | ✅ Pass | DB is authoritative for tasks |

## Project Structure

### Documentation (this feature)

```text
specs/002-task-data-layer/
├── plan.md              # This file
├── spec.md              # Feature specification
└── tasks.md             # Implementation tasks (to be generated)
```

### Source Code (Electron architecture)

```text
src/
├── main/                          # Main process (Node.js)
│   ├── ipc/
│   │   └── tasks-handlers.ts      # ✅ 755 lines - Task/Project/Status IPC handlers
│   └── database/
│       └── client.ts              # Drizzle ORM client
├── shared/                        # Shared between main/renderer
│   ├── db/
│   │   ├── schema/
│   │   │   ├── tasks.ts           # ✅ 45 lines - Tasks table
│   │   │   ├── projects.ts        # ✅ Projects table
│   │   │   ├── statuses.ts        # ✅ Statuses table
│   │   │   └── task-relations.ts  # ✅ Tags & note links
│   │   └── queries/
│   │       ├── tasks.ts           # ✅ ~700 lines - Task queries
│   │       └── projects.ts        # ✅ Project/Status queries
│   └── contracts/
│       └── tasks-api.ts           # Zod validation schemas
├── preload/
│   ├── index.ts                   # Exposes window.api.tasks
│   └── index.d.ts                 # Type definitions
└── renderer/
    └── src/
        ├── pages/
        │   └── tasks.tsx          # ✅ 1653 lines - Main tasks page
        ├── components/
        │   └── tasks/             # ✅ 144 component files
        ├── services/
        │   └── tasks-service.ts   # ✅ 438 lines - IPC client wrapper
        ├── contexts/
        │   └── tasks/
        │       └── index.tsx      # ✅ 493 lines - React context + DB integration
        ├── hooks/
        │   ├── use-task-selection.ts
        │   ├── use-task-order.ts
        │   ├── use-bulk-actions.ts
        │   ├── use-task-filters.ts
        │   └── use-subtask-management.ts
        └── lib/
            ├── task-utils.ts      # Filtering, sorting, grouping utilities
            └── subtask-utils.ts   # Subtask operations
```

**Structure Decision**: Electron architecture with main/renderer split. Backend layer complete, UI layer complete, integration layer mostly complete.

## Current Implementation Status

### Backend Layer: ✅ COMPLETE

| Component | File | Status |
|-----------|------|--------|
| Tasks Schema | `src/shared/db/schema/tasks.ts` | ✅ Complete |
| Projects Schema | `src/shared/db/schema/projects.ts` | ✅ Complete |
| Statuses Schema | `src/shared/db/schema/statuses.ts` | ✅ Complete |
| Task Relations | `src/shared/db/schema/task-relations.ts` | ✅ Complete |
| Task Queries | `src/shared/db/queries/tasks.ts` | ✅ Complete (~700 lines) |
| Project Queries | `src/shared/db/queries/projects.ts` | ✅ Complete |
| IPC Handlers | `src/main/ipc/tasks-handlers.ts` | ✅ Complete (~755 lines) |
| Tasks Service | `src/renderer/src/services/tasks-service.ts` | ✅ Complete (438 lines) |
| Tasks Context | `src/renderer/src/contexts/tasks/index.tsx` | ✅ Complete (493 lines) |

### UI Layer: ✅ COMPLETE

| Component Category | Files | Status |
|-------------------|-------|--------|
| Main Page | `pages/tasks.tsx` | ✅ 1653 lines |
| Task Rows | 7 variants | ✅ Complete |
| Kanban Board | 8 components | ✅ Complete |
| Calendar View | 8 components | ✅ Complete |
| Filters | 14 components | ✅ Complete |
| Bulk Actions | 9 components | ✅ Complete |
| Completed/Archive | 10 components | ✅ Complete |
| Detail Panel | 9 components | ✅ Complete |
| Dialogs | 9 components | ✅ Complete |
| Drag-Drop | 7 components | ✅ Complete |

### Integration Gaps: ⚠️ NEEDS WORK

| Gap | Location | Issue |
|-----|----------|-------|
| Status Loading | `contexts/tasks/index.tsx:89` | Sets `statuses: []` with TODO comment |
| RepeatConfig | `contexts/tasks/index.tsx:68` | `// TODO: Convert repeat config` |
| Client-Side Filtering | `pages/tasks.tsx` | Filters locally instead of using backend |
| Bulk Operations | `pages/tasks.tsx` | May not be using `tasksService.bulk*` methods |

## Complexity Tracking

*No violations identified.*

---

## UI Implementation Analysis

### Main Tasks Page (`src/renderer/src/pages/tasks.tsx`)

**Size**: 1653 lines, heavily feature-complete UI

**Key Features Implemented**:
- **4 View Modes**: List, Kanban, Calendar, Projects
- **4 Internal Tabs**: All, Today, Upcoming, Projects
- **Advanced Filtering**: Project, priority, due date, status, completion, repeating
- **Saved Filters**: Users can save/load filter presets (localStorage)
- **Bulk Actions**: Multi-select with complete, delete, priority, due date, move, archive
- **Subtask Management**: Add, complete, reorder, bulk operations, promote to task
- **Repeating Tasks**: Create next occurrence on complete, skip, stop repeating
- **Task Detail Panel**: Full editor with all properties, subtasks, links
- **Keyboard Shortcuts**: `/` search, `Cmd+A` select all, `Escape` deselect, etc.

### Component Architecture

**Total Components**: ~144 files across 14 subdirectories

| Category | Files | Purpose |
|----------|-------|---------|
| Task Rows | 7 | Display variants (normal, sortable, completed, parent) |
| Kanban | 8 | Board, columns, cards, drag overlay |
| Calendar | 8 | Month grid, day cells, task items |
| Filters | 14 | Search, project/priority/date filters, saved filters |
| Bulk Actions | 9 | Toolbar, buttons, dialogs |
| Completed | 10 | Completed/archived views, archive dialogs |
| Detail Panel | 9 | Subtask sections, editing |
| Dialogs | 9 | Delete, complete, bulk operations |
| Drag-Drop | 7 | Sortable rows, drop zones, overlays |
| Repeats | 6 | Repeat picker, custom dialog, indicators |

### Custom Hooks

| Hook | Purpose |
|------|---------|
| `useTaskSelection` | Multi-select state (selectedIds, selectRange, selectAll) |
| `useBulkActions` | Bulk operations (complete, delete, priority, move) |
| `useSubtaskManagement` | Subtask CRUD + 7 dialog states |
| `useFilterState` | Filter/sort state with localStorage persistence |
| `useSavedFilters` | Named filter preset management |
| `useFilteredAndSortedTasks` | Apply filters + sort with memoization |
| `useTaskOrder` | Manual task ordering per section |

### Type System

**Core Types** (from `data/tasks-data.ts` and `data/sample-tasks.ts`):

```typescript
type Priority = "none" | "low" | "medium" | "high" | "urgent"
type StatusType = "todo" | "in_progress" | "done"
type ViewMode = "list" | "kanban" | "calendar"

interface Task {
  id, title, description
  projectId, statusId
  priority: Priority
  dueDate: Date | null
  dueTime: string | null  // "HH:MM"
  isRepeating: boolean
  repeatConfig: RepeatConfig | null
  linkedNoteIds: string[]
  sourceNoteId: string | null
  parentId: string | null
  subtaskIds: string[]
  createdAt: Date
  completedAt: Date | null
  archivedAt: Date | null
}

interface Project {
  id, name, description, icon, color
  statuses: Status[]
  isDefault: boolean
  isArchived: boolean
  taskCount: number
}

interface Status {
  id, name, color
  type: StatusType
  order: number
}
```

---

## Backend Architecture

### Data Flow

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
UI Components
```

### Database Schema

**Tasks Table** (`src/shared/db/schema/tasks.ts`):
- `id` (PK), `projectId` (FK), `statusId` (FK), `parentId` (self-ref)
- `title`, `description`, `priority` (0-3 integer)
- `dueDate`, `dueTime`, `startDate` (strings: YYYY-MM-DD, HH:MM)
- `repeatConfig`, `repeatFrom` (JSON)
- `completedAt`, `archivedAt`, `createdAt`, `modifiedAt`

**Projects Table**: id, name, description, color, icon, position, isInbox, archivedAt

**Statuses Table**: id, projectId (FK), name, color, position, isDefault, isDone

**Relation Tables**: taskTags (taskId, tag), taskNotes (taskId, noteId)

### Tasks Service API

The `tasksService` provides full coverage:

**Task CRUD**: `create`, `get`, `update`, `delete`, `list`
**Task Actions**: `complete`, `uncomplete`, `archive`, `unarchive`, `move`, `reorder`, `duplicate`
**Subtasks**: `getSubtasks`, `convertToSubtask`, `convertToTask`
**Projects**: `createProject`, `getProject`, `updateProject`, `deleteProject`, `listProjects`, `archiveProject`, `reorderProjects`
**Statuses**: `createStatus`, `updateStatus`, `deleteStatus`, `reorderStatuses`, `listStatuses`
**Bulk**: `bulkComplete`, `bulkDelete`, `bulkMove`, `bulkArchive`
**Views**: `getStats`, `getToday`, `getUpcoming`, `getOverdue`
**Tags**: `getTags`

### Tasks Context (Database Integrated)

The `TasksProvider` already:
- ✅ Loads tasks/projects from database when vault opens
- ✅ Subscribes to IPC events for real-time updates
- ✅ Converts between DB types and UI types (priority int↔string, dates)
- ✅ Falls back to local state if database fails
- ✅ Provides addTask, updateTask, deleteTask operations

**Type Conversion**:
```typescript
const priorityMap = { 0: 'none', 1: 'low', 2: 'medium', 3: 'high' }
const priorityReverseMap = { none: 0, low: 1, medium: 2, high: 3, urgent: 3 }

function dbTaskToUiTask(dbTask) {
  return {
    ...dbTask,
    priority: priorityMap[dbTask.priority],
    dueDate: dbTask.dueDate ? new Date(dbTask.dueDate) : null,
    createdAt: new Date(dbTask.createdAt),
    completedAt: dbTask.completedAt ? new Date(dbTask.completedAt) : null,
  }
}
```

---

## Gap Analysis

| Feature | UI Status | Backend Status | Integration Status |
|---------|-----------|----------------|-------------------|
| Task CRUD | ✅ Complete | ✅ Complete | ✅ Connected |
| Project CRUD | ✅ Complete | ✅ Complete | ✅ Connected |
| Status CRUD | ✅ Complete | ✅ Complete | ⚠️ Not loading statuses per project |
| Filtering | ✅ Complete | ✅ Complete | ⚠️ UI filters locally, not via backend |
| Saved Filters | ✅ Complete | ❌ Not in DB | localStorage only |
| Bulk Operations | ✅ Complete | ✅ Complete | ⚠️ May not be using backend |
| Subtasks | ✅ Complete | ✅ Complete | ⚠️ Needs verification |
| Repeating Tasks | ✅ Complete | ✅ Schema exists | ⚠️ UI creates locally |
| Note Links | ✅ Complete | ✅ Schema exists | ⚠️ Needs verification |
| Archive/Unarchive | ✅ Complete | ✅ Complete | ⚠️ Needs verification |
| Undo Support | ✅ Complete | ❌ Not in backend | Client-side only |

### Key Observations

1. **Tasks Page Not Using TasksContext Directly**: The `tasks.tsx` page receives `tasks` and `onTasksChange` as props from the parent App, rather than using `useTasksContext()` directly.

2. **Status Loading Gap**: The context's `dbProjectToUiProject` sets `statuses: []` with comment "// Loaded separately".

3. **Filtering Done Client-Side**: The UI applies filters using `task-utils.ts` functions on already-loaded tasks, rather than calling `tasksService.list()` with filter params.

4. **RepeatConfig Conversion TODO**: In `dbTaskToUiTask`, there's a `// TODO: Convert repeat config` comment.

---

## Next Steps

### Phase 1: Verify Integration
- [ ] Trace data flow from App.tsx → TasksProvider → tasks.tsx
- [ ] Verify statuses are loading per project
- [ ] Test CRUD operations end-to-end

### Phase 2: Complete Integration Gaps
- [ ] Implement repeat config conversion in context
- [ ] Consider using backend filtering for large datasets
- [ ] Verify bulk operations use backend

### Phase 3: Testing
- [ ] Test with real vault and database
- [ ] Verify real-time sync across windows
- [ ] Test error handling and fallbacks
