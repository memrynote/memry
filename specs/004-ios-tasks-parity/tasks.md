# Tasks: iOS tasks parity

**Goal**: every task and project feature desktop ships today works on iOS, with
the same data semantics, synced both ways, verified on a running simulator.

**Reference implementation**: desktop. When this file and desktop disagree on a
behavior, desktop wins unless a decision below says otherwise.

**Format**: `[ID] [P?] Description`. `[P]` = can run in parallel with its `[P]`
siblings in the same block. No `[P]` = serial. A task added later takes a
suffix letter (`TP021a`) so no id ever moves. **Gates are serial**: a phase
behind a gate does not start until the gate's evidence is green.

**Checkbox protocol**: tick `[x]` only when the task's own verification ran
green. Under the ticked line append one indented `Evidence:` line (command +
result, test name, or screenshot path). Never tick partial work: split it with
a suffix id instead.

---

## 0. Operating rules for the agent (read before every resume)

### 0.1 Session

- One session, no questions to Kaan. When something is ambiguous: pick the
  desktop behavior, write the choice to §6 Decisions log, continue.
- When blocked by something outside the repo (staging down, OTP never arrives,
  Apple tooling broken): write it to §7 Blockers with evidence, skip to the
  next unblocked task, retry the blocker once per phase.
- This file is the only state. After a context compaction or restart: re-read
  §0, §1, §6, §7, then continue at the first unticked task.
- Root `AGENTS.md`, `apps/ios/AGENTS.md`, `apps/desktop/AGENTS.md`,
  `DESIGN.md`, `PRODUCT.md` apply. Read them once at TP002.

### 0.2 Authorizations Kaan granted for this plan

- **Delegation**: pstack subagents are authorized for every `[P]` block, using
  the role table in the session prompt (feature work: opus-5-5:medium;
  review/judgment: fable-5-1; mechanical/swarm: sonnet-5). Subagents get task
  ids and file ownership; they never run the simulator, never run
  `build-xcframework.sh`, never edit `api/` UniFFI files or the generated
  Swift. The orchestrator does those and integrates.
- **Commits**: allowed at the end of each phase on branch
  `feat/ios-tasks-parity`, explicit paths only, format
  `feat(ios): ...` / `feat(desktop): ...` / `chore(...)`. **No push, no PR.**
- **Spec override**: `specs/002-native-foundation-ios/spec.md` FR-060
  (projects read-only on phone) and FR-057 (four views) are superseded by this
  plan. TP004 records it.

### 0.3 Workspace

- Work in your own worktree, opened from `main` (which carries this plan):
  `git fetch origin && git worktree add .worktrees/ios-tasks-parity -b feat/ios-tasks-parity main`.
  Never work in the main checkout: other sessions use it. The worktree's
  `specs/004-ios-tasks-parity/tasks.md` is the only state file; the main
  checkout's copy stays untouched. Copy the untracked env/config files the iOS
  and desktop builds need from the main checkout (`git status --ignored`
  there), never the other way round.
- Fresh worktree: `pnpm install` (native warm runs detached, `pnpm warm:log`),
  then `crates/memry-core/build-xcframework.sh --release`.
- Simulator: `iPhone 17`, iOS 26.5 (`A7E3D181-58A5-4982-9899-4FD15F5666DC`).
  **Never erase or reset it**: the keychain holds the session.
- Drive the app with the XcodeBuildMCP CLI (`xcodebuildmcp`, skill
  `xcodebuildmcp-cli`): build, install, launch, tap, type, screenshot, logs.
- Debug builds talk to **staging** only (`SyncEnvironment.swift`). The desktop
  peer for cross-device checks is `pnpm --filter @memry/desktop dev:staging`.

### 0.4 Sign-in recovery (when the app shows the signed-out or unlock screen)

Staging test account (Kaan revokes it after the run; no secrecy handling
needed):

- Email: `kaan94karaca@gmail.com`
- Recovery phrase: `reject youth sing exist joy mobile economy chalk boil girl tag attack round lunar dove alley bright bonus there dumb rent erode force yard`
- OTP sender: `noreply@memrynote.com`

1. Enter the email, request the code. Note the request time (UTC).
2. Poll `gmail-bridge_gmail_search` for
   `from:noreply@memrynote.com newer_than:1h`, take the newest message whose
   date is after the request time, read it with `gmail-bridge_gmail_message`,
   extract the 6-digit code (`OTP_LENGTH = 6`). Poll every 10 s, give up
   after 3 min.
3. Enter the code. If the unlock screen appears, enter the recovery phrase.
4. Rate limit: **at most 3 code requests per 10 min per address**
   (`SignInViewModel.maxCodeRequests`). Never request a new code while an
   older one is still unused and unexpired. Hitting the limit is a §7 blocker,
   not a retry loop.

### 0.5 Test data

- Every task the agent creates is titled with the prefix `[agent] `; every
  project is named `Agent Test …`. TP094 deletes all of them at the end.
- Never modify or delete data that does not carry these markers.

### 0.6 Verification commands

```bash
# Rust core
cargo test -p memry-core
cargo clippy -p memry-core --all-targets -- -D warnings   # match rust-ci.yml; check it at TP001
crates/memry-core/build-xcframework.sh --release

# Vectors
pnpm --filter @memry/contracts vectors:generate
pnpm --filter @memry/contracts vectors:check

# Desktop / packages (only when touched)
pnpm lint && pnpm typecheck
pnpm --filter @memry/desktop test:renderer
pnpm --filter @memry/desktop i18n:check
pnpm check:architecture && pnpm check:contracts
git diff --check

# iOS
xcodebuild test -project apps/ios/Memry.xcodeproj -scheme Memry \
  -testPlan Unit -destination 'platform=iOS Simulator,id=A7E3D181-58A5-4982-9899-4FD15F5666DC'
# same with -testPlan Conformance, -testPlan UI
```

---

## 1. Decisions (fixed; the agent does not revisit them)

- **D1 Natural-language dates: exactly what desktop has today, English
  only.** The grammar is `natural-date-parser.ts` + `repeat-phrase.ts` as
  they are; quick-add needs the `@` prefix (`meeting @may 17 3pm`). No
  Turkish or other locale support, no new syntax, no desktop behavior change.
  The note editor's locale mapping (`toParserInput`) is not part of the task
  surfaces and is not ported.
- **D2 Projects are fully writable on iOS**: create, edit, statuses, archive,
  delete, reorder, hub links. FR-060 is superseded.
- **D3 Recurrence moves into the Rust core.** Desktop's renderer logic
  (`use-undoable-task-actions.ts` + `repeat-utils.ts`) is the reference and is
  pinned with vectors. Desktop keeps its own TS implementation. Both answer
  the same vectors.
- **D4 Views follow current desktop**: All / Today / Tomorrow / Next 7 days /
  Archived, List and Kanban, with `getTasksInDueWindow` semantics (overdue
  leads Today and Next 7, not Tomorrow; start date admits a task into Today;
  subtasks ride with parents). FR-057 is superseded.
- **D5 Shared logic lives in the Rust core**, behind conformance vectors
  generated from the real desktop TypeScript. Swift holds UI and view state
  only.
- **D6 Out of scope on iOS** (no iOS surface exists, or desktop-only
  affordance): calendar timeline and calendar task popover, Home widgets,
  keyboard-only shortcuts (hardware-keyboard shortcuts for complete, delete,
  select all are in scope), dragging to a sidebar, Agent/MCP task tools,
  Todoist/TickTick importers, importing files from a disk path into a project.
  Record anything else found desktop-only in §6.
- **D7 Compat**: no DB or wire format changes. iOS writes payloads desktop of
  any version can read: `repeatConfig` keeps desktop's JSON shape (ISO-string
  `createdAt`/`endDate`, numeric `completedCount`), unknown payload fields are
  preserved, priority is the existing 0–4 integer.

---

## Phase 0: setup and facts (serial)

- [ ] TP001 Create the worktree and branch from `main` (§0.3). Install, build the
      xcframework, build and launch the app on the simulator, reach the vault
      screen (sign in via §0.4 if needed). Record baseline:
      `cargo test -p memry-core` result, Unit/Conformance plan counts, and the
      exact CI commands from `.github/workflows/rust-ci.yml` and the iOS
      workflow.
- [ ] TP002 Read: root/iOS/desktop `AGENTS.md`, `DESIGN.md`, `PRODUCT.md`,
      `specs/002-native-foundation-ios/spec.md` FR-057..FR-061,
      `specs/003-ios-note-parity/tasks.md` (conventions),
      `docs/protocol/` chapters 06 (field merge) and 13 (payloads),
      `crates/memry-core/src/domain/{tasks,task_views,task_merge,projects}.rs`,
      `crates/memry-core/src/api/mod.rs`, `apps/ios/Memry/Features/Notes/VaultTabsView.swift`
      (Tasks tab is a `ComingSoonTab` today).
- [ ] TP003 Verify and write to §5 Verified facts, each with the file:line that
      proves it:
  - priority integer ↔ none/low/medium/high/urgent mapping
  - desktop default statuses for a new project (ids, names, colors, types,
    positions) and what `isDone`/`isDefault` mean on the wire
  - `repeatConfig` wire JSON shape as desktop writes it (read a real payload
    from the staging vault or the desktop DB)
  - task id format desktop generates in main (`generateId`)
  - whether `task_activity`, saved filters (`filter`), task settings, and
    `reminders` with `targetType: 'task'` are sync item types, and which of them
    the Rust core already projects
  - how iOS localizes strings (`*Copy.swift` pattern vs string catalog)
  - whether the iOS editor can edit markdown for a task description, or needs
    a plain text editor with markdown preview
  - whether local notifications are already scheduled for note reminders
    (FR-061), and where
- [ ] TP004 Add an entry to `specs/002-native-foundation-ios/spec-defects.md`
      recording that FR-057 and FR-060 are superseded by this plan (D2, D4),
      with the reason.

**Commit** Phase 0 docs only.

---

## Phase 1: shared parsing and recurrence, pinned by vectors

Desktop change first, so the vectors are generated from real code.

- [ ] TP010 Move the pure logic out of the renderer into
      `packages/domain-tasks/src/parsing/` (no React, no i18n, no `Date.now()`):
      `natural-date-parser`, `repeat-phrase`, the `quick-add-parser` core
      (projects as a structural `{id,name,isArchived}` list), the English
      ghost-completion helpers from `date-phrase-completion`
      (`predictDateCompletion`, `predictTime`, `isTimeInProgress`, English
      tables only) and `predictRepeatCompletion`, the recurrence math
      from `repeat-utils` (`calculateNextOccurrence`, `calculateNextOccurrences`,
      `shouldCreateNextOccurrence`, `findNthWeekdayOfMonth`,
      `firstOccurrenceFor`), and the due-window/today/completed predicates
      from `task-view-helpers`. Every function takes `now` explicitly. Desktop
      imports from the package; no behavior change. Existing desktop tests
      pass unchanged.
- [ ] TP012 Vector generator `packages/contracts/scripts/vectors/task-parsing.ts`
      → `test-vectors/task-parsing.json`, registered in `gen-protocol-vectors`
      and `package.json` exports. Fixed `now` values (including a Sunday, a
      month end, Dec 31, Feb 29). Case families:
  - natural date: every grammar branch in `natural-date-parser.ts`, invalid
    inputs, year bounds, times (`3pm`, `15:00`, `14pm`, `at 3:30pm`)
  - quick-add: each sigil, combinations, `[[…]]` shielding, unknown `+proj`
    left in title, multiple tags, English only (D1)
  - repeat phrase: every form in `repeat-phrase.ts`, including rejects
  - next occurrence: daily/weekly/days-of-week/interval>1, monthly day 31
    clamp, weekPattern incl. 5 = last, yearly Feb 29, endType date/count,
    `repeatFrom` due vs completion
  - due windows: today/tomorrow/next7 membership, overdue ordering, start
    date admission, subtask ride-along, archived and completed exclusion
- [ ] TP015 Vector generator `task-filtering.ts` → `test-vectors/task-filtering.json`
      from desktop `task-filters.ts` and `task-grouping.ts`: every
      `TaskFilters` dimension, every `SortField` × direction, group output
      (keys, order, labels as keys not strings), unknown sort field from a
      newer build leaves order untouched and yields no groups.
- [ ] TP013 [P] Rust `crates/memry-core/src/domain/task_parse/natural_date.rs`
      and `completion.rs` (English ghost completion), consumed by
      `tests/task_parse_vectors.rs`.
- [ ] TP016 [P] Rust `task_parse/quick_add.rs` + `repeat_phrase.rs`, same test file.
- [ ] TP017 [P] Rust `domain/recurrence.rs` (next occurrence, series end,
      first occurrence), `tests/recurrence_vectors.rs`.
- [ ] TP018 [P] Rust `domain/task_filter.rs` (filter, sort, group over
      projection rows; `TaskFilters` JSON identical to desktop's saved-filter
      shape, unknown values tolerated), `tests/task_filter_vectors.rs`.
- [ ] TP019 Rust `task_views.rs` rewritten to D4 (all, today, tomorrow,
      next7, archived, completed-in-window, by_project, per-tab counts),
      driven by the TP012 due-window vectors; old `today`/`upcoming` callers
      updated.

**Gate G1**: `vectors:check` green, `cargo test -p memry-core` green,
desktop `test:renderer` green, `pnpm lint && pnpm typecheck` green.
**Commit** Phase 1.

---

## Phase 2: core write and read surface (Rust)

TP020–TP027 are separate modules and run in parallel. TP028 is serial after
all of them because it owns the UniFFI surface and the generated Swift.

- [ ] TP020 [P] Tasks domain (`domain/tasks.rs`, split to stay under 600
      lines). Every write = one transaction with its outbox row and field
      clocks, as the existing functions do:
  - create with every field: description, statusId (default status of the
    project), parentId, startDate, dueTime, repeatConfig, repeatFrom, tags,
    linkedNoteIds, linkedCanvasIds, sourceNoteId, position (next position
    when absent)
  - project change resolves the equivalent status in the target project
  - parent rules: one level, same project, no self or cycle
  - complete / uncomplete: done/todo status of the project + `completedAt`;
    incomplete subtasks complete with the parent
  - complete of a repeating task (D3): close this one (`repeatConfig` null),
    create the next occurrence with a new id, `completedCount + 1`, no
    subtasks carried, series end honored; return both ids so the shell can
    undo
  - archive / unarchive; duplicate (optionally with subtasks); reorder
  - delete: cascade subtasks, or promote subtasks to top level
  - subtask bulk: complete all, mark all incomplete, set due date for all
    (with/without completed), set priority for all, delete all
  - bulk over ids: complete, uncomplete, delete, move to project, set status,
    set priority, set due date (+time, or clear), archive, unarchive
  - `tests/domain_tasks.rs` extended for each, including clocks and outbox
- [ ] TP021 [P] Projects domain write (D2) in `domain/projects.rs` (+ split
      file): create with desktop default statuses or a custom list (≥2, with
      type/color/order), update name/description/color/icon, reconcile
      statuses (add, rename, recolor, retype, reorder, delete with task
      reassignment as desktop does), archive, reorder projects, delete with
      "move tasks to inbox project" or "delete tasks", set home note,
      link/unlink/pin note, calendar event and file items. Delete
      `write_unavailable` and rewrite the module doc. `tests/domain_projects.rs`.
- [ ] TP022 [P] Saved filters: project the `filter` sync type if TP003 shows
      it missing; create, update, delete, reorder, star; payload identical to
      desktop's. Tests.
- [ ] TP023 [P] Task settings (`defaultProjectId`, `defaultSortOrder`,
      `defaultView`, `staleInboxDays`) read/write through the existing
      settings merge, with desktop's defaults and coercion of unknown values.
      Tests.
- [ ] TP024 [P] Reminders with `targetType: 'task'`: list, add, edit, delete,
      snooze for a task, reusing the existing note reminder path. Tests.
- [ ] TP025 [P] Task activity: project `task_activity` rows for reading
      (paged, filter by action). If TP003 shows it syncs, write user rows for
      local mutations with desktop's encoding (`field`, JSON `oldValue`/
      `newValue`, `description` values always null, `actor: 'user'`), never
      `superseded` rows. Tests.
- [ ] TP026 [P] Note ↔ task (FR-058) in the core:
  - completing or reopening a task from the phone flips its
    `- [ ] … {task:<id>}` line in the source note body
  - flipping the checkbox in a note body completes or reopens the task
  - turning a checklist item into a task in the iOS editor writes the task
    and the `{task:<id>}` suffix; Tab-nesting under a task block makes a
    subtask
  - deleting a task removes only its own line from the source note (as
    `remove-task-line-from-note.ts` does)
  - default project resolution chain: parent → `+token` → note's project →
    settings default → inbox → first project
  - tests over CRDT bodies
- [ ] TP027 [P] Search and linked items: tasks in vault search (exists), and
      related-item search over notes, canvases and files for the task detail
      screen.
- [ ] TP028 UniFFI surface `crates/memry-core/src/api/tasks.rs` +
      `api/projects.rs`: records for task detail, list row, project with
      statuses, repeat config, filter spec, grouped list result, activity
      entry, parse result (title + spans with kinds for pills); functions for
      everything in TP013–TP027. Errors through `api/errors.rs` with messages
      `ErrorMapping.swift` can map. Build the xcframework, commit the
      regenerated Swift.
- [ ] TP029 `tests/api_tasks.rs`: end-to-end through the API layer, including
      inbound payloads from an older desktop (missing fields) and a newer one
      (unknown fields preserved on the next local edit).

**Gate G2**: `cargo test -p memry-core` and clippy green, `vectors:check`
green, xcframework builds, iOS app still builds and Unit plan is green.
**Commit** Phase 2.

---

## Phase 3: iOS foundations (serial)

- [ ] TP030 `apps/ios/Memry/Features/Tasks/`: `TasksStore` (`@Observable`)
      over the core API; refresh on the existing core sync events; errors via
      `ErrorMapping.swift` (new cases as needed); logging via `Core/Log.swift`.
- [ ] TP031 Replace the Tasks `ComingSoonTab` in `VaultTabsView.swift`; add a
      route for opening a task by id (used by search, notes and reminder
      notifications).
- [ ] TP032 Shared task UI primitives per `DESIGN.md`: status icon, priority
      icon, due badge (overdue/today coloring), project chip, repeat
      indicator, subtask progress, tag chip. Priority colors mapped from
      desktop `--task-priority-*` into `Tokens`.
- [ ] TP033 `TasksCopy.swift` (or catalog, per TP003) mirroring the desktop
      `tasks.json` strings the iOS screens use.

**Commit** Phase 3.

---

## Phase 4: iOS features

All blocks are `[P]` against each other: each owns its own files under
`Features/Tasks/`. When two blocks need the same shared file, the first one
to land owns it and the other rebases. The orchestrator runs the simulator
checks for each block after merging it.

- [ ] TP040 [P] **Views**: segmented All / Today / Tomorrow / Next 7 / Archived
      with counts; overdue section first in Today and Next 7; completed group
      collapsed by default; per-view empty states; project scope picker (all
      projects, search, starred saved filters); List/Kanban switch;
      pull-to-refresh; Today progress/celebration; view state persisted per
      desktop's `tasks-view-state` keys meaning.
- [ ] TP041 [P] **Task row**: tap opens detail, circle completes (with haptic),
      swipe actions (complete, reschedule, delete), context menu = desktop
      Move menu (reschedule Today/Tomorrow/Next week/Remove date, move to
      project, change status) + duplicate, make subtask of…, archive, delete.
      Row shows priority, title, subtask progress, repeat, linked note, tags,
      due, project.
- [ ] TP042 [P] **Quick add**: capture field with live pills for `@date`,
      `every …`, `!priority`, `+project`, `#tag`, `[[note]]` from the core
      parse spans; ghost completion for dates and repeats; autocomplete lists
      for project, tag and note; project resolution chain; help sheet.
      **Add Task sheet** with every field and "Create another".
- [ ] TP043 [P] **Task detail**: editable title; status, priority, due
      date+time, start date, project, tags (autocomplete), reminders, repeat,
      description (per TP003), subtasks, related items (add/search/remove,
      missing-item state), activity (last 3 + full sheet with filter and
      paging), created/archived meta, unarchive, delete with confirmation.
- [ ] TP044 [P] **Date and time**: suggestions (Today, Tomorrow, This Weekend,
      Next Week), natural-language field backed by the core parser with the
      resolved date shown live, graphical calendar with "Today", add/clear
      time, remove date; start date uses the same picker.
- [ ] TP045 [P] **Repeat**: presets (daily, weekdays, weekly on X, biweekly,
      monthly on day N, monthly on Nth weekday, yearly on date); custom sheet
      (frequency, interval, days, monthly type, ends never/date/count, preview
      of next dates from the core); repeat-from due/completion; "N of M"
      progress; Stop Repeating dialog (keep as one-time / delete this and
      future); Edit Repeating dialog (only this / this and future).
- [ ] TP046 [P] **Subtasks**: inline add, reorder, promote to task, parent
      picker (same project / other projects, search), complete-parent dialog
      (all / parent only), all-subtasks-complete prompt, delete-parent dialog
      (all / keep as tasks), subtask bulk menu (complete all, incomplete all,
      due date for all incl. completed option, priority for all, delete all),
      duplicate with subtasks.
- [ ] TP047 [P] **Multi-select and bulk**: edit mode, select all, range select,
      bulk bar (complete, priority, due date + time, move to project, status,
      archive, unarchive, delete with confirmation); hardware keyboard
      Cmd+A / Cmd+Return / Cmd+Delete / Esc.
- [ ] TP048 [P] **Filters, sort, group**: filter sheet with every dimension
      (search, projects, priorities, tags, due date presets + custom range,
      status after picking a project, completion incl. archived, repeat
      type, has time); quick presets (Overdue, High Priority, Due This Week,
      Repeating, No Due Date); active filter chips with clear; group-by
      field + direction; collapsible groups persisted; saved filters (save,
      apply, rename, delete, reorder, star).
- [ ] TP049 [P] **Kanban**: paged columns for each column mode (canonical,
      status, priority, due date, project); drag between columns writes the
      field; per-column add; done column "show N more".
- [ ] TP050 [P] **Reorder and reschedule by drag**: manual order writes
      `position`; dropping onto a date group reschedules; multi-item drag in
      edit mode.
- [ ] TP051 [P] **Undo**: toast with Undo for create, delete, complete
      (including the repeating next-occurrence case), uncomplete, archive,
      field edits, and every bulk action; hardware Cmd+Z.
- [ ] TP052 [P] **Projects**: list with reorder and archive; create/edit sheet
      (icon, name ≤50, color palette, description, status editor with ≥2
      rule, type, color, reorder, delete); unsaved-changes guard; delete
      dialog (move tasks / delete all); project hub (overview, task list,
      progress, home note, linked notes/events/files with pin and unlink).
- [ ] TP053 [P] **Reminders**: picker with desktop presets + custom date/time,
      multiple per task, edit/delete; local notification scheduling; tapping
      one opens the task; a task completed or deleted elsewhere opens a
      sensible state (FR-061).
- [ ] TP054 [P] **Notes integration UI**: `TaskBlockRow` becomes interactive
      (circle toggles, title opens detail); checklist → task in the editor;
      linked tasks section on the note screen; "move note tasks?" prompt when
      a note's project changes, if iOS can edit that property.
- [ ] TP055 [P] **Settings > Tasks**: default project, default sort, default
      view, stale inbox days.
- [ ] TP056 [P] **Search**: task results open the detail route.
- [ ] TP057 Accessibility pass over every screen above: VoiceOver labels and
      custom actions (complete, delete, reschedule), Dynamic Type up to AX5,
      reduced motion, RTL, WCAG AA contrast. Runs after TP040–TP056.

Per block, before ticking: unit tests for its view model, one simulator run
of its flows via XcodeBuildMCP with screenshots saved to
`apps/ios/SpikeEvidence/tasks-parity/<id>-*.png`.

**Commit** after each block lands.

---

## Phase 5: verification (serial)

- [ ] TP080 Conformance: `apps/ios/MemryConformanceTests/TasksConformanceTests.swift`
      runs `task-parsing.json` and `task-filtering.json` through the FFI.
      Conformance plan green.
- [ ] TP081 UI tests `apps/ios/MemryUITests/TasksUITests.swift`:
      quick add `[agent] meeting @may 17 3pm !high #test` → due May 17 15:00, high,
      tagged; complete a daily repeating task → next occurrence exists; bulk
      complete 3 tasks + undo; add and complete subtasks → parent prompt;
      filter + save + reapply; kanban drag changes status. UI plan green.
- [ ] TP082 Cross-device against staging with desktop `dev:staging` on the
      same account:
  - phone → desktop: create, edit every field, complete repeating, delete,
    project create/edit/delete, saved filter
  - desktop → phone: the same list in reverse
  - FR-059: the same task edited on different fields on both, offline then
    online; both edits survive
  - FR-058: checkbox in a note ↔ task state, both directions
  - screenshots from both sides in `SpikeEvidence/tasks-parity/xdevice-*`
- [ ] TP083 Full gates: §0.6 in full (Rust, vectors, lint, typecheck, desktop
      renderer tests, i18n, architecture, contracts, all three iOS plans,
      `git diff --check`). Record counts vs the TP001 baseline.
- [ ] TP084 Desktop regression: `pnpm --filter @memry/desktop test:desktop`
      green; `electron-vite build`, then `pnpm --filter @memry/desktop test:e2e`
      for the task specs only.

---

## Phase 6: wrap-up (serial)

- [ ] TP090 `pnpm docs:impact --base <branch base> --strict`; update
      `apps/docs/src/**` where it reports missing docs; `pnpm docs:build`.
- [ ] TP091 Update `apps/ios/AGENTS.md` if a new rule came out of this work,
      and `specs/002-native-foundation-ios/compliance.md` for FR-057..FR-061.
- [ ] TP092 Review pass by a fable-5-1 subagent over the full branch diff:
      compat (D7), no `!`/`try!` outside tests, no raw error strings, logical
      layout. Fix what it finds.
- [ ] TP093 Final report in §8: what shipped, evidence index, anything left
      in §7.
- [ ] TP094 Delete all `[agent] ` tasks and `Agent Test …` projects from the
      staging vault; confirm on desktop that they are gone.

---

## 5. Verified facts (filled by TP003)

<!-- fact — file:line -->

## 6. Decisions log (agent-made choices during the run)

<!-- date — task id — choice — why -->

## 7. Blockers

<!-- date — task id — what — evidence — next retry -->

## 8. Final report

<!-- filled by TP093 -->
