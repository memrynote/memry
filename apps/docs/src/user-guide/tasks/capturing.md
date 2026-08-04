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

## Tags

Tasks take tags from the same pool as your notes — one tag means one thing across the app,
and it keeps whatever colour and icon you gave it.

You can tag a task in two places:

- **The add-task dialog** — tag it as you create it
- **The task detail drawer** — add or remove tags on an existing task

Tags appear as chips on the task row, and you can filter by them from the filter bar. See
[Filters & Sorting](/user-guide/tasks/filters-sorting).

Tags are case-insensitive but keep the case you type: `MIT` stays `MIT`, and tagging
something `mit` later files it under the same tag.

A common use is marking your Most Important Tasks — tag them `MIT`, then filter to that tag
to see just today's short list.

Quick-add has no tag shortcut yet: `#` there means **project**, not tag. Use the add dialog
or the drawer.

## From a Project View

Quick-add inside a project automatically assigns the task to that project. The status defaults to the project's first status.

## Subtasks

To create a subtask:

- Use the inline `+` on a parent row
- Or indent within the quick-add field (Tab in some contexts)

Subtasks inherit nothing automatically — give them their own due dates and priorities as needed.

## From a Note

Selecting a checklist item in a note offers a "Convert to task" action in the inline menu. The task is created with the note as a back-reference.

A checklist item that is already ticked becomes a task that is already done — so a note you imported with `- [x] Book flights` in it does not reopen work you finished elsewhere.

## The Checkbox in the File Wins

A note's tasks live in the note's own Markdown file, as checklist lines carrying the task id:

```markdown
- [ ] Book flights {task:0f2a…}
- [x] Renew passport {task:9c41…}
```

That checkbox is the source of truth for whether the task is done. Tick or untick it in any other editor — Obsidian, vim, a script, a file you sync in from another machine — and memrynote follows the file:

| The file says | memrynote does          |
| ------------- | ----------------------- |
| `- [x]`       | Marks the task complete |
| `- [ ]`       | Reopens the task        |

The change lands whether the file was edited while memrynote was running or while it was closed, and it shows up everywhere the task appears — the task lists, Today, the project, and any other note that links it.

Only the checkbox is read this way; due dates, priority, and project stay with the task itself. Leave the `{task:…}` suffix alone — it is how the line and the task find each other. A line whose id no longer matches a task is left untouched.

Any list marker works (`-`, `*`, `+`), as does an uppercase `- [X]`. Other markers some editors use for "in progress", such as `- [-]`, are ignored rather than guessed at.

## Rich Descriptions

A task's description is a rich text editor, the same style as notes. In the task detail drawer (and the add-task dialog) you can use headings, lists, checkboxes, and inline formatting, and paste links that stay clickable. Type `/` for the block menu. Descriptions are stored as Markdown, so plain-text descriptions from earlier versions keep working unchanged.

## See Also

- [List vs Kanban](/user-guide/tasks/list-vs-kanban) — view options
- [Filters & Sorting](/user-guide/tasks/filters-sorting)
- [Subtasks & Recurrence](/user-guide/tasks/subtasks-recurrence)
