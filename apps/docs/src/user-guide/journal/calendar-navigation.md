# Calendar Navigation

Browse journal entries across day, month, and year scales. Each scale shows progressively more context.

<!-- screenshot: month view heatmap showing entry density -->

## Day View

The default writing surface for a single date.

- Header arrows move ±1 day
- Date in the breadcrumb opens the picker
- The editor shows that day's entry; the day panel shows that date's schedule and tasks when the Calendar and Tasks features are enabled

## On This Day

Below each entry, **On this day** lists the same date in every other year you wrote something. Each row shows the year, the weekday, and the opening lines of that entry. Click a row to open that day.

Years with no entry, or an empty entry, are left out. If no other year has an entry on this date, the section does not appear.

**All years** in the section header switches to the Forever Journal layout: every year of the date on one page, each entry in full and read-only. Long entries fold behind **Show full entry**. **Previews** switches back. The choice is remembered.

Only the entry you have open is editable. To edit an earlier year, open that day.

### Jumping Between Years

When the same date has an entry in another year, the breadcrumb shows the nearest one: `‹ 2024` for an earlier year, `2026 ›` for a later one. The jump skips years without an entry. For example, on November 10, 2026 with no entry for 2025, `‹` goes straight to November 10, 2024. The buttons are hidden when there is nowhere to go.

The same jumps are in the [Command Palette](/user-guide/command-palette) as **Same Day, Previous Year** and **Same Day, Next Year**, with no default shortcut.

February 29 counts as February 28 in years without a leap day, so a leap-day entry still has a match every year.

Entries from other years show their year in the title, and the breadcrumb notes how far back they are, such as **2 years ago**.

## Month View

A grid of squares — one per day — with intensity reflecting entry length.

- Click any square to jump to that day
- A short preview pops on hover for non-empty days
- The current day is outlined

The heatmap uses raw word count, normalized within the visible month, so a quiet month doesn't look identical to a busy one.

Every day that has an entry shows as one, even an empty entry or one whose length has not been counted yet; those get the lightest shade instead of reading "No entry". Moving to a month in another year shows that year's entries, whichever day you had selected.

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
