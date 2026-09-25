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

- [x] JP001 Create the worktree and branch from `main` (§0.3). Install, build
      the xcframework, confirm `memry-B` (§0.3.1), then build, install and
      launch the app on it with `/tmp/memry-dd-B` and reach the vault through
      the §0.4 sign-in (`memry-B` starts signed out). Record the baseline: `cargo test -p memry-core` counts, the
      Unit/Conformance/UI plan counts, `vectors:check` class count.
      Evidence: worktree `.worktrees/ios-journal-parity` on `feat/ios-journal-parity` @77d23f213 (origin/main); desktop `.env*` copied from the main checkout; `pnpm install` ok; `build-xcframework.sh --release` ok, generated Swift unchanged. `memry-B` 87D1093B-2676-4B04-9FCF-3479FF10859D present. Signed in (OTP + recovery phrase), MemryNote vault open: `apps/ios/SpikeEvidence/journal-parity/JP001-vault-open.png`. Baseline: `cargo test -p memry-core` 920 passed / 0 failed / 1 ignored; Unit 689 tests in 101 suites passed; Conformance 27 tests in 7 suites passed; UI 8 executed, 1 skipped, 0 failures; `vectors:check` passed (16 classes).
- [x] JP002 Read everything in goal.md "Read first", plus
      `docs/protocol/` chapters 10 (§10.6.1 body window), 12 (§12.1–12.2 seed
      carve-out) and 13 (§13.7.2 journal, §13.7.12 reminder),
      `specs/002-native-foundation-ios/spec.md` FR-053–FR-055, and
      `apps/ios/Memry/Features/Notes/*` + `Editor/*` headers.
      Evidence: read goal.md "Read first" list: root/iOS/desktop AGENTS.md, Paper artboards 00 (30F-0) and 01 (38U-0) in full plus JSX of J01-J13 (saved for the run under /tmp/jp-paper); spec 004 §0.6/§6; core `domain/{journal,body_write,notes/*,templates,reminders/mod,properties,tags,reads,note_meta}.rs`, `api/{vault,notes,notes_write,search}.rs`; desktop `sync/item-handlers/journal-handler.ts`, `vault/journal.ts`, `sync/crdt-writeback.ts`, `vault/watcher.ts`, `hooks/use-journal-entry.ts`, `lib/journal-template-resolution.ts`, `journal-queries.ts`, `journal-utils.ts`, reminder hooks/presets; protocol §10.6.1, §12.1-12.2, §13.7.2, §13.7.12; spec 002 FR-053-055; iOS `Features/Notes/*` and `Editor/*` headers. Facts land in §5 (JP003).
- [x] JP003 Verify each fact below and write it to §5 with the file:line that
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
    Evidence: §5 "JP003 re-check" + facts a-i, each with file:line. Outcome that drives the plan: (a) record-only writes leave a peer desktop file body-less until the next CRDT write-back (G0 decides), (c) no markdown→Y.Doc path outside desktop, so JP022a is required, (g) phone backlinks ignore journals.
- [x] JP004 Add an entry to `specs/002-native-foundation-ios/spec-defects.md`:
      FR-054 "created if absent" is superseded by D2, with the reason.
      Evidence: `specs/002-native-foundation-ios/spec-defects.md` entry 142 (FR-054 "created if absent" superseded by D2), footer updated.

**Commit** Phase 0 docs only.

---

## Phase 1: shared journal rules, pinned by vectors

Desktop change first, so the vectors come from real code.

Evidence: `packages/domain-notes/src/journal/{preview,stats,streak,templates,index}.ts` (export `@memry/domain-notes/journal`); desktop now imports it from `vault/journal.ts` (extractPreview), `journal-queries.ts` (streak with its UTC today, year stats), `lib/journal-utils.ts` (getDaysInMonth, getMonthStats), `lib/journal-template-resolution.ts`, `hooks/use-journal-entry.ts` (Intl strings passed in). Existing tests unchanged and green: `test:renderer` 793 files / 10102 passed; `test:main` 642 files / 9170 passed; `pnpm lint` 0 errors; `pnpm typecheck` ok.

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
- [x] JP011 Vector generator `packages/contracts/scripts/vectors/journal.ts` →
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
    Evidence: `packages/contracts/scripts/vectors/{journal,journal-cases,journal-template-cases}.ts` → `test-vectors/journal.json` (sections preview 33, words 13, activity 14, streak 13, monthDays 8, monthActivity 5, yearStats 4, weekday 9, orderedWeekdays 2, templateResolution 11, templateApply 12), registered in `gen-protocol-vectors.ts` and `package.json` exports; `vectors:check passed (17 classes)`; line ceilings passed.
- [x] JP012 [P] Rust `crates/memry-core/src/domain/journal_rules/`
      (`preview.rs`, `stats.rs`, `streak.rs`, `templates.rs`), consumed by
      `tests/journal_vectors.rs`.
      Evidence: `crates/memry-core/src/domain/journal_rules/{mod,preview,stats,streak,templates}.rs` (largest 253 lines, no regex dependency) + `tests/journal_vectors.rs` (every section of `journal.json`: preview 33, words 13, activity 14, streak 13, monthDays 8, monthActivity 5, yearStats 4, weekday 9, orderedWeekdays 2, templateResolution 11, templateApply 12). Orchestrator re-run: `cargo fmt --check` clean, clippy `-D warnings` clean, `cargo test -p memry-core` 945 passed / 0 failed / 1 ignored.

**Gate G1**: `vectors:check` green, `cargo test -p memry-core` green, desktop
`test:renderer` and `test:main` green, `pnpm lint && pnpm typecheck` green.
G1 result (2026-09-25): GREEN. `vectors:check passed (17 classes)`; `cargo test -p memry-core` 945/0/1;
`test:renderer` 10102 passed; `test:main` 9170 passed; `pnpm lint` 0 errors; `pnpm typecheck` ok.
**Commit** Phase 1.

---

## Phase 2: core write and read surface (Rust)

JP020–JP026 are separate modules and run in parallel. JP027 is serial after
all of them: it owns the UniFFI surface and the generated Swift.

Evidence: `domain/journal_ops/body.rs` `edit_day`/`edit_entry`, shared `body_write::{author,append_in}`; `journal::open_day_in` creates/revives inside the edit transaction. `tests/journal_body.rs` 6/6: first edit creates `j<date>` with one upsert + one crdt-update (keyed `journal`), tombstone revives under its id, a desktop non-`j` id is edited under that id, a failing edit writes no row of any kind, a no-op edit writes and creates nothing.

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
- [x] JP021 [P] **Metadata writes** for a day: set tags, set and clear a
      property (typed as notes are, the `date` property reserved and refused),
      each creating the day first when absent (D2). The payload follows D5:
      `content: null` on update, unknown keys kept, field clocks as notes use.
      Tests: payload shape against `JournalSyncPayloadSchema` fields, an older
      desktop payload with no `properties` or `tags`, a newer payload with
      unknown keys that survive the next local edit.
      Evidence: `domain/journal_ops/metadata.rs` set_tags / set_property / clear / remove / rename by date, one transaction with the create; `content: null` on every update, unknown keys kept, `date` reserved (Invalid). `tests/journal_metadata.rs` 8/8 incl. JournalSyncPayloadSchema key/type check, older payload without tags/properties, newer payload with unknown keys surviving two edits. Property reorder is not representable (§6).
- [x] JP022 [P] **Template seeding.** `open_day_from_template(date,
template_id, formatted)` where `formatted` carries the shell's
      locale strings (D4): create (or revive) the day with the substituted
      markdown as create-time `content` and `seed_markdown` (§12.2 carve-out
      A), the template's tags, and its properties (D10). A template missing on
      this device returns a typed "not here yet" so the shell retries later,
      as desktop does. Tests over real template payloads.
      Evidence: `domain/journal_ops/seed.rs` `open_day_from_template` (content + seed_markdown + tags + properties + seeded document in one transaction; `AlreadyExists` for a live day; `NotFound` for a template not here) and `resolve_template_for`. `tests/journal_seed.rs` 7/7 over desktop-shaped template payloads.
  - [x] JP022a Conditional on JP003c. If the native iOS editor cannot edit a
        body that exists only as `seed_markdown`, a seeded day would be
        unwritable on the phone that seeded it. In that case, add a
        markdown → BlockNote Y.Doc seed in the core for the block types
        templates use, pinned by a vector class generated from desktop's real
        converter (`sync/blocknote-converter.ts`), and seed the document in
        the create transaction. Otherwise record in §6 why the existing path
        suffices.
        Evidence: Required (§5 c). `crdt/markdown_seed/*` builds the BlockNote Y.Doc desktop builds; new vector class `markdown-seed.json` (27 cases) generated through the production parse path, proven equal to desktop `markdownToYFragment` by `apps/desktop/src/main/sync/markdown-seed-vectors.test.ts` (27/27); `tests/markdown_seed_vectors.rs` green; `vectors:check passed (18 classes)`. Fallback: unsupported constructs keep their lines as paragraphs (logged in `SeedPlan.fallbacks`).
- [x] JP023 [P] **Reads**: `day(date)` (id or none, tags, properties without
      `date`, created/modified, word and character counts from the extracted
      text (D6), body state: present / not pulled / empty); `month(year,
month, today)` (every day: level, preview, has entry, is future,
      is today); `year(year, today)` (12 month stats, totals); `heatmap(year)`;
      `streak(today)` (current, longest, last entry date); `days_with_entries(from,
to)`. Tombstoned days never count. Tests, including a day whose body is
      not pulled.
      Evidence: `domain/journal_ops/reads.rs` day / month (newest first, level, preview, future/today, body state) / year (12 cards, totals, streak) / heatmap / streak(today) / days_with_entries; counts from extracted text (cached `note_bodies.text` when its source_seq is current, else replayed). `tests/journal_reads.rs` 9/9 incl. a not-pulled day and tombstones excluded.
- [x] JP024 [P] **Journal reminders**: create for a date (D8 payload per
      JP003e), set-or-replace (moves the active one), list for a date sorted
      by time. Edit, snooze, dismiss and delete reuse the id-based paths.
      Journal reminders appear in `due_window` with the date as target. Tests.
      Evidence: `domain/reminders/journal.rs` create_for_journal (targetType journal, targetId = date), set_or_replace_for_journal (moves the earliest active one), for_journal; `due_window` carries journal reminders with the date. `tests/journal_reminders.rs` 6/6.
- [x] JP025 [P] **Journal settings**: read `defaultTemplate` and the weekday map
      (defaults, keys outside `"0".."6"` ignored); write the default and one
      weekday (explicit `null` clears) through the settings merge with
      per-field clocks; unknown `journal.*` keys preserved. Tests with a
      concurrent edit of two different weekdays.
      Evidence: `domain/journal_ops/settings.rs` read default + weekday map, write default / one weekday through the settings merge with per-field clocks, explicit null clears, unknown `journal.*` keys and display flags preserved. `tests/journal_settings.rs` 7/7 incl. two devices editing weekdays 3 and 4 concurrently.
- [x] JP026 [P] **Links and search**: backlinks and outgoing links for a
      journal id, a journal backlink carrying its date, wiki-link resolution
      to a day per JP003g, and journal search hits (exist,
      `api/search.rs:32-60`) carrying the date. Tests.
      Evidence: `domain/journal_ops/links.rs` backlinks / outgoing links for note and journal ids (journal sources carry kind + date), `note_meta::resolve_wiki_target_kind` (note, then day by date, then `j<date>`), link indexer resolves day targets; journal search hits carry the date. `tests/journal_links.rs` 9/9.
- [x] JP027 UniFFI surface `crates/memry-core/src/api/journal.rs` (+
      `journal_records.rs` to stay under 600 lines): `Vault::journal(store)`
      returning a `Journal` object with everything in JP020–JP026, records for
      day, month, year, heatmap entry, streak, reminder, settings. Errors
      through `api/errors.rs` with messages `ErrorMapping.swift` can map. Build
      the xcframework and commit the regenerated Swift. It must be additive:
      check that no existing binding line is lost.
      Evidence: `api/journal.rs` + `api/journal_records.rs`: `Vault::journal(store)` → `Journal` (day, entry_id, month, year, heatmap, streak, days_with_entries, resolve_wiki_target, edit_day with FR-058 task flip, set_tags, set/clear/remove/rename_property, template_for, seed_from_template, settings + setters, reminders + set/update/snooze/dismiss/delete), free functions journal_weekday / journal_preview / journal_word_count; `Search.links_to` / `links_from`; note body reads and `fetch_note_body` accept journal ids (`reads::document_exists`). xcframework built; regenerated Swift is additive (0 lines of the previous file missing, multiset diff).
- [x] JP028 `tests/api_journal.rs`: end to end through the API layer: open,
      edit, tag, seed from a template, remind, read month, year and streak,
      plus inbound payloads from an older desktop (missing fields) and a newer
      one (unknown fields preserved on the next local edit).
      Evidence: `tests/api_journal.rs` 6/6 through the exported surface: read writes nothing, first edit creates and month/year/streak see it; tags + property + reserved date + set-or-replace reminder + dismiss; template seed once, AlreadyExists, NotFound creates nothing; older desktop payload edited under its own id; newer payload unknown key survives; weekday settings round trip.
- [x] JP029 **Gate G0, the compat probe.** Add dev-only `journal` subcommands
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
     Evidence: G0 run 2026-09-25 against the desktop peer (`iosjournal`, current `main` build, staging) with `memry-cli journal …` (same core functions the phone calls), agent days 2099-06-01..07. **Result: FAIL on the unfixed handler.** S1: desktop body on 2099-06-01 (G0-1-before.md), CLI tags → vault file body emptied (G0-1-after-cli-tags.md; desktop editor still showed the text from the Y.Doc, G0-1-desktop-after-cli-tags.png). S2: CLI-created 2099-06-02 + paragraph → file body empty after the create record landed after the CRDT write-back (G0-2-after-append.md), property added, body still missing from the file (G0-2-after-property.md, G0-2-desktop-after-property.png). S3: 2099-06-03 open in the editor, CLI tags → editor kept its text, file body emptied (G0-3-desktop-open-editor.png). S4: the last release (MemryNote.app 2026.919.1, tag v2026-09-19) is a production build and cannot point at staging; its upsert path is byte-identical to the tested one (`git diff v2026-09-19 HEAD -- journal-handler.ts` touches only applyDelete), so it loses text the same way (limit, §6). Per D5: JP029a fixes the current handler (re-run green, see JP029a); phone tag/property writes stay OFF for shipped desktops; §7 blocker for Kaan.

  Evidence: file contents before and after, and desktop screenshots in
  `apps/ios/SpikeEvidence/journal-parity/G0-*`. If any scenario loses text,
  follow D5: fix the current desktop handler (JP029a, with a
  `journal-handler.test.ts` case), keep phone tag and property writes off for
  the builds that lose text, and write the §7 blocker.
  - [x] JP029a Fix the current desktop handler: a remote journal record with
        `content` null or empty keeps the body the vault file already holds.
        Evidence: `apps/desktop/src/main/sync/item-handlers/journal-handler.ts` `writeSyncedJournal`; `journal-handler.test.ts` 3 new cases (tags-only update with null content, late create with "" content, create with no file) + existing 8, 11/11; `test:main` subset (item-handlers, journal, vault/journal) 41 files / 530 passed. Re-run against staging with the fix: G0-fixed-2099-06-04.md (desktop body kept byte for byte, CLI tags added), G0-fixed-2099-06-05.md (CLI paragraph and property both in the file), G0-3-fixed-open-editor.png + G0-3-fixed-2099-06-07.md (open editor kept text, focus and caret offset 38; file kept body).

**Gate G2**: `cargo test -p memry-core` and clippy green, `vectors:check`
green, xcframework builds, iOS app still builds and the Unit plan is green, G0
recorded.
G2 result (2026-09-25): GREEN. `cargo test -p memry-core -p memry-cli` 1056 passed / 0 failed / 1 ignored
(77 binaries); fmt + clippy `-D warnings` clean; line ceilings passed (390 files); `vectors:check passed
(18 classes)`; `build-xcframework.sh --release` ok (generated Swift additive); Unit plan 689 tests in 101
suites passed on memry-B; `pnpm lint` 0 errors, `pnpm typecheck` ok. G0 recorded: FAIL for shipped
desktop builds (JP029), fixed on `main` by JP029a; phone journal tag/property writes gated off (D5, §7).
**Commit** Phase 2.

---

## Phase 3: iOS foundations (serial)

Evidence: `Features/Journal/JournalStore.swift` (reads never write; `perform` re-reads the day/month/year/reminders it touched, bumps `generation`, calls `requestSync`; errors via `ErrorMapping`, logs via `Log`), `JournalClock.swift` (local calendar today, follows NSCalendarDayChanged / time-zone / clock changes, DEBUG-only `MEMRY_JOURNAL_TODAY` env or launch argument), `JournalWriteGate` (D5). Refresh on sync: `JournalTabContent` re-reads when the vault pass ends. Tests `MemryTests/JournalStoreTests.swift` (JournalStoreTests 5, JournalClockTests 4) over a scratch vault: pass (xcodebuild -only-testing, 14 tests incl. routing).

- [ ] JP030 `apps/ios/Memry/Features/Journal/`: `JournalStore` (`@Observable`)
      over the `Journal` API. Refresh on core sync events. Every write calls
      `requestVaultSync`. Errors go through `ErrorMapping.swift` (new cases as
      needed), logging through `Core/Log.swift`. `JournalClock` gives the local
      today (D3) and follows day rollover and time-zone changes. In debug builds
      it honors `MEMRY_JOURNAL_TODAY` (§0.5), and it does nothing in release.
      Unit tests over a scratch vault (`TasksTestVault` pattern).
- [x] JP031 Replace the Journal `ComingSoonTab` in `VaultTabsView.swift`, and
      add `JournalRoute(date)` plus a `JournalRouter` that selects the tab and
      pushes the day. Wire a journal reminder tap to it:
      `ReminderNotificationsRouting.swift:39-47` currently sends every
      non-task target to Notes.
      Evidence: `JournalRouting.swift` (`JournalRoute` month/day, `JournalRouter.openDay/showDay/openMonth/openYear/drillUp`, SceneStorage form, `openJournalDay` environment action, `ReminderTap.open(in:journal:)`), `JournalRootView.swift` (tab content + one NavigationStack Year › Month › Day, restores the saved stack or opens today); `VaultTabsView` Journal tab replaces `ComingSoonTab`, `VaultListView` passes the vault; a journal reminder tap opens its day. `JournalRoutingTests` 5/5. Simulator: tab opens on the pinned today 2099-06-15 with Back = June (`apps/ios/SpikeEvidence/journal-parity/JP031-journal-tab-today.png`).
- [x] JP032 `JournalCopy.swift` (+ extensions per screen) mirroring the
      desktop strings the screens use: `journal.json` (placeholders, relative
      dates, counts, nav, stats), `settings.json` `journal.*`, and the inbox
      reminder preset labels. Literal copy per the iOS `*Copy.swift` pattern.
      Evidence: `Features/Journal/JournalCopy.swift`: journal.json placeholders, relative dates, weekday/month names, nav, empty/count/stats strings, export title, reminder copy and inbox journal presets, settings.json journal.* (template, weekday inherit/missing/summary, footer), D8 notification title/body, the D5 read-only limitation. Compiles into the app (Unit build green).
- [x] JP033 Extract the note page parts the day page needs into shared views,
      with no behavior change for notes: the block editor host, the tags and
      properties rows and the ghost row, backlinks and outgoing links, linked
      tasks, review comments, find, and export. Notes Unit tests stay green.
      Take before and after screenshots of one note to show nothing moved.
      Evidence: `Features/Notes/NotePageContent.swift`: `NotePageContent` (metadata rows + ghost row, editable blocks, review comments, backlinks, a slot, linked tasks; empty-body and after-backlinks views passed in) and `NotePageEnvironment`; `NoteReadView` now composes them (316 lines). Find (`NoteFindView`) and export (`NoteExportButton`) were already standalone and are reused as-is. Before/after of "Beta Feedback": `JP033-note-before-{top,bottom}.png` vs `JP033-note-after-{top,bottom}.png` — same layout. Unit plan minus the real-keychain/sign-in suites: 679 tests in 97 suites passed (`/tmp/unit-safe.sh`, §6).

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

Evidence: memry-B, today pinned 2099-06-15: apps/ios/SpikeEvidence/journal-parity/JP040-J01-today-empty.png, JP040-J02-first-edit-created.png (typed line created j2099-06-15, synced to /tmp/MemryNote/journal/2099-06-15.md), JP051-J03-footer-day-section.png, JP040-J10-past-day.png (no Back, bell visible) compared with Paper J01/J02/J03/J10; desktop edit to 06-16 landed in place after the day pull (JP052-day-links-resolved.png); inline title after scroll (JP057-ax5); 'Not on this phone yet' for 06-06; JournalDayTests 13/13; unit-safe 741/741.

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
- [x] JP041 [P] **Moving between days**: horizontal paging to the adjacent
      day, ‹ › buttons, a "Today" capsule when the page is off today,
      hardware ← / → when no text field is focused, and Esc drilling up to
      Month (desktop keys). Adjacent days prefetch (desktop `PREFETCH_DAYS`
      = 1). A pending edit is never rerouted to another day.
      Evidence: Swipe left/right paged 06-17 -> 06-18 -> 06-17 (tree); ‹ › and the Today capsule shown off today (J10 shot); hardware ← moved 06-17 -> 06-16; ⌘. (the .cancelAction Esc maps to) drilled Day -> Month; XCUITest Esc not delivered (§6); per-page models (JournalDayTests a_bridge_edit_lands_on_its_own_date); window of neighbours (the_window_holds_the_neighbours...).
- [x] JP042 [P] **Title menu and Go to date** (J04): Month, Year, and Go to
      date… (a graphical date picker sheet with the xmark / checkmark chrome
      of spec 005-redesign).
      Evidence: apps/ios/SpikeEvidence/journal-parity/JP042-J04-title-menu.png (Month / Year / Go to date), apps/ios/SpikeEvidence/journal-parity/JP042-go-to-date.png (graphical picker, xmark/checkmark); picking June 3 + confirm opened 'Wednesday, June 3, 2099, 12 days ago'.
- [x] JP043 [P] **Month** (J05). Days of the month, newest first, with an
      activity dot (level 1–4, hollow when empty), the day number, the
      weekday, and a preview. Today gets a badge, future days read "Future",
      empty past days read "No entry", and days whose body is not pulled get
      a not-on-this-phone line. The subtitle shows year, entry count and
      streak. ‹ › change the month, a tap opens the day.
      Evidence: apps/ios/SpikeEvidence/journal-parity/JP043-J05-month.png, JP043-J05-month-entries.png: subtitle '2099 · 10 entries · 1-day streak', Today badge, Future, No entry, 'Not on this phone yet', entry dots; ‹ › months; tap opened the day. JournalCalendarTests green. Preview/count deltas logged in §6.
- [x] JP044 [P] **Year** (J06): 3-column grid of months with entry count and
      activity dots, current month highlighted, future months dimmed; totals
      (days with entries, thousands of characters), streak and best; ‹ ›
      years; tap → Month.
      Evidence: apps/ios/SpikeEvidence/journal-parity/JP044-J06-year.png: 3-column grid, June current (highlighted), future months dimmed, totals '9 days with entries · 402 characters', streak and best 13; tap June -> Month; ‹ › years (2026 -> 2099 by next).
- [x] JP045 [P] **Tags and properties writes** on the day page (J02),
      gated by G0 (D5): add, create with color, remove a tag; add, edit,
      rename, reorder and delete a property; the first write creates the day.
      If G0 failed, the rows are read-only with the limitation copy and this
      task records that.
      Evidence: G0 failed (§7), so rows are read-only: apps/ios/SpikeEvidence/journal-parity/JP045-J02-tags-readonly.png (06-04 tags g0/fixed), ghost tap shows JournalCopy.metadataReadOnly; accessibility value 'Read-only on iPhone'; JournalDayTests hidden_metadata_reads_as_none.
- [x] JP046 [P] **Reminders** (J07, J08, J13). The bell menu offers the presets
      with their resolved dates and a custom date and time. The sheet lists the
      active reminders for this day (edit, snooze, dismiss, delete) under
      "Change reminder" (D8). The bell is filled when a reminder is active,
      with a count when there are several. Local notifications go through the
      existing `ReminderScheduler` window. Title and body follow D8. A tap
      opens the day.
      Evidence: apps/ios/SpikeEvidence/journal-parity/JP046-J07-bell-menu.png (presets with resolved dates + custom), 'In 1 Week' set -> bell filled 'Reminder: Fri, Oct 2 · 9:00' (apps/ios/SpikeEvidence/journal-parity/JP046-J02-bell-filled.png), sheet under 'Change reminder' (apps/ios/SpikeEvidence/journal-parity/JP046-J08-reminder-sheet.png); JournalRemindersTests 8/8 incl. a_journal_notification_shows_the_date_only (J13 text) and JournalRoutingTests a_journal_reminder_tap_opens_its_day.
- [x] JP047 [P] **More menu** (J09): Find in page (note find), Export (note
      export, the title from desktop's `export.noteTitle`), Journal settings.
      Evidence: apps/ios/SpikeEvidence/journal-parity/JP047-J09-more-menu.png; Find in page 'lake' -> '1 match' (apps/ios/SpikeEvidence/journal-parity/JP047-find-in-page.png); Export -> share sheet 'Journal - June 15, 2099.txt' (apps/ios/SpikeEvidence/journal-parity/JP047-export.png); Journal Settings opens J11.
- [x] JP048 [P] **Settings › Journal** (J11, J12). Reached from the More menu
      and from a Journal row on the More tab (next to the Tasks row). It has
      the default template, a template per weekday in first-day-of-week order
      bound to the absolute weekday (showing "Default · <name>" when a day is
      unset and "Deleted template" when a set template is missing), and the
      stats footer toggle (device-local, D9). No folder or filename settings
      (D7).
      Evidence: apps/ios/SpikeEvidence/journal-parity/JP048-J11-settings.png, JP048-J12-saturday.png, JP048-J11-settings-footer.png, JP048-more-tab-row.png (More tab row next to Tasks); Wednesday -> 'Agent Test Journal' synced to desktop getJournalSettings weekdayTemplates {3: g35t8rdy1a3l}; unset days read 'Default · none'; JournalSettingsTests green.
- [x] JP049 [P] **Template seeding** (D2, D10). Opening an empty day whose
      date resolves to a template seeds it once. A template that has not
      arrived yet retries on the next open or sync, not in a loop. A day
      seeded on another device is never seeded twice. The locale strings are
      formatted with Foundation to match desktop's `Intl` output (D4).
      Evidence: Desktop template 'Agent Test Journal' (g35t8rdy1a3l) on Wednesday; opening empty 2099-06-17 seeded it once: apps/ios/SpikeEvidence/journal-parity/JP049-template-seeded.png ('Wednesday check-in', 'Today is 17.06.2099.', agent tag, agentmood: calm) and desktop file journal/2099-06-17.md matches; JournalSeedTests 8/8 (retry after generation, never seeded twice, Intl strings).
- [x] JP050 [P] **Day section** (J01, J03, J10): tasks due on the day
      from `TasksStore` (status toggle, priority, project meta), the overdue
      count on today opening the Tasks tab, a task tap opening its detail
      through `TasksRouter`. Hidden when there is nothing to show (desktop
      `JournalDayPanel`).
      Evidence: apps/ios/SpikeEvidence/journal-parity/JP050-J01-day-section.png, JP051-J03-footer-day-section.png: 'Due today 1', High priority, project meta, overdue pill; task tap -> TaskDetail ([agent] journal day task); overdue tap -> Tasks tab (apps/ios/SpikeEvidence/journal-parity/JP050-overdue-opens-tasks.png, desktop behaviour, §6); JournalSectionTests due/overdue rules; hidden on 06-12 with nothing due (J10).
- [x] JP051 [P] **Stats footer** (J03): words, characters, reading time
      (desktop's 200 wpm, "< 1 min"), modified date, when the setting is on.
      Evidence: Footer on with the device-local toggle: '7 words · 34 characters · 1 min read · Modified Sep 25, 2026' (apps/ios/SpikeEvidence/journal-parity/JP051-J03-footer-day-section.png); JournalDayTests reading_time_rounds_up_at_200_words_a_minute and the_stats_line_lists....
- [x] JP052 [P] **Cross-tab routes.** Every one of these opens the Journal tab
      on the right day: a journal search hit, a journal backlink on a note, a
      wiki link to a day (per JP003g), a journal related item in the task detail
      (`TaskRelatedSection` kind `journal`), and a journal reminder tap.
      Evidence: Search hit 'walked to the lake' -> Journal tab on 06-15 (apps/ios/SpikeEvidence/journal-parity/JP052-search-hit.png); journal backlink on 06-15 -> 06-16 (apps/ios/SpikeEvidence/journal-parity/JP052-backlink-opens-day.png); wiki link [[2099-06-15]] in 06-16 -> 06-15 (apps/ios/SpikeEvidence/journal-parity/JP052-day-links-resolved.png); task related journal item -> Journal tab 06-15 (apps/ios/SpikeEvidence/journal-parity/JP052-task-related-journal.png); reminder tap: JournalRoutingTests a_journal_reminder_tap_opens_its_day.
- [x] JP057 Accessibility pass over every screen above. VoiceOver: the date
      header reads as one heading. Month rows read "Thursday 24, entry,
      <preview>" and Year cells read "September, 17 days". Custom actions
      cover previous day, next day and today. Also check Dynamic Type at AX5
      (header, Month rows and Year grid wrap or stack), 44pt targets, Reduce
      Motion (paging and fog), Reduce Transparency, forced RTL (‹ › and paging
      mirror), and WCAG AA on the activity dots' text companions. Runs after
      JP040–JP052.
      Evidence: Header reads as one element 'Monday, June 15, 2099, Today' with actions Previous day/Next day/Go to Today; Month rows 'Monday 15, entry, Agent day one…'; Year 'June, 9 days' (value Current month); AX5: apps/ios/SpikeEvidence/journal-parity/JP057-ax5-day.png, JP057-ax5-day-lower.png, JP057-ax5-month.png, JP057-ax5-year.png (ghost row and backlinks header stack, Year 2 columns); RTL apps/ios/SpikeEvidence/journal-parity/JP057-rtl-day.png (‹ › mirrored, swipe right = next day); Reduce Motion via Tokens.animation(reduceMotion:), fog absent under Reduce Transparency (JournalDayHeader); 44pt minimumHitArea.
- [x] JP058 Dark mode: light and dark screenshots of J01, J02, J05, J06,
      J08, J11. Activity colors and fog tints derived for dark and checked.
      Evidence: Dark: apps/ios/SpikeEvidence/journal-parity/JP058-dark-J01-today.png, JP058-dark-J02-tags.png, JP058-dark-J05-month.png, JP058-dark-J05-month-entries.png, JP058-dark-J06-year.png, JP058-dark-J08-reminders.png, JP058-dark-J11-settings.png; activity dots and fog read in dark; appearance restored to light.

**Commit** after each block lands.

---

## Phase 5: verification (serial)

Evidence: journal_conformance FFI added (api/journal_conformance.rs, generated Swift diff additive: journalConformance + checksum); Conformance plan: 29 tests in 8 suites passed, suite 'journal.json — spec 005-journal JP080' passed.

- [ ] JP080 Conformance:
      `apps/ios/MemryConformanceTests/JournalConformanceTests.swift` runs
      `journal.json` through the FFI. Conformance plan green.
- [x] JP081 UI tests `apps/ios/MemryUITests/JournalUITests.swift`, with today
      pinned to an agent day. The flows are: open Journal and land on today;
      type on an empty day and confirm the day now exists (Month shows a dot);
      page to yesterday and back; Month and Year drill down and back; set a
      preset reminder and see the bell filled; a template-seeded day opens with
      the template text; the Settings weekday row reads the resolved default.
      UI plan green.
      Evidence: apps/ios/MemryUITests/JournalUITests.swift, 6 flows with today pinned to a random 2099 agent day (today + paging, first line creates the day and Month shows 'entry', Year->Month->Day->Month->Year, preset reminder fills the bell, Wednesday template seeded, Settings weekday rows 'Default · …' / 'Agent Test Journal'). UI plan: 14 tests, 1 skipped (AgentDriver), 0 failures (8 baseline + 6).
- [x] JP082 Cross-device against staging with the desktop peer, agent days only:
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
    Evidence: Staging, desktop peer /tmp/MemryNote, agent days only. Phone->desktop: typed day 06-15 created + body edit ('Phone edit xdev.') in journal/2099-06-15.md; template seeding 06-17 file matches; reminder set/moved (09:00->10:00, remindAt 07:00Z)/dismissed seen by desktop reminders.list (apps/ios/SpikeEvidence/journal-parity/xdevice-phone-reminder-dismiss.png); settings default template + Wednesday in getJournalSettings. Tags/properties: read-only on the phone (G0, D5). Desktop->phone: 06-16 created, body edit landed after the day pull, tag agentdesk + property + reminder (set, moved 11:00, dismissed) on the phone (apps/ios/SpikeEvidence/journal-parity/xdevice-phone-desktop-tags-reminder.png, apps/ios/SpikeEvidence/journal-parity/xdevice-desktop-tags-from-desktop.png); desktop-seeded 06-24 shows once; settings default/weekday; edit landing in an open day with the caret kept (apps/ios/SpikeEvidence/journal-parity/xdevice-phone-live-edit-keeps-cursor.png, apps/ios/SpikeEvidence/journal-parity/xdevice-desktop-live-edit.png). Concurrent 06-08 (desktop sync paused): both sides 'Desk: Base line for concurrency. Phone side.' (apps/ios/SpikeEvidence/journal-parity/xdevice-concurrent-phone.png, apps/ios/SpikeEvidence/journal-parity/xdevice-concurrent-desktop.png); 06-05 metadata: desktop tag + core property both kept. Non-j id legacyagent0609 (2099-06-09) edited on the phone under that id, no j2099-06-09 created. Two core fixes came out of it (§6); one desktop defect in §7.
- [x] JP083 Full gates: §0.6 in full. Record counts against the JP001 baseline.
      Evidence: §0.6 in full on 2026-09-25: cargo fmt --all --check ok; clippy -D warnings clean; cargo test -p memry-core 1028 passed / 0 failed / 1 ignored (workspace 1060, baseline 920); line ceilings 433 files; build-xcframework --release ok, Generated/ unchanged; vectors:generate + vectors:check 18 classes (baseline 16); pnpm lint 0 errors (3 pre-existing warnings; run with the untracked CDP scratch apps/desktop/.cdp-tmp.mjs ignored, which is not committed and removed at JP095), typecheck ok; test:renderer 793 files / 10102 passed; test:main 643 files / 9200 passed (+30 vs 9170); i18n:check, check:architecture, check:contracts ok; git diff --check clean. iOS memry-B: Unit 765 tests / 111 suites (baseline 689), Conformance 29 / 8 suites (baseline 27), UI 14 run / 1 skipped / 0 failures (baseline 8 + JournalUITests 6), after a fresh §0.4 sign-in (OTP 14:03).
- [x] JP084 Desktop regression: `pnpm --filter @memry/desktop test:desktop`
      green, then `electron-vite build` and `pnpm --filter @memry/desktop
test:e2e` for the journal specs.
      Evidence: No test:desktop script exists; its halves ran in JP083 (test:renderer 10102 passed, test:main 9200 passed). rebuild:electron + MEMRY_ENV=production electron-vite build ok. Journal e2e (journal, journal-reminder-edit, journal-reminder-navigation, home-journal-widget-refresh/-upcoming, marquee-selection-journal): 30 passed, 3 failed, all 3 in marquee-selection-journal (overlay never appears). marquee-selection.e2e.ts (no journal code) fails the same way here, 7/19, and the branch's desktop diff (9 files, journal queries/handler/utils/hooks) touches no marquee code, so this is the headless drag environment, logged in §6.

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

JP003 re-check (2026-09-25): every pre-filled fact above holds at the cited
lines (`sync-payloads.ts:279-294`, `journal-handler.ts:66,110,221`,
`journal.rs:88,141`, `body_write.rs:48,75`, `0002_projections.sql:72-81`,
`settings-sync.ts:75-88`). Two refinements: the journal projection has no tag
column, tags project into `note_tags` keyed by the journal id
(`projectors/notes.rs:133-180`); `templates.rs`'s module doc (lines 17-23)
is stale, `properties_of` (`:214-259`) does apply template properties to a
note by `name → value`.

- **a. Body safety on desktop.** A remote journal upsert writes
  `data.content ?? ''` as the file body, on update (`journal-handler.ts:66`)
  and create (`:110`), with the incoming `tags`/`properties`. `content: null`
  therefore **empties the vault file's body** while the Y.Doc keeps it. The
  handler then calls `syncNoteToCache` with the new bytes, so the watcher's
  hash check (`vault/watcher.ts:632`) sees nothing new and never feeds the
  empty body into the Y.Doc; the CRDT keeps the text. What restores the file
  is the **CRDT write-back**: every body or `meta` update that reaches the doc
  (`crdt-provider.ts:1297-1298` for network and IPC origins) schedules
  `writebackJournal` (`crdt-writeback.ts:729-846`), which re-serialises the
  Y.Doc over the file. Desktop's own `content: null` updates are safe because
  desktop edits tags through the Y.Doc `meta` map as well
  (`mergeJournalFrontmatter` reads `getYjsTags(doc)`, `:959-972`), so a peer's
  record update is followed by a CRDT update that writes the body back. A
  record-only write (tags or properties with no CRDT update) has no such
  follow-up: the peer's file stays body-less until the next body edit. The
  open editor is bound to the Y.Doc, not the file, so its text survives. G0
  (JP029) measures this.
- **b. Remote create with `content: ""` plus CRDT updates.** Yes. The create
  writes a body-less file (`journal-handler.ts:110`); the CRDT pull opens the
  doc without seeding (`engine/crdt-sync-coordinator.ts:602`), applies the
  updates, and the write-back (`crdt-writeback.ts:729-846`) writes the body.
  With the updates first and no cache row, `writebackJournal` creates the file
  from the doc (`:807-845`).
- **c. Seeding from markdown.** No markdown → Y.Doc path exists outside the
  desktop editor bundle (`sync/blocknote-converter.ts`, `ServerBlockNoteEditor`;
  chapter 12 §12.1: the WebView guest's `doc-load.seedMarkdown`). The iOS app
  has no WebView guest and never reads `seed_markdown` (no reference in
  `apps/ios/Memry`). A note made from a template on the phone has an empty
  update log, so `Notes.read` answers `present: false`
  (`reads.rs:529-530`) and the phone shows the not-on-this-phone state
  (`NoteReadParts.swift:38`). Typing into that note writes blocks into an
  empty Y.Doc; desktop then never seeds from the file (`seedFromMarkdown`
  runs only on an empty fragment, `crdt-provider.ts:1061`), and its next
  write-back replaces the template text in the file with the phone's blocks.
  **So a template-seeded day would be unwritable (or lossy) on the phone that
  seeded it: JP022a is required.**
- **d. `body_write::edit_block` for a journal id.** Refused today:
  `reads::note_exists` checks `notes` only (`reads.rs:413-424`,
  `body_write.rs:48`). The change is queued as
  `Change::crdt_update("note", id, …)` (`body_write.rs:75`), but the item type
  of a CRDT change never reaches the wire: `push_crdt` seals by `doc_id` only
  (`sync/push.rs:290-320`), and the pull stores updates by document id
  (`crdt/mod.rs:21-22`, `sync/body_pull.rs`). Journal bodies are pulled with
  notes (`sync/apply.rs:109` `DOCUMENT_TYPES`). A journal edit therefore needs
  a liveness check over `journal_entries` and can key the change `journal` or
  `note` with no wire difference; JP020 keys it `journal` for clarity.
- **e. Journal reminder payload.** `targetType: 'journal'`, `targetId` = the
  date, `remindAt` ISO, `note` optional, no `title`
  (`hooks/use-journal-reminders.ts:101-133`). `useSetOrReplaceReminder`
  (`hooks/use-set-or-replace-reminder.ts:28-45`): no active reminder →
  create; otherwise `updateReminder({id, remindAt, note: note ?? null})` on
  the next active one. Presets `journalPresets`
  (`components/reminder/reminder-presets.ts:191-230`): 1 week, 1/3/12 months,
  at 09:00. Desktop's notification title is the reminder title or the target
  title (the date for journals, `main/lib/reminders.ts:117`), body is the
  reminder `note` when set, else "Journal reminder" (`:317-330`).
- **f. Counts and thresholds.** Heatmap, month and year stats read
  `note_cache.characterCount` (`journal-queries.ts:71-98,108-150`), which is
  the parsed markdown body's `.length` (`vault/journal.ts` `readJournalEntry`,
  `content.length`, UTF-16 units). Levels: 0 → 0, ≤100 → 1, ≤500 → 2,
  ≤1000 → 3, else 4 (`journal-api.ts:319-325`). Year `averageLevel` is SQL
  `AVG` of per-day levels rounded to 2 decimals (`journal-queries.ts:124-149`).
  The Year view's own cards use `getMonthStats` (`lib/journal-utils.ts:332-382`):
  `entryCount` = days with `characterCount > 0`, `totalChars` = sum,
  activity dots = max level per 7-day block, at most 5.
- **g. Wiki links and journal backlinks.** Desktop titles a journal with its
  date (`journal-handler.ts:72` `title: entry.date`), so `[[2099-06-15]]`
  resolves by title to the journal row; a `j<date>` id that resolves to no
  note opens the journal on that date (`lib/wikilink-resolver.ts:31-47`,
  `dateFromJournalId`, `journal-api.ts:348-351`). The phone's
  `resolve_wiki_target` searches `notes` only (`note_meta.rs:214-260`), and
  `Search.backlinks` resolves the target title from `notes` and joins sources
  from `notes` (`api/search.rs:137-230`): **a journal id gets no backlinks
  and a journal source is dropped.** JP026 fixes both.
- **h. Body window.** First sync pulls the bodies of notes **and journals**
  modified in the last 30 days, newest first, capped at 500
  (`sync/first_sync.rs:75,84`, `first_sync_store.rs:42-66`); later passes
  pull the bodies of records that arrived (`api/sync/pass.rs:11-13`). An older
  day reads `present: false` and the note page offers the on-demand fetch
  (`NoteRead.swift:132`, `NoteReadView.swift:279`).
- **i. CLI.** `memry-cli` signs in (`login --email`, OTP), unlocks from a
  phrase file, pulls and pushes one vault, and appends a paragraph to a note
  (`src/cli.rs:25-49`). It reaches staging by default (`--server staging`).
  The live staging run is JP029's first step.

## 6. Decisions log (agent-made choices during the run)

<!-- date — task id — choice — why -->

- 2026-09-25 — planning — Paper J08 originally drew "New reminder" as a second
  reminder. It now reads "Change reminder" with the one-reminder copy, to match
  desktop's set-or-replace rule (D8).
- 2026-09-25 — Phase 4 — The account vault 87614a10 (MemryNote) came back from the server named "scratch" at about 14:05 and as "MemryNote" again by 15:00. Neither the phone nor the /tmp/MemryNote desktop peer renamed it (the peer config still says MemryNote), so another device did. Left as is; JP095 checks the name is MemryNote and does not rename a vault this run did not rename.
- 2026-09-25 — JP050 — The overdue count opens the Tasks tab as it stands, as desktop's `handleNavigateToOverdue` opens `/tasks` without choosing a view. The block first forced Today, which the Tasks tab's first-appear default view then overrode, and which would also discard the view the user left.
- 2026-09-25 — JP041 — Esc drill-up uses `.keyboardShortcut(.cancelAction)`, which a hardware Esc and ⌘. both trigger. XCUITest's `typeKey(.escape)` does not reach the app in this simulator (it does not close a sheet either), so the evidence uses ⌘.; ←/→ are shown directly.
- 2026-09-25 — JP040 — Desktop pushes a journal body edit as CRDT updates only, and the phone's sync pass pulls bodies only for records it applied, so a desktop edit to a day never reached the phone. The shown day now pulls its own body (`fetchNoteBody`) when it becomes shown and after each sync pass, as a note page pulls its missing body. Found alongside: pulled update rows were stamped with the server's `createdAt` (seconds) instead of the apply time, below the search index's epoch-ms watermark, so pulled bodies were never re-indexed and their links never became backlinks. Fixed in `sync/body_pull.rs`; `index_meta` `stamps.version` forces one full rebuild on existing installs.
- 2026-09-25 — JP052 — A wiki link whose title is a date draws as resolved (accent) because it always opens its journal day, an empty one included (sectionF's route). Desktop draws a day link in the accent too.
- 2026-09-25 — JP040 — Journal pages reindex search on store creation and after each sync pass so backlinks and link targets are current; backlinks re-read with the page on every store generation.
- 2026-09-25 — JP043/JP044 — Known deltas, not fixed. (1) A Month preview comes from the core's `extract_text`, which leaves out inline atoms, so a line with a wiki link reads "Follow-up on a …" where desktop's markdown-based preview keeps the link text. (2) A day whose body is not on this phone counts 0 characters, so Year's "days" (days with characters) can be one lower than Month's entry count (records) until that body is pulled.
- 2026-09-25 — Phase 4 — Journal settings before this run (for JP095): defaultTemplate null, weekdayTemplates {}, the device-local stats footer off. Changed during Phase 4: Wednesday -> "Agent Test Journal", stats footer on.
- 2026-09-25 — JP052 — A wiki link to a bare date with no entry opens that empty day (sectionF), as the Journal's own navigation does; desktop's link picker offers only notes, so there is no desktop behavior to copy.
- 2026-09-25 — Phase 4 — Known visual deltas against Paper, not fixed: the header fog renders as a horizontal band, not Paper's radial blob; the tab bar tint is the app-wide blue, not Paper's accent; the Month title lacks Paper's chevron and flame glyph, and the Year title its chevron. Task toasts raised from the Journal's day section are not shown on the Journal tab.
- 2026-09-25 — JP081 — JournalUITests needs the synced journal settings JP049 left (Wednesday -> Agent Test Journal, no default template); JP095 removes that template, after the last UI run (JP083). An editable block is a text view whose text is its accessibility value (VoiceOver reads it); the tests match label or value.
- 2026-09-25 — JP082 — Core fix: `BodyPull` probes `snapshotMeta` through `POST /sync/crdt/updates/batch` (one request per hundred documents that already hold a cursor, `limit: 1`) before paging the single-document route, which carries none. Without it a document whose server log a peer's snapshot pruned past this device's cursor went silent for good (§7.8's second clause could never fire). A failed probe (batch rate limit 30/min, an old server) falls back to the old behavior. `tests/sync_first_sync.rs` a_snapshot_that_pruned_past_the_cursor_is_taken_from_the_probe.
- 2026-09-25 — JP082 — Core fix: `BlockEdit::SetText` on a block holding one plain run edits that run in place (common prefix/suffix, UTF-8 byte offsets, the document's offset kind) instead of deleting and re-inserting it, so a peer's concurrent insert into the same paragraph survives. Marked runs and inline nodes keep the documented replace. `tests/body_edit_ops.rs` a_set_text_keeps_a_concurrent_insert_into_the_same_block.
- 2026-09-25 — JP082 — The phone has no socket listener (spec 002 design): remote changes land on the next sync pass (launch, return to foreground, or the phone's own write), not live. "Concurrent offline" was driven by desktop `syncOps.pause()` since neither side's network can be cut alone; the non-`j` day was pushed by the CLI core as a legacy-shaped record (current desktop always derives `j<date>`), then given a desktop body.
- 2026-09-25 — JP084 — `pnpm --filter @memry/desktop test:desktop` does not exist; renderer and main ran separately (JP083). Marquee-selection e2e fails in this environment for journal and plain notes alike (the drag overlay never appears); the journal specs that exercise this branch's desktop changes (journal, reminders, Home widgets) pass.
- 2026-09-25 — Phase 4 — Screenshots: what looked like stale simulator frames was the agent image viewer caching by file path; every preview now gets a unique name, and each evidence PNG was re-checked that way. The accessibility tree stays the reference for state.
- 2026-09-25 — JP001 — Found, not fixed (outside this plan): on the recovery-phrase unlock screen, with the keyboard up, the chooser's "Sign out" button (frame y 480-532) overlays the "Unlock" button (y 478-530), so a centred tap on Unlock opens the sign-out confirmation. The driver taps Unlock at `dy: 0.01`. Vault rows still need their label tapped (spec 004 §6 TP001). Screenshots from `XCUIScreen` can lag a few seconds; the accessibility tree is the reference for state.
- 2026-09-25 — JP003 — JP022a is in scope: the phone has no markdown → Y.Doc path, so a template-seeded day would be unwritable (or lossy on desktop's next write-back) on the phone that seeded it (§5 c).

- 2026-09-25 — JP010 — `getJournalYearStats` now aggregates in JS through `yearMonthStats`. SQL `AVG(CASE ...)` read a NULL `character_count` as level 4 (the CASE fell through to ELSE); the package reads a missing count as 0 characters. Unreachable for journal rows (`syncNoteToCache` always writes the count), and not a rule worth pinning in vectors. Output otherwise identical; the existing notes query test passes unchanged.

- 2026-09-25 — JP021 — Property reorder is not in the core: the core stores payloads as a key-sorted map (serde_json without `preserve_order`, `storage/repositories/payload.rs`), so an object key order cannot be written. Desktop keeps order in the frontmatter only. The phone shows properties in the order the core returns; rename keeps the value.
- 2026-09-25 — JP022a — Markdown seed fallback: constructs outside the template set (tables, HTML, images/embeds, callouts, math, nested quotes, mentions, task blocks) keep their source lines as paragraphs; CriticMarkup, toggles, link reference definitions and `\r` send the whole text there. Found, not fixed (desktop): a hard break inside link text leaves a literal `MEMRYHBK0;` in desktop's converter output; the seed reproduces desktop.
- 2026-09-25 — JP022 — Reviving a tombstoned day from a template adds the template's tags to the stored ones and overwrites same-named properties; a template property named `date` is dropped (reserved, D5).
- 2026-09-25 — JP023 — A day with an entry but no pulled body counts for the streak and the month's entry count, reads level 0 and "not on this phone"; counts come from the cached body text only while its source sequence is current, else from the update log.
- 2026-09-25 — JP026 — A day gets a backlink when a link spells its date or `j<date>`, unless a live note of that exact title took the link (notes win resolution, as desktop's title lookup does). A `j<date>` link with no entry resolves to the day without creating it (desktop `dateFromJournalId`).
- 2026-09-25 — JP027 — `Search.backlinks` keeps its note-only answer; journal-aware links are the new `Search.linksTo` / `linksFrom`. Note body reads (`Notes.blocks/table/comments`) and `VaultSync.fetchNoteBody` accept a journal record id.
- 2026-09-25 — JP029 — G0 limit: the last released desktop (2026.919.1) cannot run against staging; its journal upsert code is identical to the tested pre-fix code, so G0 is taken as failing for it. Also found: a phone-created day can lose its vault-file body on a shipped desktop when the create record (`content: ""`) is applied after the CRDT write-back; the next body update rewrites the file. JP029a fixes both. Desktop also leaves the open day's tag chips stale after a remote tag write (the file and index are right); not changed.
- 2026-09-25 — JP029 — Gate decision (D5): the phone ships with journal tag and property writes OFF (read-only rows with the limitation copy) behind one switch, until a desktop release carrying JP029a is out. Body editing, templates and reminders are on.

- 2026-09-25 — JP029 — Side effect found and reverted: desktop names an account vault after its local folder (`vault/init.ts` `getVaultName` → `refreshVaultDirectory`), so opening MemryNote at `/tmp/jp-desk` renamed the account vault to "jp-desk". The peer now lives at `/tmp/MemryNote` and the account vault reads "MemryNote" again (checked with `vault.listAccount`). The desktop peer must always use a folder named after the vault.

- 2026-09-25 — JP033 — Unit runs that must keep memry-B signed in skip the five suites that touch the real keychain or expect a signed-out app (`RealKeychainSuite`, `SignOutWiringTests`, `VaultContentRemovalTests`, `SignOutServiceTests`, `SignInWiringTests`); the full plan runs at G2 and JP083. `SignInWiringTests` "the app root constructs a real session" fails when the simulator is signed in (it expects `.signedOut`): environmental, not a regression.
- 2026-09-25 — JP030 — The Journal tab refreshes when the vault's sync pass ends (the pass lives in the tasks store); a debounced `requestVaultSync` follows every journal write. `PropertyWriteError` is internal to the generated module, so a Retyped refusal maps to the generic copy (pre-existing gap, notes have it too).

- 2026-09-25 — Phase 4 — The thirteen blocks run as six parallel subagents grouped by the files they share: Day page (JP040, JP041, JP045, JP051), calendar (JP042, JP043, JP044), More menu + seeding (JP047, JP049), reminders (JP046), settings (JP048), Day section + routes (JP050, JP052). Each works in its own detached worktree and compiles only, with DerivedData under `/tmp/memry-dd-B/agents/<block>`; the orchestrator owns every simulator run (`/tmp/memry-dd-B`, memry-B). The orchestrator pre-landed the shared contracts (placeholder views with fixed signatures, `JournalVaultContext`, `JournalRoute.settings/.note`, `Tokens.Journal`, `JournalPreferences`, the `journalTasks` environment value).
- 2026-09-25 — JP040 — A note opened from a day (backlink, wiki link) is pushed inside the Journal stack (`JournalRoute.note`) with the same note page the Notes tab uses; there is still no cross-tab note route.

## 7. Blockers

- 2026-09-25 — JP082 — Desktop defect, not fixed here: with sync paused (`syncOps.pause()`, the Settings pause), desktop still pushes CRDT snapshots (`Pushed CRDT snapshot j2099-06-05` at 16:06:16, while paused). The snapshot's `sequenceNum` (24) covered a phone update desktop had never pulled, and the server's `pruneUpdatesBeforeSnapshot` deleted that update, so the phone's concurrent edit on agent day 2099-06-05 now exists only on the phone. Needed on desktop: no snapshot push while paused, and a snapshot's sequence number must be the highest one the doc has applied. Retry after a desktop build with that fix; evidence in `/tmp/jp-desktop4.log` 16:05–16:08 and `SpikeEvidence/journal-parity/xdevice-concurrent-*.png` (the clean re-run on 06-08).

<!-- date — task id — what — evidence — next retry -->

- 2026-09-25 — JP029 / G0 — **For Kaan.** Every shipped desktop (through 2026.919.1) writes `content ?? ''` into the vault file for a remote journal record, so a phone tag or property write empties the day's markdown file (the Y.Doc keeps the text; the file, index and heatmap lose it until the next body edit). Evidence: `apps/ios/SpikeEvidence/journal-parity/G0-1-*`, `G0-2-*`, `G0-3-desktop-open-editor.png`. Fix on this branch: JP029a (`journal-handler.ts` `writeSyncedJournal`). Needed: ship a desktop release with JP029a, then flip the phone switch (`JournalWriteGate`, JP045) to enable tag/property writes. Not retryable inside this run.

## 8. Final report

<!-- JP094: what shipped, bugs fixed outside the plan, evidence index, left open -->
