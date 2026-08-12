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

A system notification is shown as well. Dismissing, snoozing, or deleting the reminder also retires its system notification — on macOS it is removed from Notification Center, and on Windows and Linux the banner is closed — so handled reminders don't pile up. "Dismiss all" does the same for every reminder in the batch, and only for those: a reminder that wasn't part of the action keeps its notification. If a snoozed reminder comes due again, its new notification replaces the earlier one for that reminder instead of stacking a second banner. Notifications you haven't acted on are never dismissed for you.

Dismissing a reminder updates every place it appears right away — the inbox reminders view, the note's reminder pill, the journal badge, the task chip, and any other open memrynote window. "Dismiss all" behaves the same way, refreshing those views once per reminder it actually dismissed.

Dismissing or snoozing a reminder syncs to your other devices, so a reminder you've handled on one device won't fire again on another. Each device still shows its own toast and system notification locally when the reminder's time arrives.

### Dock & Taskbar Badge

The app icon shows a badge with the number of pending reminders (scheduled or snoozed). The badge updates as reminders fire, get created, snoozed, or dismissed, and clears when nothing is pending. Numeric badges appear on the macOS Dock and Linux Unity launcher; Windows does not support numeric taskbar badges.

### Reminder Badge

Items with upcoming reminders show a small bell badge in the sidebar / tab bar / inbox row. Hover for the time.

### Upcoming & Past in the Inbox

When a reminder fires it also lands in the inbox, so you never miss one even if you dismissed the toast. The inbox toolbar's alarm-clock button toggles a dedicated reminders view with two sections:

- **Upcoming** — reminders you have scheduled but that haven't fired yet (on notes, tasks, journals, or highlights) plus any snoozed inbox items, earliest first. This is how you see a reminder _before_ its time arrives.
- **Past** — reminders that have already fired, most recent first.

Each row shows the source type icon and title; clicking it opens the source — the note, the task (with its project), or the journal day. The count on the alarm button reflects how many **upcoming** reminders you have.

### App Closed When Reminder Fires?

The reminder fires the next time memrynote opens: the toast and system notification appear, and the reminder lands in the inbox.

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
