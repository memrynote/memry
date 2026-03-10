# Tasks: Inbox Redesign

**Input**: Design doc (`compass_artifact_wf-40b0d96f-98fc-4677-b969-92f5e4785ff8_text_markdown.md`), audit of current inbox implementation
**Prerequisites**: Current inbox feature fully built (9 capture types, filing, snooze, bulk ops, AI suggestions, sync)

**Design Philosophy**: Capture and processing are fundamentally different activities requiring fundamentally different interfaces. Capture = zero decisions, under 2 seconds. Processing = guided decision tree, keyboard-first, one item at a time.

**Tests**: TDD workflow — write test → fail → implement → pass. Test tasks embedded alongside implementation.

**Organization**: Tasks grouped by user story. Each story is independently implementable and testable after Phase 2 (Architecture Refactor) completes.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story (e.g., US1, US2...) — omitted for Setup/Foundational/Polish phases

---

## User Stories

| # | Story | Priority | Summary |
|---|-------|----------|---------|
| US1 | Triage Mode | P1 | Process inbox items one at a time with 5 clear actions |
| US2 | Fix Link Filing | P1 | File/link/convert link items (currently broken, returns error) |
| US3 | Universal Quick Capture | P1 | Accept any input (text, URL, image paste, file drop, voice) with zero decisions |
| US4 | Note-Level AI Suggestions | P2 | Suggest specific notes to link, not just folders |
| US5 | Progressive Processing | P2 | Note maturity stages (seed → seedling → sapling → evergreen), partial triage |
| US6 | Inbox Health Dashboard | P2 | Replace insights tab with health metrics, collector's fallacy guard, inbox bankruptcy |
| US7 | Duplicate Detection | P2 | Prevent duplicate captures (URL match, content similarity) |
| US8 | Delightful Processing | P3 | Streaks, progress animations, undo on file actions, celebration at inbox zero |

---

## Phase 1: Critical Fixes (unblock broken things)

**Purpose**: Fix what's broken before redesigning. These are small, high-ROI fixes.

- [x] T001 [US2] Implement link filing in `fileToFolder()`: create markdown note with rich link template (title, description, author, hero image embed, source URL) in `apps/desktop/src/main/inbox/filing.ts`
- [x] T002 [US2] Implement link filing in `linkToNotes()`: same link template, add wikilink to target notes in `apps/desktop/src/main/inbox/filing.ts`
- [x] T003 [P] Persist stale threshold to settings DB: replace module-level `let staleThresholdDays` with `getSetting()`/`setSetting()` calls in `apps/desktop/src/main/inbox/stats.ts`
- [x] T004 [P] Wire `itemsProcessedToday` to `getTodayActivity()` backend instead of local `useState(0)` in `apps/desktop/src/renderer/src/pages/inbox.tsx`
- [x] T005 [P] Wire `hasFilingHistory` to actual `filing_history` table count instead of hardcoded `false` in `apps/desktop/src/renderer/src/pages/inbox.tsx`
- [x] T006 Regenerate IPC type map via `pnpm ipc:generate` and verify build with `pnpm typecheck`

**Checkpoint**: Link captures can be filed. Stale threshold survives restart. Empty state shows real data.

---

## Phase 2: Architecture Refactor (split monolith, enable triage)

**Purpose**: Break `inbox.tsx` (1,654 LOC) into focused modules. MUST complete before triage mode or any new UI work.

**⚠️ CRITICAL**: No US1/US3/US5+ UI work can begin until this phase completes.

- [x] T007 Extract `InboxListView` component from inbox.tsx: list rendering, type filter, stale/non-stale separation, selection state, drag-drop image capture in `apps/desktop/src/renderer/src/pages/inbox/inbox-list-view.tsx`
- [x] T008 [P] Extract `InboxHealthView` component shell (replaces current insights tab) in `apps/desktop/src/renderer/src/pages/inbox/inbox-health-view.tsx`
- [x] T009 [P] Extract `InboxArchivedView` import and wiring into clean sub-view in `apps/desktop/src/renderer/src/pages/inbox/inbox-archived-view.tsx`
- [x] T010 Extract keyboard shortcut logic from inbox.tsx into `useInboxKeyboard()` hook in `apps/desktop/src/renderer/src/hooks/use-inbox-keyboard.ts`
- [x] T011 Extract toast + snooze event subscription logic into `useInboxNotifications()` hook in `apps/desktop/src/renderer/src/hooks/use-inbox-notifications.ts`
- [x] T012 Refactor `inbox.tsx` into thin shell: view switcher (list/triage/health/archived) + shared state + dynamic view rendering, target <200 LOC in `apps/desktop/src/renderer/src/pages/inbox.tsx`
- [x] T013 [P] Define `TriageAction` type union and `TriageState` interface in `packages/contracts/src/inbox-api.ts`:
  - Actions: `discard` | `convert-to-task` | `expand-to-note` | `file` | `defer`
  - State: `currentIndex`, `totalItems`, `currentItem`, `completedCount`
- [x] T014 [P] Add InboxChannels.CONVERT_TO_TASK to `packages/contracts/src/ipc-channels.ts` (new channel for task creation from inbox)
- [x] T015 Regenerate IPC type map and verify build

**Checkpoint**: inbox.tsx < 200 LOC. List/health/archived views render independently. Triage contracts defined. Build passes.

---

## Phase 3: User Story 1 — Triage Mode (P1) 🎯 Centerpiece

**Goal**: User can process inbox items one at a time with 5 keyboard-driven actions in a focused, full-screen queue view.

**Independent Test**: Open inbox → click "Process" → see first item full-screen → press `D` to discard → next item appears → press `F` to file (folder picker appears inline) → progress bar advances → reach zero → celebration.

**Why this matters**: The design doc says "present items one at a time as the default mode." This is the #1 UX gap. The current list+panel approach doesn't create the habit of processing.

**Depends on**: Phase 2 (architecture refactor, contracts)

- [ ] T016 [US1] Create `useTriageQueue()` hook: manages sequential item processing — loads unfiled/unsnoozed items, tracks currentIndex, advances on action, exposes progress (n of total), handles edge cases (empty queue, last item) in `apps/desktop/src/renderer/src/hooks/use-triage-queue.ts`
- [ ] T017 [US1] Build `TriageView` shell component: full-width single-item display, progress bar at top, action bar at bottom, keyboard hint strip in `apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx`
- [ ] T018 [US1] Build `TriageItemCard` component: type-specific content preview (reuse content-section.tsx patterns), metadata bar (capture date, source, type badge), centered layout with max-width for readability in `apps/desktop/src/renderer/src/components/inbox/triage-item-card.tsx`
- [ ] T019 [US1] Build `TriageActionBar` component with exactly 5 actions + keyboard shortcuts:
  - `D` — **Discard** (archive item, slide-out animation, advance)
  - `T` — **Convert to Task** (creates task with title + link back, advance)
  - `N` — **Expand to Note** (opens inline folder picker, creates note, advance)
  - `F` — **File / Link** (shows AI folder suggestions + note suggestions inline, file on selection, advance)
  - `S` — **Defer** (shows preset snooze durations: later today / tomorrow / next week / custom, advance)
  in `apps/desktop/src/renderer/src/components/inbox/triage-action-bar.tsx`
- [ ] T020 [US1] Build inline `TriageFilePicker` sub-component for F action: AI-suggested folders as numbered chips (1-3) + "Other" dropdown with search, AI-suggested notes below with one-click link in `apps/desktop/src/renderer/src/components/inbox/triage-file-picker.tsx`
- [ ] T021 [US1] Build inline `TriageSnoozePicker` sub-component for S action: preset buttons (Later Today / Tomorrow / Next Week / Next Month) + custom date picker in `apps/desktop/src/renderer/src/components/inbox/triage-snooze-picker.tsx`
- [ ] T022 [US1] Add convert-to-task IPC handler: creates task from inbox item (title, content as description, link back to source item), marks inbox item as filed in `apps/desktop/src/main/ipc/inbox-handlers.ts`
- [ ] T023 [US1] Build `TriageProgress` component: progress bar + "5 of 17" counter + estimated time remaining + percentage in `apps/desktop/src/renderer/src/components/inbox/triage-progress.tsx`
- [ ] T024 [US1] Build `TriageComplete` component: inbox zero celebration with today's stats (items processed, time spent, streak count) in `apps/desktop/src/renderer/src/components/inbox/triage-complete.tsx`
- [ ] T025 [US1] Wire triage view into inbox page shell: add "Process Inbox" button to list view header, `Cmd+P` shortcut to enter triage mode, `Escape` to exit back to list in `apps/desktop/src/renderer/src/pages/inbox.tsx`
- [ ] T026 [US1] Add smooth transitions: item slide-out on action (left for discard, right for file/note), next item slide-in, progress bar animation in `apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx`

**Checkpoint**: Triage mode processes items sequentially. All 5 actions work via keyboard. Progress tracks correctly. Celebration shows at zero. Escape returns to list.

---

## Phase 4: User Story 2 — Fix Link Filing (P1)

**Goal**: Link captures can be filed to folders, converted to notes, and linked to existing notes (currently returns error).

**Independent Test**: Capture a URL → open in triage/detail → file to folder → verify markdown note created with link metadata → link to existing note → verify wikilink added.

**Why this matters**: Links are the #1 capture type. `filing.ts:479` returns `'Link filing not implemented yet'`. This blocks the entire triage workflow for links.

- [ ] T027 [US2] Create `generateLinkNoteContent()` helper: rich markdown template with title as H1, description blockquote, hero image embed (if available), author/site/date metadata, source URL link, filed-from-inbox footer in `apps/desktop/src/main/inbox/filing.ts`
- [ ] T028 [US2] Remove the early-return error for link type in `fileToFolder()` and wire to `generateLinkNoteContent()` + `createNote()` at line 479 in `apps/desktop/src/main/inbox/filing.ts`
- [ ] T029 [US2] Remove the early-return error for link type in `linkToNotes()` and wire to create note + add wikilinks at line 767 in `apps/desktop/src/main/inbox/filing.ts`
- [ ] T030 [US2] Add tests: file link to folder (with/without metadata), link to note, link to multiple notes, handle missing metadata gracefully in `apps/desktop/src/main/inbox/filing.test.ts`

**Checkpoint**: All link filing paths work. Rich markdown generated. No more "not implemented" errors.

---

## Phase 5: User Story 3 — Universal Quick Capture (P1)

**Goal**: Quick Capture window (Cmd+Shift+Space) accepts any input — text, URL, clipboard image, file drop, voice — with zero decisions.

**Independent Test**: Press global shortcut → paste image from clipboard → captured → press shortcut again → type text → captured → press shortcut → drop PDF → captured. All under 3 seconds each.

**Why this matters**: The design doc: "At the moment of capture, require exactly zero decisions." Current Quick Capture only handles text/URL.

**Depends on**: Phase 2 (for contracts only)

- [ ] T031 [US3] Add clipboard image detection to QuickCapture: on mount, check `navigator.clipboard.read()` for image data, show image preview thumbnail if found in `apps/desktop/src/renderer/src/components/quick-capture.tsx`
- [ ] T032 [US3] Add paste handler for images: `Cmd+V` with image in clipboard → call `captureImage()` with blob → show success in `apps/desktop/src/renderer/src/components/quick-capture.tsx`
- [ ] T033 [P] [US3] Add drag-and-drop zone to QuickCapture: accept image/PDF/audio files, detect type from MIME, route to appropriate capture function in `apps/desktop/src/renderer/src/components/quick-capture.tsx`
- [ ] T034 [P] [US3] Add voice recording button to QuickCapture: hold spacebar or click mic → record → release to capture, reuse existing voice capture infrastructure in `apps/desktop/src/renderer/src/components/quick-capture.tsx`
- [ ] T035 [US3] Remove any title/tag/decision fields if present — keep input as single textarea + auto-detected type indicator only in `apps/desktop/src/renderer/src/components/quick-capture.tsx`
- [ ] T036 [US3] Add visual feedback for capture type detection: icon morphs smoothly between FileText (note), Link (URL), Image (image), Mic (voice), FileIcon (PDF) based on input content in `apps/desktop/src/renderer/src/components/quick-capture.tsx`

**Checkpoint**: Quick Capture accepts text, URL, pasted images, dropped files, and voice. Zero decisions required. Each capture under 3 seconds.

---

## Phase 6: User Story 4 — Note-Level AI Suggestions (P2)

**Goal**: During triage/filing, AI suggests specific notes to link (not just folders), with preview snippets.

**Independent Test**: Capture a note about "React hooks" → open in triage → press F → see "Link to 'React Patterns' note" suggestion with snippet → click to link → wikilink created.

**Why this matters**: Current `suggestions.ts` finds similar notes via embeddings but discards the note info, only keeping folder paths. The most valuable suggestion is "link this to your existing note about X."

- [ ] T037 [US4] Extend `FilingSuggestion` type: add `suggestedNote?: { id: string, title: string, snippet: string }` for note-level suggestions in `packages/contracts/src/inbox-api.ts`
- [ ] T038 [US4] Modify `getSuggestions()` to return note-level suggestions alongside folder suggestions: for each similar note found, include it as a direct "link to this note" suggestion (not just its folder) in `apps/desktop/src/main/inbox/suggestions.ts`
- [ ] T039 [US4] Add snippet extraction: when suggesting a note, include first 150 chars of content as preview in `apps/desktop/src/main/inbox/suggestions.ts`
- [ ] T040 [US4] Update `TriageFilePicker` to display note suggestions: show note title + snippet below folder chips, one-click to link via `linkToNote()` in `apps/desktop/src/renderer/src/components/inbox/triage-file-picker.tsx`
- [ ] T041 [P] [US4] Update existing `filing-section.tsx` detail panel to also show note suggestions (for list view users who skip triage) in `apps/desktop/src/renderer/src/components/inbox-detail/filing-section.tsx`

**Checkpoint**: AI suggests both folders AND specific notes. Note suggestions include title + snippet. One-click linking works.

---

## Phase 7: User Story 5 — Progressive Processing (P2)

**Goal**: Items have maturity stages. Users can partially process (add thoughts, tag) without fully filing. Maturity is visible.

**Independent Test**: Capture a note → it shows 🌱 seed badge → add a tag in triage (skip filing) → badge becomes 🌿 seedling → file to folder → badge becomes 🌳 sapling → expand into connected note with links → 🌲 evergreen.

**Why this matters**: The design doc: "Support partial processing. A user can bold key passages during one session and come back later." Current system is binary (inbox vs. filed).

- [ ] T042 [US5] Add `maturity` column to `inbox_items` table: `text` field with default `'seed'`, values: `seed | seedling | sapling | evergreen` in `packages/db-schema/src/schema/inbox.ts`
- [ ] T043 [US5] Create migration `00XX_inbox_maturity.sql`: add `maturity` column with default `'seed'` to `inbox_items` in `apps/desktop/src/main/database/migrations/`
- [ ] T044 [US5] Add maturity auto-advancement logic: seed → seedling (when tags added OR content edited), seedling → sapling (when filed to folder or linked), sapling → evergreen (when converted to note with 2+ links) in `apps/desktop/src/main/inbox/maturity.ts` (new module)
- [ ] T045 [US5] Wire maturity updates into existing filing/tagging/linking handlers: call `advanceMaturity()` after each action in `apps/desktop/src/main/ipc/inbox-crud-handlers.ts` and `apps/desktop/src/main/inbox/filing.ts`
- [ ] T046 [P] [US5] Add maturity badge component: renders 🌱/🌿/🌳/🌲 with tooltip explaining stage in `apps/desktop/src/renderer/src/components/inbox/maturity-badge.tsx`
- [ ] T047 [US5] Add "Skip" action to triage: moves to next item without any action (item stays in inbox, maturity unchanged), keyboard shortcut `→` or `Space` in `apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx`
- [ ] T048 [US5] Add maturity badge to list view item rows and triage item card in `apps/desktop/src/renderer/src/components/inbox/inbox-list.tsx` and `triage-item-card.tsx`
- [ ] T049 [US5] Update `InboxItemListItem` contract type to include `maturity` field in `packages/contracts/src/inbox-api.ts`
- [ ] T050 [US5] Add maturity to sync payload schema in `apps/desktop/src/main/sync/item-handlers/inbox-handler.ts`

**Checkpoint**: Maturity advances automatically. Badges visible in list + triage. Skip works in triage. Sync includes maturity.

---

## Phase 8: User Story 6 — Inbox Health Dashboard (P2)

**Goal**: Replace current insights tab with actionable health metrics. Surface collector's fallacy. Offer inbox bankruptcy.

**Independent Test**: Open inbox → switch to Health tab → see capture/process ratio → see age distribution → capture 20 items without processing → see "collector's fallacy" warning → click "Declare Bankruptcy" → all items older than 2 weeks archived.

**Why this matters**: The design doc identifies 5 failure modes. Current insights show interesting-but-not-actionable charts (heatmap, type distribution). Health dashboard should drive behavior.

- [x] T051 [US6] Create `getInboxHealthMetrics()` backend query: returns `{ totalPending, capturedThisWeek, processedThisWeek, captureProcessRatio, ageDistribution: { fresh: n, aging: n, stale: n }, oldestItemDays, currentStreak }` in `apps/desktop/src/main/inbox/stats.ts`
- [x] T052 [US6] Add INBOX.GET_HEALTH IPC channel and handler in `packages/contracts/src/ipc-channels.ts` and `apps/desktop/src/main/ipc/inbox-query-handlers.ts`
- [x] T053 [P] [US6] Create `useInboxHealth()` hook (invoke + TanStack Query cache, 60s stale time) in `apps/desktop/src/renderer/src/hooks/use-inbox.ts`
- [x] T054 [US6] Build `InboxHealthView` component replacing insights:
  - **Capture vs Process ratio**: big number + trend arrow ("You captured 23, processed 4 this week")
  - **Age distribution**: 3-segment bar (fresh <3d / aging 3-7d / stale >7d) with item counts
  - **Collector's Fallacy Warning**: conditional banner when ratio > 3:1 ("You're collecting faster than processing")
  - **Inbox Bankruptcy Button**: "Archive everything older than N days" with configurable N + confirmation dialog
  - **Processing Streak**: consecutive days with ≥1 item processed
  - **Keep**: filing history table from current insights (actionable — shows patterns)
  - **Remove**: heatmap and type distribution charts (interesting but not actionable)
  in `apps/desktop/src/renderer/src/pages/inbox/inbox-health-view.tsx`
- [x] T055 [US6] Add `BULK_ARCHIVE_OLDER_THAN` IPC handler: archives all unfiled items older than N days in `apps/desktop/src/main/ipc/inbox-batch-handlers.ts`
- [x] T056 [US6] Wire bankruptcy button to `BULK_ARCHIVE_OLDER_THAN` with confirmation dialog in health view

**Checkpoint**: Health tab shows ratio, age distribution, streak. Warning appears when ratio > 3:1. Bankruptcy archives old items.

---

## Phase 9: User Story 7 — Duplicate Detection (P2)

**Goal**: Prevent duplicate captures. Show "already captured" feedback when URL or content matches existing item.

**Independent Test**: Capture a URL → capture same URL again → see "Already captured on [date]" with option to view existing or capture anyway → paste same text → see similar warning.

- [x] T057 [US7] Add `findDuplicateByUrl(url: string)` query: check `sourceUrl` against existing unfiled+unarchived items, return match if found in `apps/desktop/src/main/inbox/duplicates.ts`
- [x] T058 [US7] Add `findDuplicateByContent(content: string)` query: check content hash (first 500 chars SHA-256) against existing items, return match if found in `apps/desktop/src/main/inbox/duplicates.ts`
- [x] T059 [US7] Modify capture handlers (CAPTURE_TEXT, CAPTURE_LINK) to check for duplicates before creating: if duplicate found, return `{ success: true, duplicate: true, existingItem: { id, title, createdAt } }` instead of creating new item in `apps/desktop/src/main/ipc/inbox-handlers.ts`
- [x] T060 [US7] Extend `CaptureResponse` type with optional `duplicate` flag and `existingItem` reference in `packages/contracts/src/inbox-api.ts`
- [x] T061 [US7] Handle duplicate response in Quick Capture UI: show "Already captured [date]" with "View" and "Capture Anyway" buttons in `apps/desktop/src/renderer/src/components/quick-capture.tsx`
- [x] T062 [US7] Handle duplicate response in CaptureInput (inline): same treatment in `apps/desktop/src/renderer/src/components/capture-input.tsx`

**Checkpoint**: URL duplicates detected. Content duplicates detected. User can view existing or force-capture. No silent duplicates.

---

## Phase 10: User Story 8 — Delightful Processing (P3)

**Goal**: Processing feels satisfying, not administrative. Streaks, undo, smooth animations.

**Independent Test**: File an item → see undo toast (5s window) → click undo → item returns to inbox. Process 3 items → see streak badge. Reach inbox zero → see animated celebration with confetti or equivalent.

**Depends on**: US1 (triage mode must exist)

- [x] T063 [US8] Add undo support for file/archive actions: implement 5-second undo window via toast with action button. On undo: revert `filedAt`/`archivedAt` to null, re-emit events in `apps/desktop/src/main/ipc/inbox-crud-handlers.ts`
- [x] T064 [US8] Add INBOX.UNDO_FILE and INBOX.UNDO_ARCHIVE IPC channels and handlers in `packages/contracts/src/ipc-channels.ts` and `apps/desktop/src/main/ipc/inbox-crud-handlers.ts`
- [x] T065 [P] [US8] Create `useUndoableAction()` hook: wraps any inbox mutation with 5s undo window, shows toast, reverts on undo click in `apps/desktop/src/renderer/src/hooks/use-undoable-action.ts`
- [x] T066 [US8] Wire undo into triage actions and list view actions in `apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx` and `apps/desktop/src/renderer/src/pages/inbox/inbox-list-view.tsx`
- [x] T067 [P] [US8] Add processing streak tracking: `getProcessingStreak()` query — counts consecutive days with ≥1 processed item in `apps/desktop/src/main/inbox/stats.ts`
- [x] T068 [P] [US8] Build streak badge component for triage progress bar and health dashboard in `apps/desktop/src/renderer/src/components/inbox/streak-badge.tsx`
- [x] T069 [US8] Enhance `TriageComplete` celebration: animated check → stats summary (items processed, time, streak) → motivational micro-copy → "Back to inbox" button in `apps/desktop/src/renderer/src/components/inbox/triage-complete.tsx`
- [x] T070 [US8] Add slide animations to triage transitions: item exits left (discard) or right (file/note/task), next item enters from bottom with spring easing in `apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx`

**Checkpoint**: Undo works within 5s for file/archive. Streak tracks correctly. Celebration is animated and shows stats. Transitions feel fluid.

---

## Phase 11: Polish & Cross-Cutting

**Purpose**: Improvements that span multiple stories

- [x] T071 [P] Decouple reminders from inbox: render reminder items in triage with different actions (Dismiss / Open Target / Snooze Again) instead of File/Link/Convert in `apps/desktop/src/renderer/src/components/inbox/triage-action-bar.tsx`
- [x] T072 [P] Add `captureSource` field to inbox_items schema (`quick-capture` | `inline` | `browser-extension` | `api` | `reminder`), auto-populate on capture in `packages/db-schema/src/schema/inbox.ts`
- [x] T073 [P] Create migration for `captureSource` column in `apps/desktop/src/main/database/drizzle-data/0019_material_lethal_legion.sql`
- [x] T074 Wire capture source into all capture handlers (Quick Capture sets `quick-capture`, CaptureInput sets `inline`, etc.) in `apps/desktop/src/main/ipc/inbox-handlers.ts`
- [x] T075 [P] Add "Process Inbox" entry point to sidebar: when inbox count > 0, show subtle "Process" action next to count badge in `apps/desktop/src/renderer/src/components/app-sidebar.tsx`
- [ ] T076 [P] ~~Add inbox widget to home/dashboard~~ SKIPPED — no home/dashboard page exists; inbox is the primary landing
- [ ] T077 Verify triage keyboard flow end-to-end: process 10 mixed-type items using only keyboard → all actions work → progress tracks → celebration shows
- [ ] T078 [P] Performance check: triage view renders in <100ms, action transitions <300ms, Quick Capture opens in <200ms
- [x] T079 Verify inbox sync round-trip with maturity + captureSource fields: captureSource added to sync payload schema and inbox-handler upsert/insert paths

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Critical Fixes)**: No dependencies — start immediately
- **Phase 2 (Architecture Refactor)**: No dependency on Phase 1 (independent code paths) — can start in parallel
- **Phase 3 (Triage Mode)**: Depends on Phase 2 (contracts + component split)
- **Phase 4 (Link Filing)**: No dependency on Phase 2 — can start in parallel with Phase 2
- **Phase 5 (Quick Capture)**: Depends on Phase 2 (contracts only, loosely)
- **Phase 6 (AI Suggestions)**: Depends on Phase 3 (triage file picker must exist)
- **Phase 7 (Progressive Processing)**: Depends on Phase 2 (contracts) + Phase 3 (triage view for skip action)
- **Phase 8 (Health Dashboard)**: Depends on Phase 2 (health view shell)
- **Phase 9 (Duplicate Detection)**: No dependency on triage — can start anytime
- **Phase 10 (Delightful Processing)**: Depends on Phase 3 (triage mode must exist)
- **Phase 11 (Polish)**: Depends on Phases 3 + 7 complete

### Parallel Opportunities

```text
# Wave 1 — All independent (start immediately):
Phase 1: T001-T006 (critical fixes)
Phase 2: T007-T015 (architecture refactor)
Phase 4: T027-T030 (link filing — independent of refactor)
Phase 9: T057-T062 (duplicate detection — independent)

# Wave 2 — After Phase 2 completes:
Phase 3: T016-T026 (triage mode — centerpiece)
Phase 5: T031-T036 (quick capture)

# Wave 3 — After Phase 3 completes:
Phase 6: T037-T041 (AI note suggestions — needs triage file picker)
Phase 7: T042-T050 (progressive processing — needs triage for skip)
Phase 8: T051-T056 (health dashboard — needs health view shell)
Phase 10: T063-T070 (delightful processing — needs triage)

# Wave 4 — After all stories:
Phase 11: T071-T079 (polish)
```

### Within Each Story

- Contracts/types before IPC handlers
- IPC handlers before hooks
- Hooks before UI components
- Backend logic before frontend wiring

---

## Implementation Strategy

### MVP First (Triage + Link Fix Only)

1. Complete Phase 1: Critical Fixes (T001–T006)
2. Complete Phase 2: Architecture Refactor (T007–T015)
3. Complete Phase 3: Triage Mode (T016–T026)
4. Complete Phase 4: Link Filing (T027–T030)
5. **STOP and VALIDATE**: Can process all item types via triage with keyboard. Links file correctly.
6. Ship MVP

### Incremental Delivery

1. Fixes + Refactor → Broken things fixed, codebase clean
2. Triage + Link Filing → Core UX shift shipped (P1 complete)
3. Quick Capture → Capture quality improved
4. AI Suggestions + Progressive Processing → Smart processing
5. Health + Duplicate Detection → Inbox hygiene
6. Delightful Processing → Polish and feel
7. Cross-cutting → Production ready

### Single Developer Strategy

Complete in priority order: Phase 1 → Phase 2 → Phase 4 (small) → Phase 3 (big) → Phase 5 → Phase 6 → Phase 7 → Phase 8 → Phase 9 → Phase 10 → Phase 11

---

## Notes

- [P] tasks = different files, no dependencies between them
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable after Phase 2
- Commit after each task or logical group (Conventional Commits: feat|fix|refactor)
- Stop at any checkpoint to validate story independently
- Current inbox.tsx is 1,654 LOC — T007-T012 is the critical decomposition
- Link filing fix (Phase 4) is deliberately kept as a separate phase from triage because it's a backend-only change that unblocks the most common capture type immediately
- Triage mode's 5 actions map directly to the design doc's GTD-for-PKM decision tree: Discard / Do Now (Convert to Task) / Expand (to Note) / Link and File / Defer (Snooze)
- "Delightful processing" (Phase 10) is P3 because it's polish on top of triage — triage works without it, but it makes the habit stick
