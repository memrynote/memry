# Subtasks & Recurrence

Nest tasks under parents, and schedule repeating tasks.

<!-- screenshot: parent task with expanded subtasks and a recurrence picker -->

## Subtasks

Tasks can have multiple levels of subtasks. Each parent shows a progress bar and a small badge with the completion ratio (e.g. `3 / 7`).

### Adding Subtasks

| How                          | Where                      |
| ---------------------------- | -------------------------- |
| Inline **+** on a parent row | List or kanban view        |
| Indent during quick-add      | Quick-add input            |
| Drag a task onto a parent    | List or kanban (re-parent) |

### Drag-Drop Re-Parenting

Drag a subtask onto another parent to move it. Drag to the top level to **promote** it to a parent task.

### Independence

Subtasks have their own:

- Title
- Status
- Priority
- Due date
- Tags

They don't inherit anything from the parent. This is intentional — many real workflows have subtasks that finish before or after their parent's due date.

### Completion Rules

Marking a parent done **does not** auto-complete subtasks. You decide; memrynote doesn't.

If you want strict cascade behavior, use bulk-complete from [Bulk Actions](/user-guide/tasks/bulk-actions).

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
