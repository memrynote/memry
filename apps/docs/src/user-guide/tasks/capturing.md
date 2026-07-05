# Capturing Tasks

Quick add, inline create, and natural-language dates.

<!-- screenshot: quick-add input above a task list -->

## Quick Add

Every task list has a quick-add input at the top.

- Type the task title
- Press <kbd>Enter</kbd> to create

The new task is created in the current view's scope:

| Where you quick-add             | Goes to                                                          |
| ------------------------------- | ---------------------------------------------------------------- |
| All Tasks                       | No project, status defaults to your `Default Sort Order` setting |
| Today                           | Today as due date                                                |
| Inside a project                | That project, with the project's first status                    |
| Inside a status column (kanban) | That column                                                      |

## Natural Language Dates

Phrases parse into due dates as you type:

| You type                      | memrynote sets          |
| ----------------------------- | ----------------------- |
| `Buy bread tomorrow`          | Due tomorrow            |
| `Email Dana next Friday`      | Due next Friday         |
| `Pay rent in 3 days`          | Due 3 days from now     |
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

### How tasks look in your markdown files

A task in a note is stored as a plain markdown checkbox — no ids or metadata in the file:

```md
- [ ] Buy milk
- [x] Call dentist
```

Project, status, dates, and reminders live in memrynote's local database (and sync end-to-end encrypted), not in the file. The link between the checkbox line and the full task is kept internally and re-matched by title and position if you edit the file outside memrynote — so files stay clean and fully compatible with Obsidian or any other markdown editor.

- Toggling `[x]` in an external editor completes the task in memrynote.
- Renaming a task line externally renames the task (when it's the only changed line).
- Deleting a task line from the file never deletes the task — it stays in the Tasks page.
- A checkbox you add in another app stays a plain checkbox until you convert it.

Notes written by older versions with a `{task:…}` suffix are cleaned up automatically the next time you edit them.

## See Also

- [List vs Kanban](/user-guide/tasks/list-vs-kanban) — view options
- [Filters & Sorting](/user-guide/tasks/filters-sorting)
- [Subtasks & Recurrence](/user-guide/tasks/subtasks-recurrence)
