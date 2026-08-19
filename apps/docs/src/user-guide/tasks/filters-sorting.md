# Filters & Sorting

Filter, sort, and group tasks. Save filter sets you reuse.

<!-- screenshot: filter bar with active filters and saved filters dropdown -->

## Filter Bar

Above every task view. Filters available:

- **Status** — multi-select
- **Priority** — High / Medium / Low / None
- **Project** — multi-select
- **Due date** — overdue, today, this week, no date, custom range
- **Tags** — multi-select
- **Assignee** (where applicable)

Active filters render as removable chips so you can see the current scope at a glance.

### How the Tag Filter Matches

Selecting several tags shows tasks carrying **any** of them, not only tasks carrying all of
them. Picking `MIT` and `errand` gives you both sets together — the same "any of these"
behaviour as the Status, Priority, and Project filters.

Tag matching ignores case, so `MIT` and `mit` are one tag. The filter matches tags exactly:
filtering on `work` will not pull in tasks tagged `work/urgent`. (The tag view in the
sidebar does include those — see [Properties & Tags](/user-guide/notes/properties-tags).)

### Finding Tasks With No Due Date

The **Due date** filter opens on a calendar, with **No due date** as the first row above it.
Pick it and the list narrows to tasks that carry no date at all — the one set every date
scope hides, since [Today, Tomorrow, and Next 7 days](/user-guide/tasks/list-vs-kanban) are
all due-date windows. Pick the row again to go back to any due date.

Two things to know:

- The scope dropdown still applies. **No due date** inside **Today** matches nothing by
  construction; the page says so and offers to clear the filters. Set the scope to **All**.
- Save it (see below) and the Home dashboard's Tasks widget can point at it, which is how
  undated work gets a permanent home on the dashboard — see
  [Home Dashboard](/user-guide/home-dashboard).

## Quick Filter Chips

Pre-built chips at the start of the bar for the most common scopes:

- Today
- Overdue
- No project
- High priority
- Recently created

One-click toggles. Clicking a quick chip layers it on top of any active filters.

## Saved Filters

Save the current combination of filters under a name. Saved filters appear in a dropdown in the toolbar and can be set as the default view for a project.

Useful patterns:

- "Today's High-priority"
- "Overdue & no project"
- "This week's writing tasks" (project filter + tag filter)

## Sorting

Sort the visible task list by:

- Manual (default for projects — preserves drag-drop order)
- Due date
- Priority
- Created date
- Updated date
- Title (alphabetical)

Each sort can be ascending or descending. The current sort displays in the toolbar.

The default sort for new tasks is configurable in [Settings → Tasks](/user-guide/settings#tasks).

## Grouping

Group the list by:

- Status
- Project
- Priority
- Due date (today, this week, later, no date)

Group headers show counts. Subtask progress rolls up to the group level when applicable.

## Filter + Sort + Group Together

All three compose. Example combinations:

- **Group by Project, Sort by Priority, Filter to Open** — what's on each project's plate
- **Group by Due Date, Sort by Priority** — your week ahead
- **Filter to High priority, Sort by Created** — what's been waiting

## URL / Tab State

Filters, sort, and grouping persist per tab. Closing and reopening a tab restores the same scope.

## See Also

- [Capturing Tasks](/user-guide/tasks/capturing)
- [List vs Kanban](/user-guide/tasks/list-vs-kanban)
