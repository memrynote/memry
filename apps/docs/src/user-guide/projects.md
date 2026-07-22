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

## Project Home

Opening a project from the sidebar opens its **Project Home** — a dedicated page that gathers everything related to the project in one calm place, not just its tasks.

<!-- screenshot: Project Home page with stats row and sections -->

At the top, a stats row summarizes the project:

- **Tasks** — total tasks in the project
- **Notes** — linked notes
- **Events** — linked calendar events
- **Files** — linked files
- **Progress** — share of the project's tasks that are complete (derived live from the done ratio; there is nothing to configure)

Below the stats, Project Home stacks these sections:

- **Overview** — an optional inline note that acts as the project's description/home (see below)
- **Tasks** — the project's task list (the same list and quick-add you already know)
- **Notes** — the notes linked to this project
- **Calendar** — the calendar events linked to this project
- **Files** — the files linked to this project (PDFs, images, audio, video)

### Overview note

A project can point at a real note that renders inline at the top of Project Home as its overview.

- **Create overview note** — creates a fresh note and sets it as the project's overview; edit it inline, changes save automatically
- **Clear overview** — unlinks the note as the overview (the note itself stays in your vault)

The overview is a pointer to a note, so it never shows up twice — it does not also appear in the Notes section.

### Linking notes, events, and files

Notes, events, and files join a project as **links** (many-to-many): the same note or file can belong to more than one project.

- **Add a note** — from a note's **⋯** menu choose **Add to project**, or drag the note onto a project in the sidebar
- **Add a file** — open the file and choose **Add to project** from its toolbar, or drag the file onto a project in the sidebar
- **Add an event** — right-click a calendar event and choose **Add to project**
- Dragging any note or file from the sidebar onto a project links it in one step — memrynote tells notes and files apart automatically, so the same drag works for either
- Linked items appear in Project Home's **Notes** / **Calendar** / **Files** sections; use each row's remove control to unlink (this only unlinks — it never deletes the note, event, or file)

Wherever a note, event, or file lives, small **project chips** under its title show which projects it belongs to. On notes and events, click a chip to jump to that Project Home.

## Deleting a Project

Deleting asks you to choose what to do with the tasks:

- **Move to another project** — pick from the project list
- **Move to no project** — keep the tasks, drop the project assignment
- **Delete with project** — destructive; tasks go too

Each path is reversible via undo within the 10-second window.

Linked **notes, events, and files are never deleted** with a project — only the project's tasks and its links are removed. Your notes, events, and files stay in your vault and simply lose the project link, so a project is safe to delete without losing the material collected under it.

## Sync

Projects sync as standard sync items with **field-level vector clocks** for resilient cross-device editing. See [Sync Protocol](/architecture/sync-protocol#field-level-merge-tasks-projects).

## See Also

- [Tasks](/user-guide/tasks/list-vs-kanban)
- [Bulk Actions](/user-guide/tasks/bulk-actions) — to move many tasks across projects at once
