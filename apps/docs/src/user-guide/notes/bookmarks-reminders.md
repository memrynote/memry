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

The first panel holds the relative buttons, the optional note, and — once a note has reminders — the
list of the ones already set, each with its own edit and delete button. All of it scrolls together
when the panel is taller than the room the picker has, so the reminders at the end of the list stay
editable however low in the window you opened it from.

The optional note is available on both paths: type it before you press a relative button and it is
saved with that reminder too. It is kept everywhere the picker appears — notes, journal entries,
tasks and inbox items.

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

## Inline Date Pills

Typing `@` in note text offers a date. Accepting one drops a pill into the sentence, and the pill can
carry its own reminder — useful when the reminder belongs to a paragraph rather than to the note as a
whole. Click the pill to change the date, the clock format or the reminder lead time.

A pill reads as one of three things:

| Appearance                             | Meaning                                   |
| -------------------------------------- | ----------------------------------------- |
| Muted text, no alarm icon              | A date, with no reminder attached         |
| Blue text with an alarm icon           | A reminder is armed and has not fired yet |
| Muted text on a soft fill, faded alarm | The reminder already fired                |

A fired pill keeps its date and time on the page. It is a record of what you scheduled, so you can
still read it back long after the reminder has passed. Fired styling is per-device: it comes from
this device's reminder history and is never written into the note file, so the note reads the same on
a machine where the reminder has not fired yet.

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
