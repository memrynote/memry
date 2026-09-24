# Tasks: iOS Tasks redesign (Paper "Task iOS")

**Goal**: replace the iOS Tasks views with the Paper redesign (file "Task iOS",
`01M39KJ8S9S5QYX38B2HP3Q1BF`, artboards 00–20), screen by screen, keeping every
behavior spec 004 shipped (TP040–TP057). UI/UX rebuild only. Full brief:
`specs/005-ios-tasks-redesign/goal.md`.

**Reference**: artboard **00 · Feature audit + redesign map** is the spec for
where each behavior lives. Desktop wins any behavior question the design does
not answer (goal "Fixed decisions").

**Format**: `[ID] Description`. A task added later takes a suffix letter
(`RD05a`) so no id moves.

**Checkbox protocol**: tick `[x]` only when the item's own verification ran
green. Under the tick append one indented `Evidence:` line (command + result,
test name, screenshot path). Never tick partial work: split it with a suffix.

---

## 0. Operating rules (read before every resume)

### 0.1 Session

- One session, no questions to Kaan. Ambiguous: pick desktop's behavior, write
  it to §6 Decisions, continue.
- Blocked by something outside the repo: write it to §7 Blockers with
  evidence, skip to the next unblocked item, retry once per phase.
- This file is the only state. After a restart: re-read §0, §1, §6, §7, then
  continue at the first unticked item.
- Spec 004 still applies: §0.3 (simulator), §0.4 (sign-in recovery), §0.5
  (test data prefixes), §1 D1–D7, §5 facts, §6 decisions.

### 0.2 Scope

- Edit only `apps/ios/Memry/Features/Tasks/**`, `apps/ios/Memry/Design/**`
  (shared primitives only), tests under `apps/ios/MemryTests` /
  `apps/ios/MemryUITests`, this spec and `apps/ios/SpikeEvidence/tasks-redesign/`.
  `Features/Notes/VaultTabsView.swift` only if the tab bar must hide for select
  mode.
- No Rust core, UniFFI, generated Swift, sync, storage or wire changes. A
  missing core call is logged in §7 and that item stops.

### 0.3 Rules carried from goal.md

- Behavior parity: every row of the 00 audit table stays reachable at the
  place 00 names, or the nearest native equivalent. Undrawn behaviors stay:
  Kanban column modes, custom repeat editor, repeat-from, Stop/Edit Repeating
  dialogs, parent-picker search, subtask bulk menu, complete/delete-parent
  dialogs, drag reorder and reschedule, hardware keyboard shortcuts, reminder
  edit/delete, saved-filter rename/reorder/star, project reorder/archive/delete
  dialogs, unsaved-changes guard.
- Native iOS 26 first: `toolbarTitleMenu`, `ToolbarItemGroup` +
  `ToolbarSpacer`, `.buttonStyle(.glass / .glassProminent)`, `Menu` +
  `ControlGroup`, `Picker` in menus, `.swipeActions`,
  `.contextMenu(menuItems:preview:)`, `.presentationDetents`, `safeAreaInset`
  composer, `scrollTargetBehavior(.viewAligned)`. System glass, never
  hand-drawn.
- Values from Paper (`get_jsx` / `get_computed_styles`) mapped to `Tokens`. No
  new hex in views, no `Font.system(size:)`. 17/15/13 px = body / subheadline
  / footnote Dynamic Type roles. A value with no token takes the nearest and
  is logged; a token is added only for two call sites.
- 00 design rules: a property in ≤ 2 taps; show only set values; one primary
  action per screen; rows = title + one meta line (date, repeat, subtasks,
  note, project), priority in a fixed trailing slot, never repeat what the
  screen states (no date in its own date group, no "Inbox"); glass only on
  chrome; the tint fills, `Tokens.Text.tint` for tinted text.
- Accessibility keeps or improves TP057: VoiceOver labels + custom actions
  (complete, reschedule, delete), Dynamic Type to AX5 (wrap/stack), 44pt hit
  targets, `calmAnimation`, Reduce Transparency solid fallback, leading/
  trailing only, WCAG AA light and dark.
- Copy through `TasksCopy*`, desktop `tasks.json` wording where one exists.
- iOS rules: no `!` / `try!`, `ErrorMapping`, `Log.swift`, a `List` with
  `onMove` owns no multi-selection, Feature Swift files ≤ 400 lines
  (`node scripts/check-line-ceilings.mjs`).

### 0.4 Verification per artboard

- Build and run on `iPhone 17` iOS 26.5 `A7E3D181-58A5-4982-9899-4FD15F5666DC`
  (never erase), drive through `AgentDriverUITests` (spec 004 §6 TP001).
- Screenshot to `apps/ios/SpikeEvidence/tasks-redesign/RDxx-<state>.png`,
  compare with `paper_get_screenshot` of the artboard: spacing, lane
  alignment (status / title / priority), type roles, colours, glass placement,
  shown/hidden, tap counts.
- Unit + UI plans: `xcodebuild test -project apps/ios/Memry.xcodeproj -scheme
Memry -testPlan Unit|UI -destination 'platform=iOS Simulator,id=A7E3D181-58A5-4982-9899-4FD15F5666DC'`.
  Conformance stays green, untouched.
- `node scripts/check-line-ceilings.mjs`, `git diff --check`.

---

## 1. Fixed decisions (goal.md; not revisited)

- F1 "+" is a floating glass-prominent circle above the tab bar, bottom
  trailing. No second add entry point in the nav bar.
- F2 Tags are not shown in rows or cards; they are pills in the detail and
  stay filterable.
- F3 The Add Task sheet is removed. The composer covers every field; its "…"
  chip opens Status, Parent task, Reminder, Start date and "More fields…"
  (the When sheet).
- F4 The segmented view tabs and the project pill row are removed for the
  title menu.
- F5 Anything else ambiguous: desktop's behavior, logged in §6.

---

## Phase 0: plan

- [x] RD00a Read goal.md, root + iOS `AGENTS.md`, `DESIGN.md`, `PRODUCT.md`,
      spec 004 §0.3/§0.4/§1/§5/§6, artboard 00 in full, screenshots of 01–20,
      `Tokens.swift`; create this file.
      Evidence: this file; artboard 00 read via `paper_get_jsx 2WO-0` (19 audit rows, 6 interaction rules, 9 SwiftUI mappings); 01–20 read via `paper_get_screenshot` + `paper_get_jsx 1-0`.

## Phase 1: primitives

- [x] RD01p Primitives in `TaskPrimitives` / Design: status icon (dashed ring
      = todo, half = in progress, filled check = done, status colour), priority
      bars (three bars, filled by level), meta line (date, repeat, subtasks,
      note, project; context-aware), property pill, composer chip, glass
      capsule, toast capsule. Unit tests for the label and formatting logic.
      Evidence: `TaskPrimitives.swift` (status lane/glyphs, cellularbars priority, due label with day omission, progress ring, project dot), `TaskMetaLine.swift` (`TaskMeta` + wrapping `TaskFlowLayout`), `TaskPills.swift` (pill, composer chip, dashed add pill, sheet confirm, `taskGlass` with Reduce Transparency fallback), toast capsule in `TasksToast.swift`, token `Size.pill`. `TasksPrimitivesTests` 6 passed; Tasks suites 180 tests / 17 suites passed.

## Phase 2: list and capture

- [x] RD01 **Today / list** (`TaskListScreen`, `TaskListHeader`,
      `TaskListBody`, `TaskRowView`, `TaskRowBadges`): large title with title
      menu, subtitle ("Thursday, Sep 24 · 3 of 9 done" on Today), one glass
      capsule (filter + more), rows = title + one meta line, fixed trailing
      priority slot, group headers (Overdue in the overdue colour, count),
      Completed collapsed, floating glass-prominent "+".
      Carries: TP040 views + counts, overdue first, completed collapsed,
      per-view empty states, pull-to-refresh, Today progress (now the
      subtitle), persisted view state; TP041 tap opens detail, circle
      completes with haptic; TP050 drag reorder/reschedule; error notice;
      VoiceOver row sentence + custom actions (complete, reschedule tomorrow,
      delete, move up/down); hardware shortcuts.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD01-today.png, RD01-today-groups-scrolled.png (Today group rows show only the time; inline title + menu after scroll); `TasksListTests` (title/subtitle, named flat section, day omission) 17 passed.
- [x] RD02 **Title menu** (replaces `TaskListTabs`, scope sheet entry,
      segmented view-mode): views with counts (All, Today, Tomorrow, Next 7
      days, Archived), Project submenu (All projects + live projects + search),
      starred saved filters, Projects.
      Carries: TP040 scope picker, starred filters apply, project search
      (kept via "Search projects…" into `TaskListScopeSheet`), Projects route.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD02-title-menu.png (views with counts, Project submenu, Projects), RD02-title-menu-starred-view.png (starred saved view, applied and cleared); Project submenu scoped the list to Agent Test Redesign.
- [x] RD03 **Quick add composer** (`QuickAddBar` → composer): "+" opens a
      composer docked above the keyboard (`safeAreaInset`): status ring, title
      field, Notes line, horizontal chips (Date, Priority, Project, #, …), send
      button. Return = next (keeps it open).
      Carries: TP042 quick add + Add Task sheet: title, description, project,
      status, parent, priority, due + time, start date, repeat, tags,
      reminder, create another (Return keeps it open), help, project
      resolution chain, empty-state "Add task for today/tomorrow" due preset,
      project-hub and board column presets.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD03-composer.png (composer docked above the keyboard, Today + project presets from "Add task for today"); Return created `[agent] Redesign check` and kept the composer open; tap outside closes and keeps the draft (driver `value` read "draft kept"). `TasksComposerTests` 6 passed.
- [x] RD04 **Natural language fills chips**: tokens highlight inline
      (`@date`, `every …`, `!priority`, `+project`, `#tag`, `[[note]]`) and
      fill the Date / Priority / Project / # chips live; ghost completion;
      project / tag / note suggestions.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD04-natural-language-chips.png (`@tomorrow 10am !high` highlighted inline, chips Tomorrow 10:00 / High / Inbox); the task landed in Tomorrow with 10:00 and High.
- [x] RD05 **When menu** (composer chip, detail pill, swipe Date): medium icon
      row Today / Tomorrow / Next week, This weekend, Pick date & time…,
      Repeat › (presets + current), Remind me › (presets), Remove date.
      Carries: TP044 quick dates (core-resolved), TP045 presets, TP053
      presets.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD05-when-menu.png (icon row, This weekend Sat, Pick date & time…, Repeat, Remind me), RD05-when-menu-set-tomorrow.png (chip set to Tomorrow in 2 taps).
- [x] RD06 **Swipe**: leading Complete (reopen when done); trailing Date
      (the When menu targets) and Delete.
      Carries: TP041 swipe complete / reschedule / delete, requestDelete
      prompts, Undo toast.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD06-swipe-leading.png (Complete) and RD06-swipe-trailing.png (Date, Delete); leading swipe completed `[agent] Redesign check`, toast Undo reopened it.
- [x] RD07 **Row menu** (`.contextMenu(menuItems:preview:)`): small icon row
      Today / Tomorrow / Next week / No date; Priority ›, Status ›, Move to ›;
      Duplicate, Make subtask of…, Select; Archive (Unarchive), Delete.
      Carries: TP041 Move menu, duplicate-with-subtasks dialog, parent
      picker (with search), archive/unarchive, delete; TP047 enter select
      mode with the row selected.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD07-row-menu.png (icon row, Priority/Status/Move to, Duplicate, Make subtask of…, Select, Archive, Delete; preview = row); Select entered select mode with the row selected (RD14-select-mode.png).
- [x] RD12 **… menu**: medium row List / Board / Select; Group by ›, Sort ›,
      Show completed, Task settings.
      Carries: TP040 List/Kanban switch, TP047 select mode, TP048 group-by
      field + direction and sort, completed visibility, TP055 settings route.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD12-more-menu.png (List/Board/Select, Group by, Sort, Show completed, Task settings).
- [x] RD13 **Filter sheet**: xmark / Filter / checkmark, search, preset chips,
      one menu row per dimension (Project, Priority, Tags, Due, Status,
      Repeat, Has time, Show), Clear all / Save as view.
      Carries: TP048 every dimension incl. custom due range and status after
      a project, presets, saved filters save/apply/rename/delete/reorder/
      star, active-filter chips + clear.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD13-filter-sheet-medium.png, RD13-filter-sheet-large.png (Overdue preset active, Due row reads Overdue in red), RD13-saved-views.png (Save as view "Agent Test View", starred).
- [x] RD14 **Select mode**: "Select all" capsule + prominent checkmark, "N
      selected" title, drag hint subtitle, selection circles, glass bottom
      toolbar Complete / Date / Move / More replacing the tab bar.
      Carries: TP047 select all/deselect all, bulk complete, priority, due +
      time, move to project, status (one project), archive/unarchive, delete
      with confirmation, Cmd+A / Cmd+Return / Cmd+Delete / Esc; TP050
      multi-row drag.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD14-select-mode.png ("Select all", prominent check, "1 selected", selection circles, one glass bottom bar Complete/Date/Move/More, tab bar hidden); bulk Complete wrote and toasted (RD15-toast-select-mode.png).
- [x] RD15 **Undo toast**: dark capsule beside the "+", message + Undo.
      Carries: TP051 every undoable write, next-occurrence notice, VoiceOver
      announcement + 10 s under VoiceOver, Cmd+Z while shown.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD15-toast-beside-plus.png (dark capsule beside the "+", Undo reopened the task), RD15-toast-select-mode.png (above the bottom bar).
- [x] RD20 **Empty Today**: check glyph, title, next-view hint + link.
      Carries: TP040 per-view empty states (all, project, tomorrow, next 7,
      archived, filtered + clear filters), add-task action.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD20-empty-today.png ("1 task due tomorrow." + "Show tomorrow"), RD20-show-tomorrow.png (the link switched the view); `TasksListTests.a_view_whose_tasks_are_all_done_is_empty_and_names_the_next_view` passed.

## Phase 3: detail and dates

- [x] RD08 **Detail**: status circle (complete toggle) + large editable
      title; pills only for set fields (status, priority, When with repeat /
      bell glyphs, project, tags, start date, parent) + dashed "+" pill;
      notes; subtasks "N of M" + progress bar + inline Add subtask; Linked
      (only when present); activity footer line.
      Carries: TP043 every field, description editor + preview, related items
      (add/search/remove, missing state), activity (footer + sheet), created/
      archived meta, unarchive, delete confirm, FR-061 missing-task state;
      TP046 subtasks inline add, reorder, promote, complete/delete parent
      dialogs, all-subtasks-done prompt, subtask bulk menu; TP053 reminders
      list with edit/snooze/dismiss/delete.
      Evidence: apps/ios/SpikeEvidence/tasks-redesign/RD08-detail.png (status circle, title, pills with repeat + bell inside When, notes, Sub-issues 1 of 3 + bar, footer), RD08-linked-and-footer.png (Linked only when present, title-only row), RD08-complete-parent-dialog.png, RD08-subtask-menu.png (Open / Promote / Move up / Delete; Move up reordered on device), RD08-activity-sheet.png (footer line opens the feed); on device: rename via title field, 3 subtasks added inline, notes tap-to-edit + keyboard Done, subtask complete moved the bar. `TasksDetailTests` (19, incl. `the_footer_line_names_created_edited_and_archived`, `an_unknown_task_id_is_absent_not_a_crash` for FR-061) and all 17 Tasks suites (186 tests) passed.
- [x] RD09 **Add property ("+")**: Tag, Start date, Parent task, Link note or
      file (+ Priority / Date when unset).
      Carries: TP043 tags autocomplete, start date, TP046 parent picker with
      search, TP043 related search.
      Evidence: RD09-add-property-menu.png (Priority ›, Tag, Start date, Parent task, Link note or file, Reminder; Date appears when unset), RD09-tags-sheet.png (tag added, pill shown), RD09-parent-picker.png (searchable, same/other project); "Link note or file" searched and linked "iOS Parity Test" (RD08-linked-and-footer.png); Priority → High set from the menu in 2 taps.
- [x] RD10 **Detail …**: Duplicate, Make subtask of…, Activity, Archive
      (Unarchive), Delete.
      Evidence: RD10-more-menu.png, RD10-duplicate-dialog.png (with items / task only; "Copy of …" created), RD10-make-subtask-of.png, RD10-archived-unarchive.png (footer gains "Archived …", menu offers Unarchive; unarchived on device), RD10-delete-confirm.png (confirm → "Task deleted" + Undo).
- [x] RD11 **When sheet**: detent sheet, xmark / When / prominent checkmark;
      natural-language field with live resolved value (dates and repeats);
      graphical calendar; rows Time, Repeat, Remind me, Start date.
      Carries: TP044 natural-language field + ghost, calendar, time add/
      clear, remove date; TP045 custom editor, repeat-from, Stop/Edit
      Repeating dialogs; TP053 reminder picker, edit, delete.
      Evidence: RD11-when-sheet.png (detent over the detail, tint-ink selection, Remind me shows the reminder), RD11-natural-repeat.png ("every thu 3pm" → "Weekly · Thu 15:00"), RD11-ghost.png (core completion + accept), RD11-edit-repeating.png (one question after the sheet leaves; "all future" wrote the date and the Thursday rule), RD11-stop-repeating.png ("Never" on a series), RD11-repeat-page.png (current rule section + presets), RD11-custom-repeat.png, RD11-remind-page.png / RD11-reminder-actions.png / RD11-edit-reminder.png (edit, snooze, dismiss, delete; delete done on device), RD11-when-sheet-task.png; time cleared and date removed on device (When pill left, "+" offered Date). `TasksDetailTests.a_when_sheet_date_change_on_a_series_asks_once` / `…_ends_a_series_asks_stop` / `…_on_a_plain_task_writes`, `TasksDatesTests.the_when_field_reads_a_repeat_with_its_time` passed.

## Phase 4: board and projects

- [ ] RD16 **Board**: paged columns (`viewAligned`) with the next one peeking,
      header with status mark, count and "+", minimal cards, page dots.
      Carries: TP049 column modes (canonical, status, priority, due, project),
      drag between columns, per-column add, done "show N more", card menu /
      VoiceOver moves.
- [ ] RD17 **Projects**: progress-ring rows with counts, Inbox, Archived
      collapsed, "+" glass button.
      Carries: TP052 reorder, archive/unarchive, delete dialog, edit, open hub.
- [ ] RD18 **Project hub**: ring + title, "7 of 12 done · 1 overdue",
      description, overview note card, tasks (no project name), Linked, "…"
      menu with the project actions, floating "+".
      Carries: TP052 overview note pick/clear, links pin/unlink, edit,
      archive, delete.
- [ ] RD19 **Project sheet**: name with colour dot, one-row palette,
      description, Statuses row.
      Carries: TP052 icon, name ≤ 50, palette, status editor (≥ 2, type,
      colour, reorder, delete), unsaved-changes guard, delete.

## Phase 5: verification

- [ ] RD90 Accessibility: AX5, forced RTL, Reduce Motion / Reduce
      Transparency screenshots; VoiceOver tree dumps for list, detail and
      composer.
- [ ] RD91 Dark mode: light and dark screenshots of 01, 03, 08, 11.
- [ ] RD92 Tests: Unit and UI plans green, `TasksUITests` updated to the new
      structure (no coverage lost), Conformance green and untouched, line
      ceilings, `git diff --check`, `git diff --stat` inside the allowed paths.
- [ ] RD93 Final report in §8; test data (`[agent] `, `Agent Test …`) deleted.
- [ ] RD00 Parity audit: every row of the 00 audit table exercised on the
      simulator at its new location, each with evidence.

---

## 6. Decisions log

<!-- date — id — choice — why -->

- 2026-09-24 — RD00a — `xcodebuild build-for-testing` must name a test plan (`-testPlan Unit` / `-testPlan UI`). Without one every test target builds, `MemryCore` becomes a shared dynamic package product (app + Conformance) and `MemryTests` fails to link against `MemryCoreGenerated`. Scoped to one plan, the build is green. Not a code change.
- 2026-09-24 — RD01p — Priority is SF Symbols `cellularbars` with a variable value (four bars: low 1 .. urgent 4) instead of Paper's hand-drawn three bars: native, scales with Dynamic Type, and gives low priority a shape of its own (Paper draws no low). Status marks are SF `circle.dashed` / `circle.lefthalf.filled` / `checkmark.circle.fill`.
- 2026-09-24 — RD01p — Values with no token: Paper's 20pt screen edge = `Space.inset + Space.tight` (`TaskLayout.edge`), the 24pt status lane = `Space.section` (`TaskLayout.lane`), the 11pt row padding = `Space.medium`. One token added, `Size.pill` (32pt capsule height), shared by detail pills, composer chips and the toast's Undo. The composer's 26pt radius maps to `Radius.container` (20). Paper's 17/15/13 px = body / subheadline (`supporting`) / footnote (`caption`); the 34px title = `screenTitle` at bold.
- 2026-09-24 — RD01 — The Inbox is never named in a row, and a row inside a Today/Tomorrow group or view shows only its time (goal rule 4). Artboard 01 still draws "Inbox" on one row; goal.md's rule wins. An overdue date always shows.
- 2026-09-24 — RD01/RD02 — iOS 26.5 shows `toolbarTitleMenu` only on an inline title: with `.large` there was no chevron and tapping the title did nothing; after scrolling, the inline title became a menu button (driver tree). So the large title and subtitle are drawn as the list's first element (a `Menu` whose label is the title + chevron), and the nav bar is `.inline` with an empty title until that header scrolls away, when the inline title (with `toolbarTitleMenu`) and `navigationSubtitle` take over.
- 2026-09-24 — RD02 — Menu rows draw no trailing badge, so each view's count is its row subtitle. The project scope keeps its search (TP040) as "Search projects…" inside the Project submenu, opening the existing scope sheet.
- 2026-09-24 — RD01 — The Done section is titled "Completed" (Paper; desktop's `completedAt` group label). On Today/Next 7 the rows after the Overdue header get the view's name as a header ("Today 4"). A view whose open tasks are all done shows the empty state (artboard 20) and keeps its Completed section under it, so completed tasks stay reachable.
- 2026-09-24 — RD01 — Active filter chips under the title are removed (not in the redesign). The subtitle says "Filtered", the filter button fills, and the filter sheet shows each dimension's value with its own clear plus Clear all; the filtered empty state keeps "Clear all filters".
- 2026-09-24 — RD12 — Group by = the sort field (desktop groups by the sort field); Sort = direction. "Show completed" is new (desktop has none on the task list): a device-local view choice (`TasksViewState.hidesCompleted`, optional so older saved states decode) that hides the Completed section. Board moves to the All view (desktop shows the board on All only). The board's column mode moved into the … menu ("Columns").
- 2026-09-24 — RD14 — Select mode is edit mode, so rows show the system reorder handles (drag a selected row to move the selection, TP050); Paper draws none. The four actions share one bottom glass bar.
- 2026-09-24 — RD15 — The toast is drawn in the dark palette in both appearances (the tokens' dark halves read directly: an `AdaptiveColor` resolves through UIKit traits, which a SwiftUI `colorScheme` override does not reach). On the list it sits beside the "+" (or above the composer / bottom bar); pushed screens show it at the bottom.
- 2026-09-24 — RD03 — The composer's reminder is one reminder (desktop presets or a custom date), added right after the task is created; a task's full reminder list stays on the detail's When sheet. Return ("next") keeps project, parent, status and date for the next task, as "Create another" did. A chip set by hand wins over the typed token for that property.
- 2026-09-24 — Phase 2 verification — Completing from select mode completed "Refill creatine" (unmarked data); the Undo toast had expired before the tap, so it was reopened from the Completed section at once (net-zero, as spec 004 §6 Phase 4).

- 2026-09-24 — RD20 — The Today empty state keeps desktop's title "All caught up for today" (`today-empty-state.tsx`; the goal requires desktop wording where one exists) instead of Paper's "Nothing left for today". Paper's next-view hint is new copy: "N tasks due tomorrow." + "Show tomorrow" (Today → Tomorrow → Next 7 days; Tomorrow → Next 7; Next 7 → All), else the view's own line and add action. Filter presets keep desktop's labels ("High Priority", "Due This Week", "No Due Date").
- 2026-09-24 — RD03 — The composer closes on a tap outside it (the typed title is kept for the next open), on Esc from a hardware keyboard (a `UIKeyCommand` on the field: a focused text view swallows Esc before SwiftUI shortcuts), on entering select mode and on leaving the screen. Paper draws no close control; closing on focus loss was unreliable with chip menus, which take the keyboard away.
- 2026-09-24 — RD01/RD07 — Tap counts are counted after the gesture that opens a surface (long press, swipe): from the list, date = long press → icon row (1 tap) or swipe → Date → day (2); priority and status = long press → submenu → value (2). Composer: "+" → type → chip → option → send.

- 2026-09-24 — RD08 — Desktop's "Sub-issues" heading (`tasks.json` `subIssues`) is kept over Paper's "Subtasks" (goal: desktop wording wins). Reminders left the detail body: the When pill shows a bell when any is set and the list lives on the When sheet's Remind me page (edit, snooze, dismiss, delete as before). The description has no header or Edit/Done button: tap the text to edit, the keyboard's Done or leaving ends it. Unarchive and Delete moved to the … menu; the footer is one line ("Created … · Edited … · Archived …") that opens the activity feed, replacing the inline three-entry preview. Linked shows the title only for present items (the not-on-device / missing lines stay); an empty Linked section renders nothing and linking is the "+" pill's "Link note or file".
- 2026-09-24 — RD11 — On a repeating task, every change made together on the When sheet (date, start, rule) goes into one Edit Repeating question; "only this" / "all future" applies them all in one undo (previously a rule change alongside a date change would have been dropped). Removing the rule asks Stop Repeating and writes the dates directly. "every thu 3pm": quick add leaves the bare time as title text, so the remainder is read as a time. The calendar's selected day uses tint-ink (white text on it passes contrast; raw tint would not, rule 6). Detent 85 % over the detail with an opaque canvas background (Paper draws an opaque sheet); rows grouped on surface.
- 2026-09-24 — RD08/RD11 — Sheet chrome made uniform: xmark close + prominent checkmark on the date, reminder, custom repeat, parent picker, related picker and activity sheets (were text Cancel / Done / Save / Close). Identifiers unchanged.
- 2026-09-24 — RD01 follow-up — A view whose only open group is the view itself (Tomorrow's "Tomorrow") shows no group header (goal rule 4), and that group cannot fold its rows away; All keeps the header. `TasksListTests.a_lone_group_that_is_the_view_has_no_header`.
- 2026-09-24 — Phase 3 verification — One crash while presenting the When sheet from the detail right after the … menu (SIGSEGV in AttributeGraph during sheet layout, `Memry-2026-09-24-171632.ips`) with the earlier Linked section that loaded inside an empty `Section`; after moving the load to the detail's List (`linkedItemsLoader`) the same sequence ran clean three times. A test rename left "[ v2agent] Redesign check" in Agent Test Redesign (cursor landed mid-title); it goes with that project in RD93.

## Removed views (Phase 3)

- `TaskDetailProperties.swift` (menu/sheet property rows): the pills (`TaskDetailPills.swift`) and the When sheet; `TaskRepeatText` moved to `RepeatSheet.swift`.
- `RepeatSheet` (standalone repeat sheet): the When sheet's Repeat page (`TaskWhenRepeatPage`) with the same presets, custom editor, repeat-from and "current repeat" section; `RepeatSheet.swift` keeps `RepeatCurrentSection`, the prompt host and the text helpers.
- `TaskActivitySection` (inline last-three preview): the footer line; `TaskActivityRow` stays for the feed.

## Removed views (Phase 2)

- `QuickAddBar.swift` (always-visible capture bar): quick add, live tokens, ghost, suggestions, help and the project hint moved to the composer (`TaskComposer*.swift`); its "open detail" expand is no longer needed (the composer covers every field).
- `AddTaskSheet.swift`, `AddTaskFields.swift` (Add Task sheet, F3): title, description (Notes line), project, status, parent (`TaskComposerParentPicker.swift`, moved as is), priority, due + time, start date, repeat, tags and reminder are composer chips or its "…" chip; "Create another" is Return ("next"); the empty-state due preset is `TaskComposerRequest.dueDate`.
- `TaskListHeader.swift` (scope tabs, scope button, List/Kanban segmented control, F4): views and scope are in the title menu, List/Board in the … menu.
- `TaskRowBadges.swift` (wrapping badges incl. tags): the one meta line (`TaskMetaLine.swift`); tags live in the detail (F2).
- `TaskFilterChips.swift` (active filter chips + group header): each dimension's value and clear are in the filter sheet rows; Clear all and Save as view in its footer.
- From `TaskFilterPanels.swift` / `TaskFilterDueStatusViews.swift` / `TaskFilterControls.swift`: the pushed project, priority and status panels and the old row label / choice picker (now menu rows in the sheet). The tags panel (search) and the custom due range page stay, pushed from their rows. `SavedFilterSection` became `SavedFiltersPage`. `TaskTodayProgress` (the progress bar) became the subtitle's "N of M done".

## 7. Blockers

<!-- date — id — what — evidence — next retry -->

## 8. Final report
