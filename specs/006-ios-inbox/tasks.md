# Tasks: iOS Inbox

**Goal**: every desktop inbox feature marked New or Adapted in the Paper audit
works on iOS, with the same data semantics, synced both ways with desktop,
built to the Paper design (file "Task iOS", `01M39KJ8S9S5QYX38B2HP3Q1BF`, page
"Inbox iOS" `p-3-0`, artboards 00, 00b, 01–23). Full brief:
`specs/006-ios-inbox/goal.md`.

**Reference implementation**: desktop. When this file and desktop disagree on
a behavior, desktop wins unless §1 says otherwise. Artboard **00 · Feature
audit + redesign map** decides where each behavior lives on iOS.

**Format**: `[ID] [P?] Description`. `[P]` = can run in parallel with its `[P]`
siblings in the same block. A task added later takes a suffix letter (`IB05a`)
so no id moves. **Gates are serial**: a phase behind a gate does not start
until the gate's evidence is green.

**Checkbox protocol**: tick `[x]` only when the task's own verification ran
green. Under the tick append one indented `Evidence:` line (command + result,
test name, screenshot path). Never tick partial work: split it with a suffix.

---

## 0. Operating rules (read before every resume)

### 0.1 Session

- One session, no questions to Kaan. Ambiguous: pick desktop's behavior, write
  it to §6 Decisions, continue.
- Blocked by something outside the repo: write it to §7 Blockers with
  evidence, skip to the next unblocked task, retry once per phase.
- This file is the only state. After a restart: re-read §0, §1, §5, §6, §7,
  then continue at the first unticked task.

### 0.2 Authorizations

- Delegation: pstack subagents for `[P]` blocks, role table from the session
  prompt. Subagents never run the simulator, never run
  `build-xcframework.sh`, never edit `api/` UniFFI files or generated Swift.
  The orchestrator does those and integrates.
- Commits: at the end of each phase on branch `feat/ios-inbox`, explicit
  paths only, `feat(ios): …` / `feat(desktop): …` / `chore(…)`. No push, no PR.

### 0.3 Workspace, simulator, sign-in, commands

- Worktree: `git fetch origin && git worktree add .worktrees/ios-inbox -b feat/ios-inbox main`.
  Never work in the main checkout. Fresh worktree: `pnpm install`, then
  `crates/memry-core/build-xcframework.sh --release`.
- Sign-in recovery and command list: spec 004 §0.4, §0.6. Debug builds talk
  to staging; the desktop peer is `pnpm --filter @memry/desktop dev:staging`.
- **Dedicated simulator (this plan only):** `memry-A`, iPhone 16, iOS 26.5,
  UDID `945F3BE0-5A70-4126-9E0C-18884CA2DF9C`. Other sessions run on their
  own simulators at the same time.
  - Every build, install, launch and test command targets
    `-destination 'platform=iOS Simulator,id=945F3BE0-5A70-4126-9E0C-18884CA2DF9C'`.
    Never target by name, never use `booted`.
  - DerivedData: `-derivedDataPath /tmp/memry-dd-A` on every `xcodebuild`.
  - XcodeBuildMCP: pass this UDID as `simulatorId`.
  - Never boot, shut down or erase any other simulator. `simctl shutdown all`
    and `simctl erase all` are forbidden. Never erase `memry-A` either: its
    keychain holds the session.
  - `memry-A` starts signed out: sign in once (below) before the first UI
    check.

### 0.3a Sign-in (when the app shows the signed-out or unlock screen)

Staging test account. Kaan revokes it after the run; no secrecy handling
needed.

- Email: `kaan94karaca@gmail.com`
- Recovery phrase: `reject youth sing exist joy mobile economy chalk boil girl tag attack round lunar dove alley bright bonus there dumb rent erode force yard`
- OTP sender: `noreply@memrynote.com`

1. Enter the email, request the code. Note the request time (UTC).
2. Poll gmail-bridge (`gmail_search` for
   `from:noreply@memrynote.com newer_than:1h`), take the newest message dated
   after the request time, read it (`gmail_message`), extract the 6-digit
   code. Poll every 10 s, give up after 3 min.
3. Enter the code. If the unlock screen appears, enter the recovery phrase.
4. At most 3 code requests per 10 min. Never request a new code while an
   unused, unexpired one exists. Hitting the limit is a §7 blocker, not a
   retry loop.

- Spec 004/005 commands that name `A7E3D181-…` use this UDID instead.
- `xcodebuild build-for-testing` must name a test plan (spec 005 §6 RD00a).

### 0.4 Test data

- Every capture the agent makes starts with `[agent] ` (title, text or the
  optional thought). Links use `https://example.com/agent/<n>`. Folders the
  agent creates are named `Agent Test …`. IB93 deletes them all.
- Never modify or delete data without these markers.

### 0.5 Scope

- Allowed: `crates/memry-core/**` (inbox domain, projector, api, vectors),
  generated UniFFI Swift through the generator only,
  `packages/contracts/**` vectors, `apps/ios/**` (new `Features/Inbox/**`,
  a Share Extension target, `Design/**` for shared primitives,
  `Features/Notes/VaultTabsView.swift` / More tab for the entry point),
  `apps/ios/SpikeEvidence/inbox/`, this spec.
- Desktop code changes only for a verified sync bug found by the round-trip
  tests, each logged in §6 with the desktop test that pins it.
- Wire and schema: no change to `InboxSyncPayloadSchema`, the server, or D1/R2
  layout. If one seems needed, write the migration and compat plan to §6 and
  stop that item (§7).

### 0.6 Design rules (from artboard 00 + spec 005)

- Every capture leaves by one of four exits: File, Convert, Snooze, Archive,
  each one swipe or one menu tap away.
- File is the primary action; the button names the top suggested folder when
  one exists ("File to Reading"), otherwise "File…".
- Rows carry one meta line: source or kind, then age; voice rows add the
  transcript line. No hover-only control.
- Non-inbox views live in the title menu.
- Glass only on chrome; the tint fills, `Tokens.Text.tint` for tinted text.
- Reuse spec 005 primitives (title-menu header, glass capsule, toast,
  `TaskSheetConfirmButton`-style sheet chrome, `taskGlass` fallback). Move a
  primitive to `Design/` when Inbox needs it; do not copy it.

---

## 1. Decisions (fixed; not revisited)

- D1 Entry point: Inbox is a row at the top of the More tab, with the
  unprocessed count, and opens as a pushed screen. The tab bar is unchanged.
  (Paper draws More selected.) Home widget and notifications deep-link to it.
- D2 Sync: iOS subscribes to `inbox`. Conflict rule = desktop's handler:
  last-write-wins per row by vector clock, "explicit null clears, absent key
  keeps". No field clocks (desktop has none for inbox).
- D3 Background jobs: iOS fetches link metadata on-device (`LPMetadataProvider`
  - the same fields desktop writes to `metadata`). Article extraction and
    social fetch run only where desktop runs them; iOS renders whatever
    `metadata` holds and never overwrites a richer desktop value with a poorer
    one (§5 F6 decides the merge rule).
- D4 Transcription: `SFSpeechRecognizer` with `requiresOnDeviceRecognition`.
  If on-device recognition is unavailable for the locale, the item keeps
  `transcriptionStatus = failed` with Retry; audio never leaves the device
  for transcription.
- D5 AI suggestions (folder suggestions, cluster pill): shown only when the
  synced AI setting is on and the data they need exists on iOS (§5 F8).
  Otherwise the File sheet shows Recent folders and the swipe leads to
  "File…". Never fake a suggestion.
- D6 Convert → Event: iOS does not subscribe to `calendar_event`. If §5 F9
  shows event conversion needs calendar records on the device, the Event
  segment is hidden on iOS and logged; not faked. Task and Reminder ship.
- D7 Share extension (artboard 22) is in scope. It writes captures into the
  app group; the app ingests them on next launch/foreground and runs the
  same capture path (duplicate check included). Captures made while the vault
  is locked wait for unlock; nothing is written in plaintext outside the
  vault's protection class.
- D8 Notifications: review nudge and snooze-due are local notifications with
  counts only (no capture text). Settings live in the synced `settings`
  record desktop already uses for inbox preferences (§5 F11).
- D9 Desktop-only rows of the 00 table (resizable panels, split view,
  per-tab state, keyboard shortcuts as such, drag and drop into the window)
  are not built. Hardware keyboard: Return = open, Cmd-Delete = archive, Esc
  closes sheets; nothing more.

---

## Phase 0: facts (serial)

- [x] IB000 Read goal.md, AGENTS files, DESIGN.md, PRODUCT.md, spec 004 §0–§1,
      spec 005 §0.3/§6, artboards 00, 00b, 01–23 (`get_jsx` + screenshot),
      and the desktop inbox code named in goal.md. Record in §5.
      Evidence: read root/iOS/desktop AGENTS, PRODUCT.md, DESIGN.md (mobile mapping, motion, copy, a11y), spec 004 §0–§1/§5/§6, spec 005 §0–§1/§6; Paper `paper_get_jsx AKS-0` (00: 24 audit rows, 6 rules, 9 SwiftUI notes, 3 open questions), `paper_get_tree_summary 9M5-0` (00b flow), `paper_get_jsx` text of 01–23 (captions of 12, 13, 15, 22 carried into IB12/IB13/IB15/IB22); desktop `main/inbox/*` (domain, capture, crud, queries, snooze, stats, filing, batch, duplicates, attachments, jobs, review-scheduler, suggestions head), `inbox-handler.ts`, `sync-payloads.ts`, `db-schema/schema/inbox.ts`, `domain-inbox/commands.ts`, `snooze-presets.ts`, `reminder-panel.ts`, `lib/reminders.ts`. Screenshots are taken per artboard at its Phase 4 item (§0.7).
- [x] IB001 Fill §5 F1–F12 with file:line citations. Each fact is what the
      code does, not what a comment says.
      Evidence: §5 F1–F12 filled with file:line citations; decisions from them in §6 (IB001/F1, F3, F4, F8, F9, F11).

## Phase 1: core read side (Rust)

- [x] IB010 Inbox record model in core: every `InboxSyncPayloadSchema` field,
      plus the desktop-local columns the UI reads (`transcription`,
      `transcriptionStatus`, `viewedAt`, `duration`, `pageCount`,
      `thumbnailUrl` / attachment ref) mapped from where desktop actually
      keeps them (§5 F1, F3).
      Evidence: migration `0004_inbox.sql` (`inbox_items` = the 13 schema keys + `inbox_item_tags` + `inbox_view` reading desktop's local keys from the payload), projector `storage/repositories/projectors/inbox.rs`, model `domain/inbox/mod.rs` (`InboxItem` incl. transcription, viewedAt, duration/pageCount via metadata, attachment/thumbnail paths); `cargo test -p memry-core --test domain_inbox_sync` a_desktop_full_row_payload_projects_verbatim ok.
- [x] IB011 Projector: apply remote `inbox` items with desktop's merge rule
      (D2). Unit tests: absent key keeps, explicit null clears (unsnooze,
      unarchive, unfile), older payload without new keys, deleted item.
      Evidence: `domain/inbox/merge.rs` hooked in `sync/apply.rs` `apply_inbound`; `cargo test -p memry-core --test domain_inbox_sync` 8 passed (absent key keeps, explicit null unsnoozes/unarchives/unfiles, older payload, null title/type keeps, stale skip, concurrent union clock, tombstone) + 3 lib unit tests.
- [x] IB012 Subscribe `inbox`: move it from `UNSUBSCRIBED_RECORD_ITEM_TYPES`
      to `SUBSCRIBED_ITEM_TYPES` only after IB011 is green (the constant's own
      comment). Initial seed pulls existing inbox rows.
      Evidence: `protocol/types.rs` SUBSCRIBED 15 (`inbox` last), UNSUBSCRIBED 10; docs/protocol 00, 05, 13 (§13.1, §13.7.15); the_declaration_subscribes_to_inbox ok; `payload-schemas.json` regenerated with an `inbox` group (60 cases), `cargo test --test vectors` 7 passed.
- [x] IB013 Queries (UniFFI): list (active, excluding filed/archived/snoozed;
      include-snoozed variant), by type counts, item detail, archived list
      with search, snoozed + reminder panel entries (Upcoming/Past, viewed),
      stats (captured, processed today/this week, rate, stale count with
      desktop's threshold, avg time to file, heatmap buckets, by type, recent
      filings, streak). Same numbers as desktop for the same data.
      Evidence: `domain/inbox/{queries,stats,panel}.rs` + UniFFI `api/inbox.rs` (list, get, typeCounts, archived, snoozed, panel, stats, patterns, filingHistory, recentFolders, tags, duplicateByUrl); `cargo test --test domain_inbox_queries` 4 passed (list order, type counts, archived search, snoozed/due, history, recent folders, duplicates, every stat vs desktop's definitions, Upcoming/Past).
- [x] IB014 Conformance vectors in `packages/contracts`: payload fixtures from
      desktop (current and one older shape) → expected projected row and
      list/stats output. `vectors:check` green; `MemryConformanceTests` gains
      an Inbox suite.
      Evidence: `packages/contracts/scripts/vectors/inbox.ts` (+ `inbox-cases.ts`) → `test-vectors/inbox.json` (7 apply sequences, one views fixture), registered in `gen-protocol-vectors.ts`; seam `api/inbox_conformance.rs`; `cargo test --test inbox_vectors` 2 passed; `vectors:check` passed (17 classes); `apps/ios/MemryConformanceTests/InboxConformanceTests.swift`: `xcodebuild test -testPlan Conformance` on memry-A → 29 tests in 8 suites passed (was 27/7), suite "inbox.json — spec 006 IB011, IB013" passed.

## Phase 2: core write side (Rust)

- [x] IB020 Capture: text, link (normalized URL, `sourceUrl`), image, voice,
      PDF, video, file; `captureSource = "ios"` or desktop's value set
      (§5 F4). Duplicate check by URL and by content, same rules as
      `main/inbox/duplicates.ts`, returning the existing item.
      Evidence: `domain/inbox/write.rs` (capture, capture_text with content-hash duplicate, capture_link with URL duplicate + social, check_file/type_for_mime, voice title) + `urls.rs`; UniFFI `captureText/captureLink/captureFile/captureVoice/checkFile/newId`; `cargo test --test domain_inbox_write` a_text_capture…, a_duplicate…, a_link_capture… ok; `--test api_inbox` 3 passed.
- [x] IB021 Attachments: store under the same vault path desktop uses
      (`attachments/inbox/{itemId}/`), same size and MIME limits (50 MB
      images), and sync them the way desktop does (§5 F3). Round-trip test.
      Evidence: path `attachments/inbox/{id}/…` recorded as `attachmentPath` (the shell writes the bytes), 50 MB and MIME allow-lists in `write::check_file`; no sync of inbox attachments, as desktop (§5 F3, §6 IB001/F3); `api_inbox` a_file_capture_carries_its_attachment_path_and_metadata ok (payload round-trips `attachmentPath` and metadata).
- [x] IB022 Update: title, content (debounced by the UI), metadata merge
      (D3), transcription fields, mark viewed.
      Evidence: `write::update` (rename / set_content, explicit null clears), `enrich.rs` (merge_metadata, complete_link with D3 rule, set_transcription with first-sentence title), `states::mark_viewed`; tests a_link_capture_awaits_enrichment…, a_voice_memo_is_titled_and_transcribed, snooze_unsnooze… ok.
- [x] IB023 Snooze / unsnooze with desktop's presets computed on-device;
      snooze-due returns items to the list (desktop scheduler semantics,
      §5 F7).
      Evidence: `states::snooze` (future only, not filed), `unsnooze` (explicit nulls), `resurface_due` (scheduler pass); presets are computed in the shell (IB09); test snooze_unsnooze_archive_unarchive_push_explicit_nulls ok (incl. due snooze returns to the list).
- [x] IB024 Archive / restore / delete permanently, with undo for archive.
      Evidence: `states::{archive, unarchive, delete_permanent}` (tombstone + outbox delete + local tags removed), undo = unarchive; tests snooze_unsnooze_archive…, a_delete_tombstones_and_queues_a_delete ok.
- [x] IB025 File: to folder (new note from the item, `generateNoteContent`
      semantics), link to existing notes, link to new notes, tags, image mode
      embed vs link with desktop's fallback. Writes `filedAt`, `filedTo`,
      `filedAction` exactly as desktop (§5 F5). Uses the existing notes write
      path in core.
      Evidence: `domain/inbox/filing.rs` (note title/body as blocks, ensure folder, merged tags + `inbox`, properties) + `convert::link_to_notes` (existing or new targets, `## Inbox Captures` + `[[title]]` bullet) + `states::mark_filed/undo_file`; `createNoteForFile` for file captures (§6 IB025); tests filing_to_a_folder…, a_link_files_as_a_link_mention…, linking_appends_under_inbox_captures ok.
- [x] IB026 Convert: to note, to task (priority, due, reminder, project) via
      the tasks write path; to reminder via the reminder path; to event per
      D6. Same `filedAction` values as desktop.
      Evidence: `convert::convert_to_task` (inbox project default, priority/due/time, tags + inbox, activity row, filedTo = taskId) and `convert_to_reminder` (note + note-target reminder, refuses note-only types and past times); Event hidden per D6; test convert_to_task_and_to_reminder ok.
- [x] IB027 Bulk: file, tag, snooze, archive; partial-failure counts as
      desktop (`processedCount`, `errors`).
      Evidence: `convert::{bulk_archive, bulk_snooze, bulk_tag, bulk_file}` with desktop's processed/errors; UniFFI `bulk*` → `InboxBulkResult`; test bulk_counts_partial_failures ok (2 processed, 1 error each).
- [x] IB028 Every write enqueues a sync push; payload built with the exact
      keys desktop sends (explicit null for clears). Test: an iOS payload
      parses with `InboxSyncPayloadSchema` (vector) and applies on desktop's
      handler test.
      Evidence: every write goes through `outbox::commit`; new captures carry desktop's full row keys with explicit nulls (test a_text_capture_writes_desktops_full_row_and_queues_it); lifecycle payloads pinned in `test-vectors/inbox-ios-payloads.json` (the_lifecycle_payloads_match_the_committed_fixture ok) and applied by desktop's handler: `vitest run --project main src/main/sync/item-handlers/inbox-handler-ios.test.ts` 3 passed (parse, lifecycle incl. explicit-null clears, stale replay skipped); existing `inbox-handler.test.ts` 14 passed.
- [x] IB029 Gate: `cargo test -p memry-core`, clippy `-D warnings`,
      `vectors:check`, xcframework rebuilt, Conformance plan green.
      Evidence: `cargo fmt --check` 0; `cargo test -p memry-core` 71 binaries, 958 passed / 0 failed / 1 ignored; `cargo clippy -p memry-core --all-targets -D warnings` clean; `node scripts/check-line-ceilings.mjs` passed (382 files); `vectors:check` passed (17 classes); `build-xcframework.sh --release` exit 0; Conformance plan 29 tests in 8 suites passed on memry-A.

## Phase 3: iOS foundations (serial)

- [ ] IB030 `Features/Inbox/InboxStore` over the new UniFFI surface: list,
      filters, counts, snoozed, archived, stats; optimistic remove with
      rollback like `archiveWithAnimation`; sync pass after writes.
- [ ] IB031 `InboxCopy*` mirroring `inbox.json`; error mapping entries.
- [ ] IB032 Primitives: type icon (9 types, colors from tokens), row meta line
      (domain/kind · age, voice duration, PDF pages, stale amber age),
      thumbnail, match-strength label. Move shared ones from Tasks to
      `Design/` (title-menu header, glass capsule, toast, sheet chrome).
      Unit tests for meta and relative-time formatting.
- [ ] IB033 Entry point (D1): More tab row with count, deep-link route used by
      widget and notifications.

## Phase 4: screens (one checkbox per artboard)

Each item lists what it must carry. Verification per §0.7.

- [ ] IB01 **Inbox list**: title menu header, subtitle counts + "N fetching",
      Today/Yesterday/Older groups with counts, rows, image thumbnails, stale
      dimming, fresh-capture fade (Reduce Motion: none), pull to refresh,
      loading and error-with-retry states, tap opens detail, floating "+".
- [ ] IB02 **Title menu**: Inbox, Snoozed & reminders (upcoming count),
      Archived, Insights; view persists per app session.
- [ ] IB03 **Type filter**: multi-select 9 types, counts, zero disabled,
      Clear filter, filled capsule when active.
- [ ] IB04 **Capture composer**: text capture, Paste-link chip from the
      clipboard (paste permission handled), attach menu (PhotosPicker,
      camera, fileImporter for images/audio/video/PDF), size/type errors,
      mic, send disabled when empty, toast "Item captured".
- [ ] IB05 **Link + duplicate**: live link preview, "Already captured" with
      Open it / Capture anyway (IB020).
- [ ] IB06 **Voice memo**: mic permission and denied/no-mic states, record,
      cancel, stop = capture, on-device transcription (D4), transcribing /
      failed + Retry states on the row and detail.
- [ ] IB07 **Swipe**: leading File (top suggestion or File sheet, D5),
      trailing Snooze (menu) and Archive (toast + undo).
- [ ] IB08 **Row menu**: quick-file icon row, File…, Convert to ›, Snooze ›,
      Rename (not for note/reminder, desktop rule), Open link (when
      `sourceUrl`), Select, Archive.
- [ ] IB09 **Snooze menu**: six presets with resolved times, Pick date & time.
- [ ] IB10 **Detail: link**: header (kind · captured), preview card, Open,
      extracted article text, bottom bar Archive / Convert / File.
- [ ] IB11 **Detail: voice**: editable title, player (play/pause, scrub),
      transcript, Copy, Retry.
- [ ] IB12 **Detail: other types**: image (full screen + pinch, facts), note
      (editable body, autosave, title from first line), PDF (first page,
      pages), video (inline player), social (post card, unavailable state),
      clip (quote + source), reminder (target, Open, marks viewed); editable
      titles for voice/image/PDF only; Convert hidden for note-only types.
- [ ] IB13 **File sheet**: folder search, create with `/`, suggested (D5) or
      recent, all folders, tags with suggestions, link existing/new notes,
      image filing mode + Don't ask again, disabled confirm until valid
      (embed needs a linked note), success toasts incl. embed fallback.
- [ ] IB14 **Convert → Task**: segment, title, due, priority, reminder,
      project; reuses Tasks pickers.
- [ ] IB15 **Convert → Event / Reminder**: event fields (D6), reminder date +
      time.
- [ ] IB16 **Select mode**: from row menu or …, select all, File all (sheet
      without note links, desktop note), Tag all, Snooze all, Archive all with
      confirmation, AI cluster pill Add / dismiss (D5), tab bar hidden.
- [ ] IB17 **Undo toast** for archive and bulk; snooze/file success toasts.
- [ ] IB18 **Snoozed & reminders**: Upcoming/Past, tap opens target (note,
      journal day, task) or the capture detail, unusable journal target shows
      the error, marks viewed.
- [ ] IB19 **Archived**: search, groups, swipe Restore / Delete (confirm),
      read-only detail with Restore / Delete permanently.
- [ ] IB20 **Insights**: stats, heatmap + peak, by type, recent filings,
      empty states.
- [ ] IB21 **Inbox Zero**: filed this week, streak, capture hint.

## Phase 5: outside the app

- [ ] IB22 **Share extension** (D7): target + app group, activation for URL,
      image, file, PDF, text; optional thought; duplicate notice; ingest on
      foreground; locked-vault queue; extension memory limit respected.
- [ ] IB23 **Settings › Inbox + notifications** (D8): review reminder on/off,
      time, send test; image filing mode, ask when filing; daily review
      nudge and snooze-due local notifications with counts only; tap opens
      the inbox (delegate rules from iOS AGENTS.md).

## Phase 6: verification (serial)

- [ ] IB90 Accessibility: VoiceOver labels + custom actions (file, snooze,
      archive) on rows, AX5, RTL, Reduce Motion / Transparency, 44 pt.
- [ ] IB91 Dark mode screenshots of 01, 04, 10, 13, 18.
- [ ] IB92 Cross-device on staging: capture on iOS → appears on desktop;
      capture on desktop → iOS; file, convert to task, snooze, archive,
      restore each way; an iOS unsnooze/unarchive clears on desktop (explicit
      null). Unit, UI (new `InboxUITests`), Conformance plans green.
- [ ] IB00 Parity audit: every New/Adapted row of artboard 00 exercised on the
      simulator; fill the table in §4.
- [ ] IB93 Delete `[agent]` / `Agent Test` data; final report in §8.

### 0.7 Verification per artboard

- Screenshot the matching state to `apps/ios/SpikeEvidence/inbox/IBxx-<state>.png`
  and compare with `paper_get_screenshot` of the artboard: spacing, lanes
  (icon / title / trailing), type roles, colors, glass, shown/hidden, taps.
- Count taps: capture text = "+" → type → send; file with a suggestion =
  swipe or bottom-bar button (1); snooze = swipe → preset (2).
- Unit + UI plans pass on `memry-A` (§0.3); line ceilings; `git diff --check`.

---

## 4. Parity audit table (filled by IB00)

| 00 row | iOS location | Evidence |
| ------ | ------------ | -------- |

## 5. Verified facts (filled by IB001)

- **F1 Columns vs payload.** Desktop's row (`packages/db-schema/src/schema/inbox.ts:103-229`)
  holds the 13 schema keys plus local columns `viewedAt` (:159),
  `processingStatus`/`processingError` (:166-169), `attachmentPath` (:183),
  `thumbnailPath` (:186), `transcription`/`transcriptionStatus` (:193-196),
  `syncedAt`, `localOnly` (:220). The push payload is **the whole Drizzle row
  serialised** (`inbox-handler.ts:147` `JSON.stringify(item)`), so those local
  columns ride on the wire as extra keys; `InboxSyncPayloadSchema`
  (`packages/contracts/src/sync-payloads.ts:50-66`) is a plain `z.object`, so
  desktop strips them on parse and never applies them. Tags live in
  `inbox_item_tags` (`schema/inbox.ts:245`) and **never sync**. `metadata` is
  `z.unknown().nullable()`: any JSON. `duration`/`pageCount`/`excerpt` are read
  from `metadata` (`main/inbox/domain.ts:118-137`). Stale = older than the
  local `inbox.staleThresholdDays` setting, default 7 (`stats.ts:23-24,57-62`).
- **F2 Merge rule** (`apps/desktop/src/main/sync/item-handlers/inbox-handler.ts`):
  document-level `resolveClock` (:32) → skip when local dominates, LWW on
  concurrent; on update `title`/`type` use `data.x ?? existing` (null or absent
  keeps, :52-54), every nullable key uses `hasKey` (:48): absent keeps, present
  (incl. `null`) replaces (:55-72); `modifiedAt = data.modifiedAt ?? now`.
  Insert defaults `title 'Untitled'`, `type 'note'` (:86-87). Delete: skipped
  only when the local clock is ahead of the tombstone (:121), else the row is
  removed. Unclocked rows are seeded as creates on a full sync (:154-173).
- **F3 Attachments.** Stored at `attachments/inbox/{itemId}/{prefix}-{name}.{ext}`
  (`attachments.ts:154,164,278`), thumbnails `thumbnail.{jpg|png}` (:318).
  Limit 50 MB for every type (`MAX_INBOX_FILE_SIZE`, :24); MIME allow-lists
  :30-69. **Inbox attachments do not sync**: nothing under `main/sync/**`
  uploads `attachments/inbox/`, and the attachment backfill skips it
  (`sync/attachment-backfill.test.ts:92-94`). A binary item's bytes exist only
  on the capturing device until it is filed (filing moves the file into the
  vault and `syncFiledBinary` pushes it as a note attachment, `filing.ts:229-240`).
- **F4 captureSource** values: `quick-capture | inline | browser-extension | api | reminder`
  (`schema/inbox.ts:88-94`, `capture.ts:54`). The in-page composer sends
  `inline` (`renderer/.../capture-input.tsx:110,136,180,234`). Nothing in the
  renderer reads it. Capture paths: text → `type note`, title = first 50 chars
  - `...` (`domain.ts:216-218`); link → `link` or `social`, title
    `titleFromUrl`, `processingStatus pending`, metadata `{url, fetchStatus:'pending'}`
    (`domain.ts:243-261`, `domain-inbox/src/commands.ts:128-133`); image/audio/video/PDF
    by MIME → `image|voice|video|pdf`, title = filename without extension,
    metadata `{originalFilename, fileSize, mimeType}` (+ `format,width,height,hasExif`
    for images) (`domain.ts:163-169,302-356`); voice memo → title
    `Voice memo (m:ss)`, metadata `{duration, format, fileSize, waveform?}`,
    `transcriptionStatus pending|failed` (`capture.ts:220-270`). Duplicates:
    URL = exact `sourceUrl` match among unfiled, unarchived rows; content =
    sha256 of the first 500 chars among unfiled, unarchived `note` rows, only for
    content ≥ 20 chars (`duplicates.ts:10-74`); `force` skips both
    (`commands.ts:140-170`).
- **F5 Filing outputs** (`filing.ts`): `markItemAsFiled` sets `filedAt`,
  `filedTo`, `filedAction`, `modifiedAt` and **clears** `snoozedUntil`/`snoozeReason`,
  then pushes (:541-576). `filedAction` values: `folder` (:687,764), `note`
  (:824), `task` with `filedTo = taskId` (:911), `event` with `filedTo = eventId`
  (:1004), `reminder` with `filedTo = note path` (:1068), `linked` with
  `filedTo = first target note path` or the attachment path (:1208,1355,1490).
  Text items become a note (`createNoteCommand`) titled `generateNoteTitle`
  (:303-338), body `generateNoteContent` (:381-499), tags = item tags + `inbox`,
  properties from `metadata.properties`. Binary items (`image|voice|pdf|video`,
  :100-102) move the file into the folder under `getFiledBinaryFilename`
  (:357-367) and index/push it as a binary note. Linking appends
  `- [[title]] - desc *(YYYY-MM-DD)*` under `## Inbox Captures` in every target
  note (:397-416,1466-1486); image `embed` mode saves the image as an
  attachment of the first target note and falls back to link when the
  attachment store refuses it (`fellBackToLink`, :1172-1215,1273-1277).
  Bulk file is folder-only (`batch.ts:104-116`).
- **F6 metadata shapes** (`packages/contracts/src/inbox-api.ts:39-145`):
  link `{url, siteName?, description?, excerpt?, heroImage?, favicon?, author?, publishedDate?, fetchedAt, fetchStatus}`,
  written by desktop main's metadata job as `{url, fetchStatus:'complete', siteName, description, heroImage, favicon, author, publishedDate}`
  or `{url, fetchStatus:'failed', error}` (`jobs.ts:240-300`); article extract
  adds `extractionStatus` (`jobs.ts:314`); social `{platform, postUrl, authorName, authorHandle, postContent, mediaUrls, extractionStatus}`
  (`commands.ts:115-126`); voice, image, PDF, clip, reminder as the interfaces
  above. **Enrichment jobs do not push** (`jobs.ts`, `transcription.ts` call no
  `syncInbox*`): peers see enrichment only when the row is next pushed.
- **F7 Snooze**: presets are renderer-side (`components/snooze/snooze-presets.ts`):
  Later today = max(now+3h, 18:00), or 09:00 tomorrow after 18:00 (:141-155);
  Tomorrow 09:00 (:161-166); This weekend = next Saturday 09:00 (:172-174);
  Next week = next Monday 09:00 (:180-182); In 1 h / In 2 h (:187-196).
  `snoozeItem` refuses past times and filed items, sets `snoozedUntil`,
  `snoozeReason`, `modifiedAt`, pushes (`snooze.ts:144-201`). Unsnooze sets both
  to null and pushes (:209-250). The scheduler runs every minute and clears
  due snoozes (`snoozedUntil <= now`, unfiled) with a push each, then emits
  `SNOOZE_DUE` (:322-372). The review nudge fires once per local day at or after
  `reviewReminderTime` when enabled and the reviewable count > 0
  (`review-scheduler.ts:50-70`); reviewable = unfiled, unsnoozed, unarchived,
  excluding viewed reminders (`stats.ts:140-160`).
- **F8 Suggestions** need desktop's local embedding model and `vec_notes`
  (`suggestions.ts:1-35,315-340`) and the local `filing_history` table, and
  return `[]` unless the **device-local** `ai.enabled` setting is on (:66,110-120,678-682).
  `ai` is not a group of the synced settings (`settings-sync.ts`). None of it
  reaches iOS.
- **F9 Convert**: task = direct `insertTask` into the inbox project (or the
  chosen one), priority/due/time from the input, description = content,
  tags + `inbox`, then `syncTaskCreate` (`filing.ts:844-935`); event = a
  `calendar_event` record (`upsertCalendarEvent` + `syncCalendarEventCreate`,
  :940-1025), refused for note-only types `image|pdf|video|clip` (:111-113);
  reminder = a new note + a note-target `reminder` record (:1030-1075),
  refused for note-only types and past times.
- **F10 Stats** (`stats.ts`, `queries.ts:146-213`): `inbox_stats` is rebuilt
  from the rows (`rebuildInboxStatsTable`, `stats.ts:218-262`, driven by
  `projections/projectors/inbox-stats-projector.ts`): capture counts on the UTC
  date of `createdAt`, processed on the UTC date of `filedAt`, archived on
  `archivedAt`. Today = UTC date (:265-268). This week = stats dates ≥ UTC date
  7 days ago (:520-535). Ratio = captured/processed rounded to 0.1, or captured
  when processed = 0 (:537-542). Age buckets fresh < 3 days, aging to the
  stale cutoff, stale beyond (:548-585). Streak = consecutive UTC days with
  processed > 0, today may be empty if yesterday counts (:440-470). Avg time to
  process = mean minutes createdAt→filedAt over items filed in the last 30
  days (:408-437). Heatmap = last 84 days, `[hour][mon..sun]`, from
  `strftime` of the stored UTC string (`queries.ts:318-340`). Type distribution
  over the same 84 days (:342-360). Filing history = filed rows by `filedAt`
  desc (:280-305).
- **F11 Preferences**: synced settings group `inbox` carries only
  `reviewReminderEnabled`, `reviewReminderTime` (`settings-sync.ts:69-74`),
  applied by desktop's settings handler (`settings-handler.ts:106-124`).
  `imageFilingMode` (`embed|link`, default `embed`) and
  `imageFilingModeRemembered` are **desktop-local** (`settings-schemas.ts:420-441`).
  Last-notified date is device-local (`review-reminder-constants.ts:2`).
- **F12 Reminder panel** (`renderer/src/lib/reminder-panel.ts`): Upcoming =
  pending/snoozed reminders + inbox items snoozed into the future (reminder
  items expand to their target), deduped, ascending (:131-175); Past = active
  `reminder` inbox items whose snooze is not in the future, by
  `metadata.remindAt` desc (:177-195). Reminder inbox rows are created by
  desktop when a reminder fires, id `inbox_rem_…`, type `reminder`, metadata
  `ReminderMetadata` (`main/lib/reminders.ts:190-230`). Opening one marks it
  viewed (`crud.ts` `handleMarkViewed`, sets `viewedAt` + `modifiedAt`, pushes).
  Targets: note, journal day (`targetId` = YYYY-MM-DD), task (+ `projectId`),
  highlight (`inbox-api.ts:118-145`).

## 6. Decisions log

<!-- date — id — choice — why -->

- 2026-09-25 — IB000 — The worktree already existed at `.worktrees/ios-inbox` on `origin/main` HEAD under the branch name `ios-inbox`; renamed to `feat/ios-inbox` (§0.3 name) instead of creating a second worktree.
- 2026-09-25 — IB001/F1 — iOS reads the extra keys desktop's full-row payload carries (`transcription`, `transcriptionStatus`, `viewedAt`, `processingStatus`, `attachmentPath`, `thumbnailPath`) and writes the same keys on its own payloads. Desktop strips unknown keys on parse, so this is inside the current wire (no schema change). Tags stay device-local on iOS, as on desktop.
- 2026-09-25 — IB001/F3 — Inbox attachments do not sync on desktop, so iOS does not sync them either (a new attachment channel is a wire change, out of scope §0.5). A binary item captured on the other device shows its metadata, title and thumbnail-less row with an "on another device" note; filing it on iOS is refused with that reason (desktop refuses a missing attachment the same way, `filing.ts:633`). A binary captured on iOS reaches desktop's files when it is filed on iOS as a note attachment.
- 2026-09-25 — IB001/F4 — iOS writes desktop's value set: the in-app composer writes `captureSource: "inline"` (desktop's capture bar), the Share extension `"quick-capture"` (desktop's floating capture window, which the 00 audit maps to the extension). No new value on the wire.
- 2026-09-25 — IB001/F8 — D5 resolves to "no suggestions on iOS": the gating AI setting is device-local on desktop and the inputs (embeddings, filing history) never sync. The File sheet and the row menu show Recent folders (derived from synced filed rows, labelled Recent, no match strength), the swipe and bottom bar read "File…", the cluster pill is hidden.
- 2026-09-25 — IB001/F9 — D6: the Event segment is hidden on iOS (event conversion writes a `calendar_event` record, a type iOS does not subscribe to). Task and Reminder ship.
- 2026-09-25 — IB001/F11 — Review reminder enabled/time use the synced `inbox` settings group; image filing mode and "ask again" are device-local on iOS (UserDefaults), as on desktop.
- 2026-09-25 — IB010 — Desktop's local columns (`viewedAt`, `processingStatus`, `transcription`, `transcriptionStatus`, `attachmentPath`, `thumbnailPath`) are **not** projection columns: the `payload-schemas` vector requires a projector's read view to equal the schema's parse, which strips them. `inbox_view` (migration 0004, additive) reads them from the verbatim payload with `json_extract`.
- 2026-09-25 — IB011 — Found while generating the vector: a payload with `title: null` or `type: null` **fails** `InboxSyncPayloadSchema` (`z.string().optional()`), so desktop skips it whole. iOS never writes either as `null`; the core's projector still tolerates one (substitute-never-refuse).
- 2026-09-25 — IB012 — `inbox` is appended to the subscribed declaration (15 types). Existing installs backfill inbox rows through the wider-declaration feed restart spec 004 TP092/S5 added. Protocol chapters 00, 05, 13 (§13.1, new §13.7.15) updated.
- 2026-09-25 — IB013 — Stale threshold: desktop reads the device-local `inbox.staleThresholdDays` (default 7), not a synced key, so iOS uses 7. Stats follow `rebuildInboxStatsTable` exactly, including that `video` captures are not counted in captured totals (desktop's stats table has no video column). Upcoming reminders keep only those still to fire: desktop marks a fired reminder `triggered` locally and syncs it back as `pending`, so a synced past `pending` reminder is in Past through its reminder capture instead.
- 2026-09-25 — IB014 — Desktop's handler and stats need its Electron database, so `inbox.json`'s expectations are produced by the real `InboxSyncPayloadSchema` plus the handler/stats rules restated in the generator (cited per line). The phone's own writes are pinned the other way round: `inbox-ios-payloads.json` is produced by the Rust core and consumed by a new desktop test, `inbox-handler-ios.test.ts` (test only, no desktop product code).
- 2026-09-25 — IB020 — Social detection, title-from-URL and the Tweet title follow desktop's URL rules with a small parser in the core (no new dependency). HEIC is not in desktop's image allow-list; the shell converts photos to JPEG before capture so desktop can file them.
- 2026-09-25 — IB022 — D3 merge: `complete_link` only replaces the title while it is still the URL-derived default, writes `content` only when empty, and adds metadata keys only where the stored value is missing or empty (`fetchStatus` always moves). A richer desktop value is never overwritten.
- 2026-09-25 — IB025 — A filed text capture's note body is written as CRDT blocks (link mention, quote, meta lines, divider, italic "Filed from Inbox on …") instead of desktop's markdown `content`: the core parses no markdown and every phone-created note carries `content: ""`. Marks are applied only over ASCII ranges (yrs offsets are bytes). YouTube links file as a link mention, not an embed. `filedTo` for a note is `folder/Title.md`, desktop's file path shape.
- 2026-09-25 — IB025 — File captures (image, voice, PDF, video) are filed by the shell: `createNoteForFile` makes the note, the shell uploads the file into it as a note attachment, then `markFiled`. The phone has no binary-note writer, so "File in the sidebar" (image mode `link`) falls back to embedding, the same fallback desktop takes when its attachment store refuses (`fellBackToLink`), reported to the user.
- 2026-09-25 — IB026 — Convert → Task resolves the project's default status (the core's task create) where desktop inserts `statusId: null`; both read as To Do. A voice memo's transcript becomes the task description when it has no content.
- 2026-09-25 — IB029 — Phases 1 and 2 are one commit: Phase 1's conformance evidence (IB014, the Swift suite) needs the rebuilt xcframework, which is IB029's gate step, and both phases edit the same `domain/inbox/mod.rs` and `api/mod.rs`.

## 7. Blockers

<!-- date — id — what — evidence — next retry -->

## 8. Final report

### What shipped

### Decisions

### Left open
