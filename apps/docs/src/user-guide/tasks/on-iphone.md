# Tasks on iPhone

The iPhone app has a full Tasks tab. It reads and writes the same tasks, projects, saved filters and reminders as the desktop app, and every change syncs both ways. The rules are shared too: quick-add parsing, due windows, filters, grouping and repeat dates come from the same code the desktop uses, so a phrase like `@next fri 3pm` resolves to the same date on both.

This page covers what works on the phone and where it behaves differently from the desktop.

## Views

The tabs are the desktop's: **All**, **Today**, **Tomorrow**, **Next 7 days** and **Archived**, each with its count. Today and Next 7 list overdue tasks first, and Today shows "N of M done today" above the list. The Done section sits at the bottom, folded by default.

Tap the project button under the tabs to scope the page to one project or to a starred saved filter. **List / Kanban** switches the All tab between a grouped list and a board. Your tab, scope, filters, sort and folded groups are remembered per vault on the phone.

Pull the list down to sync now.

## Capturing

The quick-add bar at the bottom reads the same tokens as the desktop:

| Type       | Example                         | Sets                                |
| ---------- | ------------------------------- | ----------------------------------- |
| `@` phrase | `@tomorrow 3pm`, `@may 17`      | Due date and time                   |
| `every …`  | `every monday`, `every 2 weeks` | Repeat                              |
| `!`        | `!high`, `!urgent`              | Priority                            |
| `+`        | `+Reading`                      | Project (pick from the suggestions) |
| `#`        | `#errand`                       | Tag                                 |
| `[[…]]`    | `[[Trip plan]]`                 | Linked note                         |

Recognised tokens are highlighted as you type, and a grey completion finishes dates and repeats. Tap **?** for the full list. Return adds the task and keeps the field open for the next one; the keyboard's **Done** key closes it.

The expand button opens the **Add Task** sheet with every field, including start date, status and parent. Turn on **Create another** to keep the sheet open after each task.

## Working with a task

Tap a task to open its details: title, status, priority, start and due date, project, repeat, reminders, tags, description (with a rendered preview), subtasks, related notes and files, and the activity log.

On a row:

- The circle completes or reopens the task. Completing a repeating task creates the next occurrence, as on the desktop.
- Swipe left for **Delete** and **Reschedule**, right to complete.
- Touch and hold for the Move menu: reschedule to Today, Tomorrow or Next week, move to another project, change status, duplicate, make it a subtask, archive or delete.

Most changes show an **Undo** toast for a few seconds. Undoing a delete brings the task back, subtasks included, under a new id.

## Selecting, dragging and bulk actions

Tap **Select** to enter selection mode. Tap rows to select them, then use the bar at the bottom to complete, set priority, due date, project or status, archive, unarchive or delete them together. With a hardware keyboard, Cmd+A selects everything visible, Cmd+Return completes, Cmd+Delete deletes (after asking) and Esc clears the selection.

Dragging works in selection mode, from the handle on the right of each row:

- Within a group, it reorders.
- Into another due-date group (Today, Tomorrow, This Week, Later, No Due Date), it reschedules the task and keeps its time.
- If the row you drag is selected, the whole selection moves.

Outside selection mode, a long press opens the Move menu instead of starting a drag. In Kanban, drag a card onto a column name in the strip to move it there.

## Filters and saved filters

The filter button opens every desktop filter: search, projects, priorities, tags, due date (presets or a custom range), status, completion, repeat type and time. The quick presets are Overdue, High Priority, Due This Week, Repeating and No Due Date. Active filters show as chips under the tabs, each with its own remove button.

Save the current filters under a name, star the ones you want in the project picker, and rename, reorder or delete them from the same sheet. Saved filters sync with the desktop.

## Projects

**More → Projects** lists your projects. From there you can create a project, edit its name, icon (emoji), color, description and statuses, reorder and archive projects, and delete them. Deleting a project that has tasks asks whether to move them to the Inbox or delete them. The project page shows progress, the overview note and the project's tasks.

## Reminders

Add reminders from a task's details with the desktop presets (Later Today, Tomorrow, Next Week, In 1 Month) or a date and time you pick; a task can have several. The phone asks for notification permission the first time you add one.

Reminders fire as ordinary iPhone notifications, even when the app is closed. Tapping one opens the task. The notification shows the task's title and a generic "Task reminder" line; a reminder's note stays in the app, because iOS keeps notification text outside your vault's encryption. If the task was completed or deleted on another device in the meantime, you see its done state or a "no longer in this vault" message.

iOS limits how many notifications an app may schedule, so the phone keeps the nearest 60 reminders scheduled and refills the list whenever the app opens or syncs. A reminder whose time passed while nothing was scheduled stays in the list marked **Past due**, where you can snooze or dismiss it.

## Tasks in notes

A task line in a note has a working circle, and its title opens the task. Ticking it completes the task everywhere, and the line updates in every note that holds it. Touch and hold a checklist item to **Convert to task**; the task goes into the note's project, or your default project, or the Inbox. Indent a checklist item under a task line first to make it a subtask.

Notes list their linked tasks under **Linked Tasks**, and search shows matching tasks in their own section.

## Settings

**More → Tasks** holds the default project, default sort, default view and the stale-inbox threshold. Default View applies to this phone only. The desktop keeps its task settings on each computer, so changes made on the phone do not show on the desktop.

## Differences from the desktop

- **Subtasks.** Completing the last open subtask asks whether to complete the parent too, where the desktop completes it automatically. Picking a parent in another project moves the task into that project first.
- **Reminders.** A reminder's note can be set when you create it but not edited afterwards.
- **Notes.** Changing a note's project on the phone does not offer to move its tasks. Indenting an existing task line does not change its parent. A change another device makes to a note's text appears when you open or refresh that note.
- **Projects.** Calendar events linked to a project can be removed but not added, and linked notes and files on a project page do not open yet.
- **Kanban.** Completed cards ignore the page filters.
