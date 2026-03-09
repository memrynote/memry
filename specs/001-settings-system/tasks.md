# Tasks: Settings System

**Input**: Design documents from `/specs/001-settings-system/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: TDD workflow recommended per project conventions (write test → fail → implement → pass) for each implementation task. Test tasks not listed separately to keep this actionable — embed tests alongside each implementation step.

**Organization**: Tasks grouped by user story. Each story is independently implementable and testable after Phase 2 (Foundational) completes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story (e.g., US1, US2...) — omitted for Setup/Foundational/Polish phases

---

## Phase 1: Setup (Shared Contracts & Schemas)

**Purpose**: Define all Zod schemas and IPC channel definitions that every story depends on

- [x] T001 [P] Define GeneralSettings, EditorSettings, TaskSettings Zod schemas in `packages/contracts/src/settings-schemas.ts`
- [x] T002 [P] Define KeyboardShortcuts, SyncSettings, AISettings, BackupSettings Zod schemas in `packages/contracts/src/settings-schemas.ts`
- [x] T003 Add new settings group channels (general, editor, tasks, keyboard, sync, backup) to SettingsChannels in `packages/contracts/src/ipc-channels.ts`
- [x] T004 [P] Add AccountChannels (get-info, get-devices, remove-device, sign-out, get-recovery-key) to `packages/contracts/src/ipc-channels.ts`
- [x] T005 [P] Add TagChannels (get-all, rename, merge, delete) to `packages/contracts/src/ipc-channels.ts`
- [x] T006 [P] Add DataChannels (vault get/change, export, import, clear-cache, rebuild-index) to `packages/contracts/src/ipc-channels.ts`
- [x] T007 [P] Add AIChannels (set-api-key, test-connection) to `packages/contracts/src/ipc-channels.ts`
- [x] T008 Regenerate IPC type map via `pnpm ipc:generate` and verify contracts build with `pnpm --filter @memry/contracts build`

**Checkpoint**: All contracts defined and typed — IPC handlers + renderer hooks can now be built

---

## Phase 2: Foundational (Settings Infrastructure)

**Purpose**: Core patterns that MUST be complete before ANY user story UI work begins

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T009 Add IPC handlers for GeneralSettings (get/set with defaults) in `apps/desktop/src/main/ipc/settings-handlers.ts`
- [x] T010 [P] Add IPC handlers for EditorSettings (get/set, absorb noteEditor.toolbarMode) in `apps/desktop/src/main/ipc/settings-handlers.ts`
- [x] T011 [P] Add IPC handlers for TaskSettings (get/set with defaults) in `apps/desktop/src/main/ipc/settings-handlers.ts`
- [x] T012 [P] Add IPC handlers for KeyboardShortcuts (get/set/reset with defaults) in `apps/desktop/src/main/ipc/settings-handlers.ts`
- [x] T013 [P] Add IPC handlers for SyncSettings (get/set with defaults) in `apps/desktop/src/main/ipc/settings-handlers.ts`
- [x] T014 [P] Add IPC handlers for BackupSettings (get/set with defaults) in `apps/desktop/src/main/ipc/settings-handlers.ts`
- [x] T015 Add settings corruption recovery: wrap each group's JSON.parse in try/catch, delete corrupted key + return defaults + log warning in `apps/desktop/src/main/ipc/settings-handlers.ts`
- [x] T016 Create useGeneralSettings() hook with IPC invoke + CHANGED event subscription in `apps/desktop/src/renderer/src/hooks/use-general-settings.ts`
- [x] T017 [P] Create useEditorSettings() hook in `apps/desktop/src/renderer/src/hooks/use-editor-settings.ts`
- [x] T018 [P] Create useTaskSettings() hook in `apps/desktop/src/renderer/src/hooks/use-task-preferences.ts` (named useTaskPreferences to avoid collision with existing subtask settings hook)
- [x] T019 [P] Create useKeyboardSettings() hook in `apps/desktop/src/renderer/src/hooks/use-keyboard-settings.ts`
- [x] T020 [P] Create useSyncSettings() hook in `apps/desktop/src/renderer/src/hooks/use-sync-settings.ts`
- [x] T021 [P] Create useBackupSettings() hook in `apps/desktop/src/renderer/src/hooks/use-backup-settings.ts`
- [x] T022 Refactor `apps/desktop/src/renderer/src/pages/settings.tsx` into thin shell: vertical tab nav (left sidebar) + dynamic section rendering (right pane), extract existing sections into `apps/desktop/src/renderer/src/pages/settings/` directory
- [x] T023 Extend synced settings schema with new groups (general, editor, tasks, keyboard.overrides) in `packages/contracts/src/settings-sync.ts`
- [x] T024 Update preload bridge to expose new settings + account + tag + data channels in `apps/desktop/src/preload/index.ts`

**Checkpoint**: Foundation ready — all IPC round-trips work, hooks subscribe to changes, settings page shell renders with tab navigation

---

## Phase 3: User Story 1 — Change App Theme (P1) 🎯 MVP

**Goal**: User can switch between light, dark, and system theme modes with instant visual feedback

**Independent Test**: Open settings → select theme → verify entire app changes immediately. Switch OS theme with "System" selected → verify app follows.

- [x] T025 [US1] Build GeneralSection component with theme selector (3-option segmented control: light/dark/system) in `apps/desktop/src/renderer/src/pages/settings/general-section.tsx`
- [x] T026 [US1] Create useThemeSync() hook that bridges GeneralSettings.theme → next-themes setTheme(), listens to settings:changed events in `apps/desktop/src/renderer/src/hooks/use-theme-sync.ts`
- [x] T027 [US1] Wire useThemeSync() into App.tsx inside ThemeProvider — ensure theme persists on restart and follows OS when "system" selected in `apps/desktop/src/renderer/src/App.tsx`
- [x] T028 [US1] Add accent color picker with hex presets to GeneralSection, apply via CSS custom property `--accent` in `apps/desktop/src/renderer/src/pages/settings/general-section.tsx`

**Checkpoint**: Theme switching works end-to-end. Restart preserves choice. "System" follows OS. Accent color applies globally.

---

## Phase 4: User Story 2 — Manage Sync Account and Devices (P1)

**Goal**: Signed-in user sees account info, device list, can remove devices and sign out

**Independent Test**: Open account settings → verify email/provider/date shown → view device list → remove a non-current device → sign out and confirm data cleared.

- [ ] T029 [US2] Create account-handlers.ts with IPC handlers: get-account-info (reads auth state + server profile), get-devices (calls sync server GET /devices), remove-device, sign-out (clears local sync data) in `apps/desktop/src/main/ipc/account-handlers.ts`
- [ ] T030 [US2] Register account handlers in main process IPC registration in `apps/desktop/src/main/ipc/index.ts`
- [ ] T031 [P] [US2] Create useAccountInfo() hook (invoke account:get-info, cache via TanStack Query) in `apps/desktop/src/renderer/src/hooks/use-account-info.ts`
- [ ] T032 [P] [US2] Create useDevices() hook (invoke account:get-devices, cache + invalidate on remove) in `apps/desktop/src/renderer/src/hooks/use-devices.ts`
- [ ] T033 [US2] Build AccountSection component: avatar + email + provider badge + creation date, storage usage progress bar, device list with platform icons + last sync + remove button, sign-out danger button with confirmation dialog in `apps/desktop/src/renderer/src/pages/settings/account-section.tsx`

**Checkpoint**: Account info displays correctly. Device list shows all linked devices. Remove device works. Sign-out clears local data and returns to unsynced state.

---

## Phase 5: User Story 3 — View Recovery Key (P1)

**Goal**: User can securely view recovery key after re-authentication

**Independent Test**: Open account settings → click "View Recovery Key" → complete re-auth → see key → copy to clipboard → close dialog → key no longer visible.

**Depends on**: US2 (account section must exist)

- [ ] T034 [US3] Add get-recovery-key IPC handler that requires reAuthToken, derives key from stored master key in `apps/desktop/src/main/ipc/account-handlers.ts`
- [ ] T035 [US3] Build RecoveryKeyDialog component: re-auth prompt → key display (monospace, blurred until hover) → copy button → auto-clear on close in `apps/desktop/src/renderer/src/components/settings/recovery-key-dialog.tsx`
- [ ] T036 [US3] Add "View Recovery Key" button to AccountSection that opens RecoveryKeyDialog in `apps/desktop/src/renderer/src/pages/settings/account-section.tsx`

**Checkpoint**: Recovery key viewable only after re-auth. Copy works. Key not visible after dialog closes.

---

## Phase 6: User Story 4 — Change Vault Location (P1)

**Goal**: User can relocate vault to a different folder with atomic data migration

**Independent Test**: Open data settings → click "Change Vault Location" → select new folder → see progress → verify all data accessible at new location.

- [ ] T037 [US4] Create VaultMover service: copy files → verify integrity → update store → reopen databases → rollback on failure, with progress callback in `apps/desktop/src/main/services/vault-mover.ts`
- [ ] T038 [US4] Create data-handlers.ts with IPC handlers: vault:get-location (reads store.currentVault), vault:change-location (invokes VaultMover, emits progress events) in `apps/desktop/src/main/ipc/data-handlers.ts`
- [ ] T039 [US4] Register data handlers in main process IPC registration in `apps/desktop/src/main/ipc/index.ts`
- [ ] T040 [P] [US4] Build VaultMoveDialog component: folder picker → conflict warning (existing data) → progress bar → success/error result in `apps/desktop/src/renderer/src/components/settings/vault-move-dialog.tsx`
- [ ] T041 [US4] Build DataSection component: display current vault path + "Change" button that opens VaultMoveDialog, cache clear button, rebuild index button in `apps/desktop/src/renderer/src/pages/settings/data-section.tsx`

**Checkpoint**: Vault move works atomically. Data accessible at new location. Old location cleaned up. Rollback works on failure.

---

## Phase 7: User Story 5 — Configure Keyboard Shortcuts (P1)

**Goal**: User can view, rebind, and reset keyboard shortcuts with conflict detection

**Independent Test**: Open shortcuts settings → see all shortcuts → rebind one → verify conflict warning → verify new binding works in-app → reset to defaults.

- [ ] T042 [US5] Create ShortcutRegistry: define all default shortcuts (navigation, editor, tabs, view) as map of id → ShortcutDefinition, with conflict detection utility in `apps/desktop/src/renderer/src/lib/shortcut-registry.ts`
- [ ] T043 [US5] Refactor use-keyboard-shortcuts-base.ts to consume ShortcutRegistry + DB overrides from useKeyboardSettings() instead of inline definitions in `apps/desktop/src/renderer/src/hooks/use-keyboard-shortcuts-base.ts`
- [ ] T044 [P] [US5] Build ShortcutCapture component: focused input that captures next keypress + modifiers, displays as kbd element in `apps/desktop/src/renderer/src/components/settings/shortcut-capture.tsx`
- [ ] T045 [US5] Build ShortcutsSection component: search/filter input, grouped shortcut list, each row with description + current kbd + click-to-rebind (ShortcutCapture), inline conflict warning, "Reset to Defaults" button in `apps/desktop/src/renderer/src/pages/settings/shortcuts-section.tsx`

**Checkpoint**: All shortcuts displayed with current bindings. Rebinding works with conflict detection. Reset restores defaults. Rebound shortcuts work in-app.

---

## Phase 8: User Story 6 — Adjust Text Size and Font (P2)

**Goal**: User can change font size, font family, and enable reduced motion

**Independent Test**: Open general settings → change font size → verify all text resizes → change font family → verify update → enable reduced motion → verify animations minimized.

**Depends on**: US1 (general section must exist)

- [x] T046 [US6] Add font size segmented control (small/medium/large), font family dropdown (system/serif/sans-serif/monospace), reduced motion toggle to GeneralSection in `apps/desktop/src/renderer/src/pages/settings/general-section.tsx`
- [x] T047 [US6] Apply font size and font family via CSS custom properties (--font-size-base, --font-family) on document root, respect reduced motion via prefers-reduced-motion override in `apps/desktop/src/renderer/src/hooks/use-theme-sync.ts`
- [x] T048 [US6] Add start-on-boot toggle to GeneralSection, wire to Electron app.setLoginItemSettings() via IPC in `apps/desktop/src/renderer/src/pages/settings/general-section.tsx`

**Checkpoint**: Font size changes globally. Font family applies everywhere. Reduced motion disables animations. Settings persist on restart.

---

## Phase 9: User Story 7 — Configure Global Capture Shortcut (P2)

**Goal**: User can set a global keyboard shortcut that opens quick capture from any app

**Independent Test**: Open keyboard settings → set global capture shortcut → press it from another app → capture window appears → change shortcut → verify new one works.

**Depends on**: US5 (shortcuts section + registry must exist)

- [ ] T049 [US7] Add global capture shortcut row to ShortcutsSection with OS permission status indicator and guidance link in `apps/desktop/src/renderer/src/pages/settings/shortcuts-section.tsx`
- [ ] T050 [US7] Create IPC handler for registering/unregistering global shortcut: reads keyboard.globalCapture from settings, calls Electron globalShortcut.register(), checks accessibility permissions on macOS in `apps/desktop/src/main/ipc/settings-handlers.ts`
- [ ] T051 [US7] Wire global shortcut registration to app startup (read setting → register if set) and settings:changed event (re-register on change) in `apps/desktop/src/main/index.ts`

**Checkpoint**: Global shortcut registered and working from any app. Permission guidance shown if needed. Shortcut persists across restarts.

---

## Phase 10: User Story 8 — Enable/Disable Sync Features (P2)

**Goal**: User can toggle sync on/off and see current sync status

**Independent Test**: Open sync settings → see current sync status → toggle off → verify sync stops → toggle on → verify sync resumes.

- [ ] T052 [US8] Build SyncSection component: sync toggle, auto-sync toggle, sync status indicator (last sync time + connection state), manual sync button in `apps/desktop/src/renderer/src/pages/settings/sync-section.tsx`
- [ ] T053 [US8] Wire sync toggle to SyncProvider: when disabled, pause sync engine; when enabled, resume. Update sync status display via useSyncSettings() + existing SyncContext in `apps/desktop/src/renderer/src/pages/settings/sync-section.tsx`
- [ ] T054 [US8] Add manual sync trigger IPC handler that calls engine.pushNow() / engine.pullNow() in `apps/desktop/src/main/ipc/settings-handlers.ts`

**Checkpoint**: Sync toggles correctly. Status shows last sync time. Manual sync triggers immediately. Sync resumes correctly after re-enable.

---

## Phase 11: User Story 9 — Manage Tags (P2)

**Goal**: User can view, rename, merge, and delete tags across all items

**Independent Test**: Open tag manager → see all tags with counts → rename a tag → verify items updated → merge two tags → verify combined → delete a tag → verify removed.

- [ ] T055 [US9] Create tag aggregation query: count tags across notes + tasks tables (JSON array extraction + grouping) in `apps/desktop/src/main/database/queries/tags.ts`
- [ ] T056 [US9] Create tag-handlers.ts with IPC handlers: get-all (aggregation query), rename (batch update in transaction), merge (rename source→target in transaction), delete (remove from all items in transaction) in `apps/desktop/src/main/ipc/tag-handlers.ts`
- [ ] T057 [US9] Register tag handlers in main process IPC registration in `apps/desktop/src/main/ipc/index.ts`
- [ ] T058 [P] [US9] Create useTags() hook (invoke tags:get-all, mutation hooks for rename/merge/delete, invalidate queries on success) in `apps/desktop/src/renderer/src/hooks/use-tags.ts`
- [ ] T059 [US9] Build TagManager component: tag list with usage counts, inline rename input, merge dropdown (select target), delete with confirmation in `apps/desktop/src/renderer/src/components/settings/tag-manager.tsx`
- [ ] T060 [US9] Build AdvancedSection component shell with tag management (inline TagManager) and developer tools toggle in `apps/desktop/src/renderer/src/pages/settings/advanced-section.tsx`

**Checkpoint**: Tags listed with accurate counts. Rename updates all items atomically. Merge combines correctly. Delete removes from all items.

---

## Phase 12: User Story 10 — Set Default Project for New Tasks (P2)

**Goal**: User can set a default project that auto-assigns to new tasks

**Independent Test**: Open task settings → select default project → create new task without specifying project → verify it's assigned to default → manually select different project → verify override works.

- [x] T061 [US10] Build TasksSection component: default project dropdown (populated from project list query), sort order dropdown, week start segmented control, stale inbox threshold number input in `apps/desktop/src/renderer/src/pages/settings/tasks-section.tsx`
- [x] T062 [US10] Wire default project to task creation: read TaskSettings.defaultProjectId in task creation flow, pre-fill project field if set, allow manual override in `apps/desktop/src/renderer/src/hooks/use-task-settings.ts` and task creation component

**Checkpoint**: Default project persists. New tasks auto-assigned. Manual override works. Sort order and week start applied correctly.

---

## Phase 13: User Story 11 — Export All Data (P3)

**Goal**: User can export all data to a human-readable format (ZIP with Markdown + JSON)

**Independent Test**: Open data settings → click export → choose format + destination → see progress → open export file → verify notes (MD), tasks (JSON), settings (JSON) present.

- [ ] T063 [US11] Create DataExporter service: query all notes/tasks/journals/settings → write notes/*.md + tasks.json + journals/*.md + settings.json → ZIP → emit progress events in `apps/desktop/src/main/services/data-exporter.ts`
- [ ] T064 [US11] Add export IPC handler (data:export) that invokes DataExporter with format + destPath, streams progress via data:export-progress event in `apps/desktop/src/main/ipc/data-handlers.ts`
- [ ] T065 [US11] Add export UI to DataSection: format selector (JSON/Markdown) + "Export All Data" button + save dialog + progress indicator in `apps/desktop/src/renderer/src/pages/settings/data-section.tsx`

**Checkpoint**: Export creates valid ZIP. Notes are readable Markdown. Tasks are valid JSON. Settings included. Progress shown during export.

---

## Phase 14: User Story 12 — Import Data from Other Apps (P3)

**Goal**: User can import notes/tasks from Notion, Obsidian, or JSON format

**Independent Test**: Select a Notion/Obsidian export or JSON file → import → see progress → verify items appear in inbox/notes → test duplicate detection.

- [ ] T066 [US12] Create DataImporter service with format parsers: NotionParser (HTML/MD → notes), ObsidianParser (MD vault → notes with frontmatter), JsonParser (raw JSON → entities), each returns normalized items in `apps/desktop/src/main/services/data-importer.ts`
- [ ] T067 [US12] Add import IPC handler (data:import) that invokes DataImporter with sourcePath + format, inserts via existing DB queries, emits progress in `apps/desktop/src/main/ipc/data-handlers.ts`
- [ ] T068 [US12] Add import UI to DataSection: format selector + file picker + progress indicator + results summary (imported/skipped counts) in `apps/desktop/src/renderer/src/pages/settings/data-section.tsx`

**Checkpoint**: Import works for all 3 formats. Items appear correctly. Duplicate detection reports skipped items. Progress shown.

---

## Phase 15: User Story 13 — Configure AI Features (P3)

**Goal**: User can enable/disable AI, set API key (stored in OS keychain), and test connection

**Independent Test**: Open AI settings → toggle AI on → enter API key → see masked display → click test → see valid/invalid result.

- [ ] T069 [US13] Add AI IPC handlers: ai:set-api-key (encrypt via safeStorage + store in keychain, never in DB), ai:test-connection (make test API call to provider) in `apps/desktop/src/main/ipc/settings-handlers.ts`
- [ ] T070 [US13] Build AISection component: enable AI toggle, provider dropdown (local/OpenAI/Anthropic), masked API key input + set button, test connection button + status indicator in `apps/desktop/src/renderer/src/pages/settings/ai-section.tsx`

**Checkpoint**: AI toggle works globally. API key masked in UI, stored securely. Test connection validates key. Provider selection persists.

---

## Phase 16: User Story 14 — Set Up Integrations (P3)

**Goal**: User can view and connect/disconnect external service integrations

**Independent Test**: Open integrations list → see available services → connect one → verify active → disconnect → verify removed.

- [x] T071 [US14] Define integration registry: list of supported integrations (calendar, etc.) with connection status, auth flow type, and icon in `apps/desktop/src/renderer/src/lib/integration-registry.ts`
- [x] T072 [US14] Build IntegrationsSubsection within AdvancedSection: integration list with connect/disconnect buttons, OAuth flow for each service in `apps/desktop/src/renderer/src/pages/settings/advanced-section.tsx`

**Checkpoint**: Integration list displays. Connect/disconnect works. Auth flow completes. Status persists.

---

## Phase 17: User Story 15 — Configure Backup Settings (P3)

**Goal**: User can enable automatic backups with configurable frequency and view backup history

**Independent Test**: Open advanced settings → enable auto-backup → set frequency → verify backup file created → view backup history.

- [ ] T073 [US15] Create BackupScheduler service: setInterval-based scheduler that reads BackupSettings, creates ZIP backup of vault, rotates old backups per maxBackups setting in `apps/desktop/src/main/services/backup-scheduler.ts`
- [ ] T074 [US15] Add backup IPC handlers: get backup history (list files in backup dir), trigger manual backup in `apps/desktop/src/main/ipc/data-handlers.ts`
- [ ] T075 [US15] Add backup settings UI to AdvancedSection: auto-backup toggle, frequency dropdown (1h/6h/12h/24h), max backups input, backup history list with dates in `apps/desktop/src/renderer/src/pages/settings/advanced-section.tsx`
- [ ] T076 [US15] Wire BackupScheduler to app startup: read backup settings → start scheduler if enabled → restart on settings change in `apps/desktop/src/main/index.ts`

**Checkpoint**: Auto-backup creates files at configured interval. History displays correctly. Rotation removes oldest. Manual trigger works.

---

## Phase 18: Editor & Remaining Settings (P2 cleanup)

**Goal**: Complete editor preferences UI

- [ ] T077 Build EditorSection component: editor width segmented control (narrow/medium/wide), toolbar mode (floating/sticky), spell check toggle, auto-save delay slider (0-30s), word count toggle in `apps/desktop/src/renderer/src/pages/settings/editor-section.tsx`
- [ ] T078 Wire editor settings to note editor: read EditorSettings in editor component, apply width/spellCheck/autoSaveDelay/showWordCount/toolbarMode reactively in `apps/desktop/src/renderer/src/components/note-editor/` (relevant files)

**Checkpoint**: All editor preferences apply immediately. Settings persist across sessions.

---

## Phase 19: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that span multiple user stories

- [ ] T079 [P] Add settings:reset-all IPC handler with confirmation that deletes all settings keys + restores defaults in `apps/desktop/src/main/ipc/settings-handlers.ts`
- [ ] T080 [P] Add "Reset All Settings" danger button with confirmation dialog to AdvancedSection in `apps/desktop/src/renderer/src/pages/settings/advanced-section.tsx`
- [ ] T081 Verify 3-click accessibility (SC-001): audit every setting is reachable within 3 clicks from settings panel root
- [ ] T082 [P] Verify settings persistence across restart (SC-003): set various settings → quit → relaunch → verify all preserved
- [ ] T083 [P] Performance check: theme switch <100ms (SC-002), settings page render <200ms
- [ ] T084 Validate settings sync round-trip (SC-009): change setting on device A → verify appears on device B within 30s
- [ ] T085 Run quickstart.md validation: follow quickstart steps to verify all implementation paths work end-to-end

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **User Stories (Phases 3–17)**: All depend on Phase 2 completion
- **Editor Settings (Phase 18)**: Depends on Phase 2
- **Polish (Phase 19)**: Depends on all desired stories being complete

### User Story Dependencies

| Story | Depends On | Reason |
|-------|-----------|--------|
| US1 (Theme) | Phase 2 only | First to use GeneralSection |
| US2 (Account) | Phase 2 only | Creates AccountSection |
| US3 (Recovery Key) | US2 | Adds to AccountSection |
| US4 (Vault Move) | Phase 2 only | Creates DataSection |
| US5 (Shortcuts) | Phase 2 only | Creates ShortcutsSection + registry |
| US6 (Fonts) | US1 | Extends GeneralSection |
| US7 (Global Capture) | US5 | Extends ShortcutsSection |
| US8 (Sync Toggle) | Phase 2 only | Creates SyncSection |
| US9 (Tags) | Phase 2 only | Creates AdvancedSection |
| US10 (Default Project) | Phase 2 only | Creates TasksSection |
| US11 (Export) | US4 | Extends DataSection |
| US12 (Import) | US4 | Extends DataSection |
| US13 (AI) | Phase 2 only | Creates AISection |
| US14 (Integrations) | US9 | Extends AdvancedSection |
| US15 (Backup) | US9 | Extends AdvancedSection |

### Within Each User Story

- Contracts (Phase 1) before IPC handlers
- IPC handlers before hooks
- Hooks before UI components
- Core implementation before integration

### Parallel Opportunities

- **Phase 1**: T001–T002 parallel (different schema groups), T004–T007 parallel (different channel domains)
- **Phase 2**: T009–T014 parallel (different handler groups), T016–T021 parallel (different hooks)
- **After Phase 2**: US1, US2, US4, US5, US8, US9, US10, US13 can ALL start in parallel (no cross-dependencies)
- **Within stories**: IPC handler + hook can parallelize with UI component (different files)

---

## Parallel Example: Phase 2 Foundation

```text
# Batch 1 — All IPC handlers (different settings groups, same file but different functions):
T009: GeneralSettings handler
T010: EditorSettings handler  [P]
T011: TaskSettings handler    [P]
T012: KeyboardShortcuts handler [P]
T013: SyncSettings handler    [P]
T014: BackupSettings handler  [P]

# Batch 2 — All renderer hooks (each is a separate file):
T016: useGeneralSettings()
T017: useEditorSettings()     [P]
T018: useTaskSettings()       [P]
T019: useKeyboardSettings()   [P]
T020: useSyncSettings()       [P]
T021: useBackupSettings()     [P]

# Batch 3 — Page shell + sync + preload (independent):
T022: Settings page refactor
T023: Sync schema extension   [P]
T024: Preload bridge update   [P]
```

## Parallel Example: P1 Stories After Foundation

```text
# All independent P1 stories can start simultaneously:
US1 (Theme):     T025 → T026 → T027 → T028
US2 (Account):   T029 → T030, T031 [P] + T032 [P] → T033
US4 (Vault):     T037 → T038 → T039, T040 [P] → T041
US5 (Shortcuts): T042 → T043, T044 [P] → T045
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T008)
2. Complete Phase 2: Foundational (T009–T024)
3. Complete Phase 3: US1 — Theme (T025–T028)
4. **STOP and VALIDATE**: Theme switching works, persists, follows OS
5. Ship MVP

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US1 (Theme) → MVP shipped
3. US2 + US3 (Account + Recovery) → Account management live
4. US4 (Vault) + US5 (Shortcuts) → Power user features live
5. US6–US10 (P2 stories) → Extended preferences
6. US11–US15 (P3 stories) → Data portability + AI + integrations
7. Polish → Production ready

### Single Developer Strategy

Complete stories in priority order: US1 → US2 → US3 → US4 → US5 → US6 → ... → US15 → Polish

---

## Notes

- [P] tasks = different files, no dependencies between them
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable after Phase 2
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Settings page file (`settings.tsx`) is currently 62KB — T022 is the critical decomposition task
- All new settings follow existing pattern: DB key → JSON value → Drizzle upsert → IPC broadcast
- API keys go to safeStorage (OS keychain), never the settings table
