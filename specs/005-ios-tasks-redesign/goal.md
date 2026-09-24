# Goal: rebuild the iOS Tasks UI from the Paper redesign

## Context

- Worktree: `/Users/h4yfans/workspace/personal/memry/.worktrees/ios-tasks-parity`, branch `feat/ios-tasks-parity`.
- The Tasks feature on iOS already works: every desktop task feature is implemented (spec `specs/004-ios-tasks-parity/tasks.md`, TP040–TP057). The UI is too big, too busy and not minimal.
- A complete redesign exists in Paper: file **"Task iOS"**, id `01M39KJ8S9S5QYX38B2HP3Q1BF`, page 1. Use the Paper MCP (`paper_get_basic_info`, `paper_get_tree_summary`, `paper_get_jsx`, `paper_get_computed_styles`, `paper_get_screenshot`).
- Your job: replace the current Tasks views with the redesign, screen by screen, keeping every behavior that exists today. This is a UI/UX rebuild, not a feature change.

## Read first (once)

1. Root `AGENTS.md`, `apps/ios/AGENTS.md`, `DESIGN.md`, `PRODUCT.md`.
2. `specs/004-ios-tasks-parity/tasks.md`: §0.3 (simulator), §0.4 (sign-in recovery), §1 decisions D1–D7, §5, §6. These still apply.
3. Paper artboard **"00 · Feature audit + redesign map"** in full. It maps each existing feature to its new home. It also lists the interaction rules and the SwiftUI component mapping. Treat it as the spec.
4. Every artboard 01–20. For each one, read `get_tree_summary` and `get_jsx`, and read layer names: they encode intent ("Glass group · filter + more", "Chip scroller (horizontal)", "Related (shown only when present)", "Bottom toolbar · glass (replaces tab bar)").
5. All of `apps/ios/Memry/Features/Tasks/` and `apps/ios/Memry/Design/Tokens.swift` before editing.

## Screens (Paper artboard → current code to replace; verify the mapping yourself)

| Artboard         | What it defines                                                                                                                                                                                                                                                                                                             | Likely current files                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01 Today         | Large title with title menu, "N of M done" subtitle, one glass capsule (filter + more), rows = title + one meta line, fixed trailing priority slot, collapsed Completed, floating glass-prominent "+" above the tab bar                                                                                                     | `TaskListScreen`, `TaskListHeader`, `TaskRowView`, `TaskPrimitives`                                                                                                |
| 02 Title menu    | Views with counts, Project submenu, starred saved filters, Projects. Replaces the segmented tabs and the "All projects" pill row                                                                                                                                                                                            | `TaskListHeader`, `SavedFilterSection`, scope picker                                                                                                               |
| 03–04 Quick add  | "+" opens a composer docked above the keyboard: title, Notes line, horizontally scrolling chips (Date, Priority, Project, #, …) and a send button. Natural-language tokens highlight inline and fill the chips live. Return key = "next", keeps the composer open. Replaces the bottom quick-add bar and the Add Task sheet | `QuickAdd*`, `AddTaskSheet`, `AddTaskFields`, `QuickAddSuggestions`, `QuickAddHelpSheet`                                                                           |
| 05 When menu     | Chip or pill tap → menu with a medium icon row (Today / Tomorrow / Next week), This weekend, Pick date & time…, Repeat ›, Remind me ›, Remove date                                                                                                                                                                          | `TaskDateSheet`, `RepeatModels`, `TaskReminderPresets`                                                                                                             |
| 06 Swipe         | Leading = Complete; trailing = Date, Delete                                                                                                                                                                                                                                                                                 | `TaskRowActions`                                                                                                                                                   |
| 07 Row menu      | Long press: small icon row (Today, Tomorrow, Next week, No date), Priority / Status / Move to submenus, Duplicate, Make subtask of…, Select, Archive, Delete                                                                                                                                                                | `TaskRowActions`                                                                                                                                                   |
| 08 Detail        | Status circle (complete toggle) + large title; pills only for set fields (status, priority, When with repeat/bell glyphs, project, tags) + dashed "+" pill; notes; subtasks with "2 of 5" + progress bar + inline Add subtask; Linked (only when present); activity footer line                                             | `TaskDetailView`, `TaskDetailProperties`, `TaskDetailTags`, `TaskDescriptionSection`, `SubtasksSection`, `SubtaskRow`, `TaskRelatedSection`, `TaskActivitySection` |
| 09 Add property  | "+" pill menu: Tag, Start date, Parent task, Link note or file                                                                                                                                                                                                                                                              | detail files, `ParentPickerSheet`, `ProjectLinkPicker`                                                                                                             |
| 10 Detail …      | Duplicate, Make subtask of…, Activity, Archive, Delete                                                                                                                                                                                                                                                                      | detail files, `TaskActivitySheet`                                                                                                                                  |
| 11 When sheet    | Floating detent sheet: xmark / title / prominent checkmark; natural-language field with live resolved value (dates and repeats); graphical calendar; grouped rows Time, Repeat, Remind me, Start date                                                                                                                       | `TaskDateSheet`, `TaskDateField`, `RepeatCustomEditor`, `TaskReminderPicker`                                                                                       |
| 12 … menu        | Medium row List / Board / Select; Group by ›, Sort ›, Show completed, Task settings                                                                                                                                                                                                                                         | list header, filter model                                                                                                                                          |
| 13 Filter sheet  | Search, preset chips, one menu row per dimension, Clear all / Save as view                                                                                                                                                                                                                                                  | `TaskFilterSheet`, `TaskFilterPanels`, `TaskFilterControls`, `SavedFilterNamePrompt`                                                                               |
| 14 Select mode   | "Select all" capsule + prominent checkmark, "N selected" title, selection circles, glass bottom toolbar (Complete, Date, Move, More) replacing the tab bar                                                                                                                                                                  | `TaskSelection*`                                                                                                                                                   |
| 15 Undo toast    | Dark capsule beside the "+", message + Undo                                                                                                                                                                                                                                                                                 | `TasksToast`, `TasksToastState`                                                                                                                                    |
| 16 Board         | Paged columns with the next one peeking, header with count and +, minimal cards, page dots                                                                                                                                                                                                                                  | `TaskKanbanBoard`, `KanbanCardView`                                                                                                                                |
| 17 Projects      | Progress-ring rows with counts, Archived collapsed, "+" glass button                                                                                                                                                                                                                                                        | `ProjectsViews`                                                                                                                                                    |
| 18 Project hub   | Ring + title, "7 of 12 done · 1 overdue", description, overview note card, tasks (no project name repeated), Linked                                                                                                                                                                                                         | `ProjectHubView`, `ProjectHubSections`                                                                                                                             |
| 19 Project sheet | Name with color dot, one-row palette, description, Statuses row                                                                                                                                                                                                                                                             | `ProjectEditorSheet`, `ProjectStatusEditor`                                                                                                                        |
| 20 Empty Today   | Check glyph, "Nothing left for today", next-view hint + link                                                                                                                                                                                                                                                                | `TaskListEmptyView`                                                                                                                                                |

## Rules (non-negotiable)

- **Behavior parity.** Every behavior in the 00 audit table stays reachable, with the same data semantics. Behaviors with no drawn screen are still required. These include Kanban column modes, the custom repeat editor, repeat-from, the Stop/Edit Repeating dialogs, parent-picker search, subtask bulk menu, complete/delete-parent dialogs, drag reorder and reschedule, hardware keyboard shortcuts, reminder edit/delete, saved-filter rename/reorder/star, project reorder/archive/delete dialogs, and the unsaved-changes guard. Keep them reachable at the location 00 names, or the nearest native equivalent. Never remove a behavior. If the design gives it no home, stop and log it in the plan's Decisions section with the reason.
- **Scope.** Only `apps/ios/Memry/Features/Tasks/**`, plus `apps/ios/Memry/Design/**` for truly shared primitives. Also touch `Features/Notes/VaultTabsView.swift` only where the tab bar must hide for select mode. No Rust core, UniFFI, generated Swift, sync, storage or wire changes. The core API is already sufficient; if something seems missing, log it and stop that item.
- **Native iOS 26 first.** Use the SwiftUI mapping in artboard 00: `toolbarTitleMenu`, `ToolbarItemGroup` + `ToolbarSpacer` glass grouping, `.buttonStyle(.glass / .glassProminent)`, `Menu` + `ControlGroup` for icon rows, `Picker` in menus, `.swipeActions`, `.contextMenu(menuItems:preview:)`, `.presentationDetents`, `safeAreaInset` composer, `scrollTargetBehavior(.viewAligned)`. Don't hand-draw glass where a system component provides it. The Paper glass is an approximation of system Liquid Glass; ship the real material.
- **Values come from Paper, not screenshots.** Read spacing, sizes, radii and colors with `get_jsx` / `get_computed_styles`, then map each value to `Tokens` (Canvas, Text, Line, Interaction, Tint, Space, Radius, Size, Typography, Task, Palette). No new hex literals in views and no `Font.system(size:)`. Paper's 17/15/13 px sizes map to the Dynamic Type roles, not fixed points. If a value has no token, pick the nearest token and log it. Add a token only when two call sites share it.
- **Design rules from 00.**
  - A property takes at most two taps.
  - Show only the values that are set.
  - One primary action per screen.
  - Rows carry one meta line in the order date, repeat, subtasks, note, project, with priority in a fixed trailing slot. A row never repeats what the screen already states: no date in its own date group, no "Inbox" project.
  - Liquid Glass only on chrome.
  - The tint fills and never carries contrast: ink glyph on tint, `Tokens.Text.tint` for tinted text.
- **Accessibility.** Keep or improve TP057 on every screen:
  - VoiceOver labels and custom actions (complete, reschedule, delete).
  - Dynamic Type up to AX5, where rows, pills and chips wrap or stack.
  - 44pt hit targets.
  - Reduce Motion (`calmAnimation`) and Reduce Transparency (solid fallback).
  - Leading/trailing only (RTL).
  - WCAG AA contrast in light and dark.
- **Localization.** All strings go through the `TasksCopy*` pattern and mirror desktop `packages/i18n/src/locales/en/tasks.json` wording where one exists.
- **iOS rules** from `apps/ios/AGENTS.md`:
  - No force unwrap and no `try!`.
  - Errors go through `ErrorMapping`; logging goes through `Log.swift`.
  - A `List` that uses `onMove` must not own a multi-selection.
  - Feature Swift files stay ≤ 400 lines (`node scripts/check-line-ceilings.mjs`): split views instead of growing files.
- **Dark mode.** The Paper file is light only. Derive dark from the same semantic tokens and verify it.

## Fixed decisions (do not revisit)

- "+" is a floating glass-prominent circle above the tab bar, bottom trailing. There is no second add entry point in the nav bar.
- Tags are not shown in list rows or cards; they appear as pills in the detail. They stay filterable.
- The Add Task sheet is removed. The composer covers every field: its "…" chip opens Status, Parent task, Reminder, Start date and "More fields…" (the When sheet).
- The segmented view tabs and the project pill row are removed in favor of the title menu.
- Anything else ambiguous: pick the behavior desktop has today, log it, continue. No questions to Kaan.

## Workflow

1. **Phase 0, plan.** Create `specs/005-ios-tasks-redesign/tasks.md` in the same format as spec 004: operating rules, one checkbox per artboard RD01–RD20, plus RD00 (parity audit), RD90 (accessibility), RD91 (dark mode), RD92 (tests) and RD93 (final report), a Decisions log and a Blockers section. For each artboard, list the behaviors it must carry, taken from the 00 table and the current code. This file is the only state; after a restart, re-read it and continue at the first unticked item.
2. **Phase 1, primitives.** Status icon (dashed ring = todo, half = in progress, filled check = done, status color), priority bars, meta line, property pill, composer chip, glass capsule, and toast, all in `TaskPrimitives` / Design. Unit-test the label and formatting logic.
3. **Phase 2, list and capture:** RD01–RD07, RD12–RD15, RD20.
4. **Phase 3, detail and dates:** RD08–RD11.
5. **Phase 4, board and projects:** RD16–RD19.
6. **Phase 5, verification:** RD90–RD93.
7. Delete dead views and copy only after their replacement is verified and every behavior they carried has a new home. Record each removal in the plan.
8. **Commits:** at the end of each phase, on this branch, explicit paths only, message format `feat(ios): …`. No push, no PR.

## Verification (per artboard, before ticking)

- Build and run on the simulator from spec 004 §0.3 (`iPhone 17`, iOS 26.5, `A7E3D181-58A5-4982-9899-4FD15F5666DC`; never erase it). Drive it through the XCUITest harness described in spec 004 §6 (TP001). Sign in via §0.4 if needed. Test data uses the `[agent] ` / `Agent Test …` prefixes from §0.5, and you delete it at the end.
- Screenshot the implemented state that matches the artboard. Save it to `apps/ios/SpikeEvidence/tasks-redesign/RDxx-<state>.png`. Compare it side by side with `paper_get_screenshot` of the artboard. Check spacing, alignment of the status / title / priority lanes, type roles, colors, glass placement, what is shown and what is hidden, and tap counts.
- Walk each flow on the device and count taps: create a task with date + priority from the list (target: "+" → type → chip → option → send), change status / priority / date from the list and from the detail (target: ≤ 2 taps each).
- Unit plan and UI plan pass: `xcodebuild test -project apps/ios/Memry.xcodeproj -scheme Memry -testPlan Unit|UI -destination 'platform=iOS Simulator,id=A7E3D181-58A5-4982-9899-4FD15F5666DC'`. Update `TasksUITests` and the accessibility identifiers for the new structure; don't delete coverage. The Conformance plan must stay green, untouched.
- `node scripts/check-line-ceilings.mjs` passes. Run `git diff --check`.
- RD90: screenshots at AX5, forced RTL, and Reduce Motion / Reduce Transparency, plus a VoiceOver tree dump for the list, detail and composer. RD91: light and dark screenshots of 01, 03, 08 and 11.
- Tick a box only when its own evidence is green. Add one `Evidence:` line under each tick.

## Done when

- RD00–RD93 are all ticked with evidence.
- Every behavior in the 00 audit table has been exercised on the simulator in its new location.
- Unit and UI plans are green. The line-ceiling check passes.
- No Rust, UniFFI, generated or sync files changed (`git diff --stat` shows only the allowed paths and the spec and evidence files).
- `specs/005-ios-tasks-redesign/tasks.md` ends with a final report: what shipped, removed views, every decision made, and anything left open.
