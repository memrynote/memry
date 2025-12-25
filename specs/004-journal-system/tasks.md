# Tasks: Journal System

**Input**: Design documents from `/specs/004-journal-system/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/journal-api.ts

**Tests**: Not explicitly requested in spec. Tests are omitted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Path Conventions

Electron application structure per plan.md:

- **Main process**: `src/main/`
- **Renderer process**: `src/renderer/src/`
- **Shared**: `src/shared/`
- **Preload**: `src/preload/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Database schema, shared types, and IPC channel registration

- [x] T001 Copy journal-api.ts contracts from specs/004-journal-system/contracts/ to src/shared/contracts/journal-api.ts
- [x] T002 [P] Create journal cache schema in src/shared/db/schema/journal-cache.ts (journalCache, journalTags tables)
- [x] T003 [P] Export journal schema from src/shared/db/schema/index.ts
- [x] T004 [P] Add journal IPC channel names to src/shared/ipc-channels.ts
- [x] T005 Generate database migration for journal tables with `pnpm db:generate:index`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core journal file operations and query functions that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T006 Create journal query functions in src/shared/db/queries/journal.ts (insertJournalEntry, updateJournalEntry, getJournalEntry, deleteJournalEntry, getHeatmapData, getMonthEntries, getYearStats)
- [x] T007 Create journal file operations in src/main/vault/journal.ts (readJournalEntry, writeJournalEntry, deleteJournalEntry with atomic writes)
- [x] T008 Create journal IPC handlers skeleton in src/main/ipc/journal-handlers.ts (registerJournalHandlers function)
- [x] T009 Register journal handlers in src/main/ipc/index.ts (import and call registerJournalHandlers)
- [x] T010 [P] Add journal API methods to preload bridge in src/preload/index.ts (getEntry, createEntry, updateEntry, deleteEntry, getHeatmap, getMonthEntries, getYearStats, getDayContext)
- [x] T011 [P] Add journal type declarations to src/preload/index.d.ts
- [x] T012 Create journal service wrapper in src/renderer/src/services/journal-service.ts (journalService object with all IPC methods)

**Checkpoint**: Foundation ready - journal IPC pipeline complete, user story implementation can begin

---

## Phase 3: User Story 1 - Daily Journal Entry (Priority: P1) MVP

**Goal**: Store and retrieve journal entries as markdown files with one entry per day

**Independent Test**: Open journal, write content for today, close and reopen app, verify content persists

### Implementation for User Story 1

- [x] T013 [US1] Implement getEntry IPC handler in src/main/ipc/journal-handlers.ts (read entry from file, return null if not exists)
- [x] T014 [US1] Implement createEntry IPC handler in src/main/ipc/journal-handlers.ts (create file with frontmatter, insert into cache)
- [x] T015 [US1] Implement updateEntry IPC handler in src/main/ipc/journal-handlers.ts (update file, update cache, compute word/char counts)
- [x] T016 [US1] Implement deleteEntry IPC handler in src/main/ipc/journal-handlers.ts (delete file, remove from cache)
- [x] T017 [US1] Create useJournalEntry hook in src/renderer/src/hooks/use-journal.ts (load entry by date, loading/error states)
- [x] T018 [US1] Wire JournalPage to useJournalEntry hook in src/renderer/src/pages/journal.tsx (replace dummy data, load today's entry on mount)
- [x] T019 [US1] Wire ContentArea onChange to journal service in src/renderer/src/pages/journal.tsx (call updateContent on content change)

**Checkpoint**: User Story 1 complete - users can open journal, write content, persist across restarts

---

## Phase 4: User Story 2 - Calendar Navigation with Heatmap (Priority: P1) MVP

**Goal**: Navigate between days using calendar widget with visual heatmap showing activity levels

**Independent Test**: Create entries on multiple days, verify heatmap colors reflect entry length, click dates to navigate

### Implementation for User Story 2

- [x] T020 [US2] Implement getHeatmap IPC handler in src/main/ipc/journal-handlers.ts (query journalCache for year, return date/level pairs)
- [x] T021 [US2] Create useJournalHeatmap hook in src/renderer/src/hooks/use-journal.ts (load heatmap data for current year)
- [x] T022 [US2] Wire JournalCalendar to real heatmap data in src/renderer/src/pages/journal.tsx (replace DUMMY heatmapData with useJournalHeatmap)
- [x] T023 [US2] Wire calendar day click to entry loading in src/renderer/src/pages/journal.tsx (load entry when date changes)
- [x] T024 [US2] Add tooltip with character count to calendar days in src/renderer/src/components/journal/calendar-heatmap.tsx (show date and character count on hover)

**Checkpoint**: User Story 2 complete - calendar shows real activity data, clicking days navigates to entries

---

## Phase 5: User Story 3 - Auto-Save Journal Entries (Priority: P1) MVP

**Goal**: Automatically save entries after 1 second typing pause with save status indicator

**Independent Test**: Write content, wait for save indicator, modify content, verify both saves occur

### Implementation for User Story 3

- [x] T025 [US3] Add debounced save to useJournalEntry hook in src/renderer/src/hooks/use-journal.ts (1000ms debounce per FR-004)
- [x] T026 [US3] Add isSaving state to useJournalEntry hook in src/renderer/src/hooks/use-journal.ts (track save in progress)
- [x] T027 [US3] Create SaveStatusIndicator component in src/renderer/src/components/journal/save-status.tsx (show Saving.../Saved/Error states)
- [x] T028 [US3] Add SaveStatusIndicator to JournalPage header in src/renderer/src/pages/journal.tsx (display current save state)
- [x] T029 [US3] Add save queue logic to prevent lost saves during rapid edits in src/renderer/src/hooks/use-journal.ts (queue new save if save in progress)

**Checkpoint**: User Story 3 complete - entries auto-save with visual feedback, no data loss

---

## Phase 6: User Story 4 - Word and Character Count (Priority: P1) MVP

**Goal**: Display real-time word and character counts while writing

**Independent Test**: Type content, verify counts update in real-time

### Implementation for User Story 4

- [ ] T030 [US4] Create WordCountDisplay component in src/renderer/src/components/journal/word-count.tsx (show word count and character count)
- [ ] T031 [US4] Compute counts from BlockNote content in src/renderer/src/pages/journal.tsx (extract text, count words/chars)
- [ ] T032 [US4] Add WordCountDisplay to JournalPage footer in src/renderer/src/pages/journal.tsx (subtle position per spec)

**Checkpoint**: User Story 4 complete - real-time writing statistics displayed

---

## Phase 7: User Story 5 - Focus Mode (Priority: P2)

**Goal**: Toggle focus mode to hide sidebars for distraction-free writing

**Independent Test**: Press Cmd+\, verify sidebars hide, press Escape to exit, verify preference persists

### Implementation for User Story 5

- [ ] T033 [US5] Verify focus mode keyboard shortcut in src/renderer/src/pages/journal.tsx (Cmd+\ toggle already implemented, verify working)
- [ ] T034 [US5] Verify focus mode localStorage persistence in src/renderer/src/pages/journal.tsx (memry_journal_focus_mode key already implemented)
- [ ] T035 [US5] Add accessibility attributes for focus mode toggle button in src/renderer/src/pages/journal.tsx (aria-pressed, aria-label)

**Checkpoint**: User Story 5 complete - focus mode toggles correctly with keyboard, persists across sessions

---

## Phase 8: User Story 6 - Day Context Sidebar (Priority: P2)

**Goal**: Show tasks and events for the viewed date alongside journal entry

**Independent Test**: View today's entry, verify tasks appear with completion toggles that sync with task system

### Implementation for User Story 6

- [ ] T036 [US6] Implement getDayContext IPC handler in src/main/ipc/journal-handlers.ts (query tasks for date from data.db, compute overdue count)
- [ ] T037 [US6] Create useDayContext hook in src/renderer/src/hooks/use-journal.ts (load tasks/events for selected date)
- [ ] T038 [US6] Wire DayContextSidebar to real task data in src/renderer/src/pages/journal.tsx (replace DUMMY_TASKS/DUMMY_EVENTS)
- [ ] T039 [US6] Implement task completion toggle in sidebar in src/renderer/src/components/journal/day-context-sidebar.tsx (call tasks:update IPC handler)
- [ ] T040 [US6] Add empty state for dates with no tasks in src/renderer/src/components/journal/day-context-sidebar.tsx (show appropriate message)

**Checkpoint**: User Story 6 complete - sidebar shows real tasks, completion syncs with task system

---

## Phase 9: User Story 7 - Month and Year Views (Priority: P2)

**Goal**: Browse journal history with month and year overview modes

**Independent Test**: Click month in breadcrumb, verify month view shows entries, click year, verify year view works

### Implementation for User Story 7

- [ ] T041 [US7] Implement getMonthEntries IPC handler in src/main/ipc/journal-handlers.ts (return entries with preview, word count, tags)
- [ ] T042 [US7] Implement getYearStats IPC handler in src/main/ipc/journal-handlers.ts (return monthly summaries)
- [ ] T043 [US7] Create useMonthEntries hook in src/renderer/src/hooks/use-journal.ts (load entries for month view)
- [ ] T044 [US7] Create useYearStats hook in src/renderer/src/hooks/use-journal.ts (load stats for year view)
- [ ] T045 [US7] Wire JournalMonthView to real data in src/renderer/src/pages/journal.tsx (replace monthEntries dummy data)
- [ ] T046 [US7] Wire JournalYearView to real data in src/renderer/src/pages/journal.tsx (replace monthStats dummy data)

**Checkpoint**: User Story 7 complete - month and year views display real journal history

---

## Phase 10: User Story 8 - AI-Suggested Connections (Priority: P2)

**Goal**: Show AI-suggested connections to past entries and notes (mock implementation for now)

**Independent Test**: Write content, verify connections panel loads (mock data), clicking connection navigates

### Implementation for User Story 8

- [ ] T047 [US8] Create mock AI connections service in src/renderer/src/services/ai-connections-service.ts (returns mock connections after 2s delay)
- [ ] T048 [US8] Create useAIConnections hook in src/renderer/src/hooks/use-journal.ts (trigger search 2s after typing pause)
- [ ] T049 [US8] Wire AIConnectionsPanel to useAIConnections hook in src/renderer/src/pages/journal.tsx (replace DUMMY_AI_CONNECTIONS)
- [ ] T050 [US8] Implement connection click navigation in src/renderer/src/pages/journal.tsx (open related content)
- [ ] T051 [US8] Add loading and empty states to AIConnectionsPanel in src/renderer/src/components/journal/ai-connections-panel.tsx (show spinner while loading)

**Checkpoint**: User Story 8 complete - AI connections panel functional with mock data, ready for real AI integration

---

## Phase 11: User Story 9 - Journal Templates (Priority: P3)

**Goal**: Provide templates for different entry types to help start writing

**Independent Test**: Select a template when creating entry, verify template content appears in editor

### Implementation for User Story 9

- [ ] T052 [US9] Define template types in src/shared/contracts/journal-api.ts (JournalTemplate schema with id, name, content)
- [ ] T053 [US9] Create default templates in src/renderer/src/data/journal-templates.ts (morning pages, reflection, gratitude)
- [ ] T054 [US9] Create TemplateSelector component in src/renderer/src/components/journal/template-selector.tsx (dropdown/modal to pick template)
- [ ] T055 [US9] Add template selection to empty entry state in src/renderer/src/pages/journal.tsx (show template options when entry is empty)
- [ ] T056 [US9] Apply selected template content to editor in src/renderer/src/pages/journal.tsx (populate BlockNote with template)

**Checkpoint**: User Story 9 complete - users can start entries with predefined templates

---

## Phase 12: User Story 10 - Journaling Streak (Priority: P3)

**Goal**: Track and display consecutive days journaled for motivation

**Independent Test**: Journal on consecutive days, verify streak count increments correctly

### Implementation for User Story 10

- [ ] T057 [US10] Add getStreak query to src/shared/db/queries/journal.ts (compute current streak and longest streak from journalCache)
- [ ] T058 [US10] Implement getStreak IPC handler in src/main/ipc/journal-handlers.ts (return current/longest streak)
- [ ] T059 [US10] Create useJournalStreak hook in src/renderer/src/hooks/use-journal.ts (load streak data)
- [ ] T060 [US10] Create StreakDisplay component in src/renderer/src/components/journal/streak-display.tsx (show current streak flame icon and count)
- [ ] T061 [US10] Add StreakDisplay to JournalPage sidebar in src/renderer/src/pages/journal.tsx (display near calendar)

**Checkpoint**: User Story 10 complete - streak information motivates consistent journaling

---

## Phase 13: User Story 11 - Journal Search (Priority: P3)

**Goal**: Search across all journal entries to find past reflections

**Independent Test**: Search for a term, verify matching entries returned with highlighted snippets

### Implementation for User Story 11

- [ ] T062 [US11] Add FTS5 triggers for journal entries in src/main/database/fts.ts (sync journal content to fts_notes table)
- [ ] T063 [US11] Implement searchEntries IPC handler in src/main/ipc/journal-handlers.ts (FTS5 query with snippet extraction)
- [ ] T064 [US11] Create useJournalSearch hook in src/renderer/src/hooks/use-journal.ts (debounced search with results)
- [ ] T065 [US11] Create JournalSearchInput component in src/renderer/src/components/journal/journal-search.tsx (search input with results dropdown)
- [ ] T066 [US11] Add JournalSearchInput to JournalPage in src/renderer/src/pages/journal.tsx (search trigger in header or sidebar)
- [ ] T067 [US11] Implement search result click navigation in src/renderer/src/components/journal/journal-search.tsx (navigate to matching entry date)

**Checkpoint**: User Story 11 complete - users can search and find past journal entries

---

## Phase 14: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories, edge cases, performance

- [ ] T068 [P] Add external file change detection to journal entries in src/main/vault/watcher.ts (emit journal:externalChange event)
- [ ] T069 [P] Handle external change notification in JournalPage in src/renderer/src/pages/journal.tsx (offer to reload content)
- [ ] T070 [P] Add error boundary for journal components in src/renderer/src/pages/journal.tsx (graceful error display)
- [ ] T071 [P] Handle disk full error during auto-save in src/renderer/src/hooks/use-journal.ts (show error toast, retain content in memory)
- [ ] T072 [P] Add debounced navigation to prevent race conditions in src/renderer/src/pages/journal.tsx (cancel pending saves on rapid date changes)
- [ ] T073 [P] Add accessibility labels to calendar and sidebar components in src/renderer/src/components/journal/ (ARIA attributes per spec)
- [ ] T074 [P] Optimize heatmap query for years of data in src/shared/db/queries/journal.ts (ensure <50ms for 365 days per SC-002)
- [ ] T075 Add journal cache rebuild on vault open in src/main/vault/indexer.ts (scan journal/\*.md, populate journalCache)
- [ ] T076 Run quickstart.md validation - verify all setup steps work end-to-end

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-13)**: All depend on Foundational phase completion
  - P1 stories (US1-4) should complete before P2 (US5-8)
  - P2 stories should complete before P3 (US9-11)
  - Within same priority, stories can proceed in parallel
- **Polish (Phase 14)**: Depends on core user stories (US1-4) being complete

### User Story Dependencies

| Story                | Priority | Dependencies          | Can Parallelize With  |
| -------------------- | -------- | --------------------- | --------------------- |
| US1 Daily Entry      | P1       | Foundational          | -                     |
| US2 Calendar/Heatmap | P1       | Foundational          | US1 (different files) |
| US3 Auto-Save        | P1       | US1 (uses entry hook) | US2                   |
| US4 Word Count       | P1       | US1 (uses entry hook) | US2, US3              |
| US5 Focus Mode       | P2       | Foundational          | Any P2 story          |
| US6 Day Context      | P2       | Foundational          | Any P2 story          |
| US7 Month/Year Views | P2       | US2 (uses heatmap)    | US5, US6, US8         |
| US8 AI Connections   | P2       | Foundational          | US5, US6, US7         |
| US9 Templates        | P3       | US1                   | Any P3 story          |
| US10 Streaks         | P3       | US1                   | Any P3 story          |
| US11 Search          | P3       | US1                   | US9, US10             |

### Within Each User Story

- IPC handlers before hooks
- Hooks before UI wiring
- Core implementation before polish
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks T002-T004 marked [P] can run in parallel
- T010, T011 (preload) can run in parallel with T006, T007, T008
- US1 and US2 can start simultaneously after Foundational
- US3 and US4 share dependency on US1 hook but modify different parts
- All P2 stories can run in parallel after P1 completion
- All P3 stories can run in parallel after P2 completion
- All Polish tasks marked [P] can run in parallel

---

## Parallel Example: Phase 2 (Foundational)

```bash
# After T005 (migration), launch in parallel:
Task: "T006 - Create journal query functions"
Task: "T007 - Create journal file operations"
Task: "T010 - Add journal API to preload"
Task: "T011 - Add journal type declarations"
```

## Parallel Example: P1 User Stories

```bash
# After Foundational complete, launch in parallel:
Task: "T013-T019 - User Story 1 (Daily Entry)"
Task: "T020-T024 - User Story 2 (Calendar/Heatmap)"

# Then after US1 hook exists:
Task: "T025-T029 - User Story 3 (Auto-Save)"
Task: "T030-T032 - User Story 4 (Word Count)"
```

---

## Implementation Strategy

### MVP First (User Stories 1-4)

1. Complete Phase 1: Setup (T001-T005)
2. Complete Phase 2: Foundational (T006-T012)
3. Complete Phase 3-6: User Stories 1-4 (T013-T032)
4. **STOP and VALIDATE**: Test daily journaling end-to-end
5. Deploy/demo - users can journal with auto-save and calendar navigation

### Incremental Delivery

| Increment | Scope     | Value Delivered                                       |
| --------- | --------- | ----------------------------------------------------- |
| MVP       | US1-4     | Core journaling with auto-save, calendar, word count  |
| +P2       | US5-8     | Focus mode, tasks sidebar, month/year views, AI panel |
| +P3       | US9-11    | Templates, streaks, search                            |
| +Polish   | T068-T076 | Edge cases, performance, accessibility                |

### Recommended Task Order (Sequential Developer)

1. T001-T012 (Setup + Foundational)
2. T013-T019 (US1 - Daily Entry)
3. T020-T024 (US2 - Calendar)
4. T025-T029 (US3 - Auto-Save)
5. T030-T032 (US4 - Word Count)
6. **Test MVP thoroughly**
7. T033-T051 (US5-8 - P2 features)
8. T052-T067 (US9-11 - P3 features)
9. T068-T076 (Polish)

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- UI components already exist (100% complete) - tasks focus on backend wiring
- Existing file watcher already monitors journal/ folder - leverage for external edit detection
- AI connections uses mock data now - real implementation in 006-ai phase
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
