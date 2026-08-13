# Calendar

Day, week, month, and year views over events and date-bound tasks.

<!-- screenshot: week view with tasks and events -->

## Views

Switch between Day, Week, Month, and Year from the calendar toolbar.

| View  | Best for                                       |
| ----- | ---------------------------------------------- |
| Day   | Hour-by-hour detail; appointments back-to-back |
| Week  | Default; one screen of context                 |
| Month | Bird's-eye plan                                |
| Year  | Capacity / planning view                       |

The current view persists per tab.

Day and week views show a current-time marker on today's grid; event chips remain the
clickable target for opening or editing events.

## What Shows Up

| Source                                      | How it appears                                 |
| ------------------------------------------- | ---------------------------------------------- |
| Calendar events created in memrynote        | Inline events on the day grid                  |
| Tasks with due dates                        | Task chips on the day they're due              |
| External calendar events (if integrated)    | Translucent events with a source badge         |
| Journal entries                             | A small badge / dot on dates with entries      |
| Notes with a calendar-enabled date property | All-day note chips on the property's date      |
| Notes (with **Show notes on calendar** on)  | All-day chips on the day each note was created |

## Search

Click the search icon in the toolbar to reveal a search box. Type to filter everything
the calendar shows — events, tasks, reminders, notes, and snoozed inbox items — by title
or description, regardless of which date you're currently viewing. Matches appear in a
dropdown, sorted by how close they are to today. Selecting a result jumps the calendar to
that item's day and opens its detail popover. Press `Enter` to jump to the top match or
`Escape` to close.

## Quick Create

Click an empty time slot (day / week views) or a date cell (month) to create an event inline. The popover lets you set:

- Title
- Start and end times
- All-day toggle
- Notes / description
- Recurrence (one-off, daily, weekly, monthly)

On the day and week timelines you can also drag across a range of hours instead of clicking.
Drag to the top or bottom edge of the grid and it scrolls on its own, so a selection can run
past the hours currently on screen — hold the pointer at the edge and the range keeps growing
as the grid scrolls.

## Event Detail Popover

Click an event to open the popover. Edit title, time, and description in place. The popover has a "Open in tab" action for full editing.

### Assigning a Project

The event form (opened from **+** in the toolbar, or from an existing event) has a **Project**
row, defaulting to **No project**. Pick a project to link the event to it; pick **No project** to
clear the link. When creating a new event, the choice is saved once you save the event; when
editing an existing one, picking a project links or unlinks it immediately — the same write the
event chip's **Add to project** context-menu action makes.

On an existing event the change is written straight away, so **Cancel** does not undo it — reopen
the form and pick **No project** (or the previous project) to change it back. Only new events wait
for **Save**.

An event can end up linked to more than one project — for example if it was also added to a
second project from the chip's context menu, or if a swap only half-succeeded and reported an
error. The form still shows one project in the picker, and
lists any additional links as small chips beside it, each with an **×** to remove just that link.
A link to an archived project also shows as a chip, since the picker only lists active projects;
it stays until you remove it with its **×**.

Quick Create (dragging on the grid) stays title-only and has no Project row; add a project after
saving, from the full event form. Event cards on a [canvas](/user-guide/canvas/overview) have no
Project row either — open the event from the calendar to change its project.

## Scheduling Tasks by Drag

Tasks can be scheduled and rescheduled by dragging, from two places:

- **A task chip already on the calendar** — drag it to another day (month view) or to a
  new day and time (week / day grid). Events still move and resize as before; this adds
  the same direct manipulation for task chips.
- **A Tasks tab beside the calendar** in a [split view](/user-guide/tabs-split-view) —
  drag a task row straight onto the calendar.

Where you drop decides the time:

| Drop target              | Result                                         |
| ------------------------ | ---------------------------------------------- |
| A month-view day cell    | Sets the due date; keeps any existing time     |
| A week / day all-day row | Due that day with **no** time                  |
| A week / day time slot   | Due at the dropped time, snapped to 15 minutes |

The all-day row appears while you drag, even on days that have no all-day items, so there
is always somewhere to drop a task to clear its time. Selecting several tasks first drags
them together — one drop schedules them all. Moving a task chip on the time grid can be
undone with **Cmd/Ctrl+Z**, like moving an event.

## Notes with Dates

A note that has a `date`-typed [property](/user-guide/notes/properties-tags) can appear on the calendar. Turn on **Show on calendar** from that property's row in the note, and the note shows up as an all-day chip on the property's date. Clicking the chip opens a small read-only popover showing the property and date, with an **Open note** action.

The toggle is vault-wide per property name — enabling it for "Deadline" once surfaces every note's "Deadline" — and it syncs across your devices. A note with several calendar-enabled date properties shows one chip per date.

## Show Notes on Calendar

[Settings → Calendar](/user-guide/settings#calendar) has a **Show notes on calendar** toggle (off by default — new notes stay off the calendar until you opt in). While it's on, every note appears on the calendar as an all-day chip on the day it was created — no per-note setup. Turning it off removes them again. This is display-only: no date is written to the note. A note whose calendar-enabled date property falls on its creation day shows a single chip, not two.

With notes on the calendar, the [Day Panel](/user-guide/day-panel) mini-calendar also shows a notes dot on days that have notes — alongside the event and journal-activity dots — and the day's list under the calendar includes those notes next to events.

### Day Summary on Hover

Hover a date in the Day Panel calendar to see a quick summary of that day: counts of notes, journal, tasks, events, and reminders, each with its own color. Only the kinds present on that day are listed.

## Drag to Reschedule

On the day and week timelines, drag an **event** to reschedule it:

- Drag vertically to change the time.
- In week view, drag across columns to move it to another day.
- Drag the top or bottom edge to change the start or end time (resize).

Times snap to 15-minute steps. Task chips are draggable too — see
[Scheduling Tasks by Drag](#scheduling-tasks-by-drag) — while reminder and note chips stay
put. If the event is linked to a connected Google calendar, the new time syncs there too.

Press **Cmd/Ctrl+Z** to undo a move or resize.

## External Calendar Integration

If a Google Calendar account is linked in [Settings → Integrations](/user-guide/settings#integrations), external events appear alongside your vault events with a source badge.

External events are **read-mostly**: titles and times sync in. Inline edits propagate back if the integration supports it.

### Connecting from the calendar

While no Google account is linked, the calendar toolbar shows a **Connect Google** button. It opens a short prompt covering what a linked calendar unlocks — seeing your Google events beside notes and tasks, two-way sync, and scheduling tasks and notes on your calendar — then runs the same connect flow as Settings. The button disappears once an account is connected.

### Multiple Accounts and Calendars

You can link more than one Google account. In [Settings → Integrations](/user-guide/settings#integrations) → Google Calendar, **Add account** starts the connect flow again and Google shows its account chooser, so you can pick a different account than the one your browser is already signed in to.

Each linked account gets its own group listing every calendar on that account — shared calendars, team calendars, holiday calendars, all of them — with a checkbox each. Tick a calendar to bring its events into memrynote; untick it to take them out. Only your primary calendar is ticked when an account is first linked, so nothing else arrives until you ask for it.

**Unticking a calendar deletes its events from memrynote.** Nothing refreshes a calendar you have turned off, so its events are removed rather than left behind to go stale, and the removal reaches your other devices. Tick it again and the events are fetched fresh. Events you [promoted to your vault](#promote-external-events) are your own copy and are not affected.

The calendar list refreshes on every sync, so a calendar you create in Google later shows up on its own. If you linked an account before this existed, your other calendars appear after the next sync — no need to reconnect.

Each account has its own **Disconnect**, which unlinks only that account and removes only its events.

Disconnecting is reversible. Linking the same account again restores it along with its calendars and your calendar choices, and the events are fetched fresh on the next sync.

The **selected** count above the account groups reflects the calendars listed there. The memrynote calendar memrynote creates in Google to hold your pushed events is managed for you, so it is not listed and not counted.

### Sync Direction

By default Google Calendar sync is **two-way**: events, tasks, reminders, and snoozes you create in memrynote are pushed up to Google, and changes made in Google flow back into memrynote.

To switch to **one-way (inbound only)**, open [Settings → Integrations](/user-guide/settings#integrations) and turn off **Show memrynote events in Google Calendar**. You'll still see your Google events inside memrynote, but memrynote events will no longer appear in Google.

Switching to one-way is non-destructive — anything already synced to Google before the change stays there; only new pushes, updates, and deletes are stopped.

### How Often Google Events Refresh

Inbound pulls run on a schedule. One pull covers everything at once — every linked account and every
calendar you have ticked — so accounts never drift out of step with each other. This is also the
"every sync" that refreshes the calendar list itself, as described under
[Multiple Accounts and Calendars](#multiple-accounts-and-calendars).

memrynote pulls about every 5 minutes in the background. When Google push notifications are active
for your selected calendars, changes arrive as they happen and the background pull falls back to
roughly every 30 minutes.

Google returns a busy calendar in pages. Every pull follows all of them before it finishes, so a
calendar full of repeating meetings cannot crowd your one-off appointments out of the results.

Two extra pulls sit on top of that: memrynote syncs immediately when your machine wakes from sleep,
and bringing the memrynote window back to the front pulls again if the last pull was more than two
minutes ago. Re-focusing the window more often than that is deliberately ignored so alt-tabbing all
day doesn't hammer the network.

Need something right now? Click the **Refresh Google calendars** button in the calendar toolbar. It
pulls straight away and never waits on any of the intervals above.

None of these schedules apply to an account showing **Reconnect required** — memrynote will not sync
an account whose sign-in it cannot read. See
[If the account says "Reconnect required"](#if-the-account-says-reconnect-required).

### Promote External Events

Right-click an external event → **Promote to vault** to copy it into your encrypted vault. Useful when you want to attach notes, tags, or reminders that wouldn't survive on the source calendar.

### Google Data and AI Features

AI access to your Google Calendar events is off until you turn it on. The first time you open the
calendar with Google calendars imported, memrynote asks once: **Let AI read your Google Calendar
events?** Both answers are recorded, so you are asked only that one time.

- **Don't allow** (also the default until you answer) — the Agent Chat assistant reads only events
  you created in memrynote. Ask it about a Google event and it gets nothing back.
- **Allow** — the assistant can read events from your imported Google calendars.

Change your answer any time at [Settings → Integrations](/user-guide/settings#integrations) →
Google Calendar → **Let AI read Google Calendar events**. Turning it off takes effect on the next
question you ask; turning it on likewise applies from that point forward.

This setting covers events that live on your Google calendars. A [promoted](#promote-external-events)
event is different: the copy sits in your vault as a memrynote event, so the assistant can read it
like any other event you created. While AI access is off, memrynote confirms every promotion and
says so in the dialog, and **Don't ask again** does not skip that confirmation. Your original Google
event stays hidden from the assistant either way.

Either way you keep seeing your Google events in the calendar, calendar lists and connection
details stay out of what the assistant can access, and Google user data is never used to train or
improve AI models.

Note that promoting an external event (above) copies it into your vault as a memrynote event. From
then on it is your own event, and the assistant can read it regardless of this setting.

### If the account says "Reconnect required"

An account can drop back to **Reconnect required** without you doing anything — most often after an
app update, because the stored Google tokens are encrypted with a key tied to the app's identity on
your machine and that identity can change across versions. memrynote never guesses at a credential
it cannot read, so it asks you to reconnect rather than syncing with something stale.

Press **Connect** and sign in again. That writes fresh tokens over the unreadable ones, and your
calendars, selections and existing events are untouched — only the sign-in is redone.

## Day Cell Click Behavior

[Settings → Calendar](/user-guide/settings#calendar) lets you choose what clicking a date does by default:

- Open the day's journal entry
- Open the calendar's day view

Per-page override is available so the calendar tab itself can behave differently from clicks elsewhere.

## See Also

- [Day Panel](/user-guide/day-panel) — tasks + schedule + calendar in a side panel
- [Journal Calendar Navigation](/user-guide/journal/calendar-navigation)
- [Tasks](/user-guide/tasks/capturing) — tasks with due dates show here
