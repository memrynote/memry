# Tasks: iOS Calendar (Paper "Calendar iOS")

**Goal**: every desktop calendar feature on iPhone, built from the Paper page
"Calendar iOS" (file `01M39KJ8S9S5QYX38B2HP3Q1BF`, page `p-5-0`, artboards
00, 00b, 01–31), with native iOS 26 components and the iOS Tasks design
language. Includes the `memry-core` work to receive and write calendar
records. Full brief: `specs/007-ios-calendar/goal.md`.

**Reference**: artboard **00 · Feature audit + redesign map** says where each
behavior lives; **00b · Calendar flow map** says how screens connect. Desktop
wins any behavior question the design does not answer.

**Format**: `[ID] Description`. A task added later takes a suffix letter
(`CL21a`) so no id moves.

**Checkbox protocol**: tick `[x]` only when the item's own verification ran
green. Under the tick append one indented `Evidence:` line (command + result,
test name, screenshot path). Never tick partial work: split it with a suffix.

---

## 0. Operating rules (read before every resume)

### 0.1 Session

- One session, no questions to Kaan. Ambiguous: pick desktop's behavior,
  write it to §6 Decisions, continue.
- Blocked by something outside the repo: write it to §7 Blockers with
  evidence, skip to the next unblocked item, retry once per phase.
- This file is the only state. After a restart: re-read §0, §1, §5, §6, §7,
  then continue at the first unticked item.

### 0.2 Scope

- Edit: `crates/memry-core/**` (calendar only), UniFFI config + generated
  Swift, `apps/ios/Memry/Features/Calendar/**` (new), `apps/ios/Memry/Design/**`
  (shared primitives), the More list entry and deep-link router, navigation
  hooks into Tasks / Inbox / Notes (open existing views only),
  `packages/contracts` vectors, `docs/protocol/05-record-sync.md` and
  `13-payload-schemas.md`, tests under `crates/memry-core/tests`,
  `apps/ios/MemryTests`, `apps/ios/MemryUITests`, this spec,
  `apps/ios/SpikeEvidence/calendar/`.
- Desktop code: only the D3a settings sync extension (CL018) and bugs a
  vector exposes (§6 + separate `fix(desktop)` commit). After desktop edits:
  `pnpm lint && pnpm typecheck` and the settings sync tests.
- Provider tokens and passwords live in the iOS Keychain only; never in
  records, settings, logs or evidence screenshots (goal D3).
- Provider accounts during the run: Google is the test account's own
  (`kaan94karaca@gmail.com`); Google's sign-in page may ask for a password
  or 2FA the agent does not have: that is a §7 blocker for Kaan, not a
  workaround. ICS uses public feeds named `Agent Test …`. No CalDAV account
  exists; CalDAV is verified against a local Radicale container (CL074),
  logged in §7 if unavailable.

### 0.3 Workspace

- Worktree `.worktrees/ios-calendar`, branch `feat/ios-calendar`, from `main`:
  `git fetch origin && git worktree add .worktrees/ios-calendar -b feat/ios-calendar main`.
  Copy the untracked env/config files the iOS and desktop builds need from
  the main checkout (`git status --ignored` there), never the other way.
- Fresh worktree: `pnpm install` (native warm runs detached, `pnpm warm:log`),
  then `crates/memry-core/build-xcframework.sh --release`.
- Simulator: `iPhone 17`, iOS 26.5 (`A7E3D181-58A5-4982-9899-4FD15F5666DC`).
  **Never erase or reset it**: the keychain holds the session.
- Drive the app with the XcodeBuildMCP CLI (`xcodebuildmcp`, skill
  `xcodebuildmcp-cli`) and `AgentDriverUITests` (spec 004 TP001).
- Debug builds talk to **staging** only (`SyncEnvironment.swift`). Desktop
  peer: `pnpm --filter @memry/desktop dev:staging`.

### 0.4 Sign-in (when the app shows the signed-out or unlock screen)

Staging test account (Kaan revokes it after the run; no secrecy handling
needed). Its memrynote holds the calendar data this spec reads: Google
events, sources, tasks with dates, reminders, snoozes.

- Email: `kaan94karaca@gmail.com`
- Recovery phrase: `reject youth sing exist joy mobile economy chalk boil girl tag attack round lunar dove alley bright bonus there dumb rent erode force yard`
- OTP sender: `noreply@memrynote.com`

1. Enter the email, request the code. Note the request time (UTC).
2. Read the OTP through the **gmail-bridge** MCP: search
   `from:noreply@memrynote.com newer_than:1h`, take the newest message dated
   after the request time, open it, extract the 6-digit code
   (`OTP_LENGTH = 6`). Poll every 10 s, give up after 3 min.
3. Enter the code. If the unlock screen appears, enter the recovery phrase.
4. Rate limit: **at most 3 code requests per 10 min per address**
   (`SignInViewModel.maxCodeRequests`). Never request a new code while an
   older one is unused and unexpired. Hitting the limit is a §7 blocker, not
   a retry loop.
5. After sign-in, wait for the first sync to finish before judging an empty
   calendar (CL010 subscribes the types; before that, iOS has no calendar
   data by design).

### 0.5 Test data

- Every event the agent creates is titled with the prefix `[agent] `; every
  project is `Agent Test …`; every ICS subscription the agent adds is
  named `Agent Test …`. Never disconnect or modify a provider account the
  agent did not connect in this run.
- Never modify, move, delete or promote data that does not carry these
  markers. Read-only checks on real events are fine. Promote (CL063) is
  tested only on an `[agent] ` event created in Google through desktop.
- CL094 deletes all agent data at the end, on both iOS and desktop.

### 0.6 Verification commands

```bash
# Rust core
cargo test -p memry-core
cargo clippy -p memry-core --all-targets -- -D warnings
crates/memry-core/build-xcframework.sh --release

# Vectors
pnpm --filter @memry/contracts vectors:generate
pnpm --filter @memry/contracts vectors:check

# iOS
xcodebuild test -project apps/ios/Memry.xcodeproj -scheme Memry \
  -testPlan Unit|UI|Conformance \
  -destination 'platform=iOS Simulator,id=A7E3D181-58A5-4982-9899-4FD15F5666DC'
node scripts/check-line-ceilings.mjs
git diff --check

# Only if TS changed
pnpm lint && pnpm typecheck
```

### 0.7 Per-artboard UI check

- Screenshot to `apps/ios/SpikeEvidence/calendar/CLxx-<state>.png`, compare
  with `paper_get_screenshot` of the artboard: spacing, lanes (time gutter /
  chip / trailing), type roles, colors, glass placement, shown / hidden, tap
  counts.
- Every write: confirm on the desktop peer, and for Google-bound events in
  Google via desktop; then make a change on desktop and confirm it on iOS.

---

## 1. Fixed decisions (goal.md; not revisited)

- D1 More › Calendar; deep link opens Day + item sheet.
- D2 iOS subscribes to `calendar_event`, `calendar_source`,
  `calendar_binding`, `calendar_external_event` and projects locally in
  `memry-core`, pinned by desktop vectors.
- D3a Calendar settings are two-way: desktop and iOS both read and write
  `showNotesOnCalendar` and the per-provider groups (push, AI consent,
  default target, promote dismissed) through the settings sync `calendar`
  group. Device-local by nature: This Mac / This iPhone enablement, secrets,
  cursors.
- D3 iOS is a full provider device: connects Google / CalDAV / ICS, pulls
  and pushes itself, same write routing and bindings as desktop,
  credentials in Keychain. Cross-device logic in core pinned by vectors;
  transport in Swift.
- D4 This iPhone = EventKit, on-device, read-only, never synced, duplicate
  guard.
- D5 Timeline ships on iPhone.
- D6 Rust core changes authorized for calendar.
- D7 Additive, backward compatible; unknown fields round-trip untouched;
  desktop changes limited to D3a + logged fixes; D3a compat plan in goal.

---

## Phase 0: plan and facts

- [x] CL000 Read goal.md, root + iOS `AGENTS.md`, `DESIGN.md`, `PRODUCT.md`,
      spec 004 §0–§1/§5/§6, spec 005 goal + tasks, artboards 00 and 00b in
      full, `get_tree_summary` + screenshot of 01–31, the desktop files in
      goal "Read first" §6, `Tokens.swift`. Create the worktree.
      Evidence: all 33 artboards of `p-5-0` exported through `paper_export` (00, 00b read in full; 01–31 read against each build as their phase lands); goal, AGENTS, DESIGN, PRODUCT, specs 004/005, desktop sources read in Phase 0.
- [x] CL001 Payload facts → §5: the four schemas from
      `packages/contracts/src/sync-payloads.ts` (every field, optionality,
      enums, `fieldClocks`, deletes), their DB shapes (`calendar-*.ts`,
      migrations 0024–0028), apply order (chapter 05 table: source 0,
      event / external 2, binding 3), and what desktop does on unknown fields.
      Evidence: §5 F1 (read `sync-payloads.ts:371-470`, the four handlers, db-schema).

- [x] CL002 Projection facts → §5: from `main/calendar/projection.ts` and
      friends, the exact rules per visual type (event, external_event, task,
      reminder, snooze, note, note_date), `editability` (canMove, canResize,
      canDelete), `displayColor`, `isTriggered`, all-day UTC-midnight with
      exclusive end, range bounds per view, `includeUnselectedSources`, and
      how `showNotesOnCalendar` and source selection filter.
      Evidence: §5 F2 (read `projection.ts` in full, `capabilities.ts`, `calendar-colors.ts`).

- [x] CL003 Write-path facts → §5: what desktop writes for create / update /
      delete / move / project link / promote (`promote-external-event.ts`) /
      source selection / default target / push toggle / AI consent / week
      start / show notes, and which of these are synced records vs
      device-local settings. For each connect flow in 24, 25, 28, 29, 30,
      map the desktop provider runtime to iOS (§6): Google OAuth client ids
      (desktop uses `GOOGLE_CALENDAR_CLIENT_ID` + loopback; iOS needs an iOS
      client + URL scheme), whether a refresh token works across client ids
      and how `provider-auth-transfer` behaves on link, sync cursors and
      410 reset, CalDAV / ICS limits and error kinds, write routing and
      writer-compat, push channels / webhooks reachable by iOS, and the
      core-vs-Swift split per module.
      Evidence: §5 F3 + F3b, §6 CL003 entries (routing, OAuth, push relay, ICS limits, split).

- [x] CL004 Platform facts → §5: EventKit full-access entitlement and
      `NSCalendarsFullAccessUsageDescription`; how Tasks / Inbox / Notes
      expose "open detail", "When sheet", "focus inbox item", "open note at
      anchor" for reuse; existing deep-link router.
      Evidence: §5 F4 (`SettingsNavigation.swift:29`, `TasksRootView.swift:54`, `Info.plist`).

## Phase 1: core (Rust, UniFFI, vectors)

- [x] CL010 Move the four types from `UNSUBSCRIBED_RECORD_ITEM_TYPES` to the
      subscribed set; storage tables and projectors for sources, events,
      external events, bindings; apply order; unknown-field round trip.
      Tests: apply / re-apply / delete / out-of-order binding.
      Evidence: `cargo test -p memry-core --test domain_calendar_sync` 9/9 (apply, null-keeps, orphan external waits for its source, binding before event, skip, merge, seeded field clocks, unknown keys, tombstones); migration 0005; 19 subscribed types.
- [x] CL011 Field-level merge for `calendar_event` matching
      `field-merge-calendar.ts` (syncable fields, field clocks, tie-break).
      Vectors generated from desktop, checked in core.
      Evidence: `calendar.json` `apply` (17 sequences restated from the four desktop handlers with the real `mergeFields`) — `cargo test --test calendar_vectors every_apply_sequence_ends_on_desktops_row` green; `vectors:check passed (20 classes)`.
- [x] CL012 Projection API: `calendar_range(start, end, include_unselected)`
      returning projection items for all seven visual types with
      editability, colors, source, binding; plus `calendar_sources()`,
      `calendar_event(id)`, `calendar_external_event(id)` (attendees,
      conference, reminders, recurrence, location), `calendar_search(query,
range)`. Vectors from desktop projection for a fixed fixture (tasks,
      reminders, snoozes, notes, spans, time zones, DST).
      Evidence: `Calendar.range/search/sources/event/external_event/linked_projects`; `calendar.json` `projection` (4 queries over every row type in America/New_York across the Nov DST change, 3 searches) — `every_range_query_answers_desktops_projection`, `search_ranks_as_desktop_does` green.
- [x] CL013 Write API: create / update / delete event, move (start, end),
      link / unlink project (`calendar_event` item type in project links),
      promote external event (event + binding exactly as desktop), set
      source selection, set default target, provider settings,
      calendar settings (week start, show notes). Each write emits the same
      record shape desktop emits (vector per write).
      Evidence: `Calendar.create_event/update_event/delete_event/promote/set_source_selected/set_setting`; `calendar.json` `writes` (create, 4 updates, promote + idempotent repeat + read-only refusal, deselect purge) — `every_write_emits_desktops_record` green. Project link/unlink reuses `Tasks.link_to_project(item_type: calendar_event)` (already pinned).
- [x] CL014 Timeline model in core or Swift (decide in §6 by where desktop's
      `timeline-model.ts` logic is cheapest to pin): windows per zoom, group
      by project / status / priority / none, order by start / due / title,
      show toggles, shape per task (span, due, start, undated, overdue).
      Vectors or unit tests from desktop.
      Evidence: §6 CL014: Swift port (`TimelineModel.swift`, `+Groups.swift`); `xcodebuild test -testPlan Unit -only-testing:MemryTests/CalendarTimelineTests` 8/8 green (windows, steps, shapes, placement, edits, grouping, undated/overdue, subtask nesting restated from `timeline-model.test.ts`).
- [x] CL015 UniFFI surface, `build-xcframework.sh --release`, Swift seam
      (`Core/`) with async wrappers and change notifications so open views
      refresh on sync. Conformance plan cases for every new call.
      Evidence: `VaultCalendar` UniFFI object (renamed from `Calendar`, §6) + records; `build-xcframework.sh --release` EXIT 0; Swift seam `CalendarStore` (async over `CoreExecutor`, window cache, refresh after its own writes, after the vault's Tasks sync pass and on foreground); Conformance plan `CalendarConformanceTests` 4/4, run total 35 tests / 10 suites green.
- [x] CL016 Protocol docs: chapter 13 gains the four payload schemas;
      chapter 05 subscribed list and counts updated.
      Evidence: `docs/protocol/13-payload-schemas.md` §13.1 (nineteen) + §13.7.16–§13.7.19, §13.9 table; `05-record-sync.md` counts; `00` count; `06` §6.8 table; prettier clean; `vectors:check passed (20 classes)`.
- [x] CL018 Two-way calendar settings (D3a): extend the `calendar` group in
      `settings-sync.ts` with `showNotesOnCalendar` and per-provider groups;
      desktop reads / writes them through settings sync instead of the
      device-local store (seed from local value when the synced one is
      absent); core parses, merges per key and exposes them. Tests: old-schema
      upload does not clobber new keys; seed-once; per-key conflict.
      Evidence also: change each setting on desktop → visible on iOS, and the
      reverse.
      Evidence: `settings-sync.ts` calendar group (+`catchall`); `main/settings/settings-store.ts` write listener + `main/calendar/calendar-settings-sync.ts` (mirror, apply, seed-once, runtime hook in `sync/runtime.ts`, apply in `settings-handler.ts`); core `settings_merge.rs` keeps a value under an equal clock. Tests: `calendar-settings-sync.test.ts` 6/6 (old-schema upload, seed-once, per-key, no echo), `crates/memry-core/tests/calendar_settings_sync.rs` 3/3; desktop main project 956 passed; `pnpm lint` + `pnpm typecheck` EXIT 0. Cross-device check split to CL018a.
- [x] CL019 Protocol chapter 13 settings section updated for D3a.
      Evidence: §13.7.13 gains the `calendar` group, its leaves and the D7 equal-clock rule.
- [ ] CL018a Cross-device evidence for D3a: change each calendar setting on
      desktop → visible on iOS, and the reverse (needs the desktop peer, done
      with CL060).
- [x] CL017 Phase commit (after CL018–CL019).
      Evidence: 8603d4d93 feat(ios) core, the feat(desktop) D3a commit after it, and the docs(docs) commit carrying chapters 00/05/06/13 and this file.

## Phase 2: primitives and shell

- [x] CL020 `Tokens.Calendar`: 6 type hues (rail, surface, meta ink) light +
      dark, dashed date-reminder style, 11 event colors, now-line, today
      fill; AA contrast checked.
      Evidence: `Tokens+Calendar.swift` (six hues rail/surface/meta light+dark, dashed `note_date`, 11 event colours, now line, today fill); `CalendarTokenTests.every_meta_ink_clears_AA_on_its_surface_in_both_styles` green (Unit, 17/17 calendar tests).
- [x] CL021 Primitives: item chip (inline + block layout, rail, checkbox for
      tasks, ended / triggered fade, selected state, custom color), week
      strip day cell (dot row, today fill), all-day strip, time gutter +
      hour grid, now-line, overlap-lane layout (port of `overlap-layout.ts`,
      unit-tested), span-bar layout per week row (unit-tested).
      Evidence: `CalendarChip` (inline/block/compact, rail, task checkbox, ended fade, selected, custom colour), `CalendarWeekStrip`, `CalendarAllDayStrip`, `CalendarTimeGrid` (gutter, hairlines, now line); `CalendarLayoutTests.overlapping_items_share_a_cluster_of_lanes` + `spans_clip_to_the_week_and_stack_rows` green; CL01-day.png, CL03-week.png.
- [x] CL022 Entry point: More › Calendar row, More tab selected state,
      deep-link route `memry://calendar?date=&event=`.
      Evidence: More › Calendar row (`more.calendar`), More tab stays selected (every CL0x screenshot); `xcrun simctl openurl … memry://calendar?date=2026-09-25` opened Day on Fri Sep 25 in the open vault (driver run); `a_calendar_link_reads_its_day_and_event` green.
- [x] CL023 Calendar screen shell: large month title + `toolbarTitleMenu`
      (02), glass capsule (search, filter), floating "+", view state
      persisted per device (view, anchor date, filters, timeline settings),
      paging model, loading and error states (`ErrorMapping`).
      Evidence: CL02-title-menu.png.
      Evidence: CL02-title-menu.png (views, Today with date, Go to date, Calendar settings); glass capsule + floating + on every screen; view + anchor survive relaunch (reopened on the deep-linked Sep 25), `view_state_decodes_an_older_shape` green; failures go through `ErrorMapping.userFacing` in `CalendarStore.report`.

## Phase 3: views

- [x] CL030 **01 Day**: week strip paging in step with the day pager, dots,
      all-day strip, grid scrolled to now on today, chips per CL021, pull to
      refresh. Evidence: CL01-day.png.
      Evidence: CL01-day.png; driver: swipe on the grid moves one day (Oct 1 → Oct 2), swipe on the week strip moves a week (Sep 26 → Oct 3), vertical scroll works over the grid, today opens an hour above the now line, all-day strip pinned (three rows, then scrolls); `.refreshable` → `store.sync()`.
- [x] CL031 **03 Week**: 7 columns, span row, today column tint, swipe by
      week, `weekStartDay`. Evidence: CL03-week.png.
      Evidence: CL03-week.png: seven columns, span row (three rows then scrolls, §6), today column tint, compact chips; swipe pages by week (`DragGesture` on the grid); columns follow `store.weekStartsOn`.
- [x] CL032 **04 Month**: grid, dots, multi-day bars, "N more", tap day →
      list below, double tap → Day, long press + drag → CL040 all-day.
      Evidence: CL04-month.png.
      Evidence: CL04-month.png (grid, dots, "+N", multi-day bars, weekends and other months dimmed, selected-day list); driver: double tap Sep 24 → Day Sep 24; long press Sep 15 + drag to Sep 17 → composer "Tue, Sep 15 – Sep 17" all-day.
- [x] CL033 **05 Year** + **06 day peek**: tap day → medium sheet, row →
      item sheet, Open day → Day, tap month name → Month.
      Evidence: CL05-year.png, CL06-peek.png.
      Evidence: CL05-year.png (three columns, tint month names, today, dots), CL06-peek.png; driver: tap Aug name → Month Aug; peek row "Coffee with M." → Day Sep 26 + its event sheet.
- [x] CL034 **07 Timeline**: zoom segmented, pinned title column, grouped
      rows, bars / due diamonds / overdue / undated hint, today line, hold +
      drag bar and ends, tap undated day to date it, Undo.
      Evidence: CL07-timeline.png.
      Evidence: CL07-timeline.png, CL07-timeline-drag.png; driver on `[agent] Timeline task` / `[agent] Undated task` (project `[agent] Calendar project`): zoom segmented, pinned title column, grouped rows with dot + count, bars / diamonds / overdue red, today line; tap selects, drag moved Oct 4 → Sep 30 with "Reschedule …" + Undo; Clear dates → undated row, a tap on its day dated it; Undo restored Sep 30 → Oct 7. `CalendarTimelineTests` 8/8.
- [x] CL035 **08 Display** and **09 bar actions**: every action of
      `timeline-action-panel` (open, open in Tasks, set start, set due, week
      earlier / later, clear dates, complete / uncomplete, change project).
      Evidence: CL08-display.png, CL09-actions.png.
      Evidence: CL08-display.png (Group by / Order by with current value, Show toggles), CL09-actions.png (preview card, 1 week earlier / later / Complete, Open task, Open in Tasks, Set start / due with dates, Change project, Clear dates); driver: 1 week later Sep 30 → Oct 7, 1 week earlier + Undo, Complete hid the row (completed off) + Undo brought it back, Clear dates.
- [x] CL036 **10 Filter sheet**: sources switches, 7 type chips, per-provider
      calendar list, tick a not-syncing calendar subscribes it (CL013),
      refresh, Manage accounts → 27. Evidence: CL10-filter.png.
      Evidence: CL10-filter.png (sources switches, seven type chips filled when on, per-provider list, refresh, Manage accounts); subscribe-on-tick logic `source_selection_ticks_subscribe_and_unticks_only_hide` green + `set_source_selected` write vector. The account has no provider calendars yet; the list with real rows is re-shot at CL061.
- [x] CL037 **11 Search**: results grouped, tap → Day on date + item sheet.
      Evidence: CL11-search.png.
      Evidence: CL11-search.png (field focused, keyboard up, grouped This week / Later / Earlier, detail line per Paper 11); driver: tap "Coffee with M." → Day Sep 26 + event sheet.
- [x] CL038 Phase commit.
      Evidence: phase commit after CL034/CL035 (see git log).

## Phase 4: create and edit

- [x] CL040 **12 Quick create**: long press + drag on Day / Week grid with
      15-min snap, handles, haptic per snap; Month range → all-day; composer
      above keyboard (title, time chip, calendar chip, More… → 13); save
      error keeps composer. Evidence: CL12-quick-create.png.
      Evidence: CL12-quick-create.png: long press + drag on Day grid → composer above the keyboard with "Thu 14:15 – 15:15", calendar chip, More…; send created `[agent] Quick create test` (pushed, `calendar sync pass pushed [count=1]`); Month long press + drag → all-day composer (CL032). Hold uses `CalendarHoldDrag` (15-min snap, `.sensoryFeedback(.selection)` per snap). A failed create sets the inline error and keeps the composer (`send()` path, desktop parity).
- [x] CL041 **13 New event sheet**: title, all-day toggle (desktop date
      conversion), starts / ends with duration, calendar picker grouped by
      provider with default, project, color (default + 11), notes / URL;
      project link after create, link failure keeps event + toast.
      Evidence: CL13-new-event.png.
      Evidence: CL13-new-event.png: + opens 9–10 on the anchor day, title focused; Paper 13 layout (title on the sheet, All-day, Starts, Ends with duration, Calendar picker with default, Project, 12 swatches, notes, footer); saved `[agent] Plus event` with project `[agent] Calendar project` → the event sheet shows the project pill (link after create through `relink`, failure → toast).
- [x] CL042 **14 Event sheet**: edit + pills + "+", … menu, Join, read-only
      attendees / reminders / visibility. Evidence: CL14-event.png.
      Evidence: CL14-event.png: centred "• Event", title edits in place (saved a rename through `updateEvent`), "Sat, Sep 26 · 09:00 – 10:00 · 1h", pills (calendar, project, colour Tomato after the editor set it), + opens the full sheet; Join row reads `conferenceData` (name + host, filled Join); attendees / reminders / visibility read-only sections.
- [x] CL043 **15 Event menu** + **22 Delete** + **23 Add to project**:
      memrynote events only; Google-bound wording. Evidence: CL15-menu.png,
      CL22-delete.png, CL23-project.png.
      Evidence: CL15-menu.png (Open, Add to project, Delete event), CL22-delete.png (desktop wording, destructive Delete), CL23-project.png (search, dots, current project first and ticked, Remove from …); the sheet … menu holds the same two actions.
- [x] CL044 **16 Move / resize**: hold + drag, edge handles, snap label,
      events and timed tasks only, Undo toast restores both.
      Evidence: CL16-move.png.
      Evidence: CL16-move.png: hold + drag moved `[agent] Plus event` 09:00 → 10:00 ("Moved to 10:00" + Undo); bottom handle resized 11:00 → 11:30 ("Now 10:00 – 11:30"), a second resize to 12:00 undone back to 11:30; timed tasks move through `setDue` with "Task rescheduled" + Undo; imported / read-only chips get no hold gesture (`canDrag`).
- [ ] CL045 **18 Promote**: routing (ask / skip rule with AI access), writes
      per CL013, opens 14 on the linked copy. Evidence: CL18-promote.png.
- [ ] CL046 Phase commit.

## Phase 5: other items and cross-feature

- [x] CL050 **17 Task sheet**: status toggle + Undo, breadcrumb, pills,
      description, subtasks toggle, Move row (Later / Tomorrow / Next week
      from `snooze-options`), … (Source note, Pick date & time → Tasks When
      sheet, Remove due date), Open task → Tasks detail; chip checkbox
      completes in place. Evidence: CL17-task.png.
      Evidence: CL17-task.png (breadcrumb, … and close on one line, status circle + title, date from the task itself, coloured pills, description, subtasks disclosure with counter, Move chips from `snooze-options` — Later only for timed tasks — Complete + Open task); driver on `[agent] Undated task`: Complete → Done pill + Reopen, circle reopened it, Tomorrow moved it off Sep 29; `[agent] Timeline task` › Open task → its Tasks detail. … holds Source note, Pick date & time (Tasks detail with the When sheet), Remove due date.
- [ ] CL051 **19 Read-only sheet**: subscribed, read-only CalDAV and This
      iPhone events; recurrence text (`describeRecurrence`), alerts,
      conference + phone PIN, location, attendees (6, show more), links in
      text, details-load error line. Evidence: CL19-readonly.png.
- [x] CL052 **20 Note sheet**: note vs date reminder, Open note at anchor.
      Evidence: CL20-note.png.
      Evidence: CL20-note.png (Paper 20: kind line with close, title, "Mon, Sep 14", Open note, footnote); with Show notes on (then switched back off) Month showed pink note days, the Sep 14 row opened the sheet, Open note opened "Lisbon Food Map". Date reminders use the same sheet with the dashed kind mark.
- [x] CL053 **21 Snooze sheet**: Open in Inbox (focused), Unsnooze,
      Reschedule via Inbox snooze menu. Evidence: CL21-snooze.png.
      Evidence: CL21-snooze.png (Paper 21: "Snoozed inbox item · back at 12:17", preview, Open in Inbox / Unsnooze now / Reschedule card, footnote); Open in Inbox opened the item's Inbox detail. Reschedule is the Inbox snooze menu (`InboxSnoozeMenuItems`) and its date sheet.
- [x] CL054 Deep links: Agent Chat style `date + event` opens Day + sheet;
      project hub "Calendar event" row opens the event.
      Evidence: `xcrun simctl openurl memry://calendar?date=2026-09-03&event=<id>` from the Notes tab → Day Sep 3 with the `[agent] Quick create test` sheet; project hub "Linked" row now names the event and opens it on its day (CL54-hub-link.png); a bare event id resolves the day from the record.
- [ ] CL055 Phase commit.

## Phase 6: provider runtime, accounts and settings (D3 / D4)

- [ ] CL070 Shared provider logic in core per CL003 split: write routing,
      Google and iCal field mapping, recurrence expansion, ICS parsing,
      sync-state model. Vectors from desktop (`google/mappers`, `ical/**`,
      `provider/write-routing`, `writer-compat`).
- [ ] CL071 Google on iOS: `ASWebAuthenticationSession` + PKCE with the iOS
      client, Keychain storage, multiple accounts, reconnect-required state,
      incremental pull with cursor reset, push through routing, revoke on
      disconnect. The app already has an iOS Google client for sign-in
      (`Info.plist` client id + reversed URL scheme, `GoogleSignInRequest`);
      reuse it with the `calendar` scope added incrementally. If that client's
      Cloud project lacks the Calendar API or the consent screen lacks the
      scope: §7 blocker for Kaan, continue CL072–CL074.
- [ ] CL072 Provider-auth transfer: linking a new device carries Google
      accounts to / from iOS the way desktop does, or each device signs in;
      per CL003. Test with the desktop peer.
- [ ] CL073 Subscribed (ICS / webcal) on iOS: add, http warning, fetch with
      desktop limits and errors, hourly refresh, rename / color / remove.
- [ ] CL074 CalDAV on iOS: presets, app password in Keychain, discovery,
      pull / push with etags, writer-compat acknowledgement; verified
      against local Radicale.
- [ ] CL075 Background and foreground scheduling (`BGAppRefreshTask`,
      foreground, Sync now, realtime nudge if CL003 found one); no double
      push when desktop and iOS both hold the same account (test: edit one
      event on iOS with both online, exactly one remote write).

- [ ] CL060 **27 Calendar settings**: account rows with status, default
      calendar (one provider holds it), week start, show notes; all two-way
      per D3a, device-local rows labelled as such; account rows show this
      device's connection state.
      Evidence: CL27-settings.png.
- [ ] CL061 **28 Google**: accounts with status, imported calendars with
      sync status and Retry, push toggle, AI toggle; Add account, Reconnect,
      Sync now, Disconnect (CL071). Evidence: CL28-google.png.
- [ ] CL062 **29 Subscribed** and **30 CalDAV**: lists, statuses, errors,
      rename / color / refresh / remove, presets, writer-compat notice and
      acknowledgement; Subscribe and Connect run on iOS (CL073, CL074).
      Evidence: CL29.png, CL30.png.
- [ ] CL063 **24 Connect**, **25 Default calendar**, **26 AI consent**:
      prompt only while not connected, default picker after connect,
      consent once per provider (stored where desktop stores it).
      Evidence: CL24.png, CL25.png, CL26.png.
- [ ] CL064 **31 This iPhone**: EventKit permission states (not asked,
      denied → Open Settings / Check again, restricted, write-only, allowed),
      per-calendar switches, duplicate guard, events shown as read-only
      (19), never synced. Evidence: CL31-a/b/c.png.
- [ ] CL065 Phase commit.

## Phase 7: verification and wrap-up

- [ ] CL090 Accessibility: AX5 (lists reflow, Week / Month list fallback at
      AX3+), forced RTL, Reduce Motion / Transparency, VoiceOver tree dumps
      for Day, event sheet, composer; grid actions without drag.
- [ ] CL091 Dark mode: light + dark screenshots of 01, 04, 07, 13, 14, 27.
- [ ] CL092 Performance: 200 items / week, paging without refetch, 60 fps
      trace; numbers in §5.
- [ ] CL093 Tests: Unit (layout, projection seam, copy, state), UI
      (`CalendarUITests` for lanes A–J of 00b), Conformance for every core
      call; all green.
- [ ] CL094 Delete every `[agent] ` / `Agent Test …` item on iOS and desktop;
      confirm none remain.
- [ ] CL095 Final report (§8), last phase commit.

---

## 5. Verified facts (filled by CL001–CL004, CL092)

<!-- fact — file:line -->

### F1 Payloads (CL001)

- **`calendar_event`** (`packages/contracts/src/sync-payloads.ts:371`): every key optional:
  `title, description|null, location|null, startAt, endAt|null, timezone, isAllDay,
recurrenceRule(obj)|null, recurrenceExceptions(string[])|null, attendees(obj[])|null,
reminders(obj)|null, visibility(default|public|private|confidential)|null, colorId|null,
conferenceData(obj)|null, parentEventId|null, originalStartTime|null,
targetCalendarId|null, archivedAt|null, clock, fieldClocks|null, createdAt, modifiedAt`.
  Desktop's push is its whole row (`calendar-event-handler.ts:224` `buildPushPayload`; queue
  payload = `serialize: (local) => local`, `calendar-event-sync.ts:73`), so local columns
  (`syncedAt`) also ride along. Field-merged over 14 fields
  (`field-merge-calendar.ts:4` `CALENDAR_EVENT_SYNCABLE_FIELDS`: title … conferenceData;
  **not** `targetCalendarId/parentEventId/originalStartTime/archivedAt`).
- **`calendar_source`** (`:410`): `provider, kind(account|calendar), accountId|null, remoteId,
title, timezone|null, color|null, isPrimary, isSelected, isMemryManaged, syncCursor|null,
syncStatus(idle|ok|error|pending), lastSyncedAt|null, metadata(obj)|null, archivedAt|null,
clock, createdAt, modifiedAt`. Push = whole row incl. `lastError`, `syncedAt`
  (`calendar-source-sync.ts:76`). Document clock only.
- **`calendar_binding`** (`:431`): `sourceType(event|task|reminder|inbox_snooze), sourceId,
provider, remoteCalendarId, remoteEventId, ownershipMode(memry_managed|provider_managed),
writebackMode(schedule_only|time_and_text|broad), remoteVersion|null,
lastLocalSnapshot(obj)|null, archivedAt|null, clock, createdAt, modifiedAt`.
- **`calendar_external_event`** (`:447`): `sourceId, remoteEventId, remoteEtag|null,
remoteUpdatedAt|null, title, description|null, location|null, startAt, endAt|null,
timezone|null, isAllDay, status(confirmed|tentative|cancelled), recurrenceRule|null,
attendees|null, reminders|null, visibility|null, colorId|null, conferenceData|null,
rawPayload(obj)|null, archivedAt|null, clock, createdAt, modifiedAt`.
- **DB shapes** (`packages/db-schema/src/schema/calendar-*.ts`, desktop migrations
  `0024_google_calendar_foundation` … `0028_calendar_source_last_error`): same columns in
  snake_case plus local `synced_at`, `calendar_sources.last_error` (0028), `field_clocks`
  on `calendar_events` (0026), rich fields (0027), `target_calendar_id` (0025).
  `calendar_external_events.source_id` is NOT NULL FK → `calendar_sources` ON DELETE cascade.
- **Apply rules on desktop** (the iOS core copies them, CL010/CL011):
  - source / binding / external (`packages/sync-client/src/item-handlers/calendar-*-handler.ts`):
    document gate (skip when local dominates; concurrent → apply remote under merged clock);
    overlay with `data.x ?? existing.x` for every key (**a `null` keeps the local value**),
    except external `attendees, reminders, visibility, colorId, conferenceData` which use
    presence (explicit `null` clears). Insert defaults: source `provider 'google', kind
'calendar', remoteId = id, title 'Untitled calendar', syncStatus 'idle'`; binding
    `sourceType 'event', sourceId = id, provider 'google', remoteCalendarId 'primary',
remoteEventId = id, ownership 'memry_managed', writeback 'broad'`; external
    `title 'Untitled imported event', status 'confirmed', remoteEventId = id`.
  - external event whose `sourceId` has not landed throws `MissingSyncParentError` → parked
    and retried (`calendar-external-event-handler.ts:48`). A create with no `sourceId` is the
    same error with an empty id.
  - event (`calendar-event-handler.ts:26`): skip / field merge (a remote key that is
    `undefined` is replaced by the local value before `mergeFields`; routing keys
    `targetCalendarId, parentEventId, originalStartTime` by presence; `archivedAt` by `??`) /
    wholesale overlay (`??` for title…recurrenceExceptions, presence for attendees, reminders,
    visibility, colorId, targetCalendarId, parentEventId, originalStartTime, conferenceData).
    Missing `fieldClocks` on either side are seeded from the document clock
    (`initAllFieldClocks`). Insert defaults `title 'Untitled event', startAt now, timezone 'UTC'`.
  - deletes: document-clock tombstone gate, then row delete (every type).
  - unknown keys: zod strips them on desktop (object schemas); the iOS core keeps the verbatim
    payload (§13.2 rule 3), so unknown keys round-trip on iOS.
- **Device-local rows** (`calendar-api.ts:298` `DEVICE_LOCAL_CALENDAR_PROVIDERS`):
  `apple-eventkit` sources never sync; ICS (`ics`) and EventKit **external events** never
  sync (each device fetches the feed itself; the ICS `calendar_source` row does sync).
  So iOS must fetch ICS feeds itself to show subscribed events (CL073).
- **Apply order** (chapter 05): source 0, event / external 2, binding 3.

### F2 Projection (CL002, `apps/desktop/src/main/calendar/projection.ts`)

- Range input `startAt/endAt` ISO, `includeUnselectedSources` (default false),
  `includeExternal`, `externalProviders` (`calendar-api.ts:92`). Items sorted by `startAt`
  string then `projectionId` (`:131`).
- **event** (`:139`): `archived_at IS NULL AND startAt < end AND coalesce(endAt,startAt) >= start`
  (ISO string compare). id `event:<id>`, editability all true, source `memrynote`
  (provider null, isMemryManaged true), binding = live binding `sourceType 'event'`.
  Colour: `colorId` → event colour → hex; else the colour of the Google calendar named by
  binding.remoteCalendarId ?? targetCalendarId (google, kind calendar, not archived,
  `calendarDisplayHex(color)`).
- **task** (`:229`): `dueDate` in local day range `[localDate(start), localDate(end-1ms)]`,
  not completed, not archived; order dueDate, dueTime, position. `isAllDay = !dueTime`;
  `startAt = local(dueDate, dueTime ?? 00:00)` as UTC ISO; `endAt` = next local midnight for
  all-day else null. canMove true, canResize false, canEditText true, canDelete true. Source
  `memrynote Tasks`.
- **reminder** (`:285`): `targetType != 'note_date'` and (pending with remindAt in [start,end))
  or (snoozed with snoozedUntil in [start,end)). startAt = snoozedUntil when snoozed;
  `snoozeOffsetMinutes = round((snoozedUntil-remindAt)/60000)`; title `title.trim() || 'Reminder'`;
  preview `note ?? highlightText`. canResize false, others true. Source `memrynote Reminders`.
- **note_date** (`:350`): reminders `targetType 'note_date'`, every status (non-snoozed by
  remindAt, snoozed by snoozedUntil); title = note title or `Untitled`; `noteId`, `anchorId`,
  `isTriggered = status in (triggered, dismissed)`; read-only. Source `memrynote Notes`.
- **snooze** (`:431`): inbox items `snoozedUntil in [start,end)`, not filed, not archived;
  visualType `snooze`, sourceType `inbox_snooze`; canMove true, canResize false,
  canEditText false, canDelete true. Source `memrynote Inbox`.
- **external_event** (`:474`): join source; neither archived; overlap rule as events;
  `isSelected = 1` unless `includeUnselectedSources`; optional provider filter. Editable
  (promotable) iff provider `supportsWrite` (google, caldav); ics / apple-eventkit / unknown
  read-only (`provider/capabilities.ts`). timezone `event.tz ?? source.tz ?? local`. Colour
  `colorId` else `calendarDisplayHex(source.color)`.
- **note (date property)** (`:552`): `note_properties` rows with `type 'date'` and name in the
  calendar-enabled set, value in [start,end) (string compare), local day of the value
  (bare `YYYY-MM-DD` taken as is); all-day on that day; id `note:<noteId>:<name>`,
  preview = property name. The enabled set is `PropertyDefinitionsService.listCalendarEnabledNames()`
  = the vault's `.memry/properties.md` `showOnCalendar` flags; **not synced**:
  `PropertyDefinitionSyncPayloadSchema` (`sync-payloads.ts:328`) has no such key and a synced
  row reads `showOnCalendar: false` (`vault/property-definitions.ts:443`).
- **note by created date** (`:609`), only when `showNotesOnCalendar`: markdown notes with no
  journal date, `createdAt in [start,end)`, all-day on local creation day, id
  `note-created:<id>`; dropped when a property chip of the same note lands on that day.
- Source selection filters external events only; `showNotesOnCalendar` gates created-date
  notes only. Renderer: views request their visible window (`calendar-view-state.ts`).
- Colours: `packages/contracts/src/calendar-colors.ts` (24 calendar colours, 11 event
  colours with Google ids `lavender 1, sage 2, grape 3, flamingo 4, banana 5, tangerine 6,
peacock 7, graphite 8, blueberry 9, basil 10, tomato 11`; legacy API hex → current hex).

### F3 Writes (CL003, part 1: records)

- **create event** (`ipc/calendar-handlers.ts:176`): nanoid, row with `colorId` from colour
  name, `createdAt = modifiedAt = now`; enqueue create → clock `{dev:1}`, **every** field clock
  ticked (`calendar-event-sync.ts:55`). Push = whole row.
- **update event** (`:230`): only present keys; colour only when it differs; changed fields
  (minus `modifiedAt`, `targetCalendarId`) tick their field clocks; document clock ticks.
- **delete event** (`:318`): row deleted, tombstone payload = snapshot with ticked clock.
- **promote** (`promote-external-event.ts`): refuses read-only providers; idempotent via
  binding (provider, remoteCalendarId, remoteEventId) → archive mirror and return. Else new
  event (copy of mirror fields, `targetCalendarId = source.remoteId`, `timezone ?? 'UTC'`,
  `recurrenceExceptions null`, clock = copy of mirror clock), new binding
  (`provider_managed`, `time_and_text`, remoteVersion = etag, clock = mirror clock), mirror
  `archivedAt = now`; enqueue create event, create binding, update external.
- **source selection** (`calendar-handlers.ts:382`): only `kind 'calendar'`; upsert with
  `isSelected`, tick clock, enqueue; provider `onSelectionChanged` (unselect purges mirrors,
  select triggers a pull). So selection travels on the `calendar_source` record.
- **settings**: `weekStartDay`, `showNotesOnCalendar`, `dayCellClickBehavior` live in the
  device-local `calendar` group (`settings-handlers.ts:1286` `writeGroupSettings`), provider
  groups `calendar.google` (`defaultTargetCalendarId, onboardingCompleted,
promoteConfirmDismissed, pushEventsToGoogle, agentReadEventsConsent`) and
  `calendar.<provider>` (`agentReadEventsConsent`, writable + `pushEventsToProvider`) too.
  **None of them reaches settings sync today**: `SyncedSettingsSchema.calendar` has only
  `weekStartDay` (`settings-sync.ts:45`) and nothing calls `syncSettingsFieldUpdate` for it;
  the settings handler propagates no calendar group (`settings-handler.ts`). Desktop's
  settings field clocks are written under device id `'local'` (`local-mutations.ts:911`).
  Settings merge is per dotted path (`settings-sync.ts:78`): equal clocks with an absent
  remote value keep the local value, so an old device that strips a key cannot clear it.

### F3b Provider runtime (CL003, part 2)

- **Capabilities** (`provider/capabilities.ts`): google write+push(relay)+multi-account,
  mirror synced, `sync-token`, oauth2; caldav write, no push, multi-account, mirror synced,
  `sync-collection`, basic auth, poll 15 min; ics read-only, mirror **device**, source
  synced, conditional GET; apple-eventkit read-only, source+mirror device, darwin only;
  unknown provider = read-only, device mirror.
- **Write routing** (`provider/write-routing.ts`): live binding of any provider (oldest by
  `createdAt`, then id) > event `targetCalendarId` looked up across sources (google wins a
  collision; unknown id = google) > default write target (`calendar.defaultWriteTarget`
  local setting `{provider, remoteCalendarId}`, non-google only while its source is live and
  selected; else `calendar.google.defaultTargetCalendarId`) > `legacy_google` (managed
  memrynote calendar).
- **Google OAuth** (`google/oauth.ts`): desktop client `GOOGLE_CALENDAR_CLIENT_ID` (Cloud
  project `244914619370`, same project as the iOS sign-in client in `Info.plist`
  `MemryGoogleClientID`), loopback redirect, PKCE, token URL
  `https://oauth2.googleapis.com/token`, revoke `
https://oauth2.googleapis.com/revoke`. A refresh token is bound to the client that
  minted it, so a desktop token is not refreshable with the iOS client id (and needs the
  desktop secret). `provider-auth-transfer.ts` carries `{provider:'google', accountId,
refreshToken}` encrypted inside device linking; iOS cannot use those tokens → each
  device signs in itself (§6).
- **Google push**: desktop registers a Google watch channel through the sync server
  (`sync-server/src/routes/calendar-channels.ts`); Google's webhook hits
  `routes/webhooks.ts:120`, which broadcasts `calendar_changes_available` on the user's
  realtime socket. Any device with the socket sees the nudge.
- **ICS** (`ics/ics-fetch.ts`, `ics-subscriptions.ts`): 30 s timeout, 20 MB cap, ≤ 5
  redirects (301/302/303/307/308, http(s) only), window 90 days back / 365 ahead, refresh
  default 1 h (15 min..24 h), runner tick 5 min; error codes `invalid_url, unreachable,
timeout, not_found, unauthorized, http_error, too_large, not_a_calendar,
too_many_redirects, unsupported_redirect` stored in `calendar_sources.last_error`.
- **Writer compat** (`provider/writer-compat.ts`): before connecting a provider whose
  writes older builds would not route, desktop lists linked devices older than the routing
  release and shows a notice that must be acknowledged.

### F4 Platform (CL004)

- No calendar code on iOS; the only surface is `ProjectHubSections.swift` naming a linked
  event. EventKit needs `NSCalendarsFullAccessUsageDescription` in `Info.plist` and
  `EKEventStore.requestFullAccessToEvents()`; no entitlement is required for EventKit.
- **More tab** = `MoreTabView` (`Features/Settings/SettingsNavigation.swift:29`), one
  `NavigationStack` on `TasksRouter.settingsPath`; it already hosts `NoteRoute` pages, so
  the calendar pushes inside it and More stays selected.
- Cross-tab hooks: `TasksRouter.openTask(id)` (`TasksRootView.swift:54`) selects Tasks
  with the detail; `InboxRouter.openItem(id, in:)` (`InboxScope.swift:26`);
  `NoteRoute(id:)` (`NoteReadParts.swift:14`, no anchor field); the Tasks When sheet is
  `TaskWhenSheet` over a `TasksStore`.
- **No `memry://` scheme and no `onOpenURL` exist**; `Info.plist` registers only the
  Google reversed-client-id scheme. CL022 adds the router.

## 6. Decisions log (agent-made choices during the run)

<!-- date — id — choice — why -->

- 2026-09-26 — CL000 — The spec commit step was a no-op: `origin/main` already carries
  `specs/007-ios-calendar/{goal,tasks}.md` byte-identical (4afcdf28b). Copied `.env*`,
  `apps/sync-server/.dev.vars`, `.specify/feature.json` from the main checkout;
  `apps/ios/buildServer.json` was not kept (it points at the main checkout's project).
- 2026-09-26 — CL000 — No subagents: the request does not authorize delegation.
- 2026-09-26 — CL002 — Calendar-enabled date properties are not synced on desktop (F2), so
  iOS keeps its own device-local set and passes it to the projection, the same parameter
  desktop's `getCalendarRangeProjection` takes. Default empty, as on a fresh desktop vault.
- 2026-09-26 — CL002 — Local-time conversions (task due dates, all-day ends, note days)
  run in the core from a `CalendarZone` **record** the shell builds from `TimeZone.current`
  (base offset + DST transitions over the window), not a foreign trait: `seams/mod.rs`
  closes the seam list. JavaScript's gap/overlap rules are rebuilt in `zone.rs`. Vectors are
  generated under `TZ=America/New_York` and carry the same table.
- 2026-09-26 — CL010 — An external event that lands before its source is stored and
  simply not shown (the projection inner-joins the source) instead of desktop's park +
  orphan repair; when the source lands it shows. Desktop refuses a payload whose
  non-nullable key is `null` (zod); the core keeps the local value for that key and applies
  the rest (substitute, never refuse). ICS mirror events live in the device-local
  `calendar_local_events` table (never in `sync_items`), as desktop keeps them per device.
- 2026-09-26 — CL017 — `scripts/check-staged-secrets.mjs` read staged files with the default
  1 MB `maxBuffer`; the generated Swift bindings passed 1 MB and failed the pre-commit hook
  (`ENOBUFS`). Raised to 64 MB in the core commit (tooling, no behaviour change). Desktop D3a
  went in as its own `feat(desktop)` commit so it reviews apart from the core.
- 2026-09-26 — CL014 — The timeline model lives in Swift, not the core: it is pure view
  math over the task list `TasksStore` already holds (`timeline-model.ts` is renderer
  code), so a Swift port with unit tests restating desktop's is the cheaper pin.
- 2026-09-26 — CL015 — The UniFFI object is `VaultCalendar`: a generated `Calendar` class
  shadowed `Foundation.Calendar` across the app (`'Calendar' is ambiguous`).
- 2026-09-26 — CL018 — Desktop mirrors calendar groups through one settings-store write
  listener (every writer: settings IPC, onboarding, write routing) instead of touching each
  call site; remote applies write the raw table, so they never echo. A cleared default
  target is an absent row locally and `null` on the wire. The core's settings merge now keeps
  a local value when the remote omits it under an equal field clock (an old build stripped
  the key; a real removal ticks the clock) — desktop's `mergeRemote` already did.
- 2026-09-26 — CL012 — Two projection details the phone cannot copy byte for byte:
  desktop picks an item's binding by SQLite insert order (`new Map(rows)` keeps the last);
  the phone orders by `createdAt` so the newest wins (same answer when rows arrived in
  order). `localeCompare` for the tie-break sort is approximated (punctuation < digits <
  letters, case second).
- 2026-09-26 — CL003 — Google on iOS signs in itself with the iOS client (same Cloud
  project); desktop refresh tokens from `provider-auth-transfer` are not importable (client
  bound). Linking still works for every record; the account shows "Sign in on this
  iPhone" until the user connects it here.
- 2026-09-26 — CL003 — Core vs Swift split (goal D3 rule): **core** holds everything two
  devices must agree on — record apply / merge, projection, record writes (create, update,
  move, delete, promote, project link, source selection), write routing, Google
  event ↔ record mapping, iCalendar parsing + recurrence expansion for ICS / CalDAV
  mirrors, the mirror upsert / archive rules and the sync-state columns. **Swift** holds
  transport and platform: URLSession requests (Google REST, CalDAV WebDAV, ICS GET),
  `ASWebAuthenticationSession` + PKCE, Keychain, `BGAppRefreshTask`, EventKit. The core
  exposes pure functions over request/response bodies so it never opens a socket
  (Constitution I: no Rust networking on device).
- 2026-09-26 — CL003 — D3a set: synced under `calendar.*` — `weekStartDay` (exists),
  `showNotesOnCalendar`, `defaultWriteTarget`, `google.{defaultTargetCalendarId,
onboardingCompleted, promoteConfirmDismissed, pushEventsToGoogle, agentReadEventsConsent}`,
  `<provider>.{agentReadEventsConsent, pushEventsToProvider}`. Device-local:
  `dayCellClickBehavior` / `calendarPageClickOverride` (desktop sidebar day panel, desktop
  only per artboard 00), EventKit enablement + its per-calendar switches, provider secrets,
  sync cursors (cursors live on the synced source row already, desktop behaviour).
- 2026-09-26 — CL030 — SwiftUI `LongPressGesture.sequenced(before: DragGesture)` on scroll
  content stopped the Day / Week grids from scrolling or paging at all (driver drag: no
  movement; with the gesture off the grid scrolled). Replaced by `CalendarHoldDrag`, a
  `UIGestureRecognizerRepresentable` long press that fails on early movement (leaving the pan
  to the scroll view) and keeps tracking after it lands. Used for empty-time create, chip
  move and Month range; the grid sets `scrollDisabled` while a hold is live.
- 2026-09-26 — CL030 — The day pager re-centred a three-page window on every settle, which
  shifted pages under a finishing scroll and skipped days (Sep 26 → Oct 1 on one swipe). It
  now pages over ±60 days around a base that only moves near its edge or on a jump.
- 2026-09-26 — CL031 — Desktop grows the all-day row to fit every item. On a phone five
  all-day tasks pushed the hours off screen, so Day and Week show three rows and scroll the
  rest inside the strip. Week chips narrower than 20 pt show the rail only (words broke
  letter by letter).
- 2026-09-26 — CL033 — Year follows Paper 05: three months a row (two at accessibility
  sizes), every month name in tint ink, subtitle "Year · tap a day to peek, a month to open".
- 2026-09-26 — CL034 — Desktop day widths (48 / 26 / 8 px) are for a wide window; the phone
  canvas is about 260 pt beside the title column. iOS uses 20 / 7 / 2.5 pt so the three zooms
  show about two weeks / six weeks / four months, one tick row as Paper 07 draws it (days;
  week starts with "Oct 5" at a month change; month names). Header: "Timeline" with "By
  project · N tasks · M events".
- 2026-09-26 — CL034 — `VaultCalendarScope` built its store before the vault's tasks store
  existed and never rebuilt, so Timeline had no tasks. The scope now rebuilds once the tasks
  store arrives.
- 2026-09-26 — CL036 — Paper 10's footer says "Filters apply to this view only"; filters here
  are device state shared by every view, so the footer reads "Filters apply on this iPhone
  only". Title "Calendars"; refresh on the left, filled check closes.
- 2026-09-26 — CL035 — Bar menu per Paper 09: labelled control group (1 week earlier / 1 week
  later / Complete), plain rows, set start / due carry the current date as a subtitle, the
  lifted preview card (project, title, bar, dates · N days).

- 2026-09-26 — CL044 — A movable chip cannot carry the system context menu and a hold + drag at
  once (both claim the long press). Movable chips (memrynote events, timed tasks) show the
  same actions in a confirmation dialog when the hold ends without movement; every other chip
  keeps the system context menu (Paper 15's preview card). Resize handles show on chips of 45
  minutes or more; shorter ones only move. Toasts follow Paper 16: "Moved to 10:00", resize
  "Now 10:00 – 11:30".
- 2026-09-26 — CL045 — Promote needs an imported Google event; the account has none until
  Google connects on this phone (CL071). Deferred to Phase 6.
- 2026-09-26 — CL042 — The event sheet edits the title in place and saves it with the
  checkmark; every other field opens the full sheet (13) from its pill or +, as Paper 14's "+
  reveals the rest" reads. Sheet close buttons draw an ink glyph (00 rule 6).

- 2026-09-26 — CL050 — All-day tasks carry local midnights (`local_instant`), so the sheets'
  date line read them in UTC and named the day before (sheet "Fri, Sep 25", strip Sat 26).
  Sheets now read the same day keys the grid places items by. The task sheet reads its date
  from the task, so a Move shows the new day at once.
- 2026-09-26 — CL054 — The project hub's linked calendar events had no action and no title.
  The row now opens the event in the calendar on its day, and names it through the calendar
  store (events are not related items in the Tasks core).
- 2026-09-26 — CL051 — The read-only sheet needs an imported, subscribed, CalDAV or This
  iPhone event; the account has none until Phase 6 connects one. Deferred there.
- 2026-09-26 — CL060 — Changing week start or show notes in settings now re-reads the store's
  cached settings and windows; before, the grid kept the old request until relaunch.

## 7. Blockers

_empty_

## 8. Final report

### What shipped

### Provider parity (Google, CalDAV, ICS, This iPhone)

### Evidence index

### Left open
