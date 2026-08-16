# List vs Kanban

Two views over the same tasks.

<!-- screenshot: side-by-side list and kanban -->

## List View

Default. Tasks render as flat or grouped rows with inline editing of:

- Title
- Status
- Priority
- Due date
- Project
- Tags

Tasks linked to notes or filed audio items show a compact related-item indicator at the end of the
list row. Hover or focus the row to preview the related item title, then click the indicator to open
the note or file viewer. When a task has multiple related items, the indicator opens a small picker.

Click the row body to open the task detail drawer. Inline status and priority controls open their own pickers without opening the drawer.

The due-date chip opens its own picker too: quick presets, a month calendar, and an **Add time**
row below them. On a short window, or for a row near the bottom of the list, the presets and the
calendar scroll inside the picker while the time row stays pinned at its foot, so adding a time is
always reachable.

Drag the drawer's left edge to resize it; double-click the edge to reset to the default width. The width is remembered across restarts.

Rows can be drag-reordered. Multi-select with shift-click for bulk actions.

When grouping is on, group headers show counts and roll up subtask progress.

### When to Use List

- Long triage sessions
- Filtering a large pool of tasks by criteria
- Bulk actions across many tasks
- Cross-project review

## Kanban View

Columns reflect statuses. Drag cards across columns to update status.

- Each card shows title, due date, priority, and a subtask progress indicator
- The kanban groups by **status** by default but can group by other fields
- Empty columns offer "Add task" affordances

### When to Use Kanban

- Weekly planning ("what am I doing this week")
- Status-focused workflows (Todo / In Progress / Done)
- Per-project standups

## Internal Tabs

Above both views, internal tabs scope without changing filters:

| Tab       | Scope                                   |
| --------- | --------------------------------------- |
| All       | Everything that matches current filters |
| Today     | Due today (or earlier, undone)          |
| Completed | Recently completed (last 30 days)       |

Internal tabs are not filters in the saveable sense — they're shortcuts for the most common scopes.

## Switching

Use the view toggle in the tasks toolbar. memrynote remembers the last-used view per scope (per project, all-tasks, etc.).

## Project View vs All Tasks

Each [project](/user-guide/projects) has its own list/kanban. A project's kanban uses **that project's** custom statuses. The All Tasks kanban uses a shared coarse mapping.

## Drag Behavior

| In list                                     | In kanban                        |
| ------------------------------------------- | -------------------------------- |
| Reorder within a list                       | Reorder within a column          |
| Cross-group drag updates the grouping field | Cross-column drag updates status |
| Multi-select drag moves the whole selection | Same                             |

See [Drag & Drop](/user-guide/tasks/drag-and-drop) for the full reference.

## See Also

- [Filters & Sorting](/user-guide/tasks/filters-sorting)
- [Bulk Actions](/user-guide/tasks/bulk-actions)
