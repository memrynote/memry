# Tasks: iOS journal parity

**Goal**: every journal feature desktop ships today works on iOS with the same
data semantics, synced both ways, drawn as the Paper page "Journal iOS"
(file `01M39KJ8S9S5QYX38B2HP3Q1BF`, page `p-2-0`), verified on a running
simulator. Brief: `specs/005-ios-journal-parity/goal.md`.

**Reference implementation**: desktop. When this file and desktop disagree on a
behavior, desktop wins unless a decision in §1 says otherwise. Paper decides
layout and placement; artboard **00 · Journal feature audit** is the parity
checklist.

**Format**: `[ID] [P?] Description`. `[P]` = can run in parallel with its `[P]`
siblings in the same block. No `[P]` = serial. A task added later takes a
suffix letter (`JP021a`) so no id ever moves. **Gates are serial**: a phase
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
  `DESIGN.md`, `PRODUCT.md` apply. Read them once at JP002.

### 0.2 Authorizations (Kaan confirms these by starting the run)

The same grants spec 004 §0.2 had. The prompt that starts this run is Kaan's
explicit confirmation, which the root `AGENTS.md` "User Override" rule asks for.

- **Delegation**: pstack subagents for every `[P]` block, with the role table
  in the session prompt. Subagents get task ids and file ownership. They never
  run the simulator, never run `build-xcframework.sh`, and never edit `api/`
  UniFFI files or the generated Swift. The orchestrator does those and
  integrates.
- **Commits**: at the end of each phase on `feat/ios-journal-parity`, explicit
  paths only, format `feat(ios): ...` / `feat(desktop): ...` / `chore(...)`.
  **No push, no PR.**
- **Spec override**: `specs/002-native-foundation-ios/spec.md` FR-054's
  "created if absent" is superseded by D2. JP004 records it.
- **Dev-only CLI**: new `journal` subcommands in `crates/memry-cli` (JP029).

### 0.3 Workspace

- Work in your own worktree, opened from `main`:
  `git fetch origin && git worktree add .worktrees/ios-journal-parity -b feat/ios-journal-parity main`.
  Never work in the main checkout: other sessions use it. The worktree's
  `specs/005-ios-journal-parity/tasks.md` is the only state file. Copy the
  untracked env/config files the iOS and desktop builds need from the main
  checkout (`git status --ignored` there), never the other way round.
- Fresh worktree: `pnpm install` (native warm runs detached, `pnpm warm:log`),
  then `crates/memry-core/build-xcframework.sh --release`.
- Build, install, launch and logs through `xcodebuildmcp` (skill
  `xcodebuildmcp-cli`). Taps, typing and screenshots through the
  `AgentDriverUITests` file-command harness (spec 004 §6 TP001; AXe taps are
  unreliable on this Xcode). Both run on the simulator in §0.3.1 only.

### 0.3.1 Dedicated simulator (this session only)

Other sessions test iOS on the same Mac at the same time, each on its own
simulator. This run owns **memry-B** and nothing else:

- Name `memry-B`, UDID `87D1093B-2676-4B04-9FCF-3479FF10859D`, iPhone 16,
  iOS 26.5. It already exists (created once with
  `xcrun simctl create "memry-B" "iPhone 16"`). At JP001 confirm it with
  `xcrun simctl list devices | grep memry`. If it is missing, create it with
  that command and write the new UDID here and in §0.6 before anything else.
- Every build, install, launch and test command targets it by UDID:
  `-destination 'platform=iOS Simulator,id=87D1093B-2676-4B04-9FCF-3479FF10859D'`.
  Never target by name and never use `booted`, including in `simctl`
  (`xcrun simctl boot|install|launch|io|ui 87D1093B-2676-4B04-9FCF-3479FF10859D …`).
- DerivedData: always `-derivedDataPath /tmp/memry-dd-B`.
- XcodeBuildMCP: pass `simulatorId: 87D1093B-2676-4B04-9FCF-3479FF10859D`
  (and the same DerivedData path where the tool takes one).
- Do not boot, shut down, erase or delete any other simulator (`memry-A`,
  `Memry-verify`, `iPhone 17` and the rest belong to other sessions).
  `xcrun simctl shutdown all` and `xcrun simctl erase all` are forbidden.
  Never erase or reset `memry-B` either: its keychain holds the session.
- `memry-B` starts signed out. The first launch at JP001 goes through §0.4.
  The Unit plan's sign-out tests wipe the app's keychain
  (`apps/ios/AGENTS.md`), so any step that needs a signed-in app (UI plan,
  simulator checks) runs after a fresh §0.4 sign-in, never straight after a
  Unit run.
- Debug builds talk to **staging** only. The desktop peer is
  `MEMRY_ENV=staging MEMRY_DEVICE=iosjournal electron-vite dev --mode=staging --remoteDebuggingPort 9222`
  from `apps/desktop`, driven over CDP (spec 004 §6 TP082). A fresh
  `MEMRY_DEVICE` name avoids the keychain prompt `dev` hits.

### 0.4 Sign-in recovery

Staging test account. Kaan revokes it after the run, so no secrecy handling
is needed.

- Email: `kaan94karaca@gmail.com`
- Recovery phrase: `reject youth sing exist joy mobile economy chalk boil girl tag attack round lunar dove alley bright bonus there dumb rent erode force yard`
- OTP sender: `noreply@memrynote.com`

1. Enter the email and request the code. Note the request time (UTC).
2. Poll `gmail-bridge` search for
   `from:noreply@memrynote.com newer_than:1h`, take the newest message dated
   after the request time, read it, and extract the 6-digit code. Poll every
   10 s and give up after 3 min.
3. Enter the code. If the unlock screen appears, enter the recovery phrase.
4. Rate limit: **at most 3 code requests per 10 min per address**. Never
   request a new code while an older one is still unused and unexpired.
   Hitting the limit is a §7 blocker, not a retry loop.

The desktop peer (§0.3) and `memry-cli` (JP029) sign in to the same account
the same way.

### 0.5 Test data

A journal day cannot carry a marker in its title: the date is the identity.

- The agent writes journal days in **year 2099 only** ("agent days"). Before the
  first write to an agent day, read it and confirm it has no entry. Never
  write to, tag, remind on or delete a day outside 2099.
- "Today" for simulator runs is pinned with the debug-only override
  `MEMRY_JOURNAL_TODAY=2099-06-15` (JP030). The real today is only read, never
  written.
- Templates the agent creates are named `Agent Test …`. Journal settings the
  agent changes are written back to their previous values in the same task and
  the before/after values go in §6.
- Tasks created for the Day section follow spec 004 §0.5 (`[agent] ` prefix,
  due on an agent day).
- JP095 deletes every agent day (desktop `journal:deleteEntry` over CDP; the
  phone has no delete, D7), every agent reminder, template and task.

### 0.6 Verification commands

```bash
# Rust core (run from crates/, as rust-ci.yml does)
cargo fmt --all --check
cargo clippy -p memry-core --all-targets -- -D warnings
cargo test -p memry-core
node scripts/check-line-ceilings.mjs        # rs ≤600, Features swift ≤400
crates/memry-core/build-xcframework.sh --release
git diff --exit-code packages/swift/MemryCore/Sources/MemryCore/Generated/   # after committing the regen

# Vectors
pnpm --filter @memry/contracts vectors:generate
pnpm --filter @memry/contracts vectors:check

# Desktop / packages (only when touched)
pnpm lint && pnpm typecheck
pnpm --filter @memry/desktop test:renderer
pnpm --filter @memry/desktop test:main
pnpm --filter @memry/desktop i18n:check
pnpm check:architecture && pnpm check:contracts
git diff --check

# iOS: always name a test plan (spec 005-redesign §6 RD00a), always memry-B (§0.3.1)
xcodebuild test -project apps/ios/Memry.xcodeproj -scheme Memry \
  -testPlan Unit \
  -destination 'platform=iOS Simulator,id=87D1093B-2676-4B04-9FCF-3479FF10859D' \
  -derivedDataPath /tmp/memry-dd-B
# same with -testPlan Conformance, -testPlan UI
```

---

## 1. Decisions (fixed; the agent does not revisit them)

- **D1 Design and reference.** Paper page "Journal iOS" artboards 00, 01 and
  J01–J13 define layout. Desktop defines behavior. Where J-artboard copy and
  desktop `packages/i18n/src/locales/en/journal.json` / `settings.json`
  differ, desktop's wording wins (log it).
- **D2 When an entry is created (desktop's rule).** No template for the date:
  opening a day writes nothing. The entry is created by the first body edit,
  tag or property write (`use-journal-entry.ts`: `updateEntry` creates a
  missing entry). A template resolves for the date: opening the empty day
  seeds it from the template (`use-journal-entry.ts:221-238`). Browsing days
  never creates entries, so the heatmap, streak and sync stay clean.
  `open_day` runs on the first write, never on navigation. FR-054's "created
  if absent" is superseded (JP004).
- **D3 "Today" is the device's local calendar date**, supplied by the shell.
  The core never derives a day from an instant (`domain/journal.rs` module
  doc). The streak counts from local today. Desktop counts from UTC today
  (`journal-queries.ts:178`), which files a late-evening entry under the wrong
  day in half the world. Desktop keeps its behavior, the vectors pin the pure
  walk with an explicit `today`, and the desktop bug is logged in §8 Left open.
- **D4 Shared rules live in the Rust core, pinned by vectors** generated from
  desktop TypeScript (new class `journal.json`): preview extraction, word
  count, activity level, streak walk, month and year aggregation, template
  resolution per weekday, template token substitution. Locale formatting
  (`{{date}}` without a pattern, `{{time}}`, `{{day-of-week}}`) stays in each
  shell (desktop `Intl`, iOS `Foundation`). The core receives the formatted
  strings and does the substitution.
- **D5 Wire compatibility.** A journal payload written by the phone has
  exactly desktop's shape (`JournalSyncPayloadSchema`,
  `packages/contracts/src/sync-payloads.ts:279`): `date`, `content`, `tags`,
  `properties` (top-level map, the `date` property reserved), `clock`,
  `createdAt`, `modifiedAt`. `content` carries markdown on create only and
  `null` on update, as desktop's `buildPushPayload` does
  (`journal-handler.ts:221`). Unknown payload keys are preserved. An existing
  record's id always beats `j<date>`. A tombstoned day is revived under its
  own id (`domain/journal.rs` `open_day`). Desktop's handler writes
  `data.content ?? ''` into the vault file on every upsert
  (`journal-handler.ts:68,112`). Gate G0 (JP029) must prove that a phone
  record write does not cost a desktop user body text. If G0 fails for any
  shipped desktop build, the phone does not write journal tags or properties
  (the rows render read-only, with a clear limitation) and §7 gets a blocker
  for Kaan. Body editing is unaffected, because it travels as CRDT updates.
- **D6 Counts come from the extracted body text** (`note_bodies.text`), because
  the core renders no markdown. Desktop counts the markdown file body. An
  activity level near a threshold can therefore differ by a step between
  platforms. Accepted and logged. Thresholds and the averaging rule are
  desktop's and are pinned by vectors.
- **D7 Out of scope on iOS**: bookmarks (the record type is not subscribed,
  `NotePageShell.swift:177`), version history (desktop-local snapshots), full
  width, journal folder and filename format (vault file layout), Home
  widget, Apple Journal import, graph, AI connections, deleting an entry
  (desktop has no UI that calls it), outline panel (the iOS note page has none
  either), calendar events in the Day section (no calendar on iOS yet), and
  `DefaultTemplateIndicator` (desktop never renders it). Record anything else
  found desktop-only in §6.
- **D8 Reminders.** `targetType: 'journal'`, `targetId` = the date string,
  never the record id. One reminder per day, as desktop's
  `useSetOrReplaceReminder`: setting a time while one is active moves it.
  Several active reminders written elsewhere are all listed, each can be
  edited, snoozed, dismissed or deleted, and a new time moves the next one.
  Presets are desktop's `journalPresets` (in 1 week, 1 month, 3 months,
  1 year, each at 09:00). Notification title "Journal reminder", body
  "Revisit <long local date>". Entry text never goes in a notification. A tap
  opens the Journal tab on that day.
- **D9 Settings.** `journal.defaultTemplate` and `journal.weekdayTemplates.<0-6>`
  sync through the core settings merge with per-field clocks
  (`settings-sync.ts:75-88`). Clearing a weekday writes an explicit `null`. Keys outside
  `"0".."6"` are ignored and preserved. `showStatsFooter` is **not** in the
  synced schema, so the phone keeps it device-local, per vault (desktop keeps
  it local too). `showSchedule`, `showTasks` and `showAIConnections` are not
  surfaced and are preserved untouched.
- **D10 Template seeding applies properties** as desktop's
  `applyJournalTemplate` does (each template property's `name` → `value`),
  plus content and tags. This is journal-only. Note templates keep the gap
  `templates.rs` records.
- **D11 One tab, one stack.** The Journal tab replaces its `ComingSoonTab` and
  owns a `NavigationStack` (Year › Month › Day). The selected date and level
  survive relaunch (`SceneStorage`). Other surfaces open a day through one
  route, `JournalRoute(date)`.

---

## Phase 0: setup and facts (serial)

- [ ] JP001 Create the worktree and branch from `main` (§0.3). Install, build
      the xcframework, confirm `memry-B` (§0.3.1), then build, install and
      launch the app on it with `/tmp/memry-dd-B` and reach the vault through
      the §0.4 sign-in (`memry-B` starts signed out). Record the baseline: `cargo test -p memry-core` counts, the
      Unit/Conformance/UI plan counts, `vectors:check` class count.
- [ ] JP002 Read everything in goal.md "Read first", plus
      `docs/protocol/` chapters 10 (§10.6.1 body window), 12 (§12.1–12.2 seed
      carve-out) and 13 (§13.7.2 journal, §13.7.12 reminder),
      `specs/002-native-foundation-ios/spec.md` FR-053–FR-055, and
      `apps/ios/Memry/Features/Notes/*` + `Editor/*` headers.
- [ ] JP003 Verify each fact below and write it to §5 with the file:line that
      proves it. Update §5's pre-filled facts if they are wrong.
  - a. **Body safety on desktop.** What desktop does to the vault file
    and to the open Y.Doc when a journal record update arrives with
    `content: null` or stale `content` (`journal-handler.ts:60-100`), and how
    its own `content: null` updates avoid emptying the file today. Name the
    mechanism (CRDT write-back, watcher, guard) with file:line.
  - b. Whether a journal created by another client with `content: ""` plus
    CRDT updates materialises with its body on desktop.
  - c. **Seeding from markdown.** Whether the native iOS editor can edit a
    body that exists only as `seed_markdown` (a note made from a template on
    the phone, N803): what the phone shows, and whether any markdown → Y.Doc
    path exists outside the desktop editor. This decides JP022a.
  - d. What `body_write::edit_block` needs for a journal id: the liveness
    check (`reads::note_exists`, `body_write.rs:48`), the change key
    (`Change::crdt_update(ITEM_TYPE="note", …)`, `:75`), and how the pull and
    push paths key journal bodies.
  - e. Desktop's journal reminder payload (`targetType`, `targetId`, `title`,
    `note`) and `useSetOrReplaceReminder` semantics.
  - f. Desktop's `characterCount` source for the heatmap, month and year
    stats, and the exact activity thresholds (`ACTIVITY_THRESHOLDS`).
  - g. How desktop resolves wiki links to a journal day and journal backlink
    ids (`wikilink-resolver.ts`, `open-related-vault-item.ts`,
    `dateFromJournalId`), and what the phone's `Search.backlinks` returns for
    a journal id.
  - h. Which journal bodies the first sync pulls (chapter 10 §10.6.1 window)
    and how the phone reads a day whose body is not pulled.
  - i. Whether `crates/memry-cli` can sign in, pull and push against staging
    today (for JP029).
- [ ] JP004 Add an entry to `specs/002-native-foundation-ios/spec-defects.md`:
      FR-054 "created if absent" is superseded by D2, with the reason.

**Commit** Phase 0 docs only.

---

## Phase 1: shared journal rules, pinned by vectors

Desktop change first, so the vectors come from real code.

- [ ] JP010 Move the pure logic into `packages/domain-notes/src/journal/` (no
      React, no i18n, no `Date.now()`; every clock-dependent function takes
      `today` or `now`): `extractPreview` (`main/vault/journal.ts`), the streak
      walk over a set of dates (`journal-queries.ts` `getJournalStreak`; the SQL
      stays, desktop passes its UTC today so behavior is unchanged), month
      stats and the year aggregation (`lib/journal-utils.ts` `getMonthStats`,
      the `averageLevel` rule in `getJournalYearStats`), `resolveJournalTemplateId`
      and `orderedWeekdays` (`lib/journal-template-resolution.ts`), and the
      token substitution of `applyJournalTemplate` (`use-journal-entry.ts`)
      with the locale-formatted strings passed in. `countWords` and
      `calculateActivityLevel` stay in `@memry/contracts` and are vectored as
      they are. Desktop imports from the package. Existing desktop tests pass
      unchanged.
- [ ] JP011 Vector generator `packages/contracts/scripts/vectors/journal.ts` →
      `test-vectors/journal.json`, registered in `gen-protocol-vectors` and
      `package.json` exports. Case families:
  - preview: headings, links, wiki links (every `wiki-target` form), images,
    emphasis, whitespace collapse, the 70 % word-boundary truncation rule,
    non-ASCII text, exact-length inputs
  - words and activity level: 0, 1, 100, 101, 500, 501, 1000, 1001, UTF-16
    lengths
  - streak: today present, only yesterday, a gap, the longest run across a
    year end, Feb 29, empty set; explicit `today`
  - month and year: days in month, future flags relative to `today`, entry
    count, total characters, `averageLevel`
  - template resolution: weekday override, explicit `null` falls back,
    missing key, keys outside `"0".."6"` ignored, no default
  - template substitution: `{{title}}`, `{{date}}`, `{{date:YYYY-MM-DD}}`,
    `{{date:DD.MM.YYYY}}`, `{{time}}`, `{{day-of-week}}`, repeats, no tokens,
    tags copied, properties `name → value` with a repeated name
- [ ] JP012 [P] Rust `crates/memry-core/src/domain/journal_rules/`
      (`preview.rs`, `stats.rs`, `streak.rs`, `templates.rs`), consumed by
      `tests/journal_vectors.rs`.

**Gate G1**: `vectors:check` green, `cargo test -p memry-core` green, desktop
`test:renderer` and `test:main` green, `pnpm lint && pnpm typecheck` green.
**Commit** Phase 1.

---

## Phase 2: core write and read surface (Rust)

JP020–JP026 are separate modules and run in parallel. JP027 is serial after
all of them: it owns the UniFFI surface and the generated Swift.

- [ ] JP020 [P] **Body writes.** A block edit addressed by date:
      `edit_day(date, edit)` resolves the id through `entry_for` (the existing
      id wins, D5), runs `open_day` when the day has no live entry (D2, revive
      included), and applies the edit to the journal's document. The change is
      keyed as a journal body per JP003d. A failed edit must not leave a new
      empty entry behind (create and first update commit together, or the
      create is rolled back). Journal ids pass the liveness check. Tests:
      first edit creates `j<date>`, a tombstoned day revives under its id, a
      day desktop created under a non-`j` id is edited under that id, an edit
      that fails creates nothing, a no-op edit writes nothing.
- [ ] JP021 [P] **Metadata writes** for a day: set tags, set and clear a
      property (typed as notes are, the `date` property reserved and refused),
      each creating the day first when absent (D2). The payload follows D5:
      `content: null` on update, unknown keys kept, field clocks as notes use.
      Tests: payload shape against `JournalSyncPayloadSchema` fields, an older
      desktop payload with no `properties` or `tags`, a newer payload with
      unknown keys that survive the next local edit.
- [ ] JP022 [P] **Template seeding.** `open_day_from_template(date,
template_id, formatted)` where `formatted` carries the shell's
      locale strings (D4): create (or revive) the day with the substituted
      markdown as create-time `content` and `seed_markdown` (§12.2 carve-out
      A), the template's tags, and its properties (D10). A template missing on
      this device returns a typed "not here yet" so the shell retries later,
      as desktop does. Tests over real template payloads.
  - [ ] JP022a Conditional on JP003c. If the native iOS editor cannot edit a
        body that exists only as `seed_markdown`, a seeded day would be
        unwritable on the phone that seeded it. In that case, add a
        markdown → BlockNote Y.Doc seed in the core for the block types
        templates use, pinned by a vector class generated from desktop's real
        converter (`sync/blocknote-converter.ts`), and seed the document in
        the create transaction. Otherwise record in §6 why the existing path
        suffices.
- [ ] JP023 [P] **Reads**: `day(date)` (id or none, tags, properties without
      `date`, created/modified, word and character counts from the extracted
      text (D6), body state: present / not pulled / empty); `month(year,
month, today)` (every day: level, preview, has entry, is future,
      is today); `year(year, today)` (12 month stats, totals); `heatmap(year)`;
      `streak(today)` (current, longest, last entry date); `days_with_entries(from,
to)`. Tombstoned days never count. Tests, including a day whose body is
      not pulled.
- [ ] JP024 [P] **Journal reminders**: create for a date (D8 payload per
      JP003e), set-or-replace (moves the active one), list for a date sorted
      by time. Edit, snooze, dismiss and delete reuse the id-based paths.
      Journal reminders appear in `due_window` with the date as target. Tests.
- [ ] JP025 [P] **Journal settings**: read `defaultTemplate` and the weekday map
      (defaults, keys outside `"0".."6"` ignored); write the default and one
      weekday (explicit `null` clears) through the settings merge with
      per-field clocks; unknown `journal.*` keys preserved. Tests with a
      concurrent edit of two different weekdays.
- [ ] JP026 [P] **Links and search**: backlinks and outgoing links for a
      journal id, a journal backlink carrying its date, wiki-link resolution
      to a day per JP003g, and journal search hits (exist,
      `api/search.rs:32-60`) carrying the date. Tests.
- [ ] JP027 UniFFI surface `crates/memry-core/src/api/journal.rs` (+
      `journal_records.rs` to stay under 600 lines): `Vault::journal(store)`
      returning a `Journal` object with everything in JP020–JP026, records for
      day, month, year, heatmap entry, streak, reminder, settings. Errors
      through `api/errors.rs` with messages `ErrorMapping.swift` can map. Build
      the xcframework and commit the regenerated Swift. It must be additive:
      check that no existing binding line is lost.
- [ ] JP028 `tests/api_journal.rs`: end to end through the API layer: open,
      edit, tag, seed from a template, remind, read month, year and streak,
      plus inbound payloads from an older desktop (missing fields) and a newer
      one (unknown fields preserved on the next local edit).
- [ ] JP029 **Gate G0, the compat probe.** Add dev-only `journal` subcommands
      to `crates/memry-cli` (`journal append <date> <text>`,
      `journal tags <date> <a,b>`, `journal property <date> <name> <json>`),
      then run these
      against the desktop peer on staging, same account, agent days only:
  1. desktop writes a body on day A. The CLI sets tags on A. Desktop keeps
     the body byte for byte and shows the tags.
  2. The CLI appends a paragraph to day B (created by the CLI), then sets a
     property on B. Desktop shows the CLI paragraph and the property. The
     file holds both.
  3. Desktop has day C open in the editor while the CLI tags it. The open
     editor keeps its text and cursor.
  4. Repeat scenario 1 against the last released desktop build if it can
     run against staging. Otherwise record that as a limit in §6.

  Evidence: file contents before and after, and desktop screenshots in
  `apps/ios/SpikeEvidence/journal-parity/G0-*`. If any scenario loses text,
  follow D5: fix the current desktop handler (JP029a, with a
  `journal-handler.test.ts` case), keep phone tag and property writes off for
  the builds that lose text, and write the §7 blocker.

**Gate G2**: `cargo test -p memry-core` and clippy green, `vectors:check`
green, xcframework builds, iOS app still builds and the Unit plan is green, G0
recorded.
**Commit** Phase 2.

---

## Phase 3: iOS foundations (serial)

- [ ] JP030 `apps/ios/Memry/Features/Journal/`: `JournalStore` (`@Observable`)
      over the `Journal` API. Refresh on core sync events. Every write calls
      `requestVaultSync`. Errors go through `ErrorMapping.swift` (new cases as
      needed), logging through `Core/Log.swift`. `JournalClock` gives the local
      today (D3) and follows day rollover and time-zone changes. In debug builds
      it honors `MEMRY_JOURNAL_TODAY` (§0.5), and it does nothing in release.
      Unit tests over a scratch vault (`TasksTestVault` pattern).
- [ ] JP031 Replace the Journal `ComingSoonTab` in `VaultTabsView.swift`, and
      add `JournalRoute(date)` plus a `JournalRouter` that selects the tab and
      pushes the day. Wire a journal reminder tap to it:
      `ReminderNotificationsRouting.swift:39-47` currently sends every
      non-task target to Notes.
- [ ] JP032 `JournalCopy.swift` (+ extensions per screen) mirroring the
      desktop strings the screens use: `journal.json` (placeholders, relative
      dates, counts, nav, stats), `settings.json` `journal.*`, and the inbox
      reminder preset labels. Literal copy per the iOS `*Copy.swift` pattern.
- [ ] JP033 Extract the note page parts the day page needs into shared views,
      with no behavior change for notes: the block editor host, the tags and
      properties rows and the ghost row, backlinks and outgoing links, linked
      tasks, review comments, find, and export. Notes Unit tests stay green.
      Take before and after screenshots of one note to show nothing moved.

**Commit** Phase 3.

---

## Phase 4: iOS features

Blocks are `[P]` against each other and each owns its own files under
`Features/Journal/`. A shared file belongs to the first block that lands it.
The orchestrator runs every simulator check. Per block, before ticking: unit
tests for its view model, then a simulator run of its flows with screenshots
saved to `apps/ios/SpikeEvidence/journal-parity/<id>-*.png`, compared side by
side with `paper_get_screenshot` of its artboard: spacing, lanes, type roles,
colors, glass placement, what is shown and what is hidden.

- [ ] JP040 [P] **Day page** (J01, J02, J03, J10). The date header has a
      weekday line (a relative "N days ago" off today), the TODAY badge, and a
      serif date title (`Tokens.Typography` serif role; add a journal title
      token when three call sites share it) with the title-menu chevron. The
      time-of-day tint uses desktop's hour buckets (5–12, 12–18, 18–21,
      night) and colors as `Tokens.Journal` values. It is static, and solid
      or absent under Reduce Transparency. The glass nav groups hold ‹ › and
      bell + …. Then come the tags and properties rows (`date` hidden), the
      ghost row, and the placeholder: today, past or future copy from
      `journal.json`. Then the editor (D2: the first edit creates the day),
      linked tasks, backlinks and outgoing links, and review comments. The
      inline title appears after scroll. A day whose body is not pulled shows
      the note page's not-on-this-phone state, never an empty entry.
      Carries: artboard 00 section C rows (Reuse and New), external updates
      landing in place (same path as notes), autosave and save errors through
      the note editor path.
- [ ] JP041 [P] **Moving between days**: horizontal paging to the adjacent
      day, ‹ › buttons, a "Today" capsule when the page is off today,
      hardware ← / → when no text field is focused, and Esc drilling up to
      Month (desktop keys). Adjacent days prefetch (desktop `PREFETCH_DAYS`
      = 1). A pending edit is never rerouted to another day.
- [ ] JP042 [P] **Title menu and Go to date** (J04): Month, Year, and Go to
      date… (a graphical date picker sheet with the xmark / checkmark chrome
      of spec 005-redesign).
- [ ] JP043 [P] **Month** (J05). Days of the month, newest first, with an
      activity dot (level 1–4, hollow when empty), the day number, the
      weekday, and a preview. Today gets a badge, future days read "Future",
      empty past days read "No entry", and days whose body is not pulled get
      a not-on-this-phone line. The subtitle shows year, entry count and
      streak. ‹ › change the month, a tap opens the day.
- [ ] JP044 [P] **Year** (J06): 3-column grid of months with entry count and
      activity dots, current month highlighted, future months dimmed; totals
      (days with entries, thousands of characters), streak and best; ‹ ›
      years; tap → Month.
- [ ] JP045 [P] **Tags and properties writes** on the day page (J02),
      gated by G0 (D5): add, create with color, remove a tag; add, edit,
      rename, reorder and delete a property; the first write creates the day.
      If G0 failed, the rows are read-only with the limitation copy and this
      task records that.
- [ ] JP046 [P] **Reminders** (J07, J08, J13). The bell menu offers the presets
      with their resolved dates and a custom date and time. The sheet lists the
      active reminders for this day (edit, snooze, dismiss, delete) under
      "Change reminder" (D8). The bell is filled when a reminder is active,
      with a count when there are several. Local notifications go through the
      existing `ReminderScheduler` window. Title and body follow D8. A tap
      opens the day.
- [ ] JP047 [P] **More menu** (J09): Find in page (note find), Export (note
      export, the title from desktop's `export.noteTitle`), Journal settings.
- [ ] JP048 [P] **Settings › Journal** (J11, J12). Reached from the More menu
      and from a Journal row on the More tab (next to the Tasks row). It has
      the default template, a template per weekday in first-day-of-week order
      bound to the absolute weekday (showing "Default · <name>" when a day is
      unset and "Deleted template" when a set template is missing), and the
      stats footer toggle (device-local, D9). No folder or filename settings
      (D7).
- [ ] JP049 [P] **Template seeding** (D2, D10). Opening an empty day whose
      date resolves to a template seeds it once. A template that has not
      arrived yet retries on the next open or sync, not in a loop. A day
      seeded on another device is never seeded twice. The locale strings are
      formatted with Foundation to match desktop's `Intl` output (D4).
- [ ] JP050 [P] **Day section** (J01, J03, J10): tasks due on the day
      from `TasksStore` (status toggle, priority, project meta), the overdue
      count on today opening the Tasks tab, a task tap opening its detail
      through `TasksRouter`. Hidden when there is nothing to show (desktop
      `JournalDayPanel`).
- [ ] JP051 [P] **Stats footer** (J03): words, characters, reading time
      (desktop's 200 wpm, "< 1 min"), modified date, when the setting is on.
- [ ] JP052 [P] **Cross-tab routes.** Every one of these opens the Journal tab
      on the right day: a journal search hit, a journal backlink on a note, a
      wiki link to a day (per JP003g), a journal related item in the task detail
      (`TaskRelatedSection` kind `journal`), and a journal reminder tap.
- [ ] JP057 Accessibility pass over every screen above. VoiceOver: the date
      header reads as one heading. Month rows read "Thursday 24, entry,
      <preview>" and Year cells read "September, 17 days". Custom actions
      cover previous day, next day and today. Also check Dynamic Type at AX5
      (header, Month rows and Year grid wrap or stack), 44pt targets, Reduce
      Motion (paging and fog), Reduce Transparency, forced RTL (‹ › and paging
      mirror), and WCAG AA on the activity dots' text companions. Runs after
      JP040–JP052.
- [ ] JP058 Dark mode: light and dark screenshots of J01, J02, J05, J06,
      J08, J11. Activity colors and fog tints derived for dark and checked.

**Commit** after each block lands.

---

## Phase 5: verification (serial)

- [ ] JP080 Conformance:
      `apps/ios/MemryConformanceTests/JournalConformanceTests.swift` runs
      `journal.json` through the FFI. Conformance plan green.
- [ ] JP081 UI tests `apps/ios/MemryUITests/JournalUITests.swift`, with today
      pinned to an agent day. The flows are: open Journal and land on today;
      type on an empty day and confirm the day now exists (Month shows a dot);
      page to yesterday and back; Month and Year drill down and back; set a
      preset reminder and see the bell filled; a template-seeded day opens with
      the template text; the Settings weekday row reads the resolved default.
      UI plan green.
- [ ] JP082 Cross-device against staging with the desktop peer, agent days only:
  - phone → desktop: create by typing, body edits, tags, properties,
    template seeding, reminder set, moved and dismissed, settings
    default and weekday template
  - desktop → phone: the same list in reverse, plus an edit landing in an
    open day page without losing the cursor
  - concurrent: the same day edited on both while offline, then online; both
    body edits survive (CRDT) and both metadata fields survive (field clocks)
  - a day desktop created under a non-`j` id is edited on the phone under that
    id
  - screenshots from both sides in `SpikeEvidence/journal-parity/xdevice-*`
- [ ] JP083 Full gates: §0.6 in full. Record counts against the JP001 baseline.
- [ ] JP084 Desktop regression: `pnpm --filter @memry/desktop test:desktop`
      green, then `electron-vite build` and `pnpm --filter @memry/desktop
test:e2e` for the journal specs.

---

## Phase 6: wrap-up (serial)

- [ ] JP090 `pnpm docs:impact --base <branch base> --strict`; add
      `apps/docs/src/user-guide/journal/on-iphone.md` (and sidebar entry) and
      update what it reports; `pnpm docs:build`.
- [ ] JP091 `apps/ios/AGENTS.md` rules that came out of this work;
      `specs/002-native-foundation-ios/compliance.md` for FR-053–FR-055.
- [ ] JP092 Review pass by review subagents over the full branch diff (Rust
      core, iOS Swift, TypeScript), checking: compat (D5), no `!`/`try!`
      outside tests, no raw error strings, logical layout, no entry text in
      notifications. Fix what they find.
- [ ] JP093 Parity audit: one row per artboard 00 row marked Reuse, New or
      Core, each with its new location and simulator evidence (table below).
- [ ] JP094 Final report in §8: what shipped, evidence index, what is left in
      §7.
- [ ] JP095 Clean-up (§0.5): delete every agent day through desktop IPC, every
      agent reminder, `Agent Test …` template and `[agent] ` task; confirm on
      desktop and on the phone that none remain; journal settings match their
      recorded pre-run values.

### JP093 audit table

| 00 row | iOS location | Evidence |
| ------ | ------------ | -------- |

---

## 5. Verified facts

Pre-filled from the planning read (2026-09-25). JP003 re-checks each one and
adds a–i.

- **Journal payload** (`packages/contracts/src/sync-payloads.ts:279-294`):
  `date?`, `content?: string|null`, `tags?`, `properties?: record|null`,
  `clock?`, `createdAt?`, `modifiedAt?`. `date` is optional only for
  tombstones.
- **Desktop push** sends `content` on create only, `null` on update
  (`apps/desktop/src/main/sync/item-handlers/journal-handler.ts:221`).
  **Desktop apply** writes `data.content ?? ''` to the vault file on both the
  update and the create path (`:68`, `:112`). JP003a says why that does not
  empty files today.
- **Core journal domain** (`crates/memry-core/src/domain/journal.rs`):
  `open_day` creates `j<date>` or revives a tombstone (`:88`). The create
  payload carries `content: ""` (`:141`) and seeds an empty body row. The date
  is `NOT NULL UNIQUE` in `journal_entries`
  (`storage/migrations/data/0002_projections.sql:72-81`, columns id, date,
  properties, created/modified, clock, synced/deleted). Nothing is exported
  over UniFFI.
- **Body writes are note-only**: `body_write::edit_block` returns false unless
  `reads::note_exists` (`domain/body_write.rs:48`) and keys the change as
  `note` (`:75`). `notes::set_tags` / properties write `ITEM_TYPE = "note"`
  (`domain/notes/mod.rs:57`, `metadata.rs:100-131`).
- **Seeding**: `seed_body` stores template markdown in
  `note_bodies.seed_markdown` "until the editor has seeded the document"
  (`domain/notes/mod.rs:405-433`). The core parses no markdown
  (`domain/templates.rs:1-23`). Template properties are not applied to notes
  (`templates.rs:17-23`).
- **Reminders**: one `reminder` type for every target
  (`domain/reminders/mod.rs:1-20`). Creation exists for a note (`create`,
  `:66`) and a task (`create_for_task`, `:112`). `due_window` returns every
  target type (`queries.rs:115`). Desktop keeps one reminder per journal
  day or note (`use-set-or-replace-reminder.ts:1-30`). Journal presets are
  1 week, 1 month, 3 months, 12 months, at 09:00
  (`components/reminder/reminder-presets.ts:191-230`).
- **Settings**: synced `journal` group = `defaultTemplate`,
  `weekdayTemplates` keyed `"0".."6"` with per-key clocks
  (`packages/contracts/src/settings-sync.ts:75-88`). `showStatsFooter`,
  `showSchedule`, `showTasks`, `showAIConnections` are not in it. Desktop's
  settings page surfaces only the templates and the stats footer
  (`pages/settings/journal-section.tsx`, comment above the footer group).
- **Template seeding on desktop**: on an empty day, resolve the template id for
  the date's weekday, fetch it (a miss retries on the next run), substitute the
  tokens, and create with content, tags and properties
  (`hooks/use-journal-entry.ts:221-238`, `lib/journal-template-resolution.ts`).
- **Stats**: heatmap and year stats come from `noteCache.characterCount`, with
  the level from `calculateActivityLevel` (0, ≤100, ≤500, ≤1000, more;
  `packages/contracts/src/journal-api.ts:319-325`). `averageLevel` is SQL `AVG`
  over per-day levels (`journal-queries.ts:124-139`). The streak counts from UTC
  today (`:178`).
- **iOS today**: the Journal tab is `ComingSoonTab`
  (`apps/ios/Memry/Features/Notes/VaultTabsView.swift:48`). A non-task reminder
  tap selects Notes (`Features/Tasks/ReminderNotificationsRouting.swift:39-47`).
  Bookmarks are not subscribed (`Features/Notes/NotePageShell.swift:177`).
  Search hits already carry `journalDate` (`crates/memry-core/src/api/search.rs:32-60`).
- **CLI**: `crates/memry-cli` has login, unlock, pull, push and
  `notes edit <id> --append` (`src/cli.rs` `HELP`). It has no journal commands.

## 6. Decisions log (agent-made choices during the run)

<!-- date — task id — choice — why -->

- 2026-09-25 — planning — Paper J08 originally drew "New reminder" as a second
  reminder. It now reads "Change reminder" with the one-reminder copy, to match
  desktop's set-or-replace rule (D8).

## 7. Blockers

<!-- date — task id — what — evidence — next retry -->

## 8. Final report

<!-- JP094: what shipped, bugs fixed outside the plan, evidence index, left open -->
