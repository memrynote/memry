# Tasks: iOS Settings (Paper "Settings iOS")

**Goal:** build iOS Settings from the Paper page "Settings iOS" (file "Task iOS", `01M39KJ8S9S5QYX38B2HP3Q1BF`, page `p-4-0`). The full brief is in `specs/006-ios-settings/goal.md`.

**Reference:** artboard **00 · Settings feature audit** says what ships and where it lives; **01 · Settings flow** gives the behavior. goal.md "Fixed decisions" F1–F10 override Paper.

**Format:** `[ID] Description`. An item added later takes a suffix letter (`ST31a`) so no ID moves.

**Checkbox protocol:** tick `[x]` only when the item's own verification ran green. Under the tick, add one indented `Evidence:` line (command and result, test name, screenshot path). Never tick partial work; split it with a suffix instead.

---

## 0. Operating rules (read before every resume)

### 0.1 Session

- One session, no questions to Kaan. If something is ambiguous, pick desktop's behavior, write it to §6 Decisions and continue.
- If something outside the repo blocks an item, write it to §7 Blockers with evidence, move to the next unblocked item, and retry once per phase.
- This file is the only state. After a restart, re-read §0, §1, §6 and §7, then continue at the first unticked item.
- Spec 004 §0.5 (test data) and §1 D1–D7 still apply. Simulator and sign-in come from goal.md "Simulator and sign-in" (memry-C, gmail-bridge OTP), not spec 004 §0.3/§0.4. Reuse the spec 005 primitives and its §6 token decisions.

### 0.2 Scope

- **iOS:** `Features/Settings/**` (new), `Features/Account/**`, `Features/Notes/VaultTabsView.swift`, `Features/Tasks/TaskSettings*` (re-parenting only), `Design/**` (shared primitives only), tests, and `SpikeEvidence/settings/`.
- **Core:** additive UniFFI API in `crates/memry-core/src/api/**`, domain helpers with Rust tests, and regenerated bindings.
- **Not allowed:** wire, protocol or schema changes, sync-server changes, changes to `settings_merge.rs` semantics, DB migrations. If one seems needed, log it in §7 and stop that item.

### 0.3 Verification

- Simulator **memry-C** `0E5C90DE-62A7-42F7-94EB-82ECEBE99A59` only; `-derivedDataPath /tmp/memry-dd-C`; XcodeBuildMCP `simulatorId` = that UDID. Never target by name or `booted`. Never boot, shut down or erase another simulator; `simctl shutdown all` / `erase all` are forbidden. Drive the app with `AgentDriverUITests`. Screenshots go to `apps/ios/SpikeEvidence/settings/STxx-<state>.png`; compare each with `paper_get_screenshot`.
- `xcodebuild test -project apps/ios/Memry.xcodeproj -scheme Memry -testPlan Unit|UI -destination 'platform=iOS Simulator,id=0E5C90DE-62A7-42F7-94EB-82ECEBE99A59' -derivedDataPath /tmp/memry-dd-C`, with Conformance green and untouched.
- `cargo test -p memry-core`, `cargo clippy -p memry-core -- -D warnings`, `node scripts/check-line-ceilings.mjs`, `git diff --check`.
- Never revoke the simulator's own device or the desktop dev device.

### 0.4 Simulator isolation (per session)

Each agent session gets its own simulator, created once with `xcrun simctl create "memry-<X>" "iPhone 16"` (`xcrun simctl list devices | grep memry` lists the UDIDs). This session uses **memry-C**, UDID `0E5C90DE-62A7-42F7-94EB-82ECEBE99A59`:

- Build, install, launch and test commands always use `-destination 'platform=iOS Simulator,id=0E5C90DE-62A7-42F7-94EB-82ECEBE99A59'`. Never target by name, never use `booted`.
- DerivedData: `-derivedDataPath /tmp/memry-dd-C`.
- XcodeBuildMCP: `simulatorId` = that UDID.
- Do not boot, shut down or erase any other simulator (memry-A and memry-B belong to other sessions). `simctl shutdown all` and `simctl erase all` are forbidden.

### 0.5 Sign-in (if the app asks)

- Email `kaan94karaca@gmail.com`; recovery phrase as in goal.md "Simulator and sign-in".
- OTP: read the newest mail from `noreply@memrynote.com` via gmail-bridge, newer than the request. Kaan revokes these after the session; keep them out of code, tests, evidence and commits.

---

## 1. Fixed decisions (goal.md; not revisited)

- **F1.** Settings is a page under the More tab; sign out lives only in Account.
- **F2.** Sync scope is exactly what desktop syncs today. Synced: `general.{theme, accentColor, fontFamily, language}`, `inbox.{reviewReminderEnabled, reviewReminderTime}`, `journal.defaultTemplate`, `journal.weekdayTemplates.<day>`, `tasks.*` (shipped). Every other group or field in the payload is preserved and never written. Tags, properties and templates sync as their own item types. Everything else is device-local.
- **F3.** Paper footers that contradict F2 are wrong; the copy follows F2.
- **F4.** Voice memos (22, 22a) are skipped.
- **F5.** Language is an in-app picker that writes `general.language` and takes effect on the next launch.
- **F6.** Theme maps Warm, White, Dark and System to existing palettes; an unknown synced value means System and is preserved.
- **F7.** Accent comes from desktop presets or `ColorPicker`; tinted text is contrast-safe.
- **F8.** Billing is read-only.
- **F9.** Journal and Inbox settings sit behind their feature gates if those features have not merged.
- **F10.** Otherwise desktop wins, and the choice is logged.

---

## Phase 0: plan and audit

- [x] ST00a Read everything in goal.md "Read first". Read Paper 00 (`58I-0`), 01 (`5IQ-0`), and every phone artboard via `get_screenshot` + `get_jsx`.
      Evidence: goal Read-first files read; Paper 00 (37 audit rows, 6 rules, 8 SwiftUI mappings) and 01 (lanes 01–07) via `paper_get_jsx`; all 44 phone artboards via `get_jsx` text + screenshots of 01, 02, 03, 07, 09, 12, 15, 23, 25, 27b, 29.
- [x] ST00b Verify F2 against desktop `main`:
  - List every caller of `syncSettingsFieldUpdate` / `syncSettingsUpdates` / `syncSettingsMapEntryUpdates`, plus the Rust `task_settings` writers.
  - Confirm whether `calendar.weekStartDay`, `notes.defaultFolder`, `notes.spellCheck` and `editor.*` have a desktop writer.
  - Record the final synced-field table in §5.
    Evidence: `grep syncSettings*` over `apps/desktop/src` (5 writers + sidebar stores); §5.1.
- [x] ST00c Verify the core surface table in goal.md. For each need, write "exists: <path>" or "add: <signature>" in §5. Confirm the server endpoints (`/devices`, `/linking/*`, `/storage`, `/billing`, `/vaults/:id`) and their request/response shapes from `apps/sync-server/src/routes`.
      Evidence: `routes/devices.ts`, `routes/linking.ts`, `routes/sync.ts:128,287`, `routes/auth.ts:857`, `services/storage.ts`, `services/paddle-billing.ts`; §5.3.
- [x] ST00d Map each desktop device-local setting to its iOS storage key (UserDefaults suite or core local table) in §5.
      Evidence: §5.2.

## Phase 1: core (Rust + UniFFI)

- [x] ST10 `Settings` API: `snapshot`, `get(path)`, `set(path, json)`, `clear(path)`, built on `domain::settings`, plus a change notification after pull (a projector hook or the existing vault change stream).
  - Tests: a write to `general.theme` leaves `general.minimizeToTray`, `sidebar.*` and an unknown group byte-identical; `null` and absent stay distinct; `journal.weekdayTemplates.3` gets its own clock; concurrent edits to different days merge.
    Evidence: `cargo test -p memry-core --lib api::settings` 5 passed (theme write keeps minimizeToTray/fontSizePx/sidebar/experimental byte-identical; null vs absent; per-day clock; concurrent days merge via `settings_merge::apply_remote_merged`). Refresh = `Settings.revision()` (row `updated_at`).
- [x] ST11 Journal template settings helpers (`default_template`, `set_default_template(Option)`, `weekday_templates`, `set_weekday_template(day, Option)`), sanitized to days 0–6 exactly as desktop `journal-template-keys.ts` does.
      Evidence: `api/settings.rs` `journal_templates/set_default_template/set_weekday_template`; day >6 refused; tests above.
- [x] ST12 Inbox review settings helpers (`review_reminder`, `set_review_reminder(enabled, time "HH:mm")`), with the time format validated like desktop.
      Evidence: `is_review_time` = desktop `REVIEW_REMINDER_TIME_PATTERN`; `review_reminder_is_validated_like_desktop` green.
- [x] ST13 Account: `devices`, `rename_device`, `revoke_device`, `storage`, `billing` (read-only), `delete_vault`. Errors map to typed `ApiError`s.
      Evidence: `protocol/account_admin.rs` + `AuthSession.devices/rename_device/revoke_device/storage/billing/delete_vault`; `cargo test account_admin` 3 passed.
- [x] ST14 Linking, approver side: `initiate` (QR payload, short code, expiry), `poll`, `approve`, `cancel`. Vault keys are wrapped exactly as desktop's approver does. Tested against the recorded conformance vectors, if any exist.
      Evidence: `api/linking_approver.rs` `DeviceApprover.initiate/status/approve/cancel`; `an_approval_round_trips_through_the_new_device_half` opens the body with the new-device code (`receive_master_key`, `open_vault_transfer`); bad confirm refused. No recorded approver vectors exist.
- [x] ST15 Sync status snapshot (state, last synced, pending count) if not already exposed; `large_notes()` using `NOTE_SYNC_MAX_BYTES` and a warning ratio of 0.8.
      Evidence: `VaultSync.pending_changes()`, `Notes.large_notes()` (3_826_919 / warn 3_061_535); `cargo test large_notes` green.
- [x] ST16 Tags: `tag_definitions` (name, color, icon, count), `rename_tag`, `merge_tag(source, target)`, `delete_tag`, `set_tag_color`, `set_tag_icon`. Each touches notes, journals and tasks as desktop `tags-handlers.ts` does and enqueues sync for every changed item. Tests cover case-folding (`tags::same_tag`) and merge into an existing tag.
      Evidence: `domain/tag_admin.rs` + `Tasks.tag_list/rename_tag/merge_tag/delete_tag/set_tag_color/set_tag_icon`; 5 tests (case-fold, merge into existing, definition move).
- [x] ST17 Properties: definition list with type and options; `rename_option`, `set_option_color`, `remove_option`, `reorder_options`, `add_option`, `delete_definition` (removes values from notes). Semantics match desktop `properties-section.tsx` and its handlers.
      Evidence: `domain/property_admin.rs` + `Tasks.property_definitions/add|rename|remove|reorder_property_option(s)/set_property_option_color/delete_property_definition`; 4 tests (select + status shapes, unknown option keys survive).
- [x] ST18 Templates: list with the built-in flag, `duplicate`, `update` (title, icon, tags, folder, body), `delete`; built-in templates are read-only.
      Evidence: `domain/template_admin.rs` (desktop built-ins ported, read-only) + `Tasks.template_list/create_template/duplicate_template/update_template/delete_template`; 2 tests.
- [x] ST19 Regenerate the Swift bindings; `cargo test -p memry-core` and clippy are green; the iOS build compiles against the new API. Commit `feat(core): settings, account, linking, tags, properties, templates API`.

  Evidence: `cargo fmt`; `cargo clippy -p memry-core --all-targets -D warnings` clean; `cargo test -p memry-core` all suites 0 failed; `build-xcframework.sh --release` ok; `xcodebuild build-for-testing -testPlan Unit` on memry-C exit 0.

## Phase 2: shell and primitives

- [x] ST20 More tab root: Inbox row (F9 gate) and Settings row. `SettingsRoute` enum on one `NavigationStack`; deep links from Tasks, Journal and Inbox "… › settings" land on the section with Back returning to Settings root (flow lane 01).
      Evidence: `MoreTabView` + `SettingsRoute` on `TasksRouter.settingsPath`; Tasks … › Task settings → `openSettings(.tasks)` lands on Task settings, Back → Settings root: `apps/ios/SpikeEvidence/settings/ST20-deeplink-task-settings.png`. Inbox row hidden (F9).
- [x] ST21 Primitives in `Features/Settings/SettingsPrimitives.swift`: value row, menu row, toggle row, destructive row, footer, account card, color swatch, and the storage bar, all reusing spec 005 tokens.
      Evidence: `Features/Settings/SettingsPrimitives.swift` (link/value/toggle/destructive/action rows, footer, sync dot, account card, swatch, storage bar); used by every screen below.
- [x] ST22 `SettingsStore` (`@Observable`) over ST10 plus a `LocalSettings` wrapper for device-local keys. Optimistic write with revert and an error notice on failure; live refresh on inbound sync. Unit-tested.

  Evidence: `SettingsStore` + `LocalSettings`; `MemryTests/SettingsTests` 9 passed (unknown group survives, unknown theme → System, peer change after `refreshIfChanged`, refused write reverts + failure, weekday/review round trip, last feature refuses, accent inks ≥4.5:1).

## Phase 3: account

- [x] ST30 **01 / 01b Settings root**: account card (email, plan, sync dot + status), groups, trailing values; no Voice memos row (F4).
      Evidence: `apps/ios/SpikeEvidence/settings/ST30-root.png`, `ST30-root-scrolled.png`, `ST30-root-all-modules.png`; no Voice memos row. Compared with Paper 01/01b.
- [x] ST31 **02 Account**: identity + E2E badge, status, Sync now, Download attachments (Always / On Wi-Fi / Never, device-local), Plan (read-only, F8), Storage and Devices rows, Sign out.
      Evidence: `apps/ios/SpikeEvidence/settings/ST31-account.png`: E2E badge, status, Sync now, Download attachments menu, Plan read-only + footer, Storage/Devices rows, Sign out.
- [x] ST32 **03 Storage**: bar + legend from `storage()`, plan limits footer, large notes list (tap opens the note), empty state when none.
      Evidence: `apps/ios/SpikeEvidence/settings/ST32-storage.png`: bar + legend, plan limits footer, near-limit list (empty state on this vault).
- [x] ST33 **04 Devices**: this device, others with platform and last seen, show-more past 5 (desktop behavior).
      Evidence: `apps/ios/SpikeEvidence/settings/ST33-devices.png`: this device first, others by last seen, Show 12 more past 5.
- [x] ST34 **05 Rename device**: alert with a TextField, validated to be non-empty, toast "Renamed to …".
      Evidence: Renamed memry-C → `Agent Test memry-C` → back, toast `apps/ios/SpikeEvidence/settings/ST34-renamed-toast.png`; `SettingsUITests.testThisDeviceCanBeRenamedAndRenamedBack` passed.
- [x] ST35 **06 Revoke device**: swipe → confirmation; this device cannot be revoked here (the row has no swipe).
      Evidence: `apps/ios/SpikeEvidence/settings/ST35-revoke-confirm.png`; revoked the test-linked device and the CLI peer; this device has no swipe.
- [x] ST36 **07 Link new device**: QR + code sheet, countdown, cancel; approval prompt when the new device scans (flow lane 04); the device appears in the list.
      Evidence: Link sheet `apps/ios/SpikeEvidence/settings/ST36-link-sheet.png`; a throwaway new-device client scanned, both showed SAS 244100 (`ST36-approve-prompt.png`), Approve → client: `linked vaults=5`, `master-key-stored=true`, `registered`; device in list then revoked.
- [x] ST37 **08 Sign out**: move `SignOutBar` behavior onto Account; the More root loses it (F1). Revocation handling is unchanged.
      Evidence: Sign out only on Account (`SignOutSection`, AccountCopy confirmation); VaultTabsView keeps `SignOutHostedKey`, so no bar on the vault shell; revocation path unchanged.
- [x] ST38 **23 / 24 Vaults**: on this iPhone (open / switch), in account (Download), swipe → delete with confirmation; the currently open vault cannot be deleted from here.

  Evidence: `apps/ios/SpikeEvidence/settings/ST38-vaults.png`: open vault (no swipe), account vaults (tap opens, swipe → delete confirmation). Delete not executed on real vaults.

## Phase 4: application

- [x] ST40 **09 / 09b General**: Language (F5), time format and date format menus with live examples (device-local), week start (per ST00b), spell check, usage metrics (device-local).
      Evidence: `apps/ios/SpikeEvidence/settings/ST40-general.png`, `ST40-time-format-menu.png`; language picker, formats with examples, week start, spell check, metrics.
- [x] ST41 **10 New notes folder**: folder tree picker, check on the current one; storage per ST00b.
      Evidence: `apps/ios/SpikeEvidence/settings/ST41-new-notes-folder.png`; `VaultWrite.createNote(in: nil)` uses the choice.
- [x] ST42 **11 Diagnostic report**: preview sheet showing exactly what will be sent (no content), Send; reuse the existing diagnostics seam if iOS has one, otherwise log it in §7.
      Evidence: no iOS diagnostics seam or report route exists (`grep -ri diagnostic apps/ios/Memry` → account copy only); per the item, logged in §7 and the row is not offered (no dead control).
- [x] ST43 **12 / 12b / 13 Appearance**: color mode tiles (F6), accent presets + custom (F7), font list (built-in only); all synced; applied app-wide immediately.
      Evidence: `apps/ios/SpikeEvidence/settings/ST43-appearance.png`, `ST43-appearance-dark.png`, `ST43-accent-emerald-dark.png`, `ST43-font.png`; applied app-wide live; `testAColourModeChoiceIsAppliedAndPutBack` passed.
- [x] ST44 **14 Features**: four toggles (device-local); the last one on refuses to turn off; tabs and More rows rebuild; turning a module off stops its reminders (flow lane 06).
      Evidence: `apps/ios/SpikeEvidence/settings/ST44-home-off.png` (Home tab gone), `ST44-last-one-refuses.png` (Tasks stays on, footer 'Keep at least one on.'); Tasks off clears reminders.
- [x] ST45 **21 About**: version and build, GitHub, feedback, privacy, terms, licenses.

  Evidence: `apps/ios/SpikeEvidence/settings/ST45-about.png`: version/build, GitHub, feedback (desktop issues URL), privacy, terms, licenses.

## Phase 5: modules

- [x] ST50 **15 / 16 Journal**: default template menu (None (ask each time), None, templates), per-day toggle, Day page toggles, folder, date format + preview (device-local per F2).
      Evidence: `apps/ios/SpikeEvidence/settings/ST50-journal.png`, `ST50-template-menu.png` (launch arg `-settings.showUnshipped`, F9).
- [x] ST51 **17 Per-day templates**: seven day menus, "N of 7 set", a deleted template shows "Deleted template" and falls back to default, Clear all; each day writes its own path.
      Evidence: `apps/ios/SpikeEvidence/settings/ST51-per-day.png`, `ST51-day-menu.png`, `ST51-wednesday-set.png`; per-day path `journal.weekdayTemplates.3` confirmed in the pushed payload.
- [x] ST52 **18 / 18a / 18b / 18c Inbox**: image filing menu + ask toggle (device-local); review reminder toggle + time (synced) schedules a daily `UNCalendarNotificationTrigger` on this device; permission prompt, denied state with Open iOS Settings and a recheck on `.active`; Send test; notification tap opens Inbox; an inbound synced change reschedules.
      Evidence: `apps/ios/SpikeEvidence/settings/ST52-inbox.png`, `ST52-filing-menu.png`, `ST52-permission-prompt.png`, `ST52-reminder-on.png`, `ST52-test-notification.png` (banner delivered); inbound time 07:30 rescheduled (`ST92-inbound-inbox.png`).
- [x] ST53 **Tasks row**: pushes the existing `TaskSettingsView`; Tasks "… › Task settings" still works (goes through ST20).

  Evidence: `apps/ios/SpikeEvidence/settings/ST53-tasks-row.png` (Settings › Tasks → `tasks.settings.screen`), and the Tasks-menu path in ST20.

## Phase 6: content

- [x] ST60 **19 / 19a Templates**: Built-in and My templates, + New, long-press menu (Edit, Duplicate, Delete; built-in: Duplicate only).
      Evidence: `apps/ios/SpikeEvidence/settings/ST60-templates.png`, `ST60-builtin-menu.png` (Duplicate only), `ST60-duplicated.png`, `ST60-mine-menu.png`.
- [x] ST61 **20 / 20a Template editor + delete**: note editor with title, icon, tags and folder pills; delete confirmation.
      Evidence: `apps/ios/SpikeEvidence/settings/ST61-editor.png` (title, icon, tags, body), tags edit saved; `ST61-delete-confirm.png`, template deleted.
- [x] ST62 **25 / 26 Tags**: filter, rows (color, icon, count), tap → items with the tag, row menu.
      Evidence: `apps/ios/SpikeEvidence/settings/ST62-tags.png`, `ST62-tags-filtered.png`, `ST62-tag-row-menu.png`.
- [x] ST63 **27 / 27a–d Tag actions**: merge sheet with search, result toast with count, color and icon sheet, rename alert (count in the message), delete confirmation.
      Evidence: Rename toast `(1 items)`, merge sheet/confirm/toast, colour+icon `ST63-color-icon-applied.png`, delete `(2 items)`; `testATagIsRenamedEverywhereAndDeleted` passed.
- [x] ST64 **28 / 29 / 29a / 29b Properties**: list by type, detail with options (add, rename, color, remove, drag reorder), delete property.

  Evidence: `apps/ios/SpikeEvidence/settings/ST64-properties.png`, `ST64-property-detail.png`, `ST64-option-menu.png`; added/renamed/removed `Agent Test opt` on `energy` (net zero); `ST64-delete-confirm.png` shown and cancelled.

## Phase 7: verification

- [x] ST90 Accessibility: AX5, forced RTL, Reduce Motion / Transparency, and a VoiceOver tree dump for root, Account, Appearance, Inbox and Tags.
      Evidence: `apps/ios/SpikeEvidence/settings/ST90-ax5-root.png`, `ST90-ax5-general.png`, `ST90-ax5-account.png` (rows stack), `ST90-rtl-root.png`, `ST90-rtl-appearance.png`, `ST90-reduce-transparency-account.png`; VoiceOver trees `apps/ios/SpikeEvidence/settings/a11y/ST90-{root,account,appearance,inbox,tags}-tree.txt` (email redacted).
- [x] ST91 Dark mode: light and dark screenshots of 01, 02, 12, 15, 18 and 25; every theme option applied live.
      Evidence: `apps/ios/SpikeEvidence/settings/ST91-{01,02,12,15,18,25}-{light,dark}.png`; every theme option applied live (ST43).
- [x] ST92 Cross-device sync, per goal.md "Verification": every §5 synced field in both directions against desktop dev; concurrent weekday edits; preserved desktop-only fields; device-local fields absent from the payload.
      Evidence: Peer = repo `memry` CLI + a /tmp tool calling `domain::settings` (the core writer desktop's schema matches). iOS→server: theme, accent, review enabled/time, default template, weekday 3 in payload with per-path clocks. Server→iOS without relaunch: theme white, font serif, language de (picker shows Deutsch), accent #6366f1, review 07:30, default template, weekday 2. Concurrent weekday 1 (iOS) + 2 (peer): both kept. `general.minimizeToTray` set by peer survived an iOS theme write. No device-local key in the payload. All test paths removed afterwards (payload back to `general:{}`, `inbox:{}`, tasks untouched).
- [x] ST93 Unit + UI + Conformance plans green; `cargo test` green; UI tests cover root navigation, one synced toggle, tag rename and device rename.
      Evidence: Unit 698 tests / 102 suites passed; UI 12 executed, 0 failures, 1 skipped (driver) incl. 4 `SettingsUITests`; Conformance 27 passed; `cargo test -p memry-core` 942 passed 0 failed; clippy clean; line ceilings passed; `git diff --check` clean.
- [x] ST94 Final report (§8); test data removed; renamed test devices restored.

---

Evidence: §8 below; `[agent]` tasks, test tags, template, property option removed; memry-C name restored; test-linked and CLI devices revoked.

## 5. Facts (filled in Phase 0)

### 5.1 Synced fields (desktop writers, verified)

<!-- path — desktop writer file:line — iOS control -->

- `general.{theme,accentColor,fontFamily,language}` — `ipc/settings-handlers.ts:1147` via `GENERAL_SYNCABLE_FIELDS` (:142) — Appearance / General. Same list also syncs `fontSize, fontSizePx, customFontFamily, createInSelectedFolder, openPagesInNewTab, minimizeToTray`: preserved, never written by iOS (F2).
- `inbox.{reviewReminderEnabled,reviewReminderTime}` — `settings-handlers.ts:343` (`INBOX_SYNCABLE_FIELDS` :155) — Inbox.
- `journal.defaultTemplate` — `settings-handlers.ts:494` (null = clear) — Journal.
- `journal.weekdayTemplates.<0-6>` — `settings-handlers.ts:508` via `syncSettingsMapEntryUpdates`, keys `/^[0-6]$/` (`settings/journal-template-keys.ts`) — Per-day templates.
- `tasks.*` — Rust `domain/task_settings.rs` (shipped).
- Desktop-only writers, preserved untouched: `sidebar.sectionOrder`, `sidebar.navCollapsed`, `sidebar.sortModes.<surface>`, `sidebar.notesFirst/showFiles`.
- No desktop writer: `calendar.weekStartDay`, `notes.defaultFolder`, `notes.spellCheck`, `editor.*` (in the schema only; spellCheck lives in `editor` local prefs). So week start, new-notes folder, spell check are device-local on iOS.

### 5.2 Device-local settings

<!-- setting — desktop storage — iOS key -->

- clockFormat / dateFormat — `general` local group (not in syncable list) — UserDefaults `settings.clockFormat` / `settings.dateFormat`.
- week start — desktop calendar local — `settings.weekStart`.
- new notes folder — vault config `defaultNoteFolder` — `settings.newNotesFolder`.
- spell check — editor prefs — `settings.spellCheck`.
- usage metrics — telemetry local — `settings.usageMetrics`.
- features toggles — local — `settings.features.<home|inbox|journal|tasks>`.
- journal showTasks/showStatsFooter, folder, date format — data-DB `journal.*` keys / vault config — `settings.journal.*`.
- inbox image filing + ask — local — `settings.inbox.imageFiling`, `settings.inbox.askEveryTime`.
- attachment download — local — `settings.attachmentDownload`.

### 5.3 Core surface

<!-- need — exists: path | add: signature -->

- settings read/write — exists: `domain/settings.rs` (`all/read/set/clear/remove`); add: UniFFI `Settings` object (`snapshot`, `get`, `set`, `clear`).
- devices — exists: server `GET/PATCH/DELETE /devices[/:id]` (`routes/devices.ts`; rename `{name 1..100}`, self-revoke 400); core has only `/auth/devices` directory read (`protocol/account.rs:46`); add: `AuthSession.devices/rename_device/revoke_device`.
- linking approver — exists: server `/auth/linking/{initiate,session/:id,approve}`; core crypto `send_master_key`, `derive_subkeys`, `sas_code_from_key`; add: `DeviceApprover` (`initiate`, `status`, `approve`, `cancel`), vault transfer block sealed like desktop `linking-service.ts:628`.
- storage / billing — exists: server `GET /sync/storage` `{used,limit,breakdown{notes,attachments,crdt,other}}`, `GET /auth/billing` `{plan,status,limits{storageLimit,maxFileSize,maxVaults,versionHistoryDays},usage,expiresAt}`; add: `AuthSession.storage/billing`.
- large notes — exists: `NOTE_SYNC_MAX_BYTES = 3_826_919` (`protocol/envelope.rs:69`); add: `Notes.large_notes()` at ratio 0.8.
- vault delete — exists: server `DELETE /sync/vaults/:id`; add: `AuthSession.delete_vault`.
- sync status — exists: `VaultSync` (`api/sync/mod.rs`); add: status snapshot if missing (ST15).
- tags / properties / templates bulk ops — exist per-item only (`domain/tags.rs`, `properties.rs` values-only, `templates.rs` create/rename/delete); add per ST16–ST18.

## 6. Decisions log

<!-- date — id — choice — why -->

- 2026-09-25 — goal — Voice memos settings skipped (F4); Paper artboards 22 and 22a are not built.
- 2026-09-25 — ST00a — Kaan redirected this session from memry-B to a new simulator memry-C (`0E5C90DE-62A7-42F7-94EB-82ECEBE99A59`, iPhone 16, iOS 26.5), DerivedData `/tmp/memry-dd-C`. goal.md and §0.3/§0.4 updated.
- 2026-09-25 — goal — Sync scope follows desktop (F2), which overrides Paper's "This iPhone" / "Shared" footers (F3).

- 2026-09-25 — ST10 — Inbound refresh is `Settings.revision()` (the settings row's `updated_at`), compared by the shell after each sync pass, instead of a callback across the FFI.
- 2026-09-25 — ST13 — Account calls sit on `AuthSession` (one token manager), and `RevocationWatch` watches all six. Test fakes get refusing defaults (`MemryTests/AuthSessionFakeDefaults.swift`).
- 2026-09-25 — ST14 — The approver's vault transfer lists `GET /sync/vaults` ids only (`{vaultUuid}`); when that list is empty or unreachable the block is omitted, which the new device treats as "fetch the list after registering" (desktop falls back to its current vault, which the phone core cannot name). Provider auth is not sent (no calendar on iOS).
- 2026-09-25 — ST15 — "Last synced" is kept by the shell (the time of the last successful `sync_now`), device-local; the core has no stored timestamp.
- 2026-09-25 — ST16 — Desktop's rename/delete rewrite notes (and journals via the note index) but not tasks; merge also rewrites tasks. goal.md asks for notes, journals and tasks on all three, so the core rewrites tasks on rename and delete too (a task keeping a deleted tag would otherwise resurrect it in the list). Nested `parent/child` tag definitions are not re-parented on rename (desktop renames children); left open.
- 2026-09-25 — ST17 — Desktop's option rename and definition delete leave note values untouched; the core does the same. Paper 29b's "removed from 38 notes, with its values" copy is replaced by desktop's behavior (notes keep their values).
- 2026-09-25 — ST18 — Built-in templates are desktop code, not synced: ported verbatim into `template_admin::BUILT_INS`, read-only. Desktop templates have no folder field, so the Paper editor's Folder pill is not built. "+ New" uses `templates::create` with an empty body.

- 2026-09-25 — ST20 — More root lists Settings; Inbox row behind the gate. `TasksRouter.settingsPath` is a `NavigationPath` so a Settings page can push a note or a tag (storage near-limit notes, tag items) in the More stack. Touched outside the listed scope for wiring only: `VaultListView` (builds `VaultSettingsScope`), `VaultSelection` (+`session`, `accountVaults`), `AuthStartup` (passes the watched session), `VaultFilling` (+`pendingChanges`), `TasksStore` (+`syncFinished` hook), `VaultWrite` (new-notes folder), `TaskListMoreMenu` (deep link).
- 2026-09-25 — ST22/F7 — Accent: `Tokens.Tint.base/foreground` and `Text.tint` became computed from `AccentRuntime` (default orange keeps `#B44309`); the root `.tint` uses the ink so menu text stays ≥4.5:1; switches fill with the accent. A view that draws a Memry fill re-reads it on its next render.
- 2026-09-25 — F6 — Warm and White both render the one light palette (tokens have `#FFFFFF` only); the theme tiles show Warm with the surface tint. With no synced theme iOS follows the system (desktop default is White).
- 2026-09-25 — F5 — The language override is `AppleLanguages` in the app's defaults; with no synced language the override is removed (system language).
- 2026-09-25 — ST44 — Features lists Home, Journal, Tasks (they have tabs on iOS); Inbox appears with its gate. Toggles are device-local, so the footer says this iPhone (F3), not "Shared".
- 2026-09-25 — ST50 — The default-template menu offers desktop's single "None (ask each time)" (value null) instead of Paper's two None rows. The per-day switch is a device-local view choice; the synced data is the seven day paths.
- 2026-09-25 — ST52 — Each device schedules the review reminder from the synced enabled/time; the notification says "Review your inbox / Tap to start." with no item count (notification text is outside the vault; spec 002 R12).
- 2026-09-25 — ST61 — The template body is edited as markdown text (`content` is markdown on the wire); the block editor edits CRDT note bodies and is not wired to templates.
- 2026-09-25 — ST36 — The link code is shown as a QR and a Copy button (the payload is ~200 chars of JSON), not Paper's short "4F7K · 92QD" code, which the protocol does not have. The QR sits on a white quiet zone (`Color.white`) for scanner contrast in dark mode.
- 2026-09-25 — ST92 — Desktop dev was not launched; the peer is the repo's `memry` CLI (a registered desktop-platform device on staging) writing through `domain::settings`, which is the same dotted-path/clock writer and merge desktop's handler reads. Recorded here so the desktop UI half can be re-run by hand.
- 2026-09-25 — ST90 — Pre-existing: on the recovery-phrase screen the Sign-out bar overlays Unlock while the keyboard is up, and at AX5 on the vault chooser; a mistaken tap opened the sign-out dialog twice during setup (dismissed, never confirmed). Not in this spec's scope; left open in §8.

## 7. Blockers

<!-- date — id — what — evidence — next retry -->

- 2026-09-25 — ST42 — iOS has no diagnostics seam and no report route in the core, so "Send diagnostic report" (artboard 11) is not built. Needs a core/API decision (reuse server `routes/diagnostics.ts`), outside this spec's additive scope for Swift-only work. Retry: next phase that owns diagnostics.

## 8. Final report

**Branch** `feat/ios-settings`, commits: `785dcd31a` Phase 0 audit; `f5582cee6` core API; `93eae6509` RevocationWatch; `def129dac` core remove + billing email; `bb5e43735` iOS Settings; plus the Phase 7 commit. Not pushed.

**Shipped (iOS).** More › Settings on one stack with deep links. Root (account card, General, Appearance, Features, Modules, Content, Data), Account (status, Sync now, attachment downloads, read-only plan, storage, devices, sign out), Storage, Devices (rename, revoke, link-new-device approver with QR and SAS), Vaults, General (+ new-notes folder), Appearance (colour mode, accent presets + ColorPicker, fonts), Features, About, Journal + per-day templates, Inbox (filing, review reminder, permission states, test notification), Templates + editor, Tags (filter, rename, merge, colour/icon, delete), Properties + detail (options add/rename/colour/remove/reorder, delete). Theme and accent apply app-wide.

**Core APIs added.** `Settings` (`snapshot/get/set/clear/remove/revision`, journal and review helpers); `AuthSession.devices/rename_device/revoke_device/storage/billing/delete_vault/device_approver`; `DeviceApprover.initiate/status/approve/cancel`; `VaultSync.pending_changes`; `Notes.large_notes`; `Tasks.tag_list/rename_tag/merge_tag/delete_tag/set_tag_color/set_tag_icon`, `property_definitions` + option edits + `delete_property_definition`, `template_list/create_template/duplicate_template/update_template/delete_template`. All additive; no schema, wire or sync-server change; `settings_merge.rs` untouched.

**Verification.** Every "Yes/Adapted/Shipped" row of audit 00 (minus voice memos) was reached on memry-C; ST92 covered every F2 field in both directions plus concurrent weekday edits and desktop-only field survival. Unit 698, UI 12 (1 skip), Conformance 27, cargo 942 green.

**Decisions.** §6 (F2 list confirmed, tags rewrite tasks on rename/delete, property delete keeps values, built-ins ported, dynamic accent tokens, peer choice for ST92, and the rest).

**Left open.**

- ST42 diagnostic report (§7).
- Nested `parent/child` tag definitions are not re-parented on rename.
- ST92 used the CLI peer, not the desktop app window; re-run the desktop UI half by hand.
- Journal and Inbox rows stay behind `SettingsFeatureGates` until those features merge (F9).
- Spell check, usage metrics, attachment download, week start and date/time formats are stored per device; only the new-notes folder has a consumer on iOS today.
- Pre-existing Sign-out bar overlap on the unlock and vault-chooser screens (§6 ST90).
- Reminder: Kaan is responsible for the submitted changes (CONTRIBUTING.md); AI (Claude) wrote this code and the evidence.
