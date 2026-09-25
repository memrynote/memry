# Goal: build iOS Settings from the Paper design

## Context

- Branch: create `feat/ios-settings` in a worktree off `main`. No `codex/`, `claude/` or random names.
- iOS has almost no settings today. `VaultTabsView.swift` has a `MoreTab` holding one "Tasks settings" row, a "coming soon" note and `SignOutBar`. Task settings already ship (`TaskSettingsView`, spec 004).
- The design lives in Paper: file **"Task iOS"**, id `01M39KJ8S9S5QYX38B2HP3Q1BF`, page **"Settings iOS"** (`p-4-0`). Use the Paper MCP (`paper_get_basic_info`, `paper_get_tree_summary`, `paper_get_jsx`, `paper_get_computed_styles`, `paper_get_screenshot`).
- Your job: build every Settings screen from that page as native SwiftUI, backed by real data, and sync every setting desktop syncs today.
- Unlike spec 005 (tasks redesign), this feature needs core work. Most settings reads and writes, and every account management call, are not exposed through UniFFI yet.

## Read first (once)

1. Root `AGENTS.md`, `apps/ios/AGENTS.md`, `DESIGN.md`, `PRODUCT.md`.
2. `specs/004-ios-tasks-parity/tasks.md` §0.5 (test data prefixes), §1 D1–D7. These still apply. Its simulator (§0.3) and sign-in (§0.4) are replaced by "Simulator and sign-in" below.
3. `specs/005-ios-tasks-redesign/goal.md` and the §6 Decisions of its `tasks.md`. Reuse its primitives, sheet chrome and Tokens mapping; do not invent a second style.
4. Paper artboard **"00 · Settings feature audit"** in full. Treat it as the spec for what ships and where it lives, except where the "Fixed decisions" below override it.
5. Paper artboard **"01 · Settings flow"**: lanes 01–07.
6. Every phone artboard 01–29 and its lettered variants. For each one, read `get_tree_summary`, `get_jsx` and the layer names.
7. The desktop sources of truth:
   - `apps/desktop/src/renderer/src/pages/settings/*` for behavior and copy.
   - `packages/i18n/src/locales/en/settings.json` for wording.
   - `packages/contracts/src/settings-sync.ts` for the synced schema.
   - `apps/desktop/src/main/ipc/settings-handlers.ts` (`GENERAL_SYNCABLE_FIELDS`, `INBOX_SYNCABLE_FIELDS`, the journal writers) for which fields desktop actually syncs.
   - `apps/desktop/src/main/sync/item-handlers/settings-handler.ts` for inbound merge semantics.
8. The core side:
   - `crates/memry-core/src/domain/settings.rs` (dotted-path `set` / `clear` / `remove` / `read` / `all`).
   - `crates/memry-core/src/sync/settings_merge.rs`.
   - `crates/memry-core/src/api/projects.rs` (the `task_settings` pattern to copy).
   - `api/account.rs`, `api/linking.rs`, `api/auth.rs`.
   - `domain/tags.rs`, `domain/properties.rs`, `domain/templates.rs`.
9. All of `apps/ios/Memry/Features/Account/`, `Features/Notes/VaultTabsView.swift`, `Features/Tasks/TaskSettings*`, `Features/Unlock/QRLinkView.swift` and `Design/Tokens.swift` before editing.

## Fixed decisions (do not revisit)

- **F1. Location.** Settings is a page in the **More** tab. The More root lists Inbox (when that ships) and a Settings row. Settings root is artboard 01. Sign out lives only on the Account page (02). Remove `SignOutBar` from the More root once Account ships, and keep it everywhere else it appears today.
- **F2. Sync scope = what desktop syncs today, nothing more, nothing less.**
  - Read and write, through the `settings` sync item with per-field clocks:
    - `general`: `theme`, `accentColor`, `fontFamily`, `language`.
    - `inbox`: `reviewReminderEnabled`, `reviewReminderTime`.
    - `journal`: `defaultTemplate`, and `weekdayTemplates.<0..6>` (one clock per day; `null` = cleared).
    - `tasks`: already shipped.
  - Preserve byte for byte and never write: `general.fontSize`, `fontSizePx`, `customFontFamily`, `startOnBoot`, `createInSelectedFolder`, `openPagesInNewTab`, `minimizeToTray`; `editor.*`, `keyboard.*`, `sidebar.*`, `sync.*`; and any unknown group. `settings.rs` already preserves them. Do not rebuild the payload.
  - Synced as their own item types, not settings: tag definitions (color, icon), property definitions, templates. Tag rename, merge and delete rewrite the notes, journals and tasks that carry the tag, exactly as desktop does.
  - Device-local on iOS (UserDefaults, or the core's local settings table if it already has one), because desktop keeps them local too:
    - time format and date format
    - Features toggles
    - journal Day page toggles, folder and date format
    - image filing mode and "ask every time"
    - usage metrics
    - attachment download
  - ST00 re-verifies this list against desktop `main` before any code. If desktop writes a field this list does not name, add it and log the change in §6.
- **F3. Paper footers that contradict F2 are wrong.** Examples: theme, accent and font say "This iPhone" but sync; Features and the journal location say "Shared" but are local. The copy follows F2. Fix the text in the app, not the layout.
- **F4. Voice memos (artboards 22 and 22a) are out of scope.** No Settings row for them. Log it as skipped.
- **F5. Language** is an in-app picker (the desktop list) that writes `general.language` and sets the app's language override, which takes effect on the next launch; the footer says so. An inbound synced language applies the same way. This replaces Paper's "Opens iOS Settings".
- **F6. Theme.** Warm, White, Dark and System map to the app's existing light and dark palettes. Warm and White are both light; if Tokens has no White variant, White uses the canvas `#FFFFFF` background, and that choice is logged. An unknown synced value falls back to System and is preserved.
- **F7. Accent.** The preset hex values come from desktop `appearance-section.tsx`. Custom uses `ColorPicker(supportsOpacity: false)`. The accent tints fills only; tinted text uses a contrast-safe ink derived from it (rule 6), with the orange accent keeping `#B44309`.
- **F8. Billing is read-only.** No checkout, upgrade, yearly switch or portal link: App Store rules. The copy is "Plans are managed in memrynote on your computer."
- **F9. Journal and Inbox settings depend on those features being on iOS.** Build the screens and the core calls. If the Journal or Inbox iOS feature is not merged yet, its settings row stays hidden behind the same feature gate, and its RD item is ticked on unit plus UI evidence against a seeded vault. Log it.
- **F10. Anything else ambiguous:** pick desktop's behavior, log it, continue. No questions to Kaan.

## Scope

- **iOS:** `apps/ios/Memry/Features/Settings/**` (new), `Features/Account/**`, `Features/Notes/VaultTabsView.swift` (More tab), `Features/Tasks/TaskSettings*` (only to re-parent under Settings), `apps/ios/Memry/Design/**` (shared primitives only), tests under `MemryTests` / `MemryUITests`, and evidence under `apps/ios/SpikeEvidence/settings/`.
- **Core:** additive UniFFI surface only, in `crates/memry-core/src/api/**`, plus domain helpers where a desktop operation has no Rust equivalent (tag rename/merge/delete, property definition CRUD, template CRUD). Each new call gets Rust unit tests. Regenerate the Swift bindings with the repo's script.
- **Not allowed:** wire, protocol or schema changes; changes to the sync-server; changes to `settings_merge.rs` semantics; DB migrations. If one seems needed, log it in §7 Blockers and stop that item.
- Backward compatibility (root AGENTS.md): a payload written by an older desktop or iOS build must still merge; unknown fields survive; `null` and absent stay distinct.

## Core surface expected (verify, then add what is missing)

| Need                          | Existing                                                                      | To add (proposed name, adjust to local conventions)                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synced settings read/write    | `domain::settings::{all, read, set, clear}`                                   | `Settings` UniFFI object: `get(path) -> Option<Json>`, `set(path, json)`, `clear(path)`, `snapshot()`, plus a change stream or an existing projector callback so iOS refreshes on pull |
| Devices                       | server `GET /devices`, `PATCH /devices/:id`, `DELETE /devices/:id`            | `Account.devices()`, `rename_device`, `revoke_device`                                                                                                                                  |
| Link a device (approver side) | server `/linking/initiate`, `/linking/approve`; iOS has the scanner side only | `Linking.initiate() -> {qr, code, expires}`, `poll`, `approve` (wraps vault keys like desktop)                                                                                         |
| Storage and plan              | server `GET /storage`, `GET /billing`                                         | `Account.storage()`, `Account.billing()` (read-only)                                                                                                                                   |
| Notes near the sync limit     | `NOTE_SYNC_MAX_BYTES` rule in `sync-client/note-size.ts`                      | `Notes.large_notes()` using the same limit and the same 0.8 warning ratio                                                                                                              |
| Vaults in account             | `Account.vaults()`, server `DELETE /vaults/:id`                               | `Account.delete_vault(id)`                                                                                                                                                             |
| Sync status, sync now         | `VaultSync.sync_now()`                                                        | status snapshot (last synced, pending count, offline/paused) if not already exposed                                                                                                    |
| Tags                          | `Notes.tags()`, `domain::tags` per-note                                       | `rename_tag`, `merge_tag`, `delete_tag`, `set_tag_color`, `set_tag_icon` across notes, journals and tasks, matching desktop `tags-handlers.ts`                                         |
| Properties                    | `domain::properties::definitions`                                             | definition CRUD and option rename, color, remove and reorder, matching desktop `properties-section.tsx`                                                                                |
| Templates                     | `domain::templates::{create, rename, delete}`                                 | `duplicate`, `update_body`, and a list with the built-in flag                                                                                                                          |

## Screens (Paper artboard → code)

| Artboard                       | Defines                                                                                                                                                                                     | Notes                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 01 / 01b Settings              | Account card (avatar, email, plan · sync dot + status), groups: General, Appearance, Features; Modules (Journal, Tasks, Inbox); Content (Templates, Tags, Properties); Data (Vaults, About) | Drop the Voice memos row (F4). Rows show their current value trailing.               |
| 02 Account                     | Identity + E2E badge, Sync (status, Sync now, Download attachments), Plan and devices, Sign out                                                                                             |                                                                                      |
| 03 Storage                     | Bar + legend by category, plan limits footer, notes near the sync limit (tap opens the note)                                                                                                |                                                                                      |
| 04–07 Devices                  | This device, other devices, long press → rename (05), swipe → revoke (06), Link new device QR sheet with countdown (07)                                                                     |                                                                                      |
| 08 Sign out                    | Existing `AccountCopy` confirmation                                                                                                                                                         | Reuse `SignOutService`.                                                              |
| 09 / 09b / 10 / 11 General     | Language (F5), time and date format menus, week start, new notes folder picker, spell check, metrics, diagnostic report preview sheet                                                       | Week start and the notes folder are device-local unless ST00 finds a desktop writer. |
| 12 / 12b / 13 Appearance       | Color mode tiles, accent swatches + custom, font list                                                                                                                                       |                                                                                      |
| 14 Features                    | Home, Inbox, Journal, Tasks toggles; you cannot turn off the last one                                                                                                                       |                                                                                      |
| 15–17 Journal                  | Default template menu, per-day toggle + per-day page, Day page toggles, folder, date format + preview                                                                                       |                                                                                      |
| 18 / 18a / 18b / 18c Inbox     | Image filing menu + ask toggle, review reminder toggle + time + test, notifications-denied state                                                                                            |                                                                                      |
| 19 / 19a / 20 / 20a Templates  | List (built-in and mine), row menu, editor (note editor), delete                                                                                                                            |                                                                                      |
| 21 About                       | Version, GitHub, feedback, privacy, terms, licenses                                                                                                                                         |                                                                                      |
| 23 / 24 Vaults                 | On this iPhone / in account, Download, swipe → delete + confirm                                                                                                                             |                                                                                      |
| 25–27d Tags                    | Filter, rows with color and count, row menu, merge sheet, result toast, color and icon sheet, rename, delete                                                                                |                                                                                      |
| 28 / 29 / 29a / 29b Properties | List by type, detail with options, option menu, delete                                                                                                                                      |                                                                                      |
| Tasks row                      | Pushes the existing `TaskSettingsView`                                                                                                                                                      | No redesign.                                                                         |

## Simulator and sign-in

Other agent sessions test iOS at the same time, each on its own simulator. This spec uses **memry-C** and nothing else.

- Simulator: `memry-C` (iPhone 16, iOS 26.5), UDID `0E5C90DE-62A7-42F7-94EB-82ECEBE99A59`.
  - Created once with `xcrun simctl create "memry-C" "iPhone 16"`. If `xcrun simctl list devices | grep memry-C` shows nothing, create it again with the same command and record the new UDID in tasks.md §6.
- Every build, install, launch and test command uses `-destination 'platform=iOS Simulator,id=0E5C90DE-62A7-42F7-94EB-82ECEBE99A59'`. Never target by name and never use `booted`.
- DerivedData: always `-derivedDataPath /tmp/memry-dd-C`.
- XcodeBuildMCP: pass `simulatorId: 0E5C90DE-62A7-42F7-94EB-82ECEBE99A59`.
- `simctl` commands (boot, install, launch, screenshot, openurl) name the UDID explicitly.
- Do not boot, shut down or erase any other simulator. `simctl shutdown all` and `simctl erase all` are forbidden. Never erase memry-C either; if it is wedged, shut down only memry-C and boot it again.

Sign in, if the app asks:

- Email: `kaan94karaca@gmail.com`
- OTP: read the latest email from `noreply@memrynote.com` through the **gmail-bridge** MCP and enter its code. Wait for a message newer than the request; do not reuse an older code.
- Recovery phrase: `reject youth sing exist joy mobile economy chalk boil girl tag attack round lunar dove alley bright bonus there dumb rent erode force yard`
- These are test credentials that Kaan revokes after the session. Do not copy them into code, tests, evidence files or commit messages.

## Rules (non-negotiable)

- **Native iOS 26:** `NavigationStack` + `List(.insetGrouped)`, `LabeledContent`, `Picker(.menu)` / `.navigationLink`, `Toggle`, `DatePicker(.hourAndMinute)`, `ColorPicker`, `.confirmationDialog`, `.alert` with a `TextField`, `.swipeActions`, `.contextMenu`, `.presentationDetents`, `ShareLink` / `openURL`. System glass, never hand-drawn.
- **Tokens:** values come from Paper via `get_jsx` / `get_computed_styles`, mapped to `Tokens`. No hex in views, no `Font.system(size:)`. Reuse the spec 005 token decisions.
- **Saving:** every change saves on change. Only destructive actions confirm. A failed write reverts the control and shows `ErrorMapping` copy. Inbound synced changes update open screens live.
- **Copy:** a `SettingsCopy*` pattern that mirrors `settings.json` wording where it exists; new strings are logged.
- **Accessibility:** VoiceOver labels and values on every row, Dynamic Type to AX5 (rows stack), 44pt targets, Reduce Motion and Reduce Transparency, leading/trailing only, WCAG AA in light and dark.
- **iOS rules:** no `!` / `try!`, `ErrorMapping`, `Log.swift`, feature files ≤ 400 lines (`node scripts/check-line-ceilings.mjs`).
- **Rust rules:** `cargo fmt`, `cargo clippy -D warnings`, and `cargo test -p memry-core` green. Every new API has tests, including the "unknown group survives a write" and "null vs absent" cases for settings.

## Workflow

1. **Phase 0, plan and audit.** Fill in `tasks.md` ST00: verify F2 against desktop, verify every row of the core surface table, and read every artboard.
2. **Phase 1, core.** ST10–ST18. Bindings regenerated; `cargo test` green.
3. **Phase 2, shell and primitives.** ST20–ST22: More → Settings navigation, the settings row/group primitives, the synced-settings store for iOS (`@Observable`, a live refresh on pull).
4. **Phase 3, account.** ST30–ST37 (artboards 01–08, 23–24).
5. **Phase 4, application.** ST40–ST45 (09–14, 21).
6. **Phase 5, modules.** ST50–ST53 (15–18, Tasks row).
7. **Phase 6, content.** ST60–ST64 (19–20, 25–29).
8. **Phase 7, verification.** ST90 accessibility, ST91 dark mode, ST92 cross-device sync, ST93 tests, ST94 final report.
9. **Commits:** one per phase, explicit paths, `feat(ios): …` for Swift and `feat(core): …` for Rust. No push, no PR.

## Verification (per item, before ticking)

- Simulator **memry-C** only (see "Simulator and sign-in"), driven by `AgentDriverUITests`. Screenshot to `apps/ios/SpikeEvidence/settings/STxx-<state>.png` and compare it with `paper_get_screenshot` of the artboard.
- **Sync (ST92, required for every F2 synced field):**
  - Change the field on iOS; desktop dev on the same account shows it after a pull.
  - Change it on desktop; iOS shows it without a relaunch.
  - Change different `journal.weekdayTemplates` days on both devices at the same time; both edits survive.
  - A desktop-only field (for example `general.minimizeToTray`) set on desktop survives an iOS write to `general.theme` (check the payload).
  - Device-local fields never appear in the payload.
- **Commands:**
  - `xcodebuild test … -testPlan Unit|UI`; Conformance stays green.
  - `cargo test -p memry-core`
  - `node scripts/check-line-ceilings.mjs`
  - `git diff --check`
- Test data uses the `[agent] ` / `Agent Test …` prefixes. Delete it at the end, including test tags, properties, templates and any renamed device (rename it back).
- Never revoke the simulator's own device or the desktop dev device. Revoke only a device you linked for the test.

## Done when

- ST00–ST94 are ticked with evidence.
- Every "Yes", "Adapted" and "Shipped" row in the 00 audit, minus voice memos, is reachable and exercised on the simulator.
- Every F2 synced field has passed ST92 in both directions.
- Unit, UI and Conformance plans are green, and `cargo test` is green.
- `specs/006-ios-settings/tasks.md` ends with a final report: what shipped, the core APIs added, decisions, and anything left open.
