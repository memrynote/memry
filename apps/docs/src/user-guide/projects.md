# Projects

Projects group tasks under a custom status workflow.

<!-- screenshot: sidebar projects tree with task counts -->

## Project Tree

Projects appear in the sidebar with incomplete-task counts. Drag to reorder. Use a project's edit gear to rename, recolor, change icon, or delete.

## Creating a Project

The **+** affordance sits in the sidebar **PROJECTS** section header. It appears when you hover the header — except while you have no projects yet, when it stays visible so the section is never a dead end. It opens a creation dialog:

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

Open the project's **⋯** menu and choose **Edit statuses**. From there you can:

- Add new statuses
- Rename / recolor
- Change type (e.g. promote a custom status to `done` so it counts in progress bars)
- Reorder by drag
- Delete (with a confirmation; memrynote asks where to move tasks currently in that status)

## Task Counts

The sidebar shows **incomplete** task counts per project — tasks whose status type is not `done`. This keeps the count meaningful even as you complete tasks.

Every count is a count of **rows**. Subtasks are not rows of their own: they live under their parent task and show up as its `2/5` progress, so they never appear in a badge. Archived tasks are excluded too, so the badge always matches the number of open tasks you see when you open the project.

The **Tasks** tab in the project hub counts the same rows, but all of them rather than only the open ones — so it equals the To Do, In Progress and Done sections underneath it added together.

If a task points at a status the project no longer has — after the status was deleted, or after the task arrived from a project with a different workflow — it appears in the project's first status so you can see it and re-file it.

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

<!-- screenshot: project hub with tabs -->

### Capture bar

The capture bar is the top of the page — there is no title header above it. One input, running the full width, does the right thing with whatever you give it:

- **Plain text** becomes a task in this project. The usual quick-add shorthand still works, so `Ship the beta build friday p1` sets the due date and priority.
- **A link** becomes a note holding that link, already added to the project. memrynote uses the page's own title where it can reach it, and the address itself where it cannot.
- **The paperclip** imports files into your vault and adds them to the project in one step.

### Tabs

Five views, switched in place — none of them opens another tab:

The **⋯** menu — which edits or archives the project — sits at the end of the tab row.

- **Overview** — the first five of each category, with a **View all** that jumps to that category's tab
- **Tasks** — the full task list, with the list, quick-add, and subtasks you already know
- **Notes** · **Files** · **Events** — everything of that kind linked to the project

The Notes, Files, and Events tabs group their rows into time sections, exactly the way the Inbox does — same headings, same row type and spacing. Notes and files fall under **Today**, **Yesterday**, or **Older** by when they were last changed. Events look forward instead, under **Today**, **Tomorrow**, **Upcoming**, and **Past**, soonest first. Empty sections are not shown, and any section header collapses on click.

Each row behaves the way it does in its home view: change a task's status or priority straight from its row, click a note's icon to change it, and click any row to open the item. Clicking a linked event opens the Calendar **on that event's day** with its details showing, rather than dropping you on today.

Every category keeps its heading even when it is empty, so you can always see what a project is able to hold — and add the first one with **+**.

### Linking notes, events, and files

Notes, events, and files join a project as **links** (many-to-many): the same note or file can belong to more than one project.

- **Add a note or journal entry** — set its **`project` property** (see [Properties & Tags](/user-guide/notes/properties-tags#project-property)), or drag it onto a project in the sidebar, which fills the same property. A note's project membership lives in its frontmatter, not a menu — the project hub reflects whatever the file says.
- **Add a file** — open the file and choose **Add to project** from its toolbar, drag it onto a project in the sidebar, or use the hub's paperclip
- **Add an event** — right-click a calendar event and choose **Add to project**
- Dragging any note or file from the sidebar onto a project links it in one step — memrynote tells notes and files apart automatically, so the same drag works for either

Files and calendar events, which have no frontmatter, show small **project chips** under their title. A note or journal entry shows its projects in the `project` property row instead.

### Removing from a project

Nothing has to be deleted to undo a link. A note or journal entry leaves a project from the same `project` property row that put it there: every project is a chip with an **×**. A file leaves the same way, from the project chips under its title, which carry that **×** too. Removing the last one leaves the item in your vault with no project at all, exactly as it was before you linked it. A note's membership lives in its frontmatter, so the removal travels to your other devices with the file itself.

A calendar event leaves from the **Project** field in its own form, either by choosing **No project** or with the **×** on any extra project chip beside it.

## Deleting a Project

Open the project in the edit modal and use **Delete Project** in the footer. A confirmation dialog names the project, tells you how many tasks go with it, and states that the action cannot be undone. Cancel leaves everything untouched; confirming deletes the project and closes the modal.

**The project's tasks are deleted with it.** There is no move-the-tasks-elsewhere option, and the deletion is not undoable — move any tasks you want to keep to another project before deleting.

Linked **notes, events, and files are never deleted** with a project — only the project's tasks and its links are removed. Your notes, events, and files stay in your vault and simply lose the project link, so a project is safe to delete without losing the material collected under it.

## Sync

Projects sync as standard sync items with **field-level vector clocks** for resilient cross-device editing. See [Sync Protocol](/architecture/sync-protocol#field-level-merge-tasks-projects).

## See Also

- [Tasks](/user-guide/tasks/list-vs-kanban)
- [Bulk Actions](/user-guide/tasks/bulk-actions) — to move many tasks across projects at once
