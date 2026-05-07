# Drag & Drop

Reorder tasks, move between statuses, re-parent subtasks, and reorder projects.

<!-- screenshot: a task being dragged across kanban columns -->

## In List View

| Drag | Effect |
| --- | --- |
| Within a list / group | Reorder |
| Cross-group drag | Updates the grouping field (status, priority, due-date bucket, project) |
| To another project in the sidebar | Move to that project |
| Onto another task | Re-parent as a subtask |

## In Kanban View

| Drag | Effect |
| --- | --- |
| Within a column | Reorder |
| To another column | Update status |
| Onto a card | Re-parent as a subtask of that card |
| To the column header | Append to that column |

## Multi-Select Drag

Select multiple tasks first, then drag any of them. The whole selection moves together. See [Bulk Actions](/user-guide/tasks/bulk-actions) for selecting tasks.

## Re-Parenting Subtasks

Drag a subtask onto another parent to move it. Drag to the top level to **promote** the subtask. Drag onto a different project to move the subtree to that project.

## Project Reorder

Drag projects in the sidebar to reorder them. The order persists locally and syncs across devices.

## Drop Indicators

A horizontal blue line previews where the drag will land. Indented lines indicate re-parenting; non-indented lines indicate sibling reorder.

## Keyboard Alternatives

For accessibility:

- Use the row context menu to set status / priority / project
- Use [Bulk Actions](/user-guide/tasks/bulk-actions) for multi-row changes without dragging
- Use [Hint Mode](/user-guide/keyboard-shortcuts#hint-mode) to operate without a mouse

## Edge Cases

- **Recurring task** — dragging changes the **series** unless you've started editing only the current occurrence
- **Subtask drop on its own ancestor** — silently rejected (would create a cycle)
- **Drop on a status that doesn't exist for the project** — silently rejected; the row snaps back

## See Also

- [List vs Kanban](/user-guide/tasks/list-vs-kanban)
- [Bulk Actions](/user-guide/tasks/bulk-actions)
- [Subtasks & Recurrence](/user-guide/tasks/subtasks-recurrence)
