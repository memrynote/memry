# Bookmarks & Reminders

Mark notes you want quick access to, and schedule reminders that fire as in-app toasts.

<!-- screenshot: reminder picker open over a note -->

## Bookmarking

Toggle a bookmark from the note toolbar. Bookmarked notes:

- Appear under the sidebar **Bookmarks** section
- Persist across sessions
- Sync across devices, including reordering and removal

A bookmark is a flag on the note; toggling it doesn't move the note or change its content.

## Reminders

Open the reminder picker from the note toolbar. Pick a date and time:

- A relative button (in 1 hour, tomorrow morning, next week)
- A custom date and time picker

A relative button sets the reminder as soon as you pick it. **Pick date & time** opens a panel that
needs confirming instead: choose the day, the time and an optional note, then press **Set reminder**.
That button and the summary of what you are about to set stay pinned to the bottom of the panel, so
they stay in reach even when the picker opens somewhere with little room and the rest of the panel
has to scroll.

Selecting text in the editor does not open a separate reminder action; reminders are set at the note level.

When the reminder fires, memrynote shows an in-app toast with:

- The note title
- A snippet of context
- Action buttons

### Toast Actions

| Action        | What it does                     |
| ------------- | -------------------------------- |
| Snooze 5 min  | Reminder reappears in 5 minutes  |
| Snooze 10 min | Reminder reappears in 10 minutes |
| Custom snooze | Pick a new time                  |
| Open          | Open the note in a tab           |
| Dismiss       | Mark as handled; don't reappear  |

## Reminder Badge

Notes with upcoming reminders show a small bell badge in the sidebar and tab bar. Hover for the time.

## Where Reminders Live

- The note carries the reminder
- The reminder list view (Settings or sidebar) shows all upcoming
- Snoozed reminders show a wakes-in countdown

## Persistence

Reminders are stored in the data DB and sync end-to-end encrypted. If memrynote isn't running when a reminder fires, the toast appears the next time the app opens.

Reminders sync across devices: set one on your laptop and it shows up on your other devices too. Dismissing or snoozing a reminder on one device carries over everywhere else, so a reminder you've already handled won't nag you again elsewhere. Each device still shows its own toast locally when the reminder's time arrives — sync keeps the reminder's state in agreement, not the notification itself.

## See Also

- [Snooze & Reminders](/user-guide/snooze-reminders) — the cross-cutting view including inbox snooze
- [Day Panel](/user-guide/day-panel) — see today's reminders alongside calendar and tasks
