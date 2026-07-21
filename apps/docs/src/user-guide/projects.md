# Projects

Projects group tasks under a custom status workflow.

<!-- screenshot: sidebar projects tree with task counts -->

## Project Tree

Projects appear in the sidebar with incomplete-task counts. Drag to reorder. Use the right-click context menu to rename, recolor, change icon, or delete.

## Creating a Project

The **+** affordance in the sidebar Projects section opens a creation dialog:

- **Name** — display title
- **Color** — accent for the sidebar entry and project header
- **Icon** — click the icon button to open the shared emoji/icon picker (the same one used for notes, folders, and tags) and choose an emoji or icon
- **Initial statuses** — memrynote pre-fills `Todo / In Progress / Done`; you can edit before creating

You can also create a project without leaving the task you're working on. Every project dropdown — the **Add Task** dialog, the **task detail** drawer, the project picker in the **Projects** tab, and the project-scope dropdown above the task list — ends with a **Create project** entry. Choosing it opens the same creation dialog, and the new project is selected once you save.

## Statuses

Each project owns its own ordered list of statuses. A status has:

- **Name**
- **Type** — `todo`, `in-progress`, `done`, or `custom` (used for grouping and progress)
- **Color** — used in chips, kanban columns, and progress bars

Status types matter for cross-project views: "All Tasks → kanban grouped by status" maps `memrynote's status type`, not raw status names.

### Editing Statuses

Open the project header menu and choose **Edit statuses**. From there you can:

- Add new statuses
- Rename / recolor
- Change type (e.g. promote a custom status to `done` so it counts in progress bars)
- Reorder by drag
- Delete (with a confirmation; memrynote asks where to move tasks currently in that status)

## Task Counts

The sidebar shows **incomplete** task counts per project — tasks whose status type is not `done`. This keeps the count meaningful even as you complete tasks.

## Default Project

[Settings → Tasks → Default Project](/user-guide/settings#tasks) sets which project new tasks go to when you quick-add outside any project view. "(No project)" is a valid default.

## Project Views

Each project has its own:

- List view (with project-specific saved filters)
- Kanban view (columns = the project's statuses)
- Tabs for `All`, `Today`, `Completed` scoped to that project

memrynote remembers per-project view preferences.

## Deleting a Project

Deleting asks you to choose what to do with the tasks:

- **Move to another project** — pick from the project list
- **Move to no project** — keep the tasks, drop the project assignment
- **Delete with project** — destructive; tasks go too

Each path is reversible via undo within the 10-second window.

## Sync

Projects sync as standard sync items with **field-level vector clocks** for resilient cross-device editing. See [Sync Protocol](/architecture/sync-protocol#field-level-merge-tasks-projects).

## See Also

- [Tasks](/user-guide/tasks/list-vs-kanban)
- [Bulk Actions](/user-guide/tasks/bulk-actions) — to move many tasks across projects at once
