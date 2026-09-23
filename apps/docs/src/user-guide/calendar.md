# Calendar

Day, week, month, year, and timeline views over events and date-bound tasks.

<!-- screenshot: week view with tasks and events -->

## Views

Switch between Day, Week, Month, Year, and Timeline from the calendar toolbar.

| View     | Best for                                       |
| -------- | ---------------------------------------------- |
| Day      | Hour-by-hour detail; appointments back-to-back |
| Week     | Default; one screen of context                 |
| Month    | Bird's-eye plan                                |
| Year     | Capacity / planning view                       |
| Timeline | Scheduled work as a Gantt chart                |

The current view persists per tab.

Opening Calendar always lands on today, in that view. The date you navigate to is kept for as long as the app stays open — switch to another tab and back and you return to it — but it is not carried over to the next launch, and no dialog is ever open for you when the page appears. Earlier versions restored the last date you had visited along with the last **New event** click, so Calendar could open on a day weeks in the past with the event-creation dialog already up.

Day and week views show a current-time marker on today's grid; event chips remain the
clickable target for opening or editing events.

## Timeline

Timeline is a Gantt chart of scheduled work. Tasks are listed on the left, grouped by project,
and the days run across the top in one continuous strip. Scroll sideways to move through time;
the title follows the month you are looking at. The previous and next buttons step by a week,
a month or a quarter, depending on the zoom.

| Zoom     | Shows                                          |
| -------- | ---------------------------------------------- |
| Weeks    | Each day with its weekday                      |
| Months   | Each day; the default                          |
| Quarters | Week starts only, for planning across the year |

| Task dates                      | How it appears                                                 |
| ------------------------------- | -------------------------------------------------------------- |
| Start date and a later due date | A bar from the start day to the due day                        |
| Due date only, or start = due   | A diamond on the due day                                       |
| Start date only                 | A bar that fades out: the work has started, its end is not set |
| No date                         | An empty row you can schedule by clicking or dragging on it    |

An open task whose due date has passed shows its date in red, with a dashed line from where it
should have ended to today. It stays listed while today is on screen, even if its bar is out of
view. The thin line next to each group heading spans all of that group's work. Click a heading
to collapse it.

All-day and multi-day events appear in an **Events** group at the top. Double-click one, or
select it and press Enter, to open it. Timed events, reminders, and notes stay in the other
views.

Bars are drawn like the chips in the other views (see [Reading a Chip](#reading-a-chip)): a
colored bar on the leading edge and a tinted fill, with the title in plain text. A task bar uses
its project's color; an event uses its own color, or its type's color if it has none. The
selected bar, or the one whose card is open, is the only solid bar on screen. Tasks have a
checkbox on the bar and next to the title in the list, so you can complete one without opening
it. Enter opens the same task and event cards as the other views.

### Rescheduling

- Drag a bar to move it; drag either end to change the start or due date. Escape cancels a drag.
- Drag across an empty row to give a task a start and due date; click it to set only a due date.
- Every change can be undone with Cmd+Z.

### Keyboard

Click a row, or press ↓, to select. The bar along the bottom shows the selected task and the
keys that act on it.

| Key              | Does                                  |
| ---------------- | ------------------------------------- |
| ↑ ↓, Home, End   | Select a row                          |
| Enter            | Open the task (or event)              |
| Cmd+Enter        | Open the task in Tasks                |
| Shift+← →        | Move the task a day                   |
| Option+← →       | Move the due date a day               |
| Option+Shift+← → | Move the start date a day             |
| W, Shift+W       | Move the task a week later or earlier |
| S, D             | Set the start or due date             |
| C                | Mark complete (or incomplete)         |
| P                | Move to another project               |
| Backspace        | Clear the dates                       |
| T                | Scroll to today                       |
| Cmd+K            | All actions for the selected task     |
| Escape           | Clear the selection                   |

While the timeline has focus, Cmd+K opens its action panel instead of search. Cmd+P still
opens search. In right-to-left languages the arrows follow the timeline's direction.

### Display

**Display** in the toolbar sets the zoom, grouping (project, status, priority, or none),
ordering (start date, due date, or title), and what is shown: events, tasks without dates,
completed tasks, and subtasks. Subtasks are listed under their parent. These settings are kept
per tab. Archived tasks and tasks in archived projects are never shown.

## Reading a Chip

Every item on the calendar is a chip with a colored bar on its leading edge. The bar and the
chip's tint tell you what kind of item it is; the title is always plain dark text (light text in
dark mode) so it stays readable in every theme.

| Color  | Item                                   |
| ------ | -------------------------------------- |
| Indigo | Events created in memrynote            |
| Violet | Events from Google Calendar            |
| Green  | Tasks                                  |
| Cyan   | Reminders                              |
| Amber  | Snoozed inbox items                    |
| Pink   | Notes; a dated note has a dashed frame |

An event with its own color, or on a colored Google calendar, uses that color instead (see
[Coloring an Event](#coloring-an-event)).

In the day and week views, an item 45 minutes or longer shows its start and end time and its
length under the title (for example `10:00 – 11:30 · 1h 30m`). Shorter items keep to one line,
with the start time after the title when the chip is wide enough. Events that have already ended
fade. Overdue tasks do not; they still need doing.

The chip you opened turns solid until you close its card, so you can see which item the card
belongs to.

### Completing a Task from the Calendar

Task chips have a checkbox. Click it to complete the task without opening anything. A
notification appears with **Undo** in case it was the wrong one.

## What Shows Up

| Source                                      | How it appears                                 |
| ------------------------------------------- | ---------------------------------------------- |
| Calendar events created in memrynote        | Inline events on the day grid                  |
| Tasks with due dates                        | Task chips on the day they're due              |
| External calendar events (if integrated)    | Translucent events with a source badge         |
| Journal entries                             | A small badge / dot on dates with entries      |
| Notes with a calendar-enabled date property | All-day note chips on the property's date      |
| Notes (with **Show notes on calendar** on)  | All-day chips on the day each note was created |

## Multi-Day Events

An event whose end date is later than its start date is drawn as **one continuous bar** across
every day it covers, not as a single chip on the day it starts.

| View        | How a span appears                                                                       |
| ----------- | ---------------------------------------------------------------------------------------- |
| Week        | A bar in the all-day row, crossing the day columns it covers                             |
| Month       | A bar across the week row; a span that crosses a week boundary continues on the next row |
| Day         | In the all-day row on every day it covers, including days it merely passes through       |
| Year / mini | Every covered day is marked, not just the start day                                      |

A span that runs past the days currently on screen is clipped to what's visible and keeps
scrolling with the grid. Overlapping spans stack in lanes, and the all-day row grows to fit them.

An all-day event that ends at midnight ends on the **previous** day — a 10-12 May event covers
three days, not four. The day summary, day dots, and mini-calendar counts follow the same rule.

Spans open their detail popover on click. Drag-to-move and resize remain on single-day chips.

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

The start and end fields open a date picker with presets, a month calendar, and a time row. When
the event popover sits low in the grid there may not be room for the whole picker; the presets and
calendar scroll and the time row stays pinned below them.

On the day and week timelines you can also drag across a range of hours instead of clicking.
Drag to the top or bottom edge of the grid and it scrolls on its own, so a selection can run
past the hours currently on screen — hold the pointer at the edge and the range keeps growing
as the grid scrolls.

## Event Detail Popover

Click an event to open its card. Edit the title, time, and notes in place. The start and end
times read as one line (`Wed, Sep 23 · 10:00 AM – 11:30 AM`) followed by the event's length;
click either time to change it. Project, Google calendar, color, and notes sit below as rows,
and a Google Meet link appears as a **Join meeting** button.

The bar at the bottom shows the keys: press **Enter** in the title, or **⌘ Enter** (Ctrl Enter
on Windows and Linux) from any field, to save. **Esc** closes the card without saving.

Calendar popovers open beside the item you clicked and always stay inside the window. Near the
bottom edge a popover shifts up just enough to fit. In a window shorter than the popover, it pins
to the top edge and its contents scroll; resize the window and it moves or grows to match.

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

### Coloring an Event

memrynote uses Google Calendar's colors, the same names and the same shades.

The event form has a **Color** row with Google's eleven event colors: Tomato, Flamingo, Tangerine,
Banana, Sage, Basil, Peacock, Blueberry, Lavender, Grape, and Graphite. Pick one and save, and the
event's chip takes that color in every calendar view. Search results and the year view's day list
show the same color as a dot. **Default color** removes the event's own color. Canvas event cards
have the same row.

The color belongs to the event and syncs to your other devices. If the event is on a connected
Google calendar, the color is sent to Google too, and a color set in Google shows up in memrynote.

Events from Google Calendar keep their Google colors in memrynote, including events you have not
promoted. An event with no color of its own shows the color of its Google calendar, as it does in
Google. That can be any of Google's 24 calendar colors (Cobalt, Pumpkin, and Radicchio among them)
or a custom color you picked in Google. Calendar colors are set in Google Calendar; memrynote shows
them but does not change them.

Events on no Google calendar, tasks, reminders, notes, and subscribed calendars keep their type
colors unless you color the event.

## Task Detail Popover

Click a task chip to open its card. It shows the task's project, its due date, repeat, status,
priority, tags, the start of its description, and its subtasks with a progress bar.

The common actions take one click:

- **Complete** — the checkbox beside the title, or **⌘ Enter** (Ctrl Enter). The card closes and
  a notification offers **Undo**.
- **Move** — **Later** (about three hours from now, no later than 8 PM; not offered after 7 PM or for
  all-day tasks), **Tomorrow**, or **Next week** (Monday)
  reschedule the task straight away. Hover a button to see the exact time it moves to.
- **Open** — the arrow in the header, or **Enter**, opens the task in the Tasks tab.

The **⋯** menu holds the rest: open the note the task came from, pick an exact date and time, or
remove the due date.

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

If a Google Calendar account is linked in [Settings → Calendar](/user-guide/settings#google-calendar), external events appear alongside your vault events with a source badge.

External events are **read-mostly**: titles and times sync in. Inline edits propagate back if the integration supports it.

### Connecting from the calendar

While no Google account is linked, the calendar toolbar shows a **Connect Google** button. It opens a short prompt covering what a linked calendar unlocks — seeing your Google events beside notes and tasks, two-way sync, and scheduling tasks and notes on your calendar — then runs the same connect flow as Settings. The button disappears once an account is connected.

### Multiple Accounts and Calendars

You can link more than one Google account. In [Settings → Calendar](/user-guide/settings#google-calendar) → Google Calendar, **Add account** starts the connect flow again and Google shows its account chooser, so you can pick a different account than the one your browser is already signed in to.

Each linked account gets its own group listing every calendar on that account — shared calendars, team calendars, holiday calendars, all of them — with a checkbox each. Tick a calendar to bring its events into memrynote; untick it to take them out. Only your primary calendar is ticked when an account is first linked, so nothing else arrives until you ask for it.

**Unticking a calendar deletes its events from memrynote.** Nothing refreshes a calendar you have turned off, so its events are removed rather than left behind to go stale, and the removal reaches your other devices. Tick it again and the events are fetched fresh — straight away, not on the next sync. Events you [promoted to your vault](#promote-external-events) are your own copy and are not affected.

### Turning a Calendar On from the Calendar Page

The calendar page lists the same calendars under **GOOGLE CALENDARS** — in the sidebar on a wide window, in the filter popover on a narrow one. That list shows which calendars are actually being fetched: a calendar you have not turned on is shown unticked and marked **Not syncing**, rather than looking like an empty calendar.

Tick one there and memrynote turns it on for you and fetches its events immediately, exactly as ticking it in Settings does. Unticking it here only hides it from this calendar tab — the calendar keeps syncing and nothing is deleted, so ticking it back on is instant. To stop syncing a calendar and remove its events, untick it in [Settings → Calendar](/user-guide/settings#google-calendar).

The calendar list refreshes on every sync, so a calendar you create in Google later shows up on its own. If you linked an account before this existed, your other calendars appear after the next sync — no need to reconnect.

Each account has its own **Disconnect**, which unlinks only that account and removes only its events.

Disconnecting is reversible. Linking the same account again restores it along with its calendars and your calendar choices, and the events are fetched fresh on the next sync.

The **selected** count above the account groups reflects the calendars listed there. The memrynote calendar memrynote creates in Google to hold your pushed events is managed for you, so it is not listed and not counted.

### Sync Direction

By default Google Calendar sync is **two-way**: events, tasks, reminders, and snoozes you create in memrynote are pushed up to Google, and changes made in Google flow back into memrynote.

To switch to **one-way (inbound only)**, open [Settings → Calendar](/user-guide/settings#google-calendar) and turn off **Show memrynote events in Google Calendar**. You'll still see your Google events inside memrynote, but memrynote events will no longer appear in Google.

Switching to one-way is non-destructive — anything already synced to Google before the change stays there; only new pushes, updates, and deletes are stopped.

### How Often Google Events Refresh

Inbound pulls run on a schedule. One pull covers everything at once — every linked account and every
calendar you have ticked — so accounts never drift out of step with each other. This is also the
"every sync" that refreshes the calendar list itself, as described under
[Multiple Accounts and Calendars](#multiple-accounts-and-calendars).

Google notifies memrynote as soon as an event changes in one of your selected calendars, and the
change shows up within seconds. The background pull then runs only about every 30 minutes, as a
safety net for the few notifications Google drops. If notifications cannot be set up, memrynote
pulls about every 5 minutes instead.

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

Change your answer any time at [Settings → Calendar](/user-guide/settings#google-calendar) →
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

## Subscribed Calendars

Any calendar app that shares a calendar by link can show it in memrynote, read-only. That covers
Proton Calendar, Apple iCloud, Outlook, Fastmail, Nextcloud, and published schedules such as
sports fixtures or university timetables. No Google account or memrynote sign-in is needed.

1. In the other app, copy the calendar's public or secret address. It ends in `.ics` or starts
   with `webcal://`.
2. Open [Settings → Calendar](/user-guide/settings#subscribed-calendars) → **Subscribed calendars**,
   paste the link, and press **Subscribe**.

memrynote downloads the calendar before saving it, so a wrong link is rejected with the reason
(not a calendar, not found, access refused, unreachable) instead of leaving an empty calendar behind.

**What you see.** Events from the last 90 days through the next year, including every instance of
a repeating event with its skipped and moved dates. They appear on the calendar, the Day Panel,
and the Home calendar widget with the subscription's name as their label, and the calendar page
lists the subscription with your other imported calendars so you can hide it from view.

**Read-only.** Subscribed events can't be moved, resized, edited, or deleted. Clicking one shows
its details and where it comes from. To change an event, change it in the app that shares the
calendar; memrynote picks the change up on its next refresh.

**Refresh.** Each calendar is checked about once an hour, or on the schedule the calendar itself
asks for (between 15 minutes and a day). An unchanged calendar costs one small request. Press
**Refresh** next to a subscription to check now. If a refresh fails, the reason shows under the
subscription and the events you already had stay on the calendar.

**Across devices.** The subscription syncs to your other devices, end-to-end encrypted like the
rest of your vault; each device downloads the calendar itself. The events are never uploaded.
**Remove** unsubscribes on every device and clears the events.

Treat a secret calendar link like a password: anyone who has it can read that calendar.

## Day Cell Click Behavior

[Settings → Calendar](/user-guide/settings#calendar) lets you choose what clicking a date does by default:

- Open the day's journal entry
- Open the calendar's day view

Per-page override is available so the calendar tab itself can behave differently from clicks elsewhere.

## See Also

- [Day Panel](/user-guide/day-panel) — tasks + schedule + calendar in a side panel
- [Journal Calendar Navigation](/user-guide/journal/calendar-navigation)
- [Tasks](/user-guide/tasks/capturing) — tasks with due dates show here
