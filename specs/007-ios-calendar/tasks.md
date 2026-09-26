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

- [ ] CL000 Read goal.md, root + iOS `AGENTS.md`, `DESIGN.md`, `PRODUCT.md`,
      spec 004 §0–§1/§5/§6, spec 005 goal + tasks, artboards 00 and 00b in
      full, `get_tree_summary` + screenshot of 01–31, the desktop files in
      goal "Read first" §6, `Tokens.swift`. Create the worktree.
- [ ] CL001 Payload facts → §5: the four schemas from
      `packages/contracts/src/sync-payloads.ts` (every field, optionality,
      enums, `fieldClocks`, deletes), their DB shapes (`calendar-*.ts`,
      migrations 0024–0028), apply order (chapter 05 table: source 0,
      event / external 2, binding 3), and what desktop does on unknown fields.
- [ ] CL002 Projection facts → §5: from `main/calendar/projection.ts` and
      friends, the exact rules per visual type (event, external_event, task,
      reminder, snooze, note, note_date), `editability` (canMove, canResize,
      canDelete), `displayColor`, `isTriggered`, all-day UTC-midnight with
      exclusive end, range bounds per view, `includeUnselectedSources`, and
      how `showNotesOnCalendar` and source selection filter.
- [ ] CL003 Write-path facts → §5: what desktop writes for create / update /
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
- [ ] CL004 Platform facts → §5: EventKit full-access entitlement and
      `NSCalendarsFullAccessUsageDescription`; how Tasks / Inbox / Notes
      expose "open detail", "When sheet", "focus inbox item", "open note at
      anchor" for reuse; existing deep-link router.

## Phase 1: core (Rust, UniFFI, vectors)

- [ ] CL010 Move the four types from `UNSUBSCRIBED_RECORD_ITEM_TYPES` to the
      subscribed set; storage tables and projectors for sources, events,
      external events, bindings; apply order; unknown-field round trip.
      Tests: apply / re-apply / delete / out-of-order binding.
- [ ] CL011 Field-level merge for `calendar_event` matching
      `field-merge-calendar.ts` (syncable fields, field clocks, tie-break).
      Vectors generated from desktop, checked in core.
- [ ] CL012 Projection API: `calendar_range(start, end, include_unselected)`
      returning projection items for all seven visual types with
      editability, colors, source, binding; plus `calendar_sources()`,
      `calendar_event(id)`, `calendar_external_event(id)` (attendees,
      conference, reminders, recurrence, location), `calendar_search(query,
    range)`. Vectors from desktop projection for a fixed fixture (tasks,
      reminders, snoozes, notes, spans, time zones, DST).
- [ ] CL013 Write API: create / update / delete event, move (start, end),
      link / unlink project (`calendar_event` item type in project links),
      promote external event (event + binding exactly as desktop), set
      source selection, set default target, provider settings,
      calendar settings (week start, show notes). Each write emits the same
      record shape desktop emits (vector per write).
- [ ] CL014 Timeline model in core or Swift (decide in §6 by where desktop's
      `timeline-model.ts` logic is cheapest to pin): windows per zoom, group
      by project / status / priority / none, order by start / due / title,
      show toggles, shape per task (span, due, start, undated, overdue).
      Vectors or unit tests from desktop.
- [ ] CL015 UniFFI surface, `build-xcframework.sh --release`, Swift seam
      (`Core/`) with async wrappers and change notifications so open views
      refresh on sync. Conformance plan cases for every new call.
- [ ] CL016 Protocol docs: chapter 13 gains the four payload schemas;
      chapter 05 subscribed list and counts updated.
- [ ] CL018 Two-way calendar settings (D3a): extend the `calendar` group in
      `settings-sync.ts` with `showNotesOnCalendar` and per-provider groups;
      desktop reads / writes them through settings sync instead of the
      device-local store (seed from local value when the synced one is
      absent); core parses, merges per key and exposes them. Tests: old-schema
      upload does not clobber new keys; seed-once; per-key conflict.
      Evidence also: change each setting on desktop → visible on iOS, and the
      reverse.
- [ ] CL019 Protocol chapter 13 settings section updated for D3a.
- [ ] CL017 Phase commit (after CL018–CL019).

## Phase 2: primitives and shell

- [ ] CL020 `Tokens.Calendar`: 6 type hues (rail, surface, meta ink) light +
      dark, dashed date-reminder style, 11 event colors, now-line, today
      fill; AA contrast checked.
- [ ] CL021 Primitives: item chip (inline + block layout, rail, checkbox for
      tasks, ended / triggered fade, selected state, custom color), week
      strip day cell (dot row, today fill), all-day strip, time gutter +
      hour grid, now-line, overlap-lane layout (port of `overlap-layout.ts`,
      unit-tested), span-bar layout per week row (unit-tested).
- [ ] CL022 Entry point: More › Calendar row, More tab selected state,
      deep-link route `memry://calendar?date=&event=`.
- [ ] CL023 Calendar screen shell: large month title + `toolbarTitleMenu`
      (02), glass capsule (search, filter), floating "+", view state
      persisted per device (view, anchor date, filters, timeline settings),
      paging model, loading and error states (`ErrorMapping`).
      Evidence: CL02-title-menu.png.

## Phase 3: views

- [ ] CL030 **01 Day**: week strip paging in step with the day pager, dots,
      all-day strip, grid scrolled to now on today, chips per CL021, pull to
      refresh. Evidence: CL01-day.png.
- [ ] CL031 **03 Week**: 7 columns, span row, today column tint, swipe by
      week, `weekStartDay`. Evidence: CL03-week.png.
- [ ] CL032 **04 Month**: grid, dots, multi-day bars, "N more", tap day →
      list below, double tap → Day, long press + drag → CL040 all-day.
      Evidence: CL04-month.png.
- [ ] CL033 **05 Year** + **06 day peek**: tap day → medium sheet, row →
      item sheet, Open day → Day, tap month name → Month.
      Evidence: CL05-year.png, CL06-peek.png.
- [ ] CL034 **07 Timeline**: zoom segmented, pinned title column, grouped
      rows, bars / due diamonds / overdue / undated hint, today line, hold +
      drag bar and ends, tap undated day to date it, Undo.
      Evidence: CL07-timeline.png.
- [ ] CL035 **08 Display** and **09 bar actions**: every action of
      `timeline-action-panel` (open, open in Tasks, set start, set due, week
      earlier / later, clear dates, complete / uncomplete, change project).
      Evidence: CL08-display.png, CL09-actions.png.
- [ ] CL036 **10 Filter sheet**: sources switches, 7 type chips, per-provider
      calendar list, tick a not-syncing calendar subscribes it (CL013),
      refresh, Manage accounts → 27. Evidence: CL10-filter.png.
- [ ] CL037 **11 Search**: results grouped, tap → Day on date + item sheet.
      Evidence: CL11-search.png.
- [ ] CL038 Phase commit.

## Phase 4: create and edit

- [ ] CL040 **12 Quick create**: long press + drag on Day / Week grid with
      15-min snap, handles, haptic per snap; Month range → all-day; composer
      above keyboard (title, time chip, calendar chip, More… → 13); save
      error keeps composer. Evidence: CL12-quick-create.png.
- [ ] CL041 **13 New event sheet**: title, all-day toggle (desktop date
      conversion), starts / ends with duration, calendar picker grouped by
      provider with default, project, color (default + 11), notes / URL;
      project link after create, link failure keeps event + toast.
      Evidence: CL13-new-event.png.
- [ ] CL042 **14 Event sheet**: edit + pills + "+", … menu, Join, read-only
      attendees / reminders / visibility. Evidence: CL14-event.png.
- [ ] CL043 **15 Event menu** + **22 Delete** + **23 Add to project**:
      memrynote events only; Google-bound wording. Evidence: CL15-menu.png,
      CL22-delete.png, CL23-project.png.
- [ ] CL044 **16 Move / resize**: hold + drag, edge handles, snap label,
      events and timed tasks only, Undo toast restores both.
      Evidence: CL16-move.png.
- [ ] CL045 **18 Promote**: routing (ask / skip rule with AI access), writes
      per CL013, opens 14 on the linked copy. Evidence: CL18-promote.png.
- [ ] CL046 Phase commit.

## Phase 5: other items and cross-feature

- [ ] CL050 **17 Task sheet**: status toggle + Undo, breadcrumb, pills,
      description, subtasks toggle, Move row (Later / Tomorrow / Next week
      from `snooze-options`), … (Source note, Pick date & time → Tasks When
      sheet, Remove due date), Open task → Tasks detail; chip checkbox
      completes in place. Evidence: CL17-task.png.
- [ ] CL051 **19 Read-only sheet**: subscribed, read-only CalDAV and This
      iPhone events; recurrence text (`describeRecurrence`), alerts,
      conference + phone PIN, location, attendees (6, show more), links in
      text, details-load error line. Evidence: CL19-readonly.png.
- [ ] CL052 **20 Note sheet**: note vs date reminder, Open note at anchor.
      Evidence: CL20-note.png.
- [ ] CL053 **21 Snooze sheet**: Open in Inbox (focused), Unsnooze,
      Reschedule via Inbox snooze menu. Evidence: CL21-snooze.png.
- [ ] CL054 Deep links: Agent Chat style `date + event` opens Day + sheet;
      project hub "Calendar event" row opens the event.
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

_empty_

## 6. Decisions log (agent-made choices during the run)

_empty_

## 7. Blockers

_empty_

## 8. Final report

### What shipped

### Provider parity (Google, CalDAV, ICS, This iPhone)

### Evidence index

### Left open
