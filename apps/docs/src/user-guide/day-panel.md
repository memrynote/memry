# Day Panel

A right-side panel with calendar, tasks, and the schedule for a selected date.

<!-- screenshot: day panel docked on the right -->

## What's In It

Three stacked sections:

1. **Calendar picker**: month grid with heatmap dots indicating activity
2. **Timeline**: an hour-by-hour view of the focused date, with events and timed tasks
3. **Unscheduled**: tasks due on the focused date that have no time yet

## The Calendar Picker

A compact monthly grid:

- Heatmap dots reflect activity (entries, tasks, events)
- The current day is outlined
- Click any date to set focus across the panel

Use the prev / next arrows or the month label to jump months.

## Timeline

An hour grid for the focused date. Today opens on the current time; other days open at 08:00. A line marks now, and hours already past are dimmed. All-day items sit in a strip above the grid.

Calendar events and timed tasks appear as blocks. Tasks have a checkbox; tick it to complete the task and the block leaves the timeline. Items that overlap sit side by side.

The day runs midnight to midnight on your own clock, the same boundary the [Home board](/user-guide/home-dashboard) uses.

If the [Google Calendar integration](/user-guide/settings#google-calendar) is linked, external events appear here too.

### Time blocking

- **Schedule a task**: drag it from the Unscheduled list onto the timeline. It snaps to the half hour and becomes a 30-minute block.
- **From a note**: drag a task line from a journal entry or any note by its block handle onto the timeline. The line stays in the note; it is the same task.
- **Change the length**: drag the bottom edge of a task block. It grows from 30 minutes to 1 hour, then in whole hours.
- **Move it**: drag the block to another time. It keeps its length.
- **Reach a later hour**: hold the dragged task near the top or bottom edge of the timeline and it scrolls.
- **Unschedule**: drag the block back onto the Unscheduled list. The task stays due that day without a time.

Past days accept drops too.

## Unscheduled

Tasks due on the focused date that have no time and are not done. Each row shows its status and priority; click a task to open it.

With the calendar turned off in settings, the panel shows the task list without the timeline.

## Resizing

- Drag the panel's left edge to resize
- Double-click the edge to reset to default width
- Width persists per device

## Hiding the Panel

Toggle the panel from the workspace header, with the panel's collapse button, or with <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>B</kbd> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> on Windows / Linux).

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
