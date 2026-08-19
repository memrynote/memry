# Day Panel

A right-side panel with calendar, tasks, and the schedule for a selected date.

<!-- screenshot: day panel docked on the right -->

## What's In It

Three stacked sections:

1. **Calendar picker** — month grid with heatmap dots indicating activity
2. **Today's tasks** — tasks due on the focused date
3. **Schedule** — calendar events and a journal preview for the focused date

## The Calendar Picker

A compact monthly grid:

- Heatmap dots reflect activity (entries, tasks, events)
- The current day is outlined
- Click any date to set focus across the panel

Use the prev / next arrows or the month label to jump months.

## Today's Tasks

Tasks with a due date matching the focused date. Each row shows:

- Title
- Status chip
- Priority chip
- Project (if any)
- Subtask progress (if any)

Click a task to open its detail drawer; right-click for the context menu (status / priority / etc.).

## Schedule

Calendar events for the focused date plus a preview of that day's journal entry (when applicable).

If the [Google Calendar integration](/user-guide/settings#google-calendar) is linked, external events appear here too.

## Resizing

- Drag the panel's left edge to resize
- Double-click the edge to reset to default width
- Width persists per device

## Hiding the Panel

Toggle the panel from the workspace header or with the panel's collapse button.

When the panel is open, it starts at the tab bar edge and the tab bar reserves that space. The
collapse button stays at the far right of the panel, so opening and closing the sidebar uses the
same pointer location.

When the panel is hidden, focus state still tracks (so reopening the panel restores the previously focused date).

The **Today** label follows the real date: in a session left open past midnight it moves to the new day on its own, so yesterday is no longer labelled "Today".

## Why a Panel and a Calendar Tab?

The Day Panel is the **always-visible** glance — what's today, what's due. The [Calendar tab](/user-guide/calendar) is the focused work surface for planning across days, weeks, and months.

You can have both open: panel pinned, calendar tab in a split pane.

## Sync of Focused Date

The focused date is local to the device (it's a UI state, not synced data). If you focus a date on your laptop, your phone won't follow.

## See Also

- [Calendar](/user-guide/calendar)
- [Journal Calendar Navigation](/user-guide/journal/calendar-navigation)
- [Tasks](/user-guide/tasks/list-vs-kanban)
