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

## Project Hub

Opening a project from the sidebar opens its **hub** — a page that gathers everything related to the project in one calm place, not just its tasks.

<!-- screenshot: project hub with tabs and the details rail -->

The header names the project and summarizes it: how many of its tasks are done, and — only when there are any — how many are overdue. Click the icon to change it; the **⋯** menu edits or archives the project.

### Capture bar

One input sits under the header and does the right thing with whatever you give it:

- **Plain text** becomes a task in this project. The usual quick-add shorthand still works, so `Ship the beta build friday p1` sets the due date and priority.
- **A link** becomes a note holding that link, already added to the project. memrynote uses the page's own title where it can reach it, and the address itself where it cannot.
- **The paperclip** imports files into your vault and adds them to the project in one step.

### Tabs

Five views, switched in place — none of them opens another tab:

- **Overview** — the first five of each category, with a **View all** that jumps to that category's tab
- **Tasks** — the full task list, with the list, quick-add, and subtasks you already know
- **Notes** · **Files** · **Events** — everything of that kind linked to the project

Each row behaves the way it does in its home view: change a task's status or priority straight from its row, click a note's icon to change it, and click any row to open the item. Clicking a linked event opens the Calendar **on that event's day** with its details showing, rather than dropping you on today.

Every category keeps its heading even when it is empty, so you can always see what a project is able to hold — and add the first one with **+**.

### Details rail

A rail on the right stays with you across all five tabs. The toggle beside the **⋯** menu closes it and — staying exactly where it was — opens it again. Each project remembers your choice.

- **Overview** — the project's overview note, editable inline. Below it, the notes you have pinned to the overview; **Add note** links an existing note and pins it in one step, and removing a pin leaves the note linked to the project.
- **Progress** — how many tasks are done, then a row for **every status the project defines**. A project with four in-progress statuses gets four rows. An **Overdue** row appears only when something is past due.
- **Details** — when the project was created and last changed, and how many notes, files, and events it holds.

### Overview note

A project can point at a real note that renders inline in the rail as its overview.

- **Create overview note** — creates a fresh note and sets it as the project's overview; edit it inline, changes save automatically
- **Clear overview** — unlinks the note as the overview (the note itself stays in your vault)

The overview is a pointer to a note, so it never shows up twice — it does not also appear in the Notes tab.

### Linking notes, events, and files

Notes, events, and files join a project as **links** (many-to-many): the same note or file can belong to more than one project.

- **Add a note** — from a note's **⋯** menu choose **Add to project**, or drag the note onto a project in the sidebar
- **Add a file** — open the file and choose **Add to project** from its toolbar, drag it onto a project in the sidebar, or use the hub's paperclip
- **Add an event** — right-click a calendar event and choose **Add to project**
- Dragging any note or file from the sidebar onto a project links it in one step — memrynote tells notes and files apart automatically, so the same drag works for either

Wherever a note, event, or file lives, small **project chips** under its title show which projects it belongs to. On notes and events, click a chip to jump to that project's hub.

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
