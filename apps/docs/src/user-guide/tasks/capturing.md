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

In the Tasks page's capture bar, a task is due **Today** unless you change it — see [Setting Properties Before You Press Enter](#setting-properties-before-you-press-enter).

## Setting Properties Before You Press Enter

When the Tasks page's capture field is focused, a `Today ⌄` chip appears at its end. It shows what the task will be created with, so you don't have to find the task afterwards to finish it off.

- **Click the date** to open the date picker — Today, Tomorrow, Next week, Remove date, a calendar, and Add time. **Remove date** creates the task with no due date.
- **Click the arrow**, or press <kbd>⌥</kbd> <kbd>↓</kbd> in the field, to open the task options:
  - **Priority** — five buttons at the top, or <kbd>1</kbd>–<kbd>5</kbd> while the menu is open
  - **Project**, **Status**, **Start date**, **Repeat**, **Reminder**, **Tags**
  - **Link note** — writes `[[` into the field and opens the note picker
  - **Open full details** — the add-task dialog, same as <kbd>⌘</kbd> <kbd>Enter</kbd>

In the menu, <kbd>↑</kbd> / <kbd>↓</kbd> move, <kbd>→</kbd> opens a submenu, <kbd>←</kbd> goes back, and <kbd>Esc</kbd> returns you to the text.

Everything you set away from its default shows as a small chip beside the date. Click a chip to change it, or hover it and press **×** to drop it. After <kbd>Enter</kbd> the chips reset, ready for the next task.

### Typed Markers and the Menu Agree

The menu and the [markers](#the-whole-grammar) set the same fields, and the last thing you did wins:

| You do                                       | The task gets                             |
| -------------------------------------------- | ----------------------------------------- |
| Pick **High**, then type `!low`              | Low — the typed marker came last          |
| Type `Ship it !low`, then pick **Urgent**    | Urgent — `!low` is removed from the field |
| Type `#launch`, then add the tag `design`    | Both tags — tags add up                   |
| Type `@friday` with the date chip on _Today_ | Due Friday — the chip switches to Friday  |

A reminder is attached as soon as the task has been saved.

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

A task you create inside a [journal entry](/user-guide/journal/daily-entries) is related to that day, and clicking it opens the Journal on that date. If a related item points at something that is no longer in the vault at all, Memry tells you instead of opening an empty document.

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

## Editing a Task From the Note

A task in a note carries its properties on its own row, and every one of them can be changed there, without opening the task.

- **Status, priority and project** are always on the row. Click one to change it.
- **Everything else** shows as a small chip only while it is set: description, repeat, tags, dates, reminder, and related notes or canvases. Click a chip to change it. Clear the value in its picker and the chip goes away.
- **To add what is missing**, hover the row and click **+**. The menu lists only the properties the task does not have yet, and picking one opens its picker straight away. A task with everything set has no **+**.

Start and due dates share one chip — `Sep 5 → Sep 12`, or `Sep 5 →` with no deadline — and its picker has a **Start / Due** switch on top. Removing the due date removes its time too.

The chips never touch the note's file. The line stays `- [ ] Title {task:…}`; the properties live with the task, as they do everywhere else.

### Shorthand in the title

The quick-add markers work in a task's title in a note too. Type them and they are applied when you press <kbd>Enter</kbd> or leave the title: `Buy milk #groceries @friday !high` saves as _Buy milk_, tagged, due Friday, high priority. While you type, dashed chips show what is about to be set.

Only markers you add count. Text that was already in the title — `Fix #123 crash`, a line brought in from another app — stays title text when you edit something else on the line. A marker that names nothing, such as `+nosuchproject`, stays in the title as typed.

### From the keyboard

Click the row's empty space, or press <kbd>Esc</kbd> in the title, to select the task. Its keys then open each property's picker:

| Key                           | Opens                      |
| ----------------------------- | -------------------------- |
| <kbd>S</kbd>                  | Status                     |
| <kbd>P</kbd>                  | Priority                   |
| <kbd>⇧</kbd>+<kbd>P</kbd>     | Project                    |
| <kbd>D</kbd>                  | Due date                   |
| <kbd>⇧</kbd>+<kbd>D</kbd>     | Start date                 |
| <kbd>R</kbd>                  | Repeat                     |
| <kbd>H</kbd>                  | Reminder                   |
| <kbd>L</kbd>                  | Tags                       |
| <kbd>E</kbd>                  | Description                |
| <kbd>⇧</kbd>+<kbd>L</kbd>     | Related notes and canvases |
| <kbd>Enter</kbd>              | Edit the title             |
| <kbd>⌘</kbd>+<kbd>Enter</kbd> | Open the task in Tasks     |

The same keys work inside the **+** menu. Hovering a chip shows its key.

## Which Project a Note's Task Lands In

A task written inside a note — `/task`, a checklist line that converts, or a new task block — is filed in the note's own project. The first answer that applies wins:

| Checked                                                                             | Example                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| The parent task's project, for a subtask                                            | A line indented under another task                         |
| A `+project` marker on the line                                                     | `- [ ] Ship the beta +Memry`                               |
| The note's [`project` property](/user-guide/notes/properties-tags#project-property) | A note with `project: Website Redesign` in its frontmatter |
| Your **Settings → Tasks → Default project**                                         | No project on the note                                     |
| Inbox, then your first project                                                      | No default set                                             |

Archived projects are skipped: a note whose only project is archived falls through to your default. If the note names several projects, the first one it was linked to is used — the same one every other single-select surface calls "the" note's project.

### Bringing Existing Tasks Across

Giving a note a project only changes where _new_ tasks go. If the note already holds tasks filed somewhere else, memrynote asks once whether to move them:

- **Move tasks** — the note's top-level tasks move to the new project, and their subtasks come with them so a parent and its children never end up split. Each task keeps its status, matched to the equivalent status in the new project.
- **Keep as is** — nothing moves.

Only tasks actually written in the note (`{task:…}` lines) are offered; a task merely linked to the note under **Related** is left alone. Removing a project from a note never prompts — there is no destination to move to.

Tasks filed before this behaviour existed are not moved for you. Change them from the task row's project picker, or from the prompt above the next time you set the note's project.

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

A **checkbox with no `{task:…}` suffix** — the shape Obsidian and most other editors write — is turned into a task as you go, once it has something on it to name the task with. An empty `- [ ]` you have just typed is left as a checkbox until you write the title; a line of nothing but markers (`- [ ] #errand`) stays a checkbox too, since there is no title left after the markers are read off. If the task cannot be saved — no project to create it in, or the vault is not open — the line stays a plain checklist item, keeping its text and its tick, and memrynote tries again on your next edit. It never sits there looking like a task you cannot touch.

Turning the line into a task only adds the `{task:…}` suffix. Everything already on the line stays as written, including `[[wiki links]]`, links, and **bold** or _italic_ text, and the task takes that same text as its title. Opening a note that holds checkboxes like these, including one that just synced in from another device, never strips them.

A **`{task:…}` suffix naming a task that is not in this vault** — usually a note copied out of another install, where the ids belong to that install's tasks — shows as "Task deleted", with a button to take the line out of the note. Its text and its tick are left exactly as they are in the file; nothing is rewritten and nothing is deleted until you ask. The same holds for a task line whose task has not synced to this device yet: its links, wiki links, code, colours and bold or italic text survive opening the note, an edit made to the file outside memrynote, and the next save.

## Keeping a Checkbox a Checkbox

Not every checkbox is a task. A packing list or a checklist inside meeting notes can stay a
**plain checkbox**: it ticks like any other, never becomes a task, and never shows up in Tasks.

- **Undo right after it becomes a task.** The line goes back to a checkbox, now a plain one, and
  the task it had just become is deleted. The first time a checkbox becomes a task, a note in the
  corner says so and offers **Keep as checkbox**, which does the same.
- **Pick Check List from the `/` menu.** That makes a plain checkbox. Hold `Cmd`/`Ctrl` and press
  Enter on the row to get a task instead. Typing `[ ] ` is still the quick way to a task.
- **Turn into > Checkbox** from the block menu, on any line of text. **Turn into > Task** goes
  the other way.
- **Turn into checkbox** from the block menu of a task. The line goes back to a plain checkbox,
  and memrynote asks whether the task stays in Tasks.

Pressing Enter at the end of a plain checkbox gives another plain one, and so does a checkbox
indented under one, so a plain checklist stays plain as you write it. Right-clicking a checkbox
still turns it into a task, plain or not.

In the file a plain checkbox carries a `{check}` marker at the end of its line:

```md
- [ ] Passport {check}
- [ ] Book flights {task:0f2a…}
```

The marker is what keeps the line a checkbox when the note is opened on another device or edited
in another app; remove it and the line becomes a task the next time memrynote reads it. The same
goes for a checkbox you add in another app: without the marker it becomes a task when the note
opens, even under a plain one. An older
version of memrynote does not know plain checkboxes and turns them into tasks, as it does every
checkbox.

## Deleting a Task You Wrote in a Note

Deleting a task that came from a checklist line takes that line out of the note as well, so the note
does not keep showing a checkbox for a task that no longer exists. Only the task's own line is
removed. Anything you nested under it — a sub-bullet, a paragraph, a child task — stays where it is,
and every other byte of the file is left untouched.

One exception: if the note is open in an editor at that moment, the line is left alone, because
rewriting the file underneath you could discard what you were typing. Deleting the task block from
inside the editor removes the line directly, so this only shows up when you delete from the task
list while the note happens to be open.

## Deleting the Line, or the Whole Note

The other direction asks first. Delete a task block from a note (select it and press
<kbd>Delete</kbd>, use the block menu's **Delete**, or select several blocks and delete them
together) and memrynote asks what should happen to the task:

- **Keep in Tasks** — the default, and what <kbd>Esc</kbd> does. The task stays in Tasks; the note
  just stops being one of its linked notes. Undo the delete and the line and the link both come back.
- **Delete task** — the task is deleted everywhere, on every device.

Several task blocks deleted at once are asked about together, once.

Some removals are not deletions and never ask:

- **Cut** keeps the task, so pasting the line back finds it.
- **Move to** another note moves the task with its line: it is linked to the new note instead.
- **Emptying a task's title** and pressing <kbd>Backspace</kbd> deletes the task, as it always has.
- **<kbd>Backspace</kbd> at the start of the line below a task** does not remove the task. The
  cursor moves into the end of that task's title (the last subtask's, if it has any), so you keep
  deleting characters of the title rather than the whole task.

Deleting a whole note, several notes, or a folder works the same way. When the notes hold task
lines, the delete dialog offers **Also delete the tasks inside**, unticked. Left unticked, the tasks
stay in Tasks and the deleted note is dropped from their linked notes. Only tasks actually written in
the notes count: a task that is also linked to a note you are keeping is left alone, and so is one
that was only linked to the deleted note from its **Related** section.

While a task is still loading, its row shows but its controls are inert for that moment. A control you can click is a control that works.

A line that is _becoming_ a task is the one exception, and it works the other way round: its row is live from the start, even in the moment before the task exists. Pick a project, a status or a priority, or tick it, and the choice is applied to the task as soon as it has been created — you never have to wait for the row to catch up with you.

## Rich Descriptions

A task's description is a rich text editor, the same style as notes. In the task detail drawer (and the add-task dialog) you can use headings, lists, checkboxes, and inline formatting, and paste links that stay clickable. Type `/` for the block menu. Descriptions are stored as Markdown, so plain-text descriptions from earlier versions keep working unchanged.

## See Also

- [List vs Kanban](/user-guide/tasks/list-vs-kanban) — view options
- [Filters & Sorting](/user-guide/tasks/filters-sorting)
- [Subtasks & Recurrence](/user-guide/tasks/subtasks-recurrence)

## Start dates for longer tasks

Open a task's details and select **Start date** to choose when work should begin.
The **Due Date** remains its deadline. For example, a task starting Monday and due
Friday appears in **Today** every day from Monday through Friday. Set its status
to **In progress** when you begin; the start date does not change the status.

An unfinished task stays in Today after its deadline as overdue. A task with a
start date but no deadline stays in Today until completed. Clear the start date
to remove this scheduling behavior. Tasks without a start date keep their existing
due-date behavior.
