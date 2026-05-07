# Capturing Tasks

Quick add, inline create, and natural-language dates.

<!-- screenshot: quick-add input above a task list -->

## Quick Add

Every task list has a quick-add input at the top.

- Type the task title
- Press <kbd>Enter</kbd> to create

The new task is created in the current view's scope:

| Where you quick-add | Goes to |
| --- | --- |
| All Tasks | No project, status defaults to your `Default Sort Order` setting |
| Today | Today as due date |
| Inside a project | That project, with the project's first status |
| Inside a status column (kanban) | That column |

## Natural Language Dates

Phrases parse into due dates as you type:

| You type | Memry sets |
| --- | --- |
| `Buy bread tomorrow` | Due tomorrow |
| `Email Dana next Friday` | Due next Friday |
| `Pay rent in 3 days` | Due 3 days from now |
| `Quarterly review next month` | Due first of next month |

The parsed date appears as a chip you can adjust or remove before saving. If you don't want date parsing on a particular task, prefix or quote the text.

## Priority and Project Inline

You can set priority and project inline during quick-add:

- `! High priority` — exclamation marker for priority
- `+ Project name` — plus prefix for project assignment

(These map to the same UI pickers used for editing existing tasks.)

## From a Project View

Quick-add inside a project automatically assigns the task to that project. The status defaults to the project's first status.

## Subtasks

To create a subtask:

- Use the inline `+` on a parent row
- Or indent within the quick-add field (Tab in some contexts)

Subtasks inherit nothing automatically — give them their own due dates and priorities as needed.

## From a Note

Selecting a checklist item in a note offers a "Convert to task" action in the inline menu. The task is created with the note as a back-reference.

## See Also

- [List vs Kanban](/user-guide/tasks/list-vs-kanban) — view options
- [Filters & Sorting](/user-guide/tasks/filters-sorting)
- [Subtasks & Recurrence](/user-guide/tasks/subtasks-recurrence)
