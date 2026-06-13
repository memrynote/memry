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

| Source                                      | How it appears                            |
| ------------------------------------------- | ----------------------------------------- |
| Calendar events created in memrynote        | Inline events on the day grid             |
| Tasks with due dates                        | Task chips on the day they're due         |
| External calendar events (if integrated)    | Translucent events with a source badge    |
| Journal entries                             | A small badge / dot on dates with entries |
| Notes with a calendar-enabled date property | All-day note chips on the property's date |

## Quick Create

Click an empty time slot (day / week views) or a date cell (month) to create an event inline. The popover lets you set:

- Title
- Start and end times
- All-day toggle
- Notes / description
- Recurrence (one-off, daily, weekly, monthly)

## Event Detail Popover

Click an event to open the popover. Edit title, time, and description in place. The popover has a "Open in tab" action for full editing.

## Notes with Dates

A note that has a `date`-typed [property](/user-guide/notes/properties-tags) can appear on the calendar. Turn on **Show on calendar** from that property's row in the note, and the note shows up as an all-day chip on the property's date. Clicking the chip opens a small read-only popover showing the property and date, with an **Open note** action.

The toggle is vault-wide per property name — enabling it for "Deadline" once surfaces every note's "Deadline" — and it syncs across your devices. A note with several calendar-enabled date properties shows one chip per date.

## Drag to Reschedule

Drag an event or task chip to a new slot:

- **Day / week views** — drag vertically to change time, horizontally to change day
- **Month view** — drag to a different date

Recurring events ask whether to update **this occurrence** or the **series** (same UX as recurring tasks).

## External Calendar Integration

If a Google Calendar account is linked in [Settings → Integrations](/user-guide/settings#integrations), external events appear alongside your vault events with a source badge.

External events are **read-mostly**: titles and times sync in. Inline edits propagate back if the integration supports it.

### Sync Direction

By default Google Calendar sync is **two-way**: events, tasks, reminders, and snoozes you create in memrynote are pushed up to Google, and changes made in Google flow back into memrynote.

To switch to **one-way (inbound only)**, open [Settings → Integrations](/user-guide/settings#integrations) and turn off **Show memrynote events in Google Calendar**. You'll still see your Google events inside memrynote, but memrynote events will no longer appear in Google.

Switching to one-way is non-destructive — anything already synced to Google before the change stays there; only new pushes, updates, and deletes are stopped.

### Promote External Events

Right-click an external event → **Promote to vault** to copy it into your encrypted vault. Useful when you want to attach notes, tags, or reminders that wouldn't survive on the source calendar.

## Day Cell Click Behavior

[Settings → Calendar](/user-guide/settings#calendar) lets you choose what clicking a date does by default:

- Open the day's journal entry
- Open the calendar's day view

Per-page override is available so the calendar tab itself can behave differently from clicks elsewhere.

## See Also

- [Day Panel](/user-guide/day-panel) — tasks + schedule + calendar in a side panel
- [Journal Calendar Navigation](/user-guide/journal/calendar-navigation)
- [Tasks](/user-guide/tasks/capturing) — tasks with due dates show here
