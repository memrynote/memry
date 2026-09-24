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

- [ ] IB000 Read goal.md, AGENTS files, DESIGN.md, PRODUCT.md, spec 004 §0–§1,
      spec 005 §0.3/§6, artboards 00, 00b, 01–23 (`get_jsx` + screenshot),
      and the desktop inbox code named in goal.md. Record in §5.
- [ ] IB001 Fill §5 F1–F12 with file:line citations. Each fact is what the
      code does, not what a comment says.

## Phase 1: core read side (Rust)

- [ ] IB010 Inbox record model in core: every `InboxSyncPayloadSchema` field,
      plus the desktop-local columns the UI reads (`transcription`,
      `transcriptionStatus`, `viewedAt`, `duration`, `pageCount`,
      `thumbnailUrl` / attachment ref) mapped from where desktop actually
      keeps them (§5 F1, F3).
- [ ] IB011 Projector: apply remote `inbox` items with desktop's merge rule
      (D2). Unit tests: absent key keeps, explicit null clears (unsnooze,
      unarchive, unfile), older payload without new keys, deleted item.
- [ ] IB012 Subscribe `inbox`: move it from `UNSUBSCRIBED_RECORD_ITEM_TYPES`
      to `SUBSCRIBED_ITEM_TYPES` only after IB011 is green (the constant's own
      comment). Initial seed pulls existing inbox rows.
- [ ] IB013 Queries (UniFFI): list (active, excluding filed/archived/snoozed;
      include-snoozed variant), by type counts, item detail, archived list
      with search, snoozed + reminder panel entries (Upcoming/Past, viewed),
      stats (captured, processed today/this week, rate, stale count with
      desktop's threshold, avg time to file, heatmap buckets, by type, recent
      filings, streak). Same numbers as desktop for the same data.
- [ ] IB014 Conformance vectors in `packages/contracts`: payload fixtures from
      desktop (current and one older shape) → expected projected row and
      list/stats output. `vectors:check` green; `MemryConformanceTests` gains
      an Inbox suite.

## Phase 2: core write side (Rust)

- [ ] IB020 Capture: text, link (normalized URL, `sourceUrl`), image, voice,
      PDF, video, file; `captureSource = "ios"` or desktop's value set
      (§5 F4). Duplicate check by URL and by content, same rules as
      `main/inbox/duplicates.ts`, returning the existing item.
- [ ] IB021 Attachments: store under the same vault path desktop uses
      (`attachments/inbox/{itemId}/`), same size and MIME limits (50 MB
      images), and sync them the way desktop does (§5 F3). Round-trip test.
- [ ] IB022 Update: title, content (debounced by the UI), metadata merge
      (D3), transcription fields, mark viewed.
- [ ] IB023 Snooze / unsnooze with desktop's presets computed on-device;
      snooze-due returns items to the list (desktop scheduler semantics,
      §5 F7).
- [ ] IB024 Archive / restore / delete permanently, with undo for archive.
- [ ] IB025 File: to folder (new note from the item, `generateNoteContent`
      semantics), link to existing notes, link to new notes, tags, image mode
      embed vs link with desktop's fallback. Writes `filedAt`, `filedTo`,
      `filedAction` exactly as desktop (§5 F5). Uses the existing notes write
      path in core.
- [ ] IB026 Convert: to note, to task (priority, due, reminder, project) via
      the tasks write path; to reminder via the reminder path; to event per
      D6. Same `filedAction` values as desktop.
- [ ] IB027 Bulk: file, tag, snooze, archive; partial-failure counts as
      desktop (`processedCount`, `errors`).
- [ ] IB028 Every write enqueues a sync push; payload built with the exact
      keys desktop sends (explicit null for clears). Test: an iOS payload
      parses with `InboxSyncPayloadSchema` (vector) and applies on desktop's
      handler test.
- [ ] IB029 Gate: `cargo test -p memry-core`, clippy `-D warnings`,
      `vectors:check`, xcframework rebuilt, Conformance plan green.

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

- F1 Inbox row columns desktop keeps locally vs in the sync payload.
- F2 Merge rule in `inbox-handler.ts` (keys, clocks, deletes).
- F3 Attachment storage path and how inbox attachments sync (or don't).
- F4 `captureSource` values and capture paths per type.
- F5 Filing outputs: note content, frontmatter, `filedTo`, `filedAction`
  values, image embed/link and fallback.
- F6 `metadata` shapes per type (link, social, voice, image, PDF, reminder)
  and which process writes them.
- F7 Snooze presets, snooze-due scheduler, review scheduler timing.
- F8 Suggestions: inputs (embeddings, folder scoring), whether any of it is
  available to iOS, and the AI setting that gates it.
- F9 Convert to event / reminder: records written and their sync types.
- F10 Stats definitions (stale threshold, processed, streak, heatmap).
- F11 Inbox preferences storage (settings record keys) and sync.
- F12 Reminder panel entries: sources, viewed state, navigation targets.

## 6. Decisions log

<!-- date — id — choice — why -->

## 7. Blockers

<!-- date — id — what — evidence — next retry -->

## 8. Final report

### What shipped

### Decisions

### Left open
