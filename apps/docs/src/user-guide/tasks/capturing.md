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

Start a date with `@` — the same `@` phrases the note editor understands — and quick-add parses the whole phrase into a due date:

| You type                       | memrynote sets                |
| ------------------------------ | ----------------------------- |
| `Buy bread @tomorrow`          | Due tomorrow                  |
| `Email Dana @next friday`      | Due next Friday               |
| `Pay rent @in 3 days`          | Due 3 days from now           |
| `Quarterly review @next month` | Due a month from today        |
| `Standup @tomorrow at 9:30`    | Due tomorrow, with a due time |

The phrase turns into a pill inside the input as soon as it is recognised, so you can see what will be captured before you press <kbd>Enter</kbd>. Text that doesn't read as a date — `Ping @bob` — stays part of the title.

`!today`, `!mon` and `!dec20` still work as single-word shorthands.

### Finishing What You Type

The rest of the phrase appears greyed out ahead of the cursor as you type — `@tomo` shows `@tomorrow`. Press <kbd>Tab</kbd> or <kbd>→</kbd> to take it, or keep typing to ignore it. The same completion works for `!today`, `!!high`, `#project` and the repeat phrases below.

<kbd>Enter</kbd> never takes the suggestion — it captures exactly what is on screen.

## Repeats

Type the cadence in plain English and the task is created as a repeating task:

| You type                     | Repeats                         |
| ---------------------------- | ------------------------------- |
| `Standup every weekday`      | Mon–Fri                         |
| `Team sync every monday`     | Weekly on Monday                |
| `Water plants every 2 weeks` | Every second week               |
| `Pay rent every month`       | Monthly, on the task's due date |
| `Backup every other day`     | Every second day                |

No `@` is needed — a phrase that doesn't read as a cadence, like `Check every door`, is left in the title. Like a date, a recognised cadence becomes a pill in the input, and `every w` completes to `every weekday` on <kbd>Tab</kbd>.

If you didn't give the task a due date of its own, it starts on the first matching day: `every monday` lands on the next Monday, `every day` starts today.

Repeats are English-only for now.

## Priority and Project Inline

You can set priority and project inline during quick-add:

- `!!high` — double exclamation for priority (`!!urgent`, `!!high`, `!!medium`, `!!low`)
- `#project-name` — hash prefix for project assignment

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
