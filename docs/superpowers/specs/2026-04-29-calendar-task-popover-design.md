# Calendar Task Popover

**Date:** 2026-04-29
**Status:** Draft

## Summary

When a task chip is clicked in any calendar view (month/week/day), open a small floating popover anchored to the clicked element that surfaces the task's key fields read-only, plus three inline-edit affordances (complete toggle, subtask checklist, snooze) and quick navigation to the existing `TaskDetailDrawer` and source note. Mirrors the positioning and dismissal behavior of `CalendarEventPopover`. Closes a UX gap where task chips currently render but their `onClick` is not routed to any UI.

## Goals

- Make calendar task chips clickable with a useful, fast result
- Match the visual + interaction patterns of `CalendarEventPopover` for consistency
- Cover ~80% of post-click intent ("is this done?", "what is this?", "push it to tomorrow") without leaving the calendar
- Keep the popover small enough to stay anchored without occluding adjacent days
- Reuse existing IPC and existing `TaskDetailDrawer` for any deeper edit flow

## Non-Goals

- Full inline task editing (title/description/project/status remain read-only here — use the drawer)
- Per-occurrence completion of recurring tasks (current model is one row per task; this spec preserves that — see "Recurrence" below)
- Drag-resize / drag-move of task chips from inside the popover
- Reminders or snooze items (different `sourceType`, different popover later)

## Architecture

### Component Breakdown

```
CalendarTaskPopover (new)
├── Anchored via computePopoverPosition() — same util as CalendarEventPopover
├── Rendered with DialogPrimitive.Root modal={false} + Radix Portal (matches event popover)
├── Receives { item: CalendarProjectionItem, anchorRect: DOMRect } from the calendar view
├── Renders title + due-row immediately from `item` (no skeleton flash on open)
├── Fetches in parallel using `item.sourceId` as the task id:
│   ├── useTaskById(item.sourceId)     — full row + tags + parent + project + status
│   ├── useSubtasks(item.sourceId)     — IPC tasks:get-subtasks (existing)
│   └── useDayPanel()                  — for "Open task" → opens TaskDetailDrawer
├── Mutations:
│   ├── tasks:update (toggle complete on task)
│   ├── tasks:update (toggle complete on subtask)
│   └── tasks:update (snooze: rewrite dueDate / dueTime)
└── Children: header / meta block / description / subtask list / action bar / overflow menu
```

### File Structure

```
apps/desktop/src/renderer/src/
├── components/calendar/
│   ├── calendar-task-popover.tsx          — main component
│   ├── calendar-task-popover-header.tsx   — parent breadcrumb + ☐ + title + ⋯
│   ├── calendar-task-popover-meta.tsx     — due / recurrence / project / status / priority / tags
│   ├── calendar-task-popover-subtasks.tsx — checklist + "X of Y" counter
│   └── calendar-task-popover-actions.tsx  — Open task / Source note / Snooze ▾
└── lib/
    ├── format-task-due.ts                  — "Tomorrow · 2:00 PM" / "⚠ 2 days overdue"
    └── snooze-options.ts                   — pure: input task → snooze choices + new dueDate/dueTime
```

### Wiring at the click site

`CalendarItemChip` already accepts `onClick(item, anchorRect)`. Parent calendar views (`calendar-month-view.tsx`, `calendar-week-view.tsx`, `calendar-day-view.tsx`) currently pass an `onSelectItem` that handles events. Update that handler to fork on `item.sourceType`:

```
event       → setEventPopover({ item, anchor })   (existing)
task        → setTaskPopover({ item, anchor })    (new)
reminder    → no-op (covered later)
snooze      → no-op (covered later)
```

Only one popover open at a time — opening either closes the other.

## Layout

```
┌────────────────────────────────────────────┐
│ ↳ {parent.title}                           │   ← only if parentId
│ ☐  {task.title}                       ⋯   │
│ ──────────────────────────────────────     │
│ 📅 {due-format}                            │   always
│ 🔁 Repeats {summary}                       │   only if repeatConfig
│ 📁 {project.name}      ⊙ {status.label}    │   project always; status if set
│ ⚑ {priority}    🏷 #t1 #t2 #t3 +N          │   priority if >0; tags if any, cap 3+overflow
│                                            │
│ {description, 3-line clamp}                │   only if description
│                                            │
│ Subtasks  ▸  X of Y done                   │   only if children exist
│  ☐ {subtask.title}                         │
│  ☑ {subtask.title}                         │
│  ...                                       │
│ ──────────────────────────────────────     │
│  Open task   📝 Source note ↗   Snooze ▾  │
└────────────────────────────────────────────┘
```

**Width:** ~340px fixed (matches `CalendarEventPopover` visual weight).
**Height:** dynamic. Estimated min 180px (no description, no subtasks), max 360px (everything present). Estimated height for `computePopoverPosition()`: 320px.

### Empty-field rule

Sections without data are omitted entirely — no "—" placeholders, no empty rows. This is the only way A3 stays compact when fields are sparse, which is the common case.

## Fields and Data Sources

| Field | Source | Visibility |
|-------|--------|------------|
| Parent breadcrumb | `tasks` join on `parentId` | only if `parentId` set |
| Title | `tasks.title` | always |
| Complete checkbox | `tasks.completedAt` | always |
| Due date/time | `tasks.dueDate` + `tasks.dueTime` + `tasks.endAt`(if exists) | always (calendar context guarantees one) |
| Recurrence summary | `tasks.repeatConfig` → human string | only if `repeatConfig` set |
| Project | `projects` join on `projectId` | always (FK required) |
| Status pill | `statuses` join on `statusId` | only if `statusId` set |
| Priority | `tasks.priority` | only if `> 0` |
| Tags | `taskTags` join → `tag` strings | only if any; cap 3 visible + `+N` |
| Description | `tasks.description` (3-line clamp via CSS) | only if non-empty |
| Subtasks | IPC `tasks:get-subtasks` | only if returns ≥1 |
| Source note action | `tasks.sourceNoteId` | button shown only if set |

**Tag overflow:** show first 3 tags by their existing display order; if more, append `+N` chip. Hover/click on `+N` is out of scope here (use `Open task` for the full list).

**Due-date format rules** (centralize in `format-task-due.ts`):

| Condition | Output |
|-----------|--------|
| Same calendar day, has time | `Today · 2:00 PM` (or range if `endAt`) |
| Tomorrow, has time | `Tomorrow · 2:00 PM` |
| This week, has time | `Thu · 2:00 PM` |
| Past date, not completed | `⚠ 2 days overdue` (red) |
| Other | `Apr 30, 2026 · 2:00 PM` |
| All-day | drop time, e.g. `Tomorrow` |

## Inline-Edit Affordances

Three, and only three. Anything outside this list goes through `Open task`.

1. **Header `☐` toggles complete.** Single click. Mutates `completedAt` (timestamp on check, `null` on uncheck). On flip-to-done, the popover stays open for ~600ms with the title strikethrough animation, then auto-closes (matches "I just checked it off" intent). On uncheck, the popover does **not** auto-close — it re-renders in the default (non-completed) layout and stays open so the user can take a follow-up action.
2. **Subtask `☐` toggles subtask complete.** Same IPC, parent popover does not close. Counter and ordering update in place.
3. **Snooze ▾ rewrites due date/time.** No new schema; this is just a reschedule UX over existing fields.

### Snooze submenu

```
Later today    · 6:00 PM   (skipped if already past 6 PM today; see edge cases)
Tomorrow       · 9:00 AM
Next week      · Mon 9:00 AM
─────────────────────────
Pick date & time…              opens a date+time picker, applies on confirm
Remove due date                 sets dueDate=null, dueTime=null
```

**Defaults:**
- "Later today": same date, time = `now + 3h` clamped to `[now+1h, 20:00]`. If `now ≥ 19:00`, item is hidden (use Tomorrow instead).
- "Tomorrow": next calendar date, `09:00`.
- "Next week": next Monday, `09:00`.

All snooze paths preserve `dueTime` precision: if the original task was all-day (no `dueTime`), the snoozed result is also all-day at the chosen date — clock options are skipped.

## State Variants

| State | Visual |
|-------|--------|
| Default | as drawn above |
| Completed | `☑`, title strikethrough, sub-line `✓ Done · {completedAt formatted}`, action bar shows `Open task` only (Snooze hidden, Source note still shown if set) |
| Overdue | due row in destructive color, `⚠` icon, relative phrase (`2 days overdue`) |
| Recurring | `🔁` row visible; behavior identical to non-recurring (see Recurrence) |

## Recurrence

Existing model (`apps/desktop/src/main/calendar/projection.ts:175-187`): each task is one row, calendar query filters `isNull(tasks.completedAt)`. Completing a recurring task sets `completedAt` and the task disappears from the calendar; the recurrence is **not** auto-rolled forward. `repeatConfig.completedCount` is incremented.

**This spec preserves that behavior.** The popover's complete toggle is exactly the same mutation as everywhere else in the app. Per-instance completion / auto-roll-forward of recurring tasks is a separate problem and explicitly out of scope.

The popover's only recurrence-aware behavior is the read-only `🔁 Repeats {summary}` row, computed from `repeatConfig`.

## Action Bar and Overflow Menu

**Action bar (left → right):**
1. `Open task` → `useDayPanel()` triggers `TaskDetailDrawer` with this task selected. (See "Open Questions for Plan" — exact API to select a specific task in the drawer needs verification at planning time.)
2. `📝 Source note ↗` — only when `sourceNoteId` set; opens the note in the editor.
3. `Snooze ▾` — submenu above; hidden when task is completed.

**Overflow `⋯`:**
- Delete
- Duplicate
- Move to project…
- Convert to event
- Copy link

`Convert to event` and `Copy link` are placeholder labels if the equivalent IPC doesn't yet exist — confirm at planning time, drop if not present.

## Dismissal & Multi-task Interaction

Mirrors `CalendarEventPopover`:
- Click outside → close
- `Escape` → close
- Clicking another calendar item → close current popover, open the new one at the new anchor
- Switching calendar view (month → week, navigating days) → close

## IPC and Data Reuse

All existing — no new IPC channels:

| Operation | Channel | Status |
|-----------|---------|--------|
| Fetch task by id | existing `tasks:*` (verify exact channel at planning time) | reuse |
| Fetch subtasks | `tasks:get-subtasks` | reuse |
| Toggle complete | existing task update via `TaskCompleteSchema` path | reuse |
| Update due date / time | existing task update | reuse |
| Open detail drawer | `useDayPanel()` context | reuse |

## Testing

Unit / RTL component tests:

- Renders title and due always
- Hides each conditional row (parent, recurrence, status, priority, tags, description, subtasks, source-note button) when its data is absent
- Tag overflow renders `+N` when more than 3
- Due format function: today, tomorrow, this week, past (overdue), distant future, all-day
- Completed state: strike-through + checked + Done sub-line + action-bar prunes Snooze
- Overdue state: destructive color + `⚠` only when not completed
- Header checkbox calls update IPC with new `completedAt` (timestamp on check, null on uncheck)
- Subtask toggle calls update IPC for the subtask, popover stays open
- Snooze options compute correct new dueDate/dueTime per defaults table; all-day path skips time
- "Later today" hidden when `now ≥ 19:00`
- Click outside / Escape dismisses
- Clicking another item replaces popover

Integration:

- Click task chip in month view → popover opens anchored to chip
- Open task button opens `TaskDetailDrawer` with this task selected
- Source note button navigates to note editor when `sourceNoteId` is set

## Edge Cases

- **Task deleted while popover open** (e.g., from another window via sync): popover dismisses gracefully; toast on attempted action.
- **Subtasks load fails**: skip the subtasks section, render the rest. No blocking spinner for the whole popover.
- **Anchor scrolls off-screen** (calendar view scroll, window resize): close the popover, matching event popover behavior.
- **Long title**: clamp to 2 lines with `text-ellipsis`. Full title visible in `Open task`.
- **Long description**: 3-line CSS clamp; no "show more" toggle (use `Open task`).
- **Time-zone**: due-date formatting uses the same TZ logic as the rest of the calendar — defer to existing util, do not reinvent.

## Accessibility

- Popover is a `dialog` role with `aria-modal="false"` (matches event popover). Initial focus on the complete checkbox so Space immediately toggles done.
- Tab order: complete checkbox → overflow menu → subtasks (each a focusable checkbox) → action bar buttons.
- All interactive elements keyboard-reachable; `Escape` always closes.
- Status pill, priority, and tags include screen-reader labels (e.g. `aria-label="Status: In Progress"`).

## Internationalization

All user-facing strings (action labels, "Tomorrow", "Repeats weekly", "X of Y done", overflow menu items) go through the existing `i18n` pipeline (see `docs/i18n-adding-a-locale.md`). RTL: use logical Tailwind classes (`ms-*` / `me-*` / `text-start` / `text-end`) per project rule.

## Open Questions for the Plan

These don't change the design but need a concrete answer before code:

1. Exact API for "open `TaskDetailDrawer` selected to task X". The day-panel context exposes `openForDayView(date)`; the drawer accepts a `task: Task | null` prop, but the wiring to set the *selected* task from outside the drawer needs verification or a small extension to the context (e.g., add `openForTask(taskId)`).
2. Confirm IPC channels for `Move to project`, `Duplicate`, `Convert to event`, `Copy link` exist; drop any that don't.
3. Verify whether `tasks:get-subtasks` returns task rows with their tags and statuses pre-joined, or whether the popover needs separate joins for the parent task itself.

## Out of Scope (Future Work)

- Per-instance completion of recurring tasks
- Drag-rescheduling from the popover
- Inline edit of title / description / project / status (Open task covers this)
- Reminder and snooze-source popovers (separate `sourceType`s)
- Bulk actions across multiple tasks
