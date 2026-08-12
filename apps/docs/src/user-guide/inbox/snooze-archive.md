# Snooze & Archive

Defer items to reappear later, and file processed items so they leave the active inbox.

<!-- screenshot: snooze picker with presets and custom option -->

## Snooze

Snoozing an inbox item hides it until the wake time arrives. The item leaves the active inbox view and rejoins it when wake fires.

### Snooze Presets

- 30 minutes
- 1 hour
- 3 hours
- Tomorrow morning (9:00 AM)
- Tomorrow afternoon (2:00 PM)
- Next week (Monday 9:00 AM)
- Custom date and time

### Custom Snooze

The custom dialog accepts any future date and time. Past times are rejected.

### Snoozed View

A separate view tab lists currently snoozed items and reminder rows generated from fired note reminders. Snoozed rows show a wakes-in countdown. From a snoozed row you can:

- **Wake now** — return to the inbox immediately
- **Reschedule** — pick a different wake time
- **Cancel snooze** — also returns to inbox

Every countdown refreshes once a minute off a single shared tick, and again as
soon as the app returns to the foreground, so a long snoozed list stays accurate
without one timer per row.

### When the Wake Fires

When wake fires, the item appears at the top of the active inbox. If memrynote isn't running, the item appears next time the app opens.

If the inbox is open — including in more than one pane or window — you also get a single system notification for that wake, not one per open inbox. A later wake for different items always gets its own notification, even when the titles happen to match.

## Archive

Archived items leave the active inbox but stay in your vault. They're still:

- Searchable via the [global search palette](/user-guide/search)
- Visible in the **Archived** view
- Re-openable to extract content or convert to other types

Archive is non-destructive. To truly remove an item, use **Delete**.

### Archiving from a Triage Card

The fastest path: <kbd>Delete</kbd> or <kbd>Backspace</kbd> on a triage card archives and slides to the next.

### Archiving from the List

Each row has a context menu with **Archive**. Multi-select rows for bulk archive.

### Restoring from Archive

Archived view → row context menu → **Move to inbox** brings the item back as pending.

## Snooze vs Archive

| Use snooze when                          | Use archive when                           |
| ---------------------------------------- | ------------------------------------------ |
| You want the item to **come back** later | You're **done** with the item              |
| The work isn't relevant right now        | The work is complete or no longer relevant |
| You'll need a reminder                   | You only need it findable later            |

## Cross-Cutting

Snooze in the inbox is the same picker used for tasks and note reminders. See [Snooze & Reminders](/user-guide/snooze-reminders) for the broader cross-app view.

## See Also

- [Capturing to Inbox](/user-guide/inbox/capturing)
- [Triage Mode](/user-guide/inbox/triage)
- [Snooze & Reminders](/user-guide/snooze-reminders)
