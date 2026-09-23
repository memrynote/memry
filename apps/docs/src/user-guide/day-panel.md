# Day Panel

A right-side panel with calendar, tasks, and the schedule for a selected date.

<!-- screenshot: day panel docked on the right -->

## What's In It

Stacked sections:

1. **Calendar picker** — month grid with heatmap dots indicating activity
2. **Day header** — names the focused date: **Today · Wed, Sep 23**, or the weekday and date
   for any other day. The arrow beside it opens that day in the Calendar tab.
3. **Day timeline** — the focused date as an hour-by-hour grid (on every tab except Calendar)
4. **Tasks** — tasks due on the focused date
5. **Schedule** — calendar events for the focused date, listed only while the Calendar tab is
   active, since everywhere else the day timeline shows them

## The Calendar Picker

A compact monthly grid:

- Heatmap dots reflect activity (entries, tasks, events)
- The current day is outlined
- Click any date to set focus across the panel

Use the prev / next arrows or the month label to jump months.

## Day Timeline

The focused date's calendar, hour by hour, like the Calendar tab's Day view but compact: it
shows about six hours at a time and scrolls within itself. It opens at the current time on
today, and at 07:00 on any other day.

All-day events sit above the hours as small pills. Each block shows its title and time range.

- Drag a task from **Tasks** onto an hour to block that time for it. While you drag, a dashed
  block shows where it will land and the time range it will get. The drop sets the task's
  time; nothing is copied.
- Drag a block to move it. Drag its top or bottom edge to change its length.
- Drag across empty hours to create an event.
- Click a block to open the Calendar tab on that day.

A completed task leaves the timeline. See [Time Blocks](/user-guide/calendar#time-blocks).

On the Calendar tab the timeline is hidden, because the tab already shows the day.

## Tasks

Tasks with a due date matching the focused date. The heading shows how many there are and, on
today, how many tasks are overdue; click the overdue count to open the Tasks tab.

Each row shows the status circle and the title. A task with a time shows it at the end of the
row. Hovering an open task shows a drag handle in that spot instead. Priority and subtask
progress are not shown here; open the task to see or change them.

Click a task to open it in the Tasks tab. Click its status circle to change status or complete it.

Open tasks are draggable: onto the day timeline above, onto the Calendar tab's grid, or onto
any other task drop target.

**Add task** at the end of the list creates a task due on the focused date. Type a title and
press Enter; the field stays open for the next one. Escape closes it. The task goes to your
default project from Settings > Tasks, or to the inbox when none is set.

## Schedule

Calendar events for the focused date plus a preview of that day's journal entry (when applicable).

The day runs midnight to midnight on your own clock, the same boundary the [Home board](/user-guide/home-dashboard) uses. A late-evening event and one just after midnight land on the days you would put them on, and the panel and the board never disagree about which day an event belongs to.

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

The **Today** heading follows the real date: in a session left open past midnight it moves to the new day on its own, so yesterday is no longer labelled "Today".

## Why a Panel and a Calendar Tab?

The Day Panel is the **always-visible** glance — what's today, what's due. The [Calendar tab](/user-guide/calendar) is the focused work surface for planning across days, weeks, and months.

You can have both open: panel pinned, calendar tab in a split pane.

## Sync of Focused Date

The focused date is local to the device (it's a UI state, not synced data). If you focus a date on your laptop, your phone won't follow.

## See Also

- [Calendar](/user-guide/calendar)
- [Journal Calendar Navigation](/user-guide/journal/calendar-navigation)
- [Tasks](/user-guide/tasks/list-vs-kanban)
