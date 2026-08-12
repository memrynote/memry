# Calendar Navigation

Browse journal entries across day, month, and year scales. Each scale shows progressively more context.

<!-- screenshot: month view heatmap showing entry density -->

## Day View

The default writing surface for a single date.

- Header arrows move ±1 day
- Date in the breadcrumb opens the picker
- The editor shows that day's entry; the day panel shows that date's schedule and tasks when the Calendar and Tasks features are enabled

## Month View

A grid of squares — one per day — with intensity reflecting entry length.

- Click any square to jump to that day
- A short preview pops on hover for non-empty days
- The current day is outlined

The heatmap uses raw word count, normalized within the visible month, so a quiet month doesn't look identical to a busy one.

## Year View

Annual statistics for the focused year:

- Entries per month
- Total words
- Longest streak (consecutive days with entries)
- Words-by-month sparkline

Useful for end-of-year retrospectives.

## Date Picker

Available from:

- The breadcrumb in any journal view
- The picker icon next to the date

Picks any date, switches to that view if needed.

## Day Panel Integration

The [Day Panel](/user-guide/day-panel) on the right has its own monthly grid. Clicking a date in the day panel sets focus across the journal — both the panel and the journal page navigate together.

## Streak

If you write something every day, the year view shows the streak count. memrynote doesn't gamify streaks beyond displaying them — there are no notifications, badges, or pressure.

## Gaps

Empty days are visualized but not editable as "no entry". Just open the day; if it's empty, memrynote creates a fresh entry seeded with your default template the moment you focus the editor.

## Sync

Calendar views read directly from local data. Newly synced entries appear after the next pull cycle.
