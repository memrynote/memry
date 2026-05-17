# Snooze & Reminders

Defer items so they reappear later, and get nudged at a specific time.

<!-- screenshot: snooze picker with presets and custom option -->

## Snooze

Snoozing an inbox item, task, or note's reminder hides it until the wake time arrives. Useful for "I'll deal with this on Monday" workflows.

### Snooze Presets

- 30 minutes
- 1 hour
- 3 hours
- Tomorrow morning (9:00 AM)
- Tomorrow afternoon (2:00 PM)
- Next week (Monday 9:00 AM)
- Custom date and time

### Custom Snooze

The custom dialog lets you pick any future date and time. Past times are rejected with a clear error.

### Where Snooze Is Available

| Surface       | Snooze                                                      |
| ------------- | ----------------------------------------------------------- |
| Inbox item    | ✓ (item leaves inbox until wake)                            |
| Task          | ✓ (task hidden in default views; visible in "Snoozed" view) |
| Note reminder | ✓ (toast deferred)                                          |

### Countdown Display

Snoozed items show a "wakes in X" countdown until they reappear. Right-click to:

- Wake now
- Reschedule
- Cancel snooze

## Reminders

Reminders fire as **in-app toasts** at a specified date and time.

### Setting a Reminder

| Where     | How                            |
| --------- | ------------------------------ |
| On a note | Note toolbar → reminder picker |
| On a task | Task detail → reminder picker  |

The picker offers relative options ("in 1 hour", "tomorrow morning") plus a full date/time picker.

### When the Reminder Fires

memrynote shows a toast with:

- Title and snippet
- Action buttons (snooze 5 min, snooze 10 min, custom snooze, open, dismiss)

### Reminder Badge

Items with upcoming reminders show a small bell badge in the sidebar / tab bar / inbox row. Hover for the time.

### App Closed When Reminder Fires?

The toast appears when memrynote next opens. Reminders aren't OS-level notifications (yet — see [Roadmap](/roadmap)).

## Snooze vs Reminder

| Use snooze when                                | Use a reminder when                     |
| ---------------------------------------------- | --------------------------------------- |
| You want the item to **disappear** until later | You want a **nudge** at a specific time |
| You're processing an inbox                     | You're scheduling future attention      |
| The item shouldn't clutter today's view        | The item should still be findable       |

## See Also

- [Bookmarks & Reminders](/user-guide/notes/bookmarks-reminders)
- [Inbox](/user-guide/inbox/capturing)
- [Day Panel](/user-guide/day-panel)
