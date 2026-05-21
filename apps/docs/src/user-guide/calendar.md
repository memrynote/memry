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

| Source                                   | How it appears                            |
| ---------------------------------------- | ----------------------------------------- |
| Calendar events created in memrynote     | Inline events on the day grid             |
| Tasks with due dates                     | Task chips on the day they're due         |
| External calendar events (if integrated) | Translucent events with a source badge    |
| Journal entries                          | A small badge / dot on dates with entries |

## Quick Create

Click an empty time slot (day / week views) or a date cell (month) to create an event inline. The popover lets you set:

- Title
- Start and end times
- All-day toggle
- Notes / description
- Recurrence (one-off, daily, weekly, monthly)

## Event Detail Popover

Click an event to open the popover. Edit title, time, and description in place. The popover has a "Open in tab" action for full editing.

## Drag to Reschedule

Drag an event or task chip to a new slot:

- **Day / week views** — drag vertically to change time, horizontally to change day
- **Month view** — drag to a different date

Recurring events ask whether to update **this occurrence** or the **series** (same UX as recurring tasks).

## External Calendar Integration

If a Google Calendar account is linked in [Settings → Integrations](/user-guide/settings#integrations), external events appear alongside your vault events with a source badge.

External events are **read-mostly**: titles and times sync in. Inline edits propagate back if the integration supports it.

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
