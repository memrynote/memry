# Subtasks & Recurrence

Nest tasks under parents, and schedule repeating tasks.

<!-- screenshot: parent task with expanded subtasks and a recurrence picker -->

## Subtasks

A task can have subtasks. A parent shows a progress badge with the completion ratio of its direct subtasks (e.g. `1/4`); subtasks further down count toward their own parent, not the top one.

### Adding Subtasks

| How                                      | Where              |
| ---------------------------------------- | ------------------ |
| Hover a row and click **+**              | List view          |
| **Add sub-issue** at the end of the list | Task detail drawer |
| Indent a checkbox under a task           | A note             |

The **+** opens a draft row under the task. Type a title and press <kbd>Enter</kbd> to save it and start the next one, or <kbd>Esc</kbd> to close the draft. The draft names the task it will land in.

### Subtasks at any depth

A subtask can have subtasks of its own, as deep as you need. To keep subtasks one level deep, turn off **Settings → Modules → Tasks → Subtasks inside subtasks**.

- In a draft row, <kbd>Tab</kbd> moves the draft under the row above it and <kbd>Shift</kbd>+<kbd>Tab</kbd> moves it out one level.
- In a note, a checkbox indented under a subtask becomes that subtask's subtask. <kbd>Tab</kbd> on a task in a note nests it under the task above, and <kbd>Shift</kbd>+<kbd>Tab</kbd> moves it out one level. The note indents each task by its real depth.
- The note's markdown file keeps one level: every task below a top-level task is written as a `- [ ]` line indented once under it, in order. The full tree lives with your tasks, so a note opened in another editor, or on a device that has not updated yet, lists the deeper tasks flat under their top-level task and loses nothing.
- Importers keep nested checklists at every level.
- Each level indents a step and draws a thin guide line. Past five levels the indent stops growing, so long titles keep their width.
- Select a parent row and press <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> to **zoom into** it: the list shows only that branch, with the parent as the page title. The path above the title walks back, and <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>↑</kbd> goes up one level.
- The task drawer shows the path to the task above its title. Each part opens that task in the drawer, and a subtask's title opens it in place, so the drawer moves one level at a time.

Devices on older versions of memrynote show only the first level until they update.

### Right-click Menu

Right-click any task row or kanban card for every action on it, each listed with its shortcut: **Open**, **Complete** / **Reopen**, **Add subtask**, **Zoom into subtasks**, **Move under…**, **Move under _the task above_**, **Move out one level**, **Make top-level task**, and **Delete**. Only the actions that apply to that task are shown.

### Moving a Task Under Another

Select a row and press <kbd>Shift</kbd>+<kbd>M</kbd> for **Move under…**. It lists the project as a tree; pick the new parent and press <kbd>Enter</kbd>, or <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> to make the task top level. The task's own subtasks are greyed out, because a task cannot go inside its own branch. The whole branch moves with it.

In a list of subtasks you can also drag a row sideways: a step to the right nests it under the row above, a step to the left moves it out one level. A label on the row says where it will land. <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes the move.

### On iPhone

The task list indents subtasks up to two levels under each task. A subtask deeper than that is not drawn in the list: its parent shows a count such as `1/3` with a chevron, and tapping it opens that branch as its own screen, with the parent as the title. The back button returns to where you came from, one level at a time.

Touch and hold a row for **Move under _the task above_**, **Move out one level**, **Move under…**, and **Make top-level task**. **Move under…** lists the project as the same tree as on desktop, with the task's own branch greyed out. **Settings → Tasks → Subtasks inside subtasks** applies to the iPhone on its own, the same as on desktop.

### Independence

Subtasks have their own:

- Title
- Status
- Priority
- Due date
- Tags

They don't inherit anything from the parent. This is intentional — many real workflows have subtasks that finish before or after their parent's due date.

### Completion Rules

Completing a parent completes every open task under it, at every level, and a toast offers **Undo**. Reopening a subtask whose parent is done reopens the parent too, so a finished task never hides open work. Completing the last open subtask of a parent completes the parent as well, with an **Undo** in the toast.

### Deleting a Parent

Deleting a task that has subtasks asks once. **Keep subtasks** moves its direct subtasks up into its place, under its own parent if it has one. **Delete all** removes the whole branch. Both can be undone from the toast.

### Subtasks in Date Views

Today, Tomorrow, Next 7 days, the Home tasks widget and the calendar list each dated task on its own row, at any depth. A parent and its subtask that are due the same day both appear, and the tab count includes both. A subtask with no date of its own still shows only under its parent.

Under a subtask's title is its path: the project, then the tasks above it, for example `Website relaunch › … › Case studies`. A long path keeps the project and the direct parent and folds the middle into `…`. Click the path to open the project zoomed into that parent, with the subtask open. In the calendar, a subtask's card names its parent; click the name to do the same.

### Filters and Kanban

When a filter matches a subtask, the tasks above it stay in the list in a lighter colour so the match keeps its place. Kanban shows top-level tasks only; a card with subtasks shows its progress and its next open subtask.

## Recurrence

Schedule a task to repeat on a fixed cadence.

### Recurrence Patterns

- **Daily** — every N days
- **Weekly** — chosen weekdays (e.g. Mon / Wed / Fri)
- **Monthly** — same date every month, or "first Monday"
- **Yearly** — every N years

The custom picker combines those: a frequency, an interval, the weekdays or the monthly
pattern, and an end condition. It is not a cron expression — there is no minute or hour
field, because recurrence lands on a date and the time of day comes from the task's own
due time.

End the series never, on a date, or after a number of occurrences ("weekly for 6 weeks").
The picker previews the next five dates as you change the rule.

You can also type the cadence straight into quick-add — `Team sync every monday` — instead of opening the picker. See [Capturing Tasks](/user-guide/tasks/capturing#repeats).

### How Completion Works

When you mark a recurring task done, memrynote closes that instance and creates a **new
task** for the next date in the rule. You end up with one completed record per cycle, each
with its own completion date, rather than a single task you keep reopening. The completed
instance moves to the Completed view; the fresh one appears in the active list.

Editing a recurring task edits the series. There is no per-occurrence override and no
"skip this occurrence" action yet; to skip a cycle, move the due date forward by hand.

### Which Date the Next Occurrence Counts From

By default the cadence is fixed: the next date is measured from the **due date**, so a
daily task due Monday and finished on Thursday is still due Tuesday. A task can instead be
anchored to its **completion date**, which restarts the interval on the day you actually
finished — finishing Monday's daily task on Thursday then schedules Friday. That is what
habit tracking usually wants.

The anchor has no picker in the app yet. It is set by the importers and the CLI: an
Obsidian task written as `🔁 every day when done` keeps its completion anchor through
[Obsidian import](/user-guide/tasks/import-obsidian), and `memrynote tasks create` takes
`--repeat-from completion`. Tasks with no anchor recorded keep the fixed cadence.

## Combining Subtasks and Recurrence

Completing a recurring parent also completes its open subtasks, and those completed
subtasks stay with the instance that owned them. The next occurrence starts without
subtasks; there is no subtask template that regenerates each cycle.

Recurring **subtasks** of a non-recurring parent are unusual but supported.

## See Also

- [Capturing Tasks](/user-guide/tasks/capturing)
- [Drag & Drop](/user-guide/tasks/drag-and-drop)
