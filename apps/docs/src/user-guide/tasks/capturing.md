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

### Finishing What You Type

The rest of the phrase appears greyed out ahead of the cursor as you type — `@tomo` shows `@tomorrow`. Press <kbd>Tab</kbd> or <kbd>→</kbd> to take it, or keep typing to ignore it. The same completion works for `!high`, `+project`, `#tag` and the repeat phrases below.

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

## The Whole Grammar

Quick-add speaks the same shorthand as the note editor, so a marker means the same thing wherever you type it:

```
Ship the beta @next friday !high +Memry #launch [[Roadmap]] every 2 weeks
```

| Marker    | Sets          | Notes                                                              |
| --------- | ------------- | ------------------------------------------------------------------ |
| `@…`      | Due date      | Any phrase from [Natural Language Dates](#natural-language-dates)  |
| `!…`      | Priority      | `!urgent`, `!high`, `!medium`, `!low` — `!u`, `!h`, `!m`, `!l` too |
| `+…`      | Project       | `+work`, `+Personal`, `+project-alpha`                             |
| `#…`      | Tag           | Every `#tag` counts, so a task can take several                    |
| `[[…]]`   | A linked note | Opens a note picker as you type                                    |
| `every …` | Repeat        | See [Repeats](#repeats)                                            |

Each marker has to start a word, so ordinary writing is safe: `Ship it!`, `Learn C++`, `Compute 1+2` and `Close issue#12` are captured exactly as typed. A marker the app cannot resolve — `+nowhere` for a project that doesn't exist — stays in the title rather than disappearing.

::: tip Changed in this release
`#` used to mean **project**. It now means **tag**, matching the note editor. Use `+` for projects: `#Work` files a `Work` tag, `+Work` files into the Work project. Priority is a single `!` — `!high`, not `!!high` — and the old `!today` date shorthand is gone; `@today` does more.
:::

Every marker sets the same field the pickers in the task drawer set — quick-add is a shortcut, not a separate system.

## Linking a Note

Type `[[` and a note picker opens straight away, showing your most recently edited notes and narrowing as you type:

- <kbd>↑</kbd> / <kbd>↓</kbd> to move
- <kbd>Enter</kbd> or <kbd>Tab</kbd> to pick — the title is written in as `[[Note title]]`
- <kbd>Esc</kbd> to close the list and keep what you typed (a second <kbd>Esc</kbd> clears the field)

The `[[…]]` run leaves the task title, and the note shows up under **Related** on the task. You can type the title yourself, too — `[[Roadmap]]` links the note called _Roadmap_. A title that matches no note is simply dropped from the title with nothing linked.

This is the one marker with a list instead of greyed-out completion: note titles are yours, so showing them beats guessing at them.

## Related Items

The **Related** section of the task drawer links both notes and canvases. Press <kbd>+</kbd> beside the heading to open the picker; it lists your most recently edited notes and your canvases, each with its own icon. Picking a canvas links it, and clicking a linked canvas opens it in a canvas tab.

Typing in the picker searches your whole vault rather than filtering the handful of items already on screen, so a note you have not touched in months is still reachable by title.

Notes and canvases are stored as separate links, so a task keeps its note links unchanged when you add a canvas — including on a device still running an older version of Memry, which simply does not show the canvas half.

## Tags

Tasks take tags from the same pool as your notes — one tag means one thing across the app,
and it keeps whatever colour and icon you gave it.

You can tag a task in three places:

- **Quick-add** — type `#launch` in the capture field, as many as you like
- **The add-task dialog** — tag it as you create it
- **The task detail drawer** — add or remove tags on an existing task

Tags appear as chips on the task row, and you can filter by them from the filter bar. See
[Filters & Sorting](/user-guide/tasks/filters-sorting).

Tags are case-insensitive but keep the case you type: `MIT` stays `MIT`, and tagging
something `mit` later files it under the same tag.

A common use is marking your Most Important Tasks — tag them `MIT`, then filter to that tag
to see just today's short list.

Nested tags work the same way they do in notes: `#work/client` files under `work`. A brand-new
tag typed in quick-add is created on the spot and picks up a colour like any other.

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

## When a Line Has No Task Behind It

A checklist line is only a task once memrynote has a task for it. Two cases where it does not, both common in a vault you brought over from somewhere else:

A **plain checkbox with no `{task:…}` suffix** — the shape Obsidian and most other editors write — is turned into a task as you go. If that cannot happen, because there is no project to create it in or the task could not be saved, the line stays a plain checklist item. It keeps its text and its tick, and memrynote tries again the next time you open the note. It never sits there looking like a task you cannot touch.

A **`{task:…}` suffix naming a task that is not in this vault** — usually a note copied out of another install, where the ids belong to that install's tasks — shows as "Task deleted", with a button to take the line out of the note. Its text and its tick are left exactly as they are in the file; nothing is rewritten and nothing is deleted until you ask.

While a task is still loading, its row shows but its controls are inert for that moment. A control you can click is a control that works.

## Rich Descriptions

A task's description is a rich text editor, the same style as notes. In the task detail drawer (and the add-task dialog) you can use headings, lists, checkboxes, and inline formatting, and paste links that stay clickable. Type `/` for the block menu. Descriptions are stored as Markdown, so plain-text descriptions from earlier versions keep working unchanged.

## See Also

- [List vs Kanban](/user-guide/tasks/list-vs-kanban) — view options
- [Filters & Sorting](/user-guide/tasks/filters-sorting)
- [Subtasks & Recurrence](/user-guide/tasks/subtasks-recurrence)
