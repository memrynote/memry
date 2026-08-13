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
- **Custom** — any cron-like rule

Set a `repeat count` to cap the number of occurrences (e.g. "weekly for 6 weeks").

You can also type the cadence straight into quick-add — `Team sync every monday` — instead of opening the picker. See [Capturing Tasks](/user-guide/tasks/capturing#repeats).

### How Completion Works

When you mark a recurring task done, memrynote generates the **next occurrence** based on the rule and the current date.

The completed instance moves to the Completed view; the next instance appears in the active list.

### Editing the Series vs One Occurrence

Editing a recurring task:

- Edit the **series** — affects all future occurrences
- Edit just **this occurrence** — overrides for that single instance only

The picker asks which mode you want when you make a change to a recurring task.

### Skipping an Occurrence

Right-click → "Skip this occurrence" advances the recurrence without creating a completed instance.

## Combining Subtasks and Recurrence

Recurring **parent** tasks regenerate clean subtask lists each cycle (using the parent's subtask template). This is great for routines like a weekly review with the same five subtasks.

Recurring **subtasks** of a non-recurring parent are unusual but supported.

## See Also

- [Capturing Tasks](/user-guide/tasks/capturing)
- [Drag & Drop](/user-guide/tasks/drag-and-drop)
