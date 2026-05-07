# Bulk Actions

Select many tasks and act on them in one step.

<!-- screenshot: bulk action bar with multiple tasks selected -->

## Selecting Tasks

| How | Result |
| --- | --- |
| Click a row checkbox | Toggle that row |
| Shift-click | Range-select from previous |
| <kbd>⌘</kbd>-click | Toggle without affecting others |
| Drag-select (where supported) | Lasso-select rows |

The bulk action bar appears at the top of the view with the selection count.

## Available Actions

- **Status** — change to any status (project-aware)
- **Priority** — High / Medium / Low / None
- **Due date** — set or clear
- **Project** — move to a project (or remove project)
- **Tags** — add or remove tags
- **Subtask actions** — complete or uncomplete subtasks of the selection
- **Delete** — remove with a confirmation

## Drag the Selection

If multiple tasks are selected, dragging any of them moves the **whole selection**:

- Across kanban columns to bulk update status
- Into a different group in list view to update the grouped field
- Into another project's section in the sidebar to bulk reassign

## Undo

<kbd>⌘</kbd>+<kbd>Z</kbd> reverses the most recent bulk change within a 10-second window. The undo coverage includes:

- Status changes
- Priority changes
- Due date changes
- Deletion (restores the tasks)

After 10 seconds the action is committed and undo no longer reaches it. (You can still manually reverse, of course.)

## Multi-Select Across Filters

Multi-select operates on the visible task list. If you want to act on tasks not currently visible, change filters or scope first, then select.

## Keyboard Patterns

- <kbd>⌘</kbd>+<kbd>A</kbd> selects all visible tasks (in list view)
- <kbd>Esc</kbd> clears the selection

## See Also

- [Drag & Drop](/user-guide/tasks/drag-and-drop)
- [Filters & Sorting](/user-guide/tasks/filters-sorting)
