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

- [x] IB030 `Features/Inbox/InboxStore` over the new UniFFI surface: list,
      filters, counts, snoozed, archived, stats; optimistic remove with
      rollback like `archiveWithAnimation`; sync pass after writes.
      Evidence: `xcodebuild test -testPlan Unit -only-testing:MemryTests/InboxStoreTests` on memry-A: `capture_lists_and_archive_hides_with_undo`, `the_type_filter_and_the_views` passed.
- [x] IB031 `InboxCopy*` mirroring `inbox.json`; error mapping entries.
      Evidence: `Features/Inbox/InboxCopy{,+Sheets,+Detail,+Settings}.swift`, `InboxErrors.swift`; app builds, swiftlint reports no errors in `Features/Inbox`.
- [x] IB032 Primitives: type icon (9 types, colors from tokens), row meta line
      (domain/kind · age, voice duration, PDF pages, stale amber age),
      thumbnail, match-strength label. Move shared ones from Tasks to
      `Design/` (title-menu header, glass capsule, toast, sheet chrome).
      Unit tests for meta and relative-time formatting.
      Evidence: `Design/{Chrome,UndoToast,TitleMenuHeader}.swift` shared with Tasks; `-only-testing:MemryTests/InboxFormattingTests` 7 tests passed (suite "Inbox formatting"; 9 tests in 2 suites total).
- [x] IB033 Entry point (D1): More tab row with count.
      Superseded by IB033b (§6): the Inbox is a tab and Home is removed.
      Evidence: memry-A signed in to MemryNote, More tab shows "Inbox 28", tapping opens the list "28 to process": `apps/ios/SpikeEvidence/inbox/IB033-more-row.png`.
- [x] IB033a Deep-link route used by widget and notifications (verified with IB23).
      Evidence: memry-A, a Send-test notification tapped while the app was
      on the Tasks tab opened the Inbox list
      (`SpikeEvidence/inbox/IB23-notification-opens-inbox.png`).

## Phase 4: screens (one checkbox per artboard)

Each item lists what it must carry. Verification per §0.7.

- [x] IB01 **Inbox list**: title menu header, subtitle counts + "N fetching",
      Today/Yesterday/Older groups with counts, rows, image thumbnails, stale
      dimming, fresh-capture fade (Reduce Motion: none), pull to refresh,
      loading and error-with-retry states, tap opens detail, floating "+".
      Evidence: memry-A, Paper 01 (390-0): title menu header, "28 to process
      · 11 filed today" (+ "Filtering by 1 type" when filtered), Today /
      Yesterday / Older with counts, type-tinted rows, image thumbnail on a
      photo captured here, tap opens the detail, floating "+". Pull to
      refresh ran a sync pass (log "inbox sync pass pulled [count=1]").
      Stale dimming: `InboxFormattingTests` (§6 IB01). Live error state split
      to IB01a. `SpikeEvidence/inbox/IB01-list.png`,
      `IB01-filtered-after-refresh.png`, `IB04-photo-captured.png`.
- [x] IB01a **Inbox list error state** live: `InboxFailureRow` with Try again
      on a failed read. No read fails on memry-A; force one in Phase 6
      (offline launch) or cover it with a store test.
      Evidence: store test `InboxFailureTests` renames `inbox_items` away
      under a real scratch vault. `load()` then sets `failure`, which the list
      shows as the row, and after the rename back, `load()` (the row's Try
      again) clears it. Result: 7/7 with InboxStoreTests on memry-A. An offline
      launch does not fail a read, since reads are local SQLite (§6). The
      staging vault's table was not renamed live.
- [x] IB02 **Title menu**: Inbox, Snoozed & reminders (upcoming count),
      Archived, Insights; view persists per app session.
      Evidence: memry-A, Paper 02 (3PA-0): Inbox 19 (checked), Snoozed &
      reminders 5, Archived, Insights; counts as native subtitles (§6). Chose
      Archived, backed out to More, reopened -> still "Archived" (5 items).
      `SpikeEvidence/inbox/IB02-title-menu.png`.
- [x] IB03 **Type filter**: multi-select 9 types, counts, zero disabled,
      Clear filter, filled capsule when active.
      Evidence: memry-A, Paper 03 (3XW-0): "Show types" Links 4, Notes 4,
      Images 2, Voice 2, Video 0 (disabled), Clips 2, PDFs 2, Social 2,
      Reminders 1 (menu scrolls); Links only -> list filtered, filter glyph
      filled, Clear filter shown. `SpikeEvidence/inbox/IB03-filter-menu.png`,
      `IB03-filter-menu-all-types.png`, `IB03-filter-active.png`.
- [x] IB04 **Capture composer**: text capture, Paste-link chip from the
      clipboard (paste permission handled), attach menu (PhotosPicker,
      camera, fileImporter for images/audio/video/PDF), size/type errors,
      mic, send disabled when empty, toast "Item captured".
      Evidence: memry-A, Paper 04 (427-0): text capture -> "Item captured";
      a copied URL shows the "Paste link" chip (pattern detection, no paste
      prompt until tapped) and fills the field with the live preview; attach
      menu Photo Library / Choose File (Camera only where a camera exists;
      the simulator has none); Photo Library capture -> image row "Photo ·
      1,5 MB"; Choose File opens the Files importer; send disabled when
      empty. Size/type refusals: `InboxStoreTests.an_unsupported_or_oversized_file_is_refused`.
      `SpikeEvidence/inbox/IB04-composer.png`, `IB04-captured-toast.png`,
      `IB04-paste-chip.png`, `IB04-pasted-link.png`, `IB04-attach-menu.png`,
      `IB04-file-importer.png`, `IB04-photo-captured.png`.
- [x] IB05 **Link + duplicate**: live link preview, "Already captured" with
      Open it / Capture anyway (IB020).
      Evidence: memry-A, Paper 05 (46I-0): typed link -> live preview card
      (title, domain); an already captured URL -> "Already captured: "…" · 5h
      ago" with Open it (opens the detail, clears the draft, §6) and Capture
      anyway (new row, "Item captured", 23->24).
      `SpikeEvidence/inbox/IB05-live-preview.png`, `IB05-duplicate.png`,
      `IB05-capture-anyway.png`.
- [x] IB06 **Voice memo**: mic permission and denied/no-mic states, record,
      cancel, stop = capture, on-device transcription (D4), transcribing /
      failed + Retry states on the row and detail.
      Evidence: memry-A, Paper 06 (4AT-0) after restyle (§6): scrim over the
      list, tab bar hidden, "Recording" + timer, centered bars, centered
      caption, grey cancel, orange stop. Stop -> "Voice memo (0:06)" row,
      "Transcription failed" (silent simulator input) with Retry in the
      detail; an interrupted memo resumes on next launch (§6). Denied /
      no-mic alert: `recorder.phase` `.denied` / `.failed` path (the
      simulator grants the mic). `SpikeEvidence/inbox/IB06-recording.png`,
      `IB06-captured-failed.png`.
- [x] IB07 **Swipe**: leading File (top suggestion or File sheet, D5),
      trailing Snooze (menu) and Archive (toast + undo).
      Evidence: memry-A, Paper 07 (4F4-0) tints matched: File brand orange
      (`Tint.base`), Snooze grey (`Text.tertiary`, alarm glyph), Archive near
      black (`Text.primary`). Full leading swipe files to the top recent
      folder ("Filed to Notes" + Undo, see §7 note); trailing Snooze opens
      the preset menu; Archive shows the undo toast.
      `SpikeEvidence/inbox/IB07-swipe-leading.png`, `IB07-swipe-trailing.png`,
      `IB09-snooze-swipe-menu.png`, `IB17-archive-undo-toast.png`.
- [x] IB08 **Row menu**: quick-file icon row, File…, Convert to ›, Snooze ›,
      Rename (not for note/reminder, desktop rule), Open link (when
      `sourceUrl`), Select, Archive.
      Evidence: memry-A, Paper 08 (4JF-0) groups matched. Link row: quick-file
      row (Agent Test / Notes / food, recents per D5), File…, Convert to ›,
      Snooze ›, Rename, Open link, Select, Archive. Note row: no Rename, no
      Open link. Convert to › offers Task / Reminder / Note.
      `SpikeEvidence/inbox/IB08-row-menu-link.png`, `IB08-row-menu.png`.
- [x] IB09 **Snooze menu**: six presets with resolved times, Pick date & time.
      Evidence: memry-A, Paper 09 (4NQ-0): "Snooze until" section Later today
      18:00 / Tomorrow Sat 09:00 / This weekend Sat 09:00 / Next week Mon
      09:00, then In 1 hour 06:26 / In 2 hours 07:26, then Pick date & time…
      (calendar glyph). Same menu from swipe and bulk bar (reversed from the
      bottom bar, system). `SpikeEvidence/inbox/IB09-snooze-swipe-menu.png`,
      `IB09-snooze-menu.png`.
- [x] IB10 **Detail: link**: header (kind · captured), preview card, Open,
      extracted article text, bottom bar Archive / Convert / File.
      Evidence: memry-A, Paper 10 (5Z2-0): "Link · Captured …" header; a
      fresh capture shows the og:image hero with the site name, the page
      description and domain + Open (enrichment §6); a desktop capture shows
      its stored content in the card; bottom bar Archive / Convert / File….
      `SpikeEvidence/inbox/IB10-detail-link-hero.png`,
      `IB10-detail-link-content.png`, `IB10-detail-link-no-thumb.png`.
- [x] IB11 **Detail: voice**: editable title, player (play/pause, scrub),
      transcript, Copy, Retry.
      Evidence: memry-A, Paper 11 (6HF-0) after restyle (§6): editable title
      (desktop keeps the stored title, placeholder only when empty), player
      card with the waveform as scrubber; tap at 60% then Play -> 0:14 of
      0:21 with played bars tinted; "Transcription failed" + Retry. Copy
      shows only with a transcript (none on the silent simulator).
      `SpikeEvidence/inbox/IB11-voice-detail.png`.
- [x] IB12 **Detail: other types**: image (full screen + pinch, facts), note
      (editable body, autosave, title from first line), PDF (first page,
      pages), video (inline player), social (post card, unavailable state),
      clip (quote + source), reminder (target, Open, marks viewed); editable
      titles for voice/image/PDF only; Convert hidden for note-only types.
      Evidence: memry-A, Paper 12 (6IX-0): image detail (photo, facts,
      inline title; Done saves, §6), tap -> full screen with close; note
      (title + editable body); PDF captured on desktop -> "The file is on the
      device that captured it." + Size (§5 F3), no Convert; social post card
      with "View on Reddit" (§6); clip quote bar + source link, no Convert;
      reminder "Reminder triggered", Source + Open, "Viewed". Video split to
      IB12a. `SpikeEvidence/inbox/IB12-detail-image.png`,
      `IB12-image-fullscreen.png`, `IB12-title-renamed.png`,
      `IB12-detail-note.png`, `IB12-detail-pdf-elsewhere.png`,
      `IB12-detail-social.png`, `IB12-detail-clip.png`,
      `IB12-detail-reminder.png`.
- [x] IB12a **Detail: video** inline player. No video capture exists on the
      account and the simulator's Photos picker is images-only; check with a
      `.mov` through Choose File in Phase 6.
      Evidence: memry-A. A 4 s test `.mov` made with ffmpeg and added with
      `simctl addmedia` was shared from Photos to Memry
      (`IB12a-share-video.png`). It was ingested as a video row
      (`2WqSgjyofeugOpTAVbvm3`, source quick-capture). The detail shows
      "Video · Captured today at 14:43" and the inline player
      (`IB12a-detail-video.png`); a tap plays it with system controls
      (`IB12a-video-playing.png`). Videos have no Convert button because
      desktop treats them as note-only.
- [x] IB13 **File sheet**: folder search, create with `/`, suggested (D5) or
      recent, all folders, tags with suggestions, link existing/new notes,
      image filing mode + Don't ask again, disabled confirm until valid
      (embed needs a linked note), success toasts incl. embed fallback.
      Evidence: memry-A, Paper 13 (6QO-0): search/create field, Recent
      (Agent Test / Notes / food, D5), All folders, tag suggestions
      (+#inbox +#reference +#fitness; empty vault shows only Add tag),
      "Agent Test" created earlier through the sheet. `[agent] swipe row` +
      #reference + new note "[agent] link target" -> "Linked to note",
      filed_action `linked`, both notes in Agent Test, tags inbox,reference.
      Image: embed mode with a folder and no note -> confirm disabled +
      "Embedding needs a linked note." (desktop `canFileItem`); "File in the
      sidebar" + Agent Test -> filed (`folder`), image embedded in a note
      (§6 IB13 fixes), fallback toast. `filing_confirms_only_when_it_can_land`.
      `SpikeEvidence/inbox/IB13-file-sheet.png`, `IB13-link-create.png`,
      `IB13-linked-toast.png`, `IB13-file-image-mode.png`,
      `IB13-embed-needs-note.png`, `IB13-image-filed-in-note.png`,
      `IB13-filed-toast.png`.
- [x] IB14 **Convert → Task**: segment, title, due, priority, reminder,
      project; reuses Tasks pickers.
      Evidence: memry-A, Paper 14 (6S6-0) layout matched: segment, dashed
      circle + title, Due/Priority/Remind me/Project value rows with chevrons,
      footer. Due opens `TaskDateSheet`, Remind me opens
      `TaskReminderPickerSheet` (Tasks pickers). Picked Next Week -> "Monday"
      in the upcoming tint; confirm -> "Converted to Task" toast, 28->27,
      task `dzAu-iLRaX5LAdehUCvtt` in Tasks "Priority: Medium, Due Monday,
      Project: Inbox". `SpikeEvidence/inbox/IB14-convert-task.png`,
      `IB14-converted-toast.png`, `IB14-task-created.png`.
- [x] IB15 **Convert → Event / Reminder**: event fields (D6), reminder date +
      time.
      Evidence: memry-A, Event hidden per D6; Reminder shows "Remind me at"
      date + Time rows (Paper 15 caption). Confirm -> reminder
      `rem_EcysmJBdhQwn3XKLTYcWY` listed in Snoozed "Tomorrow, 09:00, Note";
      Convert -> Note -> "Converted to Note" toast.
      `SpikeEvidence/inbox/IB15-convert-reminder.png`,
      `IB15-reminder-in-snoozed.png`, `IB15-converted-note.png`.
- [x] IB16 **Select mode**: from row menu or …, select all, File all (sheet
      without note links, desktop note), Tag all, Snooze all, Archive all with
      confirmation, AI cluster pill Add / dismiss (D5), tab bar hidden.
      Evidence: memry-A, Paper 16 (4S1-0): no back button, Select all +
      checkmark, "N selected" title, circle in the type lane, one glass bar
      File / Tag / Snooze / Archive, tab bar hidden. Entered from row menu and
      "…" › Select; Select all -> "21 selected" / Deselect all. Tag all ->
      "Applied 1 tag to 2 items"; Snooze all -> "Snoozed 2 items until…";
      File all sheet shows the desktop no-links note, -> "Filed 2 items to
      Agent Test"; Archive all asks ("Archive 2 items?", popover from the
      bar) -> exits select mode, 21->19. Cluster pill hidden (D5).
      `SpikeEvidence/inbox/IB16-select-mode.png`, `IB16-select-all.png`,
      `IB16-bulk-tag.png`, `IB16-bulk-file-toast.png`,
      `IB16-archive-confirm.png`.
- [x] IB17 **Undo toast** for archive and bulk; snooze/file success toasts.
      Evidence: memry-A: single archive "Archived" + Undo (restored),
      bulk "Archived 2 items" + Undo, snooze "Snoozed until…", bulk snooze
      "Snoozed 2 items until Today at 06:17", file "Filed to Agent Test" +
      Undo, bulk file "Filed 2 items to Agent Test", convert "Converted to
      Task/Note". `SpikeEvidence/inbox/IB17-archive-undo-toast.png`,
      `IB17-bulk-archive-undo.png`, `IB17-snooze-toast.png`,
      `IB17-bulk-snooze-toast.png`, `IB13-filed-toast.png`.
- [x] IB18 **Snoozed & reminders**: Upcoming/Past, tap opens target (note,
      journal day, task) or the capture detail, unusable journal target shows
      the error, marks viewed.
      Evidence: memry-A, Paper 18 (89G-0): Upcoming with the converted
      reminder "Tomorrow, 09:00, Note" and snoozed captures, Past; a task
      reminder opens the task in the Tasks tab; a snoozed capture opens its
      detail; the reminder detail marks it viewed ("Viewed", IB12). Note and
      journal targets split to IB18a. `SpikeEvidence/inbox/IB18-snoozed.png`,
      `IB18-open-task-target.png`, `IB15-reminder-in-snoozed.png`,
      `IB12-detail-reminder.png`.
- [ ] IB18a **Reminder targets across tabs**: note and journal-day targets
      open in their tab (only task targets route today, §7 limitation);
      unusable journal target error.
- [x] IB19 **Archived**: search, groups, swipe Restore / Delete (confirm),
      read-only detail with Restore / Delete permanently.
      Evidence: memry-A, Paper 19 (8BH-0): groups by `archivedAt` (§6), search
      "agent" -> 4 matches, swipe Restore (row back in Inbox) and Delete with
      confirmation, read-only detail with Restore / Delete permanently.
      `SpikeEvidence/inbox/IB19-archived.png`, `IB19-search.png`,
      `IB19-delete-confirm.png`, `IB19-readonly-detail.png`.
- [x] IB20 **Insights**: stats, heatmap + peak, by type, recent filings,
      empty states.
      Evidence: memry-A, Paper 20 (8KH-0): stats cards, 9-column heatmap with
      peak (§6), by type, recent filings; empty states come from the same
      stats record (zero counts render the empty copy).
      `SpikeEvidence/inbox/IB20-insights.png`.
- [x] IB21 **Inbox Zero**: filed this week, streak, capture hint.
      Evidence: memry-A, Paper 21 (8P7-0) after restyle (§6): check in a
      surface circle, "Inbox Zero", the capture hint, "1 filed this week"
      (ink) and "1 day streak" (tint) as plain facts, block a third down.
      Shown in the account's empty `default` vault after filing
      `[agent] zero check`. `SpikeEvidence/inbox/IB21-inbox-zero.png`.

## Phase 5: outside the app

- [x] IB22 **Share extension** (D7): target + app group, activation for URL,
      image, file, PDF, text; duplicate notice; ingest on
      foreground; locked-vault queue; extension memory limit respected.
      Evidence: memry-A. `MemryShare.appex` (app group
      `group.com.memry.app`) shows as "Memry" in Safari's and Photos' share
      sheets (`IB22-share-sheet-memry.png`); Paper 22 sheet with the link card
      (`IB22-share-extension.png`) and the photo card with thumbnail and size
      (`IB22-share-photo.png`). A drop made before any vault was open waited
      in `inbox-share/` until MemryNote was opened past the vault picker, then
      became link row `fpYOYJdYUlcDU8EB2Oegu` (`capture_source`
      `quick-capture`) with the "1 shared item saved" toast
      (`IB22-ingested-toast.png`). Sharing the same URL again showed "Already
      captured" with Confirm disabled until Capture anyway
      (`IB22-already-captured.png`, `IB22-capture-anyway.png`); foregrounding
      the app ingested it as a second row (`1jvrwur4luXK_vLRFz-Lv`). The Photos
      share became image row `4qz927pCscN7FUtZ9iI_X` (4.1 MB,
      `IB22-photo-ingested.png`). Close enqueues nothing (queue empty).
      Memory: the extension never loads a payload into memory; files are
      copied from `loadFileRepresentation`, thumbnails come from ImageIO
      downsampling, and anything over 50 MB is refused before the copy.
      Unit `shared_drops_are_captured_on_load` (link, text, file, duplicate,
      forced duplicate, digests) green with the Inbox suites (16/16).
- [ ] IB22a Optional thought on a shared item. Not built; see §6 (no field on
      the wire for it).
- [x] IB23 **Settings › Inbox + notifications** (D8): review reminder on/off,
      time, send test; image filing mode, ask when filing; daily review
      nudge and snooze-due local notifications with counts only; tap opens
      the inbox (delegate rules from iOS AGENTS.md).
      Evidence: memry-A, Paper 23 (9K0-0) after the header fix (§6):
      More › Inbox › … › Inbox settings (`IB23-settings.png`). Turning the
      reminder on asked for notification permission once and wrote the synced
      `inbox` settings (`reviewReminderEnabled` true, `reviewReminderTime`
      "18:00"); Send test showed "Time to review your inbox" as a banner
      (`IB23-test-notification.png`); tapping it from the Tasks tab opened the
      Inbox (`IB23-notification-opens-inbox.png`). Time set to 13:16 with the
      app in the background fired "Time to review 31 items / Process today's
      captures in one calm pass." at 13:16 (`IB23-review-nudge-fired.png`,
      count only). `[agent] snooze due check` (`sgVekWr2b1138vFN9U0kv`) snoozed
      through Pick date & time to 13:35 fired "1 snoozed item" at 13:35
      (`IB23-snooze-due-fired.png`). Image lands as and Ask when filing are the
      device-local preferences the File sheet reads (IB13). Restored to off,
      18:00, Embedded (`IB23-settings-restored.png`).

## Phase 6: verification (serial)

- [x] IB90 Accessibility: VoiceOver labels + custom actions (file, snooze,
      archive) on rows, AX5, RTL, Reduce Motion / Transparency, 44 pt.
      Evidence: memry-A. The live accessibility tree reads each row as one
      button, "type: title, meta, age" (e.g. "Image: IMG_0111, Photo · 4,1 MB,
      47m"), and every row is at least 61 pt tall. The File, Snooze and
      Archive custom actions are on every row (`InboxRowActions`), and
      Archived rows have Restore and Delete permanently. Reduce Motion drops
      the new-row fade (`InboxRow`), and Reduce Transparency swaps the glass
      for an opaque fill (shared `ChromeGlass`). AX5 exposed two problems,
      fixed in §6: rows cut titles and meta short, and the detail bar
      overflowed. After the fixes: `IB90-ax5-list.png`, `IB90-ax5-detail.png`.
      RTL (`-AppleTextDirection YES`): the glyph lane, thumbnail, separators,
      FAB and toolbars all mirror (`IB90-rtl-list.png`).
- [x] IB91 Dark mode screenshots of 01, 04, 10, 13, 18.
      Evidence: memry-A in dark appearance (set back to light afterwards):
      `IB91-dark-01-list.png`, `IB91-dark-04-composer.png`,
      `IB91-dark-08-row-menu.png`, `IB91-dark-10-link.png`,
      `IB91-dark-13-file.png` and `IB91-dark-18-snoozed.png`. All read from
      the semantic tokens; nothing is hard-coded light.
- [x] IB92 Cross-device on staging: capture on iOS → appears on desktop;
      capture on desktop → iOS; file, convert to task, snooze, archive,
      restore each way; an iOS unsnooze/unarchive clears on desktop (explicit
      null). Unit, UI (new `InboxUITests`), Conformance plans green.
      Evidence: the desktop peer was this worktree's `dev:staging`, run as
      `MEMRY_DEVICE=inbox`, linked by recovery phrase to vault 87614a10 and
      driven over CDP (§7). The other session's `jp-desk` app was not
      touched. - iOS → desktop: all 33 iOS items listed on desktop, including the
      Share-extension links (`captureSource` quick-capture) and the photo. - Desktop → iOS: six `[agent] desk …` captures. After an iOS relaunch,
      D1 and D2 were open, D3 snoozed, D4 archived, D5 filed to Agent Test,
      and D6 filed as task `MITX-qAuig89ImwgciIZo`. - Actions on iOS, checked on desktop: D1 filed to Agent Test (desktop
      wrote its note file), D2 converted to task `pzSiJ97D-vG1Ny6MrimTk`
      (desktop `tasks.get` returns it), D3 unsnoozed and D4 restored (both
      null on desktop), I1 snoozed to 09:00 tomorrow, I2 archived. - Actions on desktop, checked on iOS: I1 unsnoozed and I2 unarchived;
      both columns read null on iOS.
      Screenshots: `IB92-desktop-inbox.png`, `IB92-ios-inbox.png`.
      Test plans on memry-A: - UI: 9 tests pass (Tasks 6, Editor 1, and the new `InboxUITests` 2:
      capture → archive → delete from Archived; snooze → Back to inbox),
      with `TEST_RUNNER_MEMRY_UI_VAULT=scratch` and the driver skipped. - Conformance: 29 tests pass. - Unit: 683 tests pass, skipping the five real-keychain and sign-out
      suites so memry-A stays signed in.
- [x] IB00 Parity audit: every New/Adapted row of artboard 00 exercised on the
      simulator; fill the table in §4.
      Evidence: §4 lists all 25 rows of Paper 00 (AKS-0). The 24 New or
      Adapted rows each point at the IB item and screenshot from memry-A; the
      Desktop-only row is not carried over. The one gap is IB18a
      (note/journal reminder targets), blocked in §7.
- [x] IB93 Delete `[agent]` / `Agent Test` data; final report in §8.
      Evidence: done through this worktree's desktop peer (IB92), which
      synced every change: status idle, 0 pending. - Inbox: 34 rows deleted permanently. These are every live `[agent]`
      row, the unprefixed test captures §7 lists by id (links, voice memos,
      Share1 ×2, IMG_0111, the video, Desk2), and the eight
      `[agent] parent task` reminder rows. - Seed row: `inbox_lnk_0SyBQ1wUWU-R` unfiled with `undoFile`. - Notes: 17 deleted. These are everything under `Agent Test/` (the five
      empty "[agent] Photo" notes, the filed photos, links, desk one/five,
      parent task ×2, link target, swipe row), the root `agent make me a
    note` and `agent remind me later`, and the root basil note the seed
      filing made. The empty `Agent Test` folder was removed too. - Tasks: 23 deleted. These are the three conversions (`dzAu…`, `MITX…`,
      `pzSi…`) and the `[agent] ui-*` Tasks UI rows created in this spec's
      two UI-plan windows (09:19–09:27 and 11:17–11:28 UTC). - Other: saved filters `GGoOX87…` and `zTFEo…` and the IB15 note
      reminder were deleted, and the vault name was set back to "MemryNote". - Default vault: the `[agent] zero check` note was deleted from the iOS
      note page. - Checked on memry-A after a relaunch: 0 live `[agent]` inbox rows, 0
      live `[agent]` notes, the conversion tasks gone, the seed row unfiled,
      and the Share queue empty. Settings were already restored (IB23). - Left in place (§7): data other sessions own, and one filed history row.

### 0.7 Verification per artboard

- Screenshot the matching state to `apps/ios/SpikeEvidence/inbox/IBxx-<state>.png`
  and compare with `paper_get_screenshot` of the artboard: spacing, lanes
  (icon / title / trailing), type roles, colors, glass, shown/hidden, taps.
- Count taps: capture text = "+" → type → send; file with a suggestion =
  swipe or bottom-bar button (1); snooze = swipe → preset (2).
- Unit + UI plans pass on `memry-A` (§0.3); line ceilings; `git diff --check`.

---

## 4. Parity audit table (filled by IB00)

| 00 row                                         | iOS location                                                       | Evidence                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Views: Inbox, Archived, Insights               | New: title menu with Snoozed & reminders as a fourth view (02)     | IB02; `IB02-title-menu.png`                                                                                          |
| Snoozed toggle + reminders panel               | New: title menu › Snoozed & reminders (18); a tap opens the target | IB18; `IB18-snoozed.png`, `IB18-open-task-target.png`. Note/journal targets: IB18a, open (§7)                        |
| Type filter: 9 types, counts, Clear all        | New: filter button menu (03)                                       | IB03; `IB03-filter-menu-all-types.png`, `IB03-filter-active.png`                                                     |
| Capture bar: text, link paste, duplicate check | New: + composer (04, 05)                                           | IB04/IB05; `IB04-composer.png`, `IB04-paste-chip.png`, `IB05-duplicate.png`, `IB05-capture-anyway.png`               |
| Attach file: image, audio, video, PDF          | New: composer paperclip                                            | IB04; `IB04-attach-menu.png`, `IB04-photo-captured.png`, `IB04-file-importer.png`                                    |
| Voice memo + transcription                     | New: composer mic → recorder (06), detail player (11)              | IB06/IB11; `IB06-recording.png`, `IB11-voice-detail.png`                                                             |
| Quick-capture window, drag and drop            | Adapted: Share extension (22) and the + composer                   | IB22; `IB22-share-sheet-memry.png`, `IB22-ingested-toast.png`, `IB22-share-photo.png`, `IB12a-share-video.png`       |
| Background jobs: link metadata                 | New: "N fetching" subtitle (01); failures stay silent              | IB10; `IB00-fetching.png`, `IB10-detail-link-hero.png`                                                               |
| List: Today / Yesterday / Older rows           | New: type icon, title, one meta line, image thumbnail              | IB01; `IB01-list.png`, `IB90-ax5-list.png`                                                                           |
| Comfortable density preview line               | Adapted: only voice transcripts show a preview line                | IB01; `IB01-list.png`                                                                                                |
| Row hover actions, quick file keys             | Adapted: leading swipe File, trailing Snooze / Archive (07)        | IB07; `IB07-swipe-leading.png`, `IB07-swipe-trailing.png`                                                            |
| Context menu: Rename                           | New: long-press menu (08)                                          | IB08; `IB08-row-menu.png`, `IB12-title-renamed.png`                                                                  |
| Keyboard shortcuts                             | Adapted: tap, long press, swipe, pull to refresh                   | IB07/IB08/IB01; `IB01-filtered-after-refresh.png`                                                                    |
| Snooze presets + custom date                   | New: snooze menu, Pick date & time sheet (09)                      | IB09; `IB09-snooze-menu.png`, `IB09-pick-date-sheet.png`, `IB23-snooze-due-fired.png`                                |
| Detail panel per type                          | New: pushed detail (10–12), video inline                           | IB10–IB12a; `IB10-detail-link-hero.png`, `IB11-voice-detail.png`, `IB12-detail-image.png`, `IB12a-video-playing.png` |
| Filing: AI folder suggestions, search          | Adapted (D5): Recent folders, search, create with `/`              | IB13; `IB13-file-sheet.png`, `IB13-filed-toast.png`                                                                  |
| Image filing mode                              | New: File sheet row + Settings › Inbox                             | IB13/IB23; `IB13-file-image-mode.png`, `IB23-settings.png`                                                           |
| Convert: Task, Event, Reminder                 | New: Convert sheet (14, 15); Event hidden (D6)                     | IB14/IB15; `IB14-convert-task.png`, `IB15-convert-reminder.png`, IB92 task round trip                                |
| Archive with undo                              | New: undo toast beside + (17)                                      | IB17; `IB17-archive-undo-toast.png`                                                                                  |
| Bulk: File, Tag, Snooze, Archive all           | New: select mode, glass toolbar (16); no AI pill (D5)              | IB16; `IB16-select-mode.png`, `IB16-bulk-file-toast.png`, `IB16-bulk-tag.png`                                        |
| Archived: search, restore, delete              | New: Archived view, swipe Restore / Delete (19)                    | IB19; `IB19-archived.png`, `IB19-search.png`, `IB19-delete-confirm.png`; `InboxUITests`                              |
| Insights                                       | New: single-column Insights (20)                                   | IB20; `IB20-insights.png`                                                                                            |
| Inbox Zero                                     | New: empty state (21)                                              | IB21; `IB21-inbox-zero.png`                                                                                          |
| Notifications: review nudge, snoozed back      | New: local notifications + Settings › Inbox (23)                   | IB23; `IB23-review-nudge-fired.png`, `IB23-snooze-due-fired.png`, `IB23-notification-opens-inbox.png`                |
| Resizable panel, split view                    | Desktop only: not carried over                                     | n/a                                                                                                                  |

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
- 2026-09-25 — IB033 — The Phase 3 commit also carries the Phase 4 screen code: the screens share the store, copy and primitives files and were written together. Phase 4 boxes are ticked only after each artboard's simulator check. The review reminder settings API (`api/inbox_settings.rs`) was split out of `api/inbox_write.rs` to stay under the 600-line ceiling.
- 2026-09-25 — IB033a — Split from IB033. The notification deep link (`memry.inbox` userInfo → `InboxLinks`) can only be checked end to end once IB23 schedules the review reminder.
- 2026-09-25 — IB02/IB03 — Menu counts render as native `Menu` subtitles (Paper draws them trailing; SwiftUI menus have no trailing accessory). Detail bottom-bar labels stay `caption`; the composer keeps `chromeGlass`; the Insights heatmap keeps 9 columns at 390 pt.
- 2026-09-25 — IB01 — Stale dimming (7 days, §6 IB013) is proven by `InboxFormattingTests` only: no live row is old enough on memry-A, and back-dating rows would mean writing to the synced store by hand.
- 2026-09-25 — IB19 — Archived groups and ages by `archivedAt`, as desktop's archived list does (not `createdAt`).
- 2026-09-25 — IB13 — `recent_folders` also counts `filed_action = 'note'` (convert to note files into a folder too), so a folder used only through Convert still shows as recent.
- 2026-09-25 — IB14 — The Convert sheet reuses the Tasks pickers through a private `TasksStore` keyed `inbox-convert-picker`, so it never touches the Tasks tab's persisted state; `TasksStore` is not lifted into the environment for one sheet.
- 2026-09-25 — IB05 — "Open it" on the duplicate notice clears the composer draft first; without it the next capture joined the old URL and the new text into one title.
- 2026-09-25 — IB10 — Link enrichment adds a small `<head>` reader (`InboxLinkPage`, 512 KB cap, 10 s) next to `LPMetadataProvider`, which exposes no description or og:image URL. It fills desktop's `description`, `heroImage`, `siteName`, `favicon` metadata keys (D3 merge still applies). The link detail draws the local thumbnail or the https `heroImage` as a 180 pt hero.
- 2026-09-25 — IB12 — The inline title field is vertical-axis, so Return inserted a newline and never saved. A newline now ends editing (saves), and leaving the screen saves too.
- 2026-09-25 — IB13 — Filing a photo failed on every attempt; three defects in the **core's attachment upload**, which no shipped iOS flow had exercised against the live server (the note-attachment spec used fakes): (1) no Worker attachment route sent the session token (`Auth::None` default) → 401 with no refresh; now `Auth::Session` on initiate/chunk/complete/status/cancel/manifest/dereference and on manifest/presign/proxied-chunk reads. (2) `HttpClient` prefixed an absolute presigned R2 URL with the Worker base → transport error; absolute URLs are now sent as given. (3) `complete` did not report chunks PUT straight to R2 → "Missing chunks" 400; it now sends desktop's additive `directChunks` (`i`,`h`,`b`), omitted when none (the body older servers take), and a failed presigned PUT falls back to the Worker as desktop does. Wire shapes are desktop's; no server change. Tests: `attachment_upload_wire.rs` (2 new).
- 2026-09-25 — IB13 — A picture this phone uploaded never bound to its block: the upload writes the note's `attachmentReferences` but not the cache row's `note_refs`, and `attachments::for_note` read only `note_refs`. It now also accepts rows the note's own references name (`attachment_cache.rs` test). And `AttachmentPaths.imagesDirectory` was never set anywhere, so every cached picture resolved under the temp directory ("could not be opened"); `CoreVaultOpener` now sets it on open (`VaultBrowseWiringTests`). Both are pre-existing notes-side defects fixed because IB13 depends on them.
- 2026-09-25 — IB06 — The recorder panel follows Paper 06: the screen dims the list with `Canvas.surfaceActive` at 70% (Paper's scrim colour) and hides the tab bar while recording; the scrim swallows taps so a stray tap cannot end a recording.
- 2026-09-25 — IB06 — Found live: `Info.plist` had no `NSMicrophoneUsageDescription` or `NSSpeechRecognitionUsageDescription`. Stopping a memo crashed the app (TCC abort on transcription), and on a device the first recording would too. Both keys added; the camera string now also names inbox photos. No data format change.
- 2026-09-25 — IB06 — A memo left `pending` by a process that ended mid-transcription is transcribed again on the first load when its audio is on this phone (desktop has no recovery; there a crash leaves "Transcribing…" too). Memos from another device are left alone.
- 2026-09-25 — IB06/IB11 — Voice titles round the seconds and rows/player floor them ("Voice memo (0:06)" over 0:05), exactly as desktop (`capture.ts` vs `content-section.tsx`). Kept.
- 2026-09-25 — IB11 — The player follows Paper 11: the waveform is the scrubber (tap/drag seeks, VoiceOver adjustable in 5 s steps), times below, no separate slider. A seek before the first Play now starts playback there. The title shows the stored "Voice memo (m:ss)" as desktop does; Paper's placeholder only appears for an empty title.
- 2026-09-25 — IB12 — The social card's link names the post's platform ("View on Reddit"), from `metadata.platform` or the host; desktop's card is X-only. Unknown platforms read "Open post".
- 2026-09-25 — IB13 — Embedding an image now needs a linked note before Confirm enables, whatever the folder (desktop `canFileItem`, `inbox-detail-panel.tsx:143`); the hint sits under "Link to notes" so it stays visible after "Don't ask again". Folder filing with "File in the sidebar" says it landed in a note (the IB025 fallback) instead of "Filed to …", keeping Undo.
- 2026-09-25 — IB13 — The note search keeps its results in view above the keyboard (`ScrollViewReader`); before, "Create …" sat under the keyboard. A vault with no tags shows no empty chip row.
- 2026-09-25 — IB21 — Inbox Zero follows Paper 21: surface-circle check, plain facts (streak in tint), block set a third down, instead of the first pass's ring glyph and capsules.
- 2026-09-25 — IB10 — The page-head request lives in `Seams/PageHeadFetch.swift` (the architecture check allows `URLSession` only in Seams/). It is the shell's one request that is not the core's: a third-party page head for a link preview, no credentials, no cookies, the same page `LPMetadataProvider` already reads. It never reaches Memry's server, so the core's retry and kill-switch have nothing to govern there.
- 2026-09-25 — Phase 4 gate — `TasksUITests` picks the vault by `TEST_RUNNER_MEMRY_UI_VAULT` (default "MemryNote"): the staging vault is now named "jp-desk" by a desktop peer (§7). Test harness only.
- 2026-09-25 — IB13 — Vault picker rows now hit-test their full width (`contentShape`); a plain button only took taps on its text and chevron. Pre-existing, found when the driver's centre tap did nothing.
- 2026-09-25 — IB13 — A failed file-capture filing tombstones the note it created for it (it used to leave one empty twin per retry). The Notes list re-reads its outline quietly when it comes back on screen, so a note the Inbox filed shows without a relaunch.
- 2026-09-25 — IB22 — The Share extension queues drops in the app group (`inbox-share/<id>/drop.json` + `payload`, protection `completeUntilFirstUserAuthentication`, the vault's class) and the app captures them on every inbox `load()` (open and foreground) through the composer's path with `captureSource` `quick-capture`, desktop's value for its quick-capture window. A drop is removed once its capture ran, whatever the answer: a duplicate or a refused file answers the same on every retry. The duplicate notice reads SHA-256 digests of live link captures' `sourceUrl`s that the app publishes after each refresh (`inbox-known-links.json`), so no URL text sits outside the vault. The check runs again at ingest, so a stale digest file can only under-warn. No wire, schema or sync change.
- 2026-09-25 — IB22a — No thought field on shared items. goal.md's row 22 lists an "optional thought", but Paper 22 draws none and desktop's quick-capture has none. There is also no field to carry it: a link's `content` is desktop's extracted description, which desktop's link job overwrites and filing quotes as the page's excerpt. A thought stored there would be lost or shown as the page's words. Adding one needs a synced field and a desktop reader; left open, not faked.
- 2026-09-25 — IB22 — The agent driver's `app` selector takes any bundle id (Safari, Photos), so a share sheet can be driven from its host app. Test harness only.
- 2026-09-25 — IB23 — Settings › Inbox section headers are 13 pt uppercase tertiary (Paper 23); iOS 26's default grouped header is larger and sentence case.
- 2026-09-25 — IB09/IB23 — Found live: the Pick date & time sheet re-presented itself on every render, because its binding wrapped the ids in a new `InboxIdList` (new UUID) on each read. It flickered, collapsed to its toolbar or vanished. `InboxSheets.snooze` now holds the identified list, as `tag` already did. The sheet opens at `.large` only: at `.medium` the graphical picker's time row sat below the fold with nothing to scroll. Evidence `IB09-pick-date-sheet.png`.
- 2026-09-25 — IB90 — At AX5 an inbox row put its thumbnail beside the text and cut the title to 2 lines and the meta to one. It read "[agent] snooze du…" and "Phot… 40m". Following spec 005's TaskRow rule, accessibility sizes now allow 6 title lines and 3 preview lines, stack the meta pieces, and move the thumbnail under the text.
- 2026-09-25 — IB90 — At AX5 the detail bar (Archive / Convert / File…) was cut off: Convert dropped out and File… wrapped. The floating bars now stop at `.xxxLarge` (`InboxLayout.barTypeCap`), as the system tab bar does, and each button shows the Large Content Viewer on long press.
- 2026-09-25 — IB91 — In dark mode, the large title under the top scroll-edge effect reads a little dimmer than the rows. It uses `Text.primary`; the dimming comes from the system's edge effect in the shared `TitleMenuHeader`, which Tasks has too. Not changed here.
- 2026-09-25 — IB92 — Filing on iOS writes `filedTo` from the core note path, which keeps the title's brackets (`Agent Test/[agent] desk one….md`). Desktop writes that note to disk as `agent desk one….md` because it sanitizes the filename, and desktop's own filing writes that name. Desktop only shows `filedTo` (filing history, insights) and never opens it, so nothing breaks. Converging needs the core to use desktop's filename sanitizer; left as is.
- 2026-09-25 — IB92 — `VaultBrowseWiringTests` "opening a vault points attachment paths…" flaked in the full Unit plan: `AttachmentPaths.imagesDirectory` is process-wide, and parallel suites open other vaults. The test now retries the open-and-read up to three times. The app opens one vault at a time, so the global stays.
- 2026-09-25 — IB01a — The failure row covers failed reads and writes. A failed sync pass is logged, but the `refresh()` that follows it clears `failure`, so going offline shows nothing in the list. Desktop keeps sync status out of the inbox list too (sidebar sync indicator). Left that way.
- 2026-09-25 — IB033b — Kaan changed D1 after the run: the Inbox is now a tab in the old Home slot, and Home is gone. Home was a "coming soon" placeholder; the home board stays desktop-only. The tab bar reads Notes · Inbox · Tasks · Journal · More. The list is the tab's root, and detail and settings push on its stack (`InboxTab`, `InboxRoute`). The More row and its `moreRowAccessibility` copy are removed. Notification and Share hand-offs select the Inbox tab (`InboxRouter.openInbox`). The tab has no badge: the subtitle already shows the count, and a red count on the bar goes against "calm". `VaultTab.home` became `.inbox`; it is an in-memory selection, never persisted, so nothing needs migrating. Evidence on memry-A: `IB033b-inbox-tab.png`, `IB033b-more-without-inbox.png`, and `IB033b-notification-opens-tab.png` (Send test tapped from the Tasks tab). `InboxUITests` 2/2 pass (they open the Inbox tab now); Inbox, formatting, failure and reminder unit suites 27/27 pass.

## 7. Blockers

<!-- date — id — what — evidence — next retry -->

- 2026-09-25 — IB07 — A partial `dragxy` (0.1 -> 0.42 width) on seed row
  `inbox_lnk_0SyBQ1wUWU-R` ("How to keep basil alive past week two", from
  `apps/desktop/scripts/seed-data/inbox.ts`) counted as a full leading swipe
  and filed it to the root folder ("Filed to Notes"); the Undo toast expired
  before it could be tapped. No UI unfiles after the toast. Not a code bug
  (full swipe = File is the spec). Revert in IB93: `undoFile` on that id and
  delete the created root note. Swipe checks from here on use `[agent]` rows
  only. Evidence: `/tmp/ibdrv/k7.png`.
- 2026-09-25 — IB13 — Before the upload fixes, five failed photo filings left
  empty notes "[agent] Photo 2026-09-25" in Agent Test (ids
  `utckhoegi8T9N6qvr_AWM`, `8Hryuhjn-RoWFLx8qieNo`, `ebSlkLQCgNepSsWau3Xtz`,
  `u9JrFzUGIClyY3yfiHM6v`, `DsKIVrkDSWq9vNGeP8qI_`; the last carries attachment
  `b70095dd2665b9cc31b0c53fe91879e2`). All `[agent]`-prefixed, deleted in
  IB93 with the rest of the test data. Fixed going forward (§6 IB13).
- 2026-09-25 — Phase 4 — At 10:46 a desktop peer on the shared staging
  account set vault 87614a10's name to "jp-desk" (`sync_vaults.updated_at`,
  read-only D1 check); the picker no longer shows "MemryNote". Same vault,
  same data: the driver now opens "jp-desk". Before that was known, tapping
  "Unnamed vault" opened the account's `default` vault once, which created
  an empty local `vault/default` directory on memry-A (nothing written to
  the server). Not a code issue; no retry needed.
- 2026-09-25 — IB18a — Blocked by the app shell, not the Inbox: the only
  cross-tab route is `TasksRouter.openTask`. `NotesListView` owns its own
  `NavigationStack` with no external route, and the Journal tab is spec 005's.
  Spec 004's reminder-notification tap has the same gap (non-task targets only
  select the Notes tab). The Inbox shows "can't open here" for note/journal
  targets. Needs a Notes/Journal router; retry after spec 005 lands.
- 2026-09-25 — Out of scope — Unlock screen: with the keyboard up, "Sign out"
  is laid over "Unlock" (both at y≈478–532 pt), so a centre tap on Unlock
  signs out. Workaround used: Return adds a line, which exposes a strip of
  Unlock below Sign out. Auth UI is not this spec's; reported here.
- 2026-09-25 — Phase 4 gate — The full Unit plan's sign-out tests wipe the
  simulator session; the UI plan then fails "Signed out". Signed in again
  (§0.3a, one code) before the UI plan.
- 2026-09-25 — Phase 4 — Test captures without the `[agent]` prefix (the
  titles are generated): links `wOTvyu1ZgIXnfZBOHSxh6` (rust-lang/rust),
  `zyKS1Yixpt02EfYZtyAO5` and `N8nWQqxD6RhATGJF5oLWN` (swiftlang/swift),
  voice memos `ihA2Z_mg0XBRNsIbo-XGE`, `ac9JStVMkpGrLEmlCUibt`. IB93 deletes
  them by id with the `[agent]` data. The `default` vault holds
  `[agent] zero check` (`fNlHbLv_OxRZ8SQVWaQ2I`) filed to its root note.
- 2026-09-25 — IB22 — Share test rows without the prefix (titles come from
  the page and the photo): links `fpYOYJdYUlcDU8EB2Oegu`,
  `1jvrwur4luXK_vLRFz-Lv` (https://example.com/agent/share1), image
  `4qz927pCscN7FUtZ9iI_X` ("IMG_0111"). IB93 deletes them by id. On memry-A
  the test runner kept the old appex after `build-for-testing`; an explicit
  `simctl install` of the built app picked up the new one.
- 2026-09-25 — IB23 — The review reminder check wrote Kaan's synced
  `inbox` settings (on, 13:16), then set them back to off and 18:00. Those
  are desktop's defaults, and the screen showed off before. The rows now
  exist explicitly with those values. A mis-aimed tap opened the detail of a
  real "Reminder: task" row, which only marks it viewed. The snooze check row
  `sgVekWr2b1138vFN9U0kv` is `[agent]` and goes in IB93.
- 2026-09-25 — IB92 — The desktop peer ran on a scratch folder at
  `/tmp/ib-desk/scratch`, profile `memry-inbox-inbox`, with
  `rebuild:electron`. Binding that folder renamed staging vault 87614a10 to
  "scratch": desktop names a vault after its folder. The picker had shown
  "MemryNote" and before that "jp-desk". The UI tests ran with
  `MEMRY_UI_VAULT=scratch`; IB93 restores "MemryNote". The run added
  `[agent] desk …` and `[agent] ios …` items (D1–D6, I1, I2) and two filed
  notes and two tasks from the conversions. All go in IB93.
- 2026-09-25 — IB93 — Left in place:
  (a) `[agent] zero check` (`fNlHbLv_OxRZ8SQVWaQ2I`), a filed history row in
  the account's `default` vault. Neither app deletes a filed row. Only a
  desktop bound to that vault could, and binding would rename "Unnamed vault"
  after its folder, as happened to MemryNote. Its note is deleted.
  (b) `[agent] ui-*` Tasks rows, "Agent Test ui-*" filters and the "Agent
  Test Redesign" project from UI runs outside this spec's windows. They belong
  to spec 005's RD93 and may belong to the journal-parity session.
  (c) `[agent] journal …` tasks: the journal-parity session's.
  (d) The desktop peer's device registration (`ee6669a7-…`), profile
  `memry-inbox-inbox` and `/tmp/ib-desk`. The staging account is revoked
  after the run.
  (e) The 4 s test video in memry-A's Photos.
- 2026-09-25 — Out of scope — Notes list: the swipe Delete on a note row
  closes the row without showing its "Delete this note?" dialog, so nothing
  is deleted; the note page's More › Delete works. Seen on memry-A in the
  `default` vault. This belongs to the Notes screens, not this spec.
- 2026-09-25 — Coordination — The journal-parity desktop still names vault
  87614a10 "jp-desk" locally. Its next vault-directory refresh may push that
  name again over the restored "MemryNote". Desktop names a vault after its
  local config, so two desktops with different names on one vault take turns.
  Pre-existing behaviour.

## 8. Final report

### What shipped

Branch `feat/ios-inbox`, six commits, no push:

- `f9136bbee`: Phase 0 facts and decisions.
- `d00ed7b0b`: core sync, reads, writes and the UniFFI surface.
- `a8e3e3fd6`: iOS foundations, screens and the review settings API.
- `305d7a940`: screens verified, plus the attachment upload and filing fixes.
- `8c0530839`: Share extension, review and snooze notifications.
- Phase 6: AX5 fixes, `InboxUITests`, the failure-row test and this report.

**Core (`crates/memry-core`).** The inbox projector, merge and apply for
desktop's whole-row sync payload. Reads cover the list, stats, panel,
archived, patterns and filing history. Writes cover capture, file, convert
to task or reminder, snooze, archive, restore, delete, tags and rename, with
explicit null on unsnooze and unarchive. Plus the synced review settings,
conformance vectors shared with desktop, and attachment upload fixes: Worker
auth, absolute R2 URLs and `directChunks`.

**iOS (`apps/ios`).** The Inbox, reached from More, covering all 23 Paper
artboards:

- the list, the title-menu views and the type filter;
- the composer: text, paste link, duplicate check, photo, file, voice;
- swipes, the row menu, snooze and the date picker;
- detail views per type, including video;
- the File sheet with image modes, and Convert;
- select mode with bulk actions, undo toasts, Snoozed & reminders,
  Archived, Insights and Inbox Zero;
- Settings › Inbox with the local review nudge and snooze-due
  notifications, which open the Inbox when tapped.

**Share extension (`MemryShare`).** Takes links, pages, text, photos, videos
and files. It queues drops in the app group, and the app ingests them on its
next Inbox load. It flags a duplicate with "Already captured" / "Capture
anyway".

**Verification.** Rust passes 963 tests. On memry-A: Unit 683, Conformance
29, UI 9 (with the new `InboxUITests`). `pnpm lint`, typecheck, and the
architecture, contracts and line-ceiling checks pass; so do the desktop
iOS-compat vitest and a live cross-device round trip with a desktop staging
peer (IB92). The Paper 00 parity table is §4.

### Decisions

§6 holds the full log. The ones that shape behaviour:

- **Sync payload:** desktop's whole-row payload is kept as is, with no wire
  or schema change. iOS writes the same keys, and an absent key keeps its
  value.
- **Device-local data:** inbox attachments stay on the device that made
  them; elsewhere they show as "file on another device". Tags and the image
  filing mode are device-local too. Review reminder settings sync.
- **No AI (D5):** Recent folders replace AI suggestions, and there is no
  cluster pill.
- **Convert (D6):** Convert → Event is hidden.
- **Share extension:** it never opens the vault. The app ingests its queue,
  and duplicates are checked against link digests the app publishes. It
  presents full height, because the host controls the detents.
- **Failure row:** it covers failed reads and writes. A sync failure is
  logged, and desktop's sidebar reports sync status.
- **Accessibility sizes:** rows stack and the floating bars stop at
  `.xxxLarge`, with the Large Content Viewer above that.

### Left open

- IB18a: note and journal-day reminder targets can't open across tabs; that
  needs a Notes/Journal router (blocked, §7).
- IB22a: no optional thought on shared items, because there is no synced
  field for one (§6).
- The IB93 leftovers above: the filed row in `default`, other sessions' test
  data, and the desktop peer's device registration.
- Pre-existing, not fixed here:
  - the search index catches up only on relaunch;
  - there is no upload progress indicator;
  - the app icon is blank;
  - the Notes list's swipe Delete doesn't confirm;
  - iOS `filedTo` keeps brackets that desktop's filenames drop (display only);
  - two desktops with different local names take turns renaming the vault.
