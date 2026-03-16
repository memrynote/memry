# Task Feature Roadmap

## Current State

The task system is feature-rich: 136 components, 12 hooks, 3 views (list/kanban/calendar), repeating tasks, drag-drop, bulk ops, subtask hierarchy, field-level sync, full-text search. Color system migration to CSS variables is in progress.

---

## Tier 1 — Expected in any serious task app

### Reminders & Notifications
- **What**: System for "remind me 30min before", push notifications on due dates, daily digest
- **Why**: Tasks go overdue silently — no nudge mechanism
- **Scope**:
  - `reminders` table (taskId, type, triggerAt, dismissed)
  - Main process scheduler (check due dates on interval via `setInterval`)
  - Electron `Notification` API for native OS notifications
  - Notification preferences in settings (sound, badge, quiet hours)
  - Snooze: 5min / 15min / 1hr / custom
- **Complexity**: Medium — scheduler + IPC + notification UI
- **Dependencies**: Settings system (exists), main process lifecycle

### Task Dependencies
- **What**: "Blocked by" / "Blocks" relationships between tasks
- **Why**: Can't express "do X before Y" — critical for project planning
- **Scope**:
  - `task_dependencies` junction table (taskId, dependsOnTaskId, type)
  - Dependency types: `blocks`, `blocked_by`, `related`
  - Visual indicator on task row (blocked badge, dependency chain)
  - Circular dependency detection (topological sort)
  - Auto-suggest unblocking when dependency completed
- **Complexity**: Medium-High — UI for linking + cycle detection
- **Dependencies**: Task CRUD (exists)

### Activity Log / History
- **What**: Audit trail of changes per task (created, title changed, status changed, etc.)
- **Why**: Useful for multi-device sync debugging and understanding task evolution
- **Scope**:
  - `task_activity` table (taskId, action, field, oldValue, newValue, timestamp, deviceId)
  - Activity feed in task detail drawer
  - Filter by action type
  - Auto-generated entries on task mutations (IPC handler middleware)
- **Complexity**: Medium — write-path hooks + read UI
- **Dependencies**: Task handlers (exists), sync engine (for deviceId)

### Undo/Redo for Task Operations
- **What**: Reversible operations for accidental delete/complete/move/archive
- **Why**: No easy recovery path beyond manual archive browsing
- **Scope**:
  - Command pattern: each mutation creates an undoable command
  - Undo stack (in-memory, per-session)
  - Toast notification with "Undo" action button (5s window)
  - Support: delete, complete, move, archive, bulk ops
  - Keyboard shortcut: Cmd+Z / Ctrl+Z
- **Complexity**: Medium — command pattern + toast integration
- **Dependencies**: IPC handlers (exists)

### Keyboard Shortcuts
- **What**: Comprehensive keyboard navigation for power users
- **Why**: Mouse-dependent workflow is slow for heavy task management
- **Scope**:
  - Global: `n` (new task), `q` (quick add — exists), `f` (filter), `/` (search)
  - List navigation: `j`/`k` (up/down), `x` (toggle select), `e` (edit), `d` (done)
  - Task detail: `p` (priority cycle), `d` (due date picker), `s` (status)
  - Bulk: `Shift+click` range select, `Cmd+A` select all
  - Shortcut overlay: `?` to show all shortcuts
- **Complexity**: Low-Medium — hook-based, mostly wiring
- **Dependencies**: Keyboard shortcuts base hook (exists)

---

## Tier 2 — Differentiators

### Time Estimation & Tracking
- **What**: `estimatedMinutes` and `timeSpent` fields for workload planning
- **Why**: Can't plan workload or review time allocation
- **Scope**:
  - Add `estimated_minutes` and `time_spent_minutes` to tasks table
  - Timer UI in task detail drawer (start/stop/pause)
  - Daily/weekly time summary view
  - Workload bar per project
- **Complexity**: Medium
- **DB Changes**: Migration for 2 new columns + field clocks

### Task Templates
- **What**: Reusable task structures (e.g., "Weekly Review" with pre-filled subtasks)
- **Why**: Repetitive multi-step workflows get re-created manually each time
- **Scope**:
  - `task_templates` table (name, structure JSON with subtasks/priorities/tags)
  - "Save as template" action on any task
  - Template picker in add-task modal
  - Template library page in settings
- **Complexity**: Medium
- **Dependencies**: Task CRUD, subtasks

### Comments / Discussion on Tasks
- **What**: Threaded comments on tasks (beyond description)
- **Why**: Context gets lost; description is single-author
- **Scope**:
  - `task_comments` table (taskId, content, createdAt, deviceId)
  - Comment thread UI in task detail drawer
  - Markdown support in comments
  - Sync via existing sync engine
- **Complexity**: Medium

### Attachments / Files
- **What**: Attach files (images, PDFs, docs) to tasks
- **Why**: Related files live outside the task system
- **Scope**:
  - `task_attachments` table (taskId, filename, path, mimeType, size)
  - Drag-and-drop file upload in task detail
  - Inline preview for images
  - Storage: local vault folder + sync via R2
- **Complexity**: Medium-High (sync + storage)

### Smart Lists / Auto-Views
- **What**: Auto-generated views beyond saved filters
- **Why**: Manual filter setup for common patterns is tedious
- **Scope**:
  - "Stale tasks" — no update in >7 days
  - "Quick wins" — low effort + due soon
  - "Blocked" — has unresolved dependencies
  - "No project" — orphaned tasks
  - Configurable thresholds in settings
- **Complexity**: Low — query-based, mostly UI

### Focus / Today Planning
- **What**: "Plan my day" flow — drag tasks into today, time-blocking
- **Why**: Today view exists but no intentional daily planning workflow
- **Scope**:
  - Morning planning mode (modal or dedicated view)
  - Drag tasks from "All" into today's plan
  - Optional time blocks (8am-9am: Task X)
  - Daily review prompt (end of day)
- **Complexity**: Medium-High

---

## Tier 3 — Polish / Power User

### Natural Language Repeat in Quick-Add
- **What**: Parse "every monday" / "every 2 weeks" in quick-add input
- **Why**: Repeat config currently requires modal dialog
- **Scope**: Extend `quick-add-parser.ts` with repeat pattern recognition
- **Complexity**: Low

### System Tray / Menu Bar Widget
- **What**: Quick glance at today's tasks without opening main window
- **Why**: Reduces context-switch friction
- **Scope**: Electron tray menu with task list, quick-complete
- **Complexity**: Medium

### Import/Export
- **What**: CSV/JSON import from Todoist, TickTick, Things, Apple Reminders
- **Why**: Migration path for new users
- **Scope**: Parser per service, mapping to memry task schema, conflict resolution
- **Complexity**: Medium (per service)

### Batch Undo
- **What**: "Undo last N actions" — especially for bulk ops gone wrong
- **Why**: Bulk delete + immediate regret = data loss
- **Scope**: Extends undo stack to support grouped commands
- **Complexity**: Low (builds on undo/redo)

### Print / Share View
- **What**: Export task list or project as PDF / shareable link
- **Why**: Sharing progress with non-memry users
- **Scope**: HTML-to-PDF via Electron, optional share link via sync server
- **Complexity**: Medium

---

## Implementation Priority (suggested order)

1. **Keyboard shortcuts** — highest ROI, lowest complexity
2. **Undo/Redo** — safety net before adding more destructive features
3. **Reminders & Notifications** — core expectation for task apps
4. **Task Dependencies** — unlocks project planning use case
5. **Smart Lists** — low effort, high perceived value
6. **Time Estimation** — differentiator for productivity-focused users
7. **Activity Log** — debugging aid + user trust
8. **Task Templates** — workflow automation

---

## Current Branch Work (tasks-refinement)

### In Progress
- CSS variable migration for task colors (base.css + 14 components)
- Component polish: celebration-progress, group-header, quick-add-input, badges

### Test Fixes Needed
- `task-grouping.ts`: sync hardcoded overdue color `#EB5757` → `#ef4444`
- `sort-dropdown.test.tsx`: update for new component structure (no radio buttons, case-sensitive labels)
- `tasks-tab-bar.test.tsx`: prop renamed `onDeleteSavedFilter` → `onUnstarSavedFilter`, aria-label changed
- `quick-add-input.test.tsx`: verify placeholder still matches regex
- `use-save-filter-shortcut.test.ts`: add `@vitest-environment jsdom` pragma
