# Goal: ship the Inbox on native iOS from the Paper design

## Context

- iOS has no inbox today. The iOS core does not even subscribe to the `inbox`
  sync type: it is in `UNSUBSCRIBED_RECORD_ITEM_TYPES`
  (`crates/memry-core/src/protocol/types.rs`). Desktop is the reference
  implementation: `apps/desktop/src/main/inbox/**`,
  `apps/desktop/src/renderer/src/pages/inbox*`, `components/inbox/**`,
  `components/inbox-detail/**`, `components/capture-input.tsx`,
  `components/bulk/**`, `components/snooze/**`,
  `pages/settings/inbox-section.tsx`, contracts `packages/contracts/src/inbox-api.ts`
  and `InboxSyncPayloadSchema` in `sync-payloads.ts`.
- The design is in Paper: file **"Task iOS"**, id `01M39KJ8S9S5QYX38B2HP3Q1BF`,
  page **"Inbox iOS"** (`p-3-0`). Use the Paper MCP (`paper_get_basic_info`,
  `paper_get_tree_summary`, `paper_get_jsx`, `paper_get_computed_styles`,
  `paper_get_screenshot`).
- Unlike spec 005 (UI rebuild over a finished core), this is a feature build
  end to end: core sync + domain + UniFFI surface, then the iOS screens.
  Spec 004 is the template for the core half, spec 005 for the UI half.

## Read first (once)

1. Root `AGENTS.md`, `apps/ios/AGENTS.md`, `apps/desktop/AGENTS.md`,
   `DESIGN.md`, `PRODUCT.md`.
2. `specs/004-ios-tasks-parity/tasks.md` §0.3–§0.6, §1, §5, §6: workspace,
   simulator, sign-in recovery, test data, commands, core conventions. They
   apply here unchanged unless §1 of the plan overrides them.
3. `specs/005-ios-tasks-redesign/tasks.md` §0.3, §6: design rules and the
   decisions already made for the shared chrome (title menu on an inline
   title, toast, glass fallback, sheet chrome, tokens). Reuse its primitives;
   do not fork them.
4. Paper artboard **"00 · Feature audit + redesign map"** in full (the spec for
   where each desktop behavior lives) and **"00b · Inbox flow"** (entry →
   triage → action → outcome, plus the return paths).
5. Every artboard 01–23 on the Inbox iOS page: `get_tree_summary`, `get_jsx`,
   layer names. Captions inside frames 12, 13, 15, 22 describe undrawn
   variants; they are requirements.
6. The desktop inbox code listed above, in full, before designing the core API.

## Screens (Paper artboard → what it defines)

| Artboard               | Defines                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 Inbox               | Large title + title menu, subtitle "N to process · N filed today" + "N fetching", glass capsule (filter + more), Today / Yesterday / Older groups, rows = type icon + title + one meta line, image thumbnail trailing, stale rows dimmed |
| 02 Title menu          | Inbox, Snoozed & reminders, Archived, Insights, with counts                                                                                                                                                                              |
| 03 Filter menu         | 9 types, checkmarks, counts, disabled at zero, Clear filter                                                                                                                                                                              |
| 04 Capture             | "+" → composer above the keyboard: field, Paste-link chip, attach menu (Photo Library, Take Photo, Choose File), mic, send                                                                                                               |
| 05 Pasted link         | Link preview in the composer; "Already captured" notice with Open it / Capture anyway                                                                                                                                                    |
| 06 Voice memo          | Recorder: timer, waveform, cancel, stop = capture; on-device transcription                                                                                                                                                               |
| 07 Swipe               | Leading = File (top suggestion); trailing = Snooze, Archive                                                                                                                                                                              |
| 08 Row menu            | Quick-file icon row (3 suggested folders + match strength), File…, Convert to ›, Snooze ›, Rename, Open link, Select, Archive                                                                                                            |
| 09 Snooze menu         | Later today, Tomorrow, This weekend, Next week, In 1 h, In 2 h, Pick date & time…                                                                                                                                                        |
| 10–12 Detail           | Pushed detail per type; bottom glass bar: Archive, Convert, prominent "File to <top suggestion>" / "File…"                                                                                                                               |
| 13 File sheet          | Folder search/create with `/`, suggested folders with match strength, all folders, tags with suggestions, link notes (existing or new), image filing mode row                                                                            |
| 14–15 Convert          | Type segment Note / Task / Event / Reminder and each type's fields                                                                                                                                                                       |
| 16 Select mode         | Select all + checkmark, "N selected", selection circles, bottom glass bar File / Tag / Snooze / Archive, AI cluster pill                                                                                                                 |
| 17 Undo toast          | Archive → toast beside "+"                                                                                                                                                                                                               |
| 18 Snoozed & reminders | Upcoming / Past, open target, viewed state                                                                                                                                                                                               |
| 19 Archived            | Search, groups, swipe Restore / Delete, read-only detail                                                                                                                                                                                 |
| 20 Insights            | Four stats, capture heatmap + peak, by type, recent filings                                                                                                                                                                              |
| 21 Inbox Zero          | Empty state with filed-this-week and streak                                                                                                                                                                                              |
| 22 Share extension     | Save to Inbox from any app: link, image, file, PDF, text; optional thought; duplicate notice                                                                                                                                             |
| 23 Settings › Inbox    | Review reminder on/off, time, test; image filing mode, ask again; the two local notifications                                                                                                                                            |

## Rules (non-negotiable)

- **Behavior parity with desktop.** Every row of the 00 audit table marked New
  or Adapted ships. "Desktop only" rows do not. Anything the design leaves
  undrawn follows desktop and is logged.
- **Backward compatibility (root AGENTS.md).** Real users already have inbox
  rows synced from desktop. The iOS projector must accept every payload
  `InboxSyncPayloadSchema` allows, including missing keys, and apply the same
  "explicit null clears, absent key keeps" rule as
  `apps/desktop/src/main/sync/item-handlers/inbox-handler.ts`. Payloads iOS
  writes must parse on the oldest desktop still in use. No wire or schema
  change without a written compat plan in §6 first.
- **E2E and privacy.** Server sees no plaintext. Transcription is on-device
  only. Notification bodies never contain capture text (iOS AGENTS.md;
  spec 002 R12): the review nudge and snooze-due carry counts only.
- **Native iOS 26 first**, same mapping as spec 005 plus: `PhotosPicker`,
  `.fileImporter`, `AVAudioRecorder`, `SFSpeechRecognizer` with
  `requiresOnDeviceRecognition`, `LPMetadataProvider` for link previews, a
  Share Extension target with an app group, `UNUserNotificationCenter`.
- **Values from Paper** mapped to `Tokens` (spec 005 §0.3 rule). No new hex,
  no `Font.system(size:)`.
- **Accessibility, dark mode, RTL, Dynamic Type to AX5, 44 pt targets** as in
  spec 005 RD90/RD91.
- **Copy** through an `InboxCopy*` pattern mirroring
  `packages/i18n/src/locales/en/inbox.json` wording.
- **iOS rules** from `apps/ios/AGENTS.md`: no `!` / `try!`, `ErrorMapping`,
  `Log.swift`, Feature files ≤ 400 lines, writes schedule a sync pass.

## Workflow

1. Phase 0: facts. Fill plan §5 from desktop code and the core (sync payload,
   attachments, filing outputs, suggestions, stats, snooze scheduling).
2. Phase 1: core read side (subscribe `inbox`, projector, list/detail/stats
   queries), conformance vectors against desktop.
3. Phase 2: core write side (capture, update, snooze, archive, file, convert,
   bulk) with sync push.
4. Phase 3: iOS foundations (store, copy, primitives, entry point).
5. Phase 4: screens IB01–IB23.
6. Phase 5: Share extension and notifications.
7. Phase 6: verification and final report.

The plan file `specs/006-ios-inbox/tasks.md` is the only state. Tick a box
only with its own evidence line.

## Done when

- Every IB item and every core item is ticked with evidence.
- A capture made on iOS appears on desktop and the reverse; file, convert,
  snooze, archive and restore round-trip both ways with no data loss on rows
  written by the current desktop build.
- Unit, UI and Conformance plans green; `cargo test -p memry-core`, clippy,
  line ceilings and `git diff --check` green.
- The plan ends with a final report: what shipped, decisions, what is left.
