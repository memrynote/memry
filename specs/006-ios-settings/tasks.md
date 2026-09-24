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
- Spec 004 §0.5 (test data) and §1 D1–D7 still apply. Simulator and sign-in come from goal.md "Simulator and sign-in" (memry-B, gmail-bridge OTP), not spec 004 §0.3/§0.4. Reuse the spec 005 primitives and its §6 token decisions.

### 0.2 Scope

- **iOS:** `Features/Settings/**` (new), `Features/Account/**`, `Features/Notes/VaultTabsView.swift`, `Features/Tasks/TaskSettings*` (re-parenting only), `Design/**` (shared primitives only), tests, and `SpikeEvidence/settings/`.
- **Core:** additive UniFFI API in `crates/memry-core/src/api/**`, domain helpers with Rust tests, and regenerated bindings.
- **Not allowed:** wire, protocol or schema changes, sync-server changes, changes to `settings_merge.rs` semantics, DB migrations. If one seems needed, log it in §7 and stop that item.

### 0.3 Verification

- Simulator **memry-B** `87D1093B-2676-4B04-9FCF-3479FF10859D` only; `-derivedDataPath /tmp/memry-dd-B`; XcodeBuildMCP `simulatorId` = that UDID. Never target by name or `booted`. Never boot, shut down or erase another simulator; `simctl shutdown all` / `erase all` are forbidden. Drive the app with `AgentDriverUITests`. Screenshots go to `apps/ios/SpikeEvidence/settings/STxx-<state>.png`; compare each with `paper_get_screenshot`.
- `xcodebuild test -project apps/ios/Memry.xcodeproj -scheme Memry -testPlan Unit|UI -destination 'platform=iOS Simulator,id=87D1093B-2676-4B04-9FCF-3479FF10859D' -derivedDataPath /tmp/memry-dd-B`, with Conformance green and untouched.
- `cargo test -p memry-core`, `cargo clippy -p memry-core -- -D warnings`, `node scripts/check-line-ceilings.mjs`, `git diff --check`.
- Never revoke the simulator's own device or the desktop dev device.

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

- [ ] ST00a Read everything in goal.md "Read first". Read Paper 00 (`58I-0`), 01 (`5IQ-0`), and every phone artboard via `get_screenshot` + `get_jsx`.
- [ ] ST00b Verify F2 against desktop `main`:
  - List every caller of `syncSettingsFieldUpdate` / `syncSettingsUpdates` / `syncSettingsMapEntryUpdates`, plus the Rust `task_settings` writers.
  - Confirm whether `calendar.weekStartDay`, `notes.defaultFolder`, `notes.spellCheck` and `editor.*` have a desktop writer.
  - Record the final synced-field table in §5.
- [ ] ST00c Verify the core surface table in goal.md. For each need, write "exists: <path>" or "add: <signature>" in §5. Confirm the server endpoints (`/devices`, `/linking/*`, `/storage`, `/billing`, `/vaults/:id`) and their request/response shapes from `apps/sync-server/src/routes`.
- [ ] ST00d Map each desktop device-local setting to its iOS storage key (UserDefaults suite or core local table) in §5.

## Phase 1: core (Rust + UniFFI)

- [ ] ST10 `Settings` API: `snapshot`, `get(path)`, `set(path, json)`, `clear(path)`, built on `domain::settings`, plus a change notification after pull (a projector hook or the existing vault change stream).
  - Tests: a write to `general.theme` leaves `general.minimizeToTray`, `sidebar.*` and an unknown group byte-identical; `null` and absent stay distinct; `journal.weekdayTemplates.3` gets its own clock; concurrent edits to different days merge.
- [ ] ST11 Journal template settings helpers (`default_template`, `set_default_template(Option)`, `weekday_templates`, `set_weekday_template(day, Option)`), sanitized to days 0–6 exactly as desktop `journal-template-keys.ts` does.
- [ ] ST12 Inbox review settings helpers (`review_reminder`, `set_review_reminder(enabled, time "HH:mm")`), with the time format validated like desktop.
- [ ] ST13 Account: `devices`, `rename_device`, `revoke_device`, `storage`, `billing` (read-only), `delete_vault`. Errors map to typed `ApiError`s.
- [ ] ST14 Linking, approver side: `initiate` (QR payload, short code, expiry), `poll`, `approve`, `cancel`. Vault keys are wrapped exactly as desktop's approver does. Tested against the recorded conformance vectors, if any exist.
- [ ] ST15 Sync status snapshot (state, last synced, pending count) if not already exposed; `large_notes()` using `NOTE_SYNC_MAX_BYTES` and a warning ratio of 0.8.
- [ ] ST16 Tags: `tag_definitions` (name, color, icon, count), `rename_tag`, `merge_tag(source, target)`, `delete_tag`, `set_tag_color`, `set_tag_icon`. Each touches notes, journals and tasks as desktop `tags-handlers.ts` does and enqueues sync for every changed item. Tests cover case-folding (`tags::same_tag`) and merge into an existing tag.
- [ ] ST17 Properties: definition list with type and options; `rename_option`, `set_option_color`, `remove_option`, `reorder_options`, `add_option`, `delete_definition` (removes values from notes). Semantics match desktop `properties-section.tsx` and its handlers.
- [ ] ST18 Templates: list with the built-in flag, `duplicate`, `update` (title, icon, tags, folder, body), `delete`; built-in templates are read-only.
- [ ] ST19 Regenerate the Swift bindings; `cargo test -p memry-core` and clippy are green; the iOS build compiles against the new API. Commit `feat(core): settings, account, linking, tags, properties, templates API`.

## Phase 2: shell and primitives

- [ ] ST20 More tab root: Inbox row (F9 gate) and Settings row. `SettingsRoute` enum on one `NavigationStack`; deep links from Tasks, Journal and Inbox "… › settings" land on the section with Back returning to Settings root (flow lane 01).
- [ ] ST21 Primitives in `Features/Settings/SettingsPrimitives.swift`: value row, menu row, toggle row, destructive row, footer, account card, color swatch, and the storage bar, all reusing spec 005 tokens.
- [ ] ST22 `SettingsStore` (`@Observable`) over ST10 plus a `LocalSettings` wrapper for device-local keys. Optimistic write with revert and an error notice on failure; live refresh on inbound sync. Unit-tested.

## Phase 3: account

- [ ] ST30 **01 / 01b Settings root**: account card (email, plan, sync dot + status), groups, trailing values; no Voice memos row (F4).
- [ ] ST31 **02 Account**: identity + E2E badge, status, Sync now, Download attachments (Always / On Wi-Fi / Never, device-local), Plan (read-only, F8), Storage and Devices rows, Sign out.
- [ ] ST32 **03 Storage**: bar + legend from `storage()`, plan limits footer, large notes list (tap opens the note), empty state when none.
- [ ] ST33 **04 Devices**: this device, others with platform and last seen, show-more past 5 (desktop behavior).
- [ ] ST34 **05 Rename device**: alert with a TextField, validated to be non-empty, toast "Renamed to …".
- [ ] ST35 **06 Revoke device**: swipe → confirmation; this device cannot be revoked here (the row has no swipe).
- [ ] ST36 **07 Link new device**: QR + code sheet, countdown, cancel; approval prompt when the new device scans (flow lane 04); the device appears in the list.
- [ ] ST37 **08 Sign out**: move `SignOutBar` behavior onto Account; the More root loses it (F1). Revocation handling is unchanged.
- [ ] ST38 **23 / 24 Vaults**: on this iPhone (open / switch), in account (Download), swipe → delete with confirmation; the currently open vault cannot be deleted from here.

## Phase 4: application

- [ ] ST40 **09 / 09b General**: Language (F5), time format and date format menus with live examples (device-local), week start (per ST00b), spell check, usage metrics (device-local).
- [ ] ST41 **10 New notes folder**: folder tree picker, check on the current one; storage per ST00b.
- [ ] ST42 **11 Diagnostic report**: preview sheet showing exactly what will be sent (no content), Send; reuse the existing diagnostics seam if iOS has one, otherwise log it in §7.
- [ ] ST43 **12 / 12b / 13 Appearance**: color mode tiles (F6), accent presets + custom (F7), font list (built-in only); all synced; applied app-wide immediately.
- [ ] ST44 **14 Features**: four toggles (device-local); the last one on refuses to turn off; tabs and More rows rebuild; turning a module off stops its reminders (flow lane 06).
- [ ] ST45 **21 About**: version and build, GitHub, feedback, privacy, terms, licenses.

## Phase 5: modules

- [ ] ST50 **15 / 16 Journal**: default template menu (None (ask each time), None, templates), per-day toggle, Day page toggles, folder, date format + preview (device-local per F2).
- [ ] ST51 **17 Per-day templates**: seven day menus, "N of 7 set", a deleted template shows "Deleted template" and falls back to default, Clear all; each day writes its own path.
- [ ] ST52 **18 / 18a / 18b / 18c Inbox**: image filing menu + ask toggle (device-local); review reminder toggle + time (synced) schedules a daily `UNCalendarNotificationTrigger` on this device; permission prompt, denied state with Open iOS Settings and a recheck on `.active`; Send test; notification tap opens Inbox; an inbound synced change reschedules.
- [ ] ST53 **Tasks row**: pushes the existing `TaskSettingsView`; Tasks "… › Task settings" still works (goes through ST20).

## Phase 6: content

- [ ] ST60 **19 / 19a Templates**: Built-in and My templates, + New, long-press menu (Edit, Duplicate, Delete; built-in: Duplicate only).
- [ ] ST61 **20 / 20a Template editor + delete**: note editor with title, icon, tags and folder pills; delete confirmation.
- [ ] ST62 **25 / 26 Tags**: filter, rows (color, icon, count), tap → items with the tag, row menu.
- [ ] ST63 **27 / 27a–d Tag actions**: merge sheet with search, result toast with count, color and icon sheet, rename alert (count in the message), delete confirmation.
- [ ] ST64 **28 / 29 / 29a / 29b Properties**: list by type, detail with options (add, rename, color, remove, drag reorder), delete property.

## Phase 7: verification

- [ ] ST90 Accessibility: AX5, forced RTL, Reduce Motion / Transparency, and a VoiceOver tree dump for root, Account, Appearance, Inbox and Tags.
- [ ] ST91 Dark mode: light and dark screenshots of 01, 02, 12, 15, 18 and 25; every theme option applied live.
- [ ] ST92 Cross-device sync, per goal.md "Verification": every §5 synced field in both directions against desktop dev; concurrent weekday edits; preserved desktop-only fields; device-local fields absent from the payload.
- [ ] ST93 Unit + UI + Conformance plans green; `cargo test` green; UI tests cover root navigation, one synced toggle, tag rename and device rename.
- [ ] ST94 Final report (§8); test data removed; renamed test devices restored.

---

## 5. Facts (filled in Phase 0)

### 5.1 Synced fields (desktop writers, verified)

<!-- path — desktop writer file:line — iOS control -->

### 5.2 Device-local settings

<!-- setting — desktop storage — iOS key -->

### 5.3 Core surface

<!-- need — exists: path | add: signature -->

## 6. Decisions log

<!-- date — id — choice — why -->

- 2026-09-25 — goal — Voice memos settings skipped (F4); Paper artboards 22 and 22a are not built.
- 2026-09-25 — goal — Sync scope follows desktop (F2), which overrides Paper's "This iPhone" / "Shared" footers (F3).

## 7. Blockers

<!-- date — id — what — evidence — next retry -->

## 8. Final report
