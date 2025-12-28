# Tasks: Inbox System for Quick Capture

**Input**: Design documents from `/specs/005-inbox-capture/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/inbox-api.ts

**Tests**: Tests are not explicitly requested in the specification. Test tasks are NOT included.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Electron app**: `src/main/`, `src/renderer/src/`, `src/shared/`, `src/preload/`
- Following established patterns from 001-core-data-layer

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, dependencies, and basic structure

- [x] T001 Install new dependencies (metascraper, pdf-parse, pdfjs-dist, sharp, openai) per plan.md
- [x] T002 [P] Create src/main/inbox/ directory structure with index.ts module exports
- [x] T003 [P] Create src/main/lib/url-utils.ts with URL validation and parsing utilities
- [x] T004 [P] Add environment variable handling for OPENAI_API_KEY in src/main/index.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Extend inbox schema in src/shared/db/schema/inbox.ts with all columns from data-model.md
- [x] T006 Add inbox_item_tags table schema in src/shared/db/schema/inbox.ts
- [x] T007 Add filing_history table schema in src/shared/db/schema/inbox.ts
- [x] T008 Add inbox_stats table schema in src/shared/db/schema/inbox.ts
- [x] T009 Run drizzle-kit generate to create migration for extended inbox schema
- [x] T010 Add InboxChannels to src/shared/ipc-channels.ts (from contracts/inbox-api.ts)
- [x] T011 Copy inbox-api.ts contract to src/shared/contracts/inbox-api.ts
- [x] T012 Create src/main/inbox/attachments.ts for inbox attachment management
- [x] T013 Create basic src/main/ipc/inbox-handlers.ts with handler registration
- [x] T014 Register inbox IPC handlers in src/main/ipc/index.ts
- [x] T015 Add inbox API to preload in src/preload/index.ts
- [x] T016 Create src/renderer/src/services/inbox-service.ts IPC client
- [x] T017 Create src/renderer/src/hooks/use-inbox.ts base hook structure

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Quick Link Capture with Preview (Priority: P1)

**Goal**: Capture URLs with automatic metadata extraction displaying title, excerpt, and image

**Independent Test**: Paste a URL into inbox, wait for preview, verify title/description/image display

### Implementation for User Story 1

- [ ] T018 [P] [US1] Create src/main/inbox/metadata.ts with metascraper setup
- [ ] T019 [P] [US1] Implement fetchUrlMetadata function in src/main/inbox/metadata.ts
- [ ] T020 [US1] Add URL detection logic in src/main/inbox/capture.ts
- [ ] T021 [US1] Implement captureLink handler in src/main/inbox/capture.ts
- [ ] T022 [US1] Add CAPTURE_LINK IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T023 [US1] Add LIST IPC handler for inbox items in src/main/ipc/inbox-handlers.ts
- [ ] T024 [US1] Add GET IPC handler for single item in src/main/ipc/inbox-handlers.ts
- [ ] T025 [US1] Implement retry logic for failed metadata fetches in src/main/inbox/metadata.ts
- [ ] T026 [US1] Add captureLink method to src/renderer/src/services/inbox-service.ts
- [ ] T027 [US1] Update useInbox hook to fetch real data in src/renderer/src/hooks/use-inbox.ts
- [ ] T028 [US1] Replace sampleInboxItems with useInbox hook in src/renderer/src/pages/inbox.tsx
- [ ] T029 [US1] Add loading state for metadata fetch in src/renderer/src/pages/inbox.tsx
- [ ] T030 [US1] Add error state with retry button for failed fetches in src/renderer/src/pages/inbox.tsx

**Checkpoint**: Link capture with metadata extraction is fully functional

---

## Phase 4: User Story 2 - Quick Text Note Capture (Priority: P1)

**Goal**: Capture text notes with markdown preserved, single keypress submission

**Independent Test**: Type text, press Enter, verify note appears in inbox list with formatting preserved

### Implementation for User Story 2

- [ ] T031 [P] [US2] Implement captureText handler in src/main/inbox/capture.ts
- [ ] T032 [US2] Add CAPTURE_TEXT IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T033 [US2] Add text/URL auto-detection in capture input component
- [ ] T034 [US2] Add captureText method to src/renderer/src/services/inbox-service.ts
- [ ] T035 [US2] Create capture input component with Enter key handling in src/renderer/src/components/capture-input.tsx
- [ ] T036 [US2] Integrate capture input into InboxPage in src/renderer/src/pages/inbox.tsx
- [ ] T037 [US2] Add optimistic UI update when capturing text in src/renderer/src/hooks/use-inbox.ts

**Checkpoint**: Text note capture is fully functional

---

## Phase 5: User Story 3 - File Inbox Items (Priority: P1)

**Goal**: File items to folders, convert to notes, or link to existing notes

**Independent Test**: Select item, click File, choose destination, verify item moves and is removed from inbox

### Implementation for User Story 3

- [ ] T038 [P] [US3] Create src/main/inbox/filing.ts with filing operations
- [ ] T039 [US3] Implement fileToFolder function in src/main/inbox/filing.ts
- [ ] T040 [US3] Implement convertToNote function in src/main/inbox/filing.ts
- [ ] T041 [US3] Implement linkToNote function in src/main/inbox/filing.ts
- [ ] T042 [US3] Add FILE IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T043 [US3] Add CONVERT_TO_NOTE IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T044 [US3] Add LINK_TO_NOTE IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T045 [US3] Create filing_history record on file operations in src/main/inbox/filing.ts
- [ ] T046 [US3] Add file methods to src/renderer/src/services/inbox-service.ts
- [ ] T047 [US3] Connect FilingPanel to real API in src/renderer/src/components/filing/filing-panel.tsx
- [ ] T048 [US3] Add handleFilingComplete with real IPC calls in src/renderer/src/pages/inbox.tsx
- [ ] T049 [US3] Move inbox attachments to notes folder on convert in src/main/inbox/filing.ts

**Checkpoint**: Filing to folders and converting to notes is fully functional

---

## Phase 6: User Story 4 - Delete Inbox Items (Priority: P1)

**Goal**: Delete items with confirmation and permanent removal

**Independent Test**: Select item, click delete, confirm, verify item is permanently removed

### Implementation for User Story 4

- [ ] T050 [P] [US4] Implement deleteItem function in src/main/inbox/capture.ts
- [ ] T051 [US4] Add DELETE IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T052 [US4] Delete inbox attachments on item delete in src/main/inbox/attachments.ts
- [ ] T053 [US4] Add delete method to src/renderer/src/services/inbox-service.ts
- [ ] T054 [US4] Connect delete button to real API in src/renderer/src/pages/inbox.tsx
- [ ] T055 [US4] Update inbox stats on delete (increment deleted_count) in src/main/inbox/stats.ts

**Checkpoint**: Item deletion is fully functional

---

## Phase 7: User Story 5 - Bulk Select and Process Items (Priority: P1)

**Goal**: Multi-select items with Cmd+A, Cmd+click, bulk file and bulk delete

**Independent Test**: Select multiple items, apply bulk action, verify all selected items are processed

### Implementation for User Story 5

- [ ] T056 [P] [US5] Implement bulkFile function in src/main/inbox/filing.ts
- [ ] T057 [P] [US5] Implement bulkDelete function in src/main/inbox/capture.ts
- [ ] T058 [US5] Add BULK_FILE IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T059 [US5] Add BULK_DELETE IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T060 [US5] Add bulk methods to src/renderer/src/services/inbox-service.ts
- [ ] T061 [US5] Connect BulkActionBar to real API in src/renderer/src/components/bulk/bulk-action-bar.tsx
- [ ] T062 [US5] Connect BulkFilePanel to real API in src/renderer/src/components/bulk/bulk-file-panel.tsx
- [ ] T063 [US5] Update handleBulkFileComplete with real IPC in src/renderer/src/pages/inbox.tsx
- [ ] T064 [US5] Update handleBulkDeleteConfirm with real IPC in src/renderer/src/pages/inbox.tsx

**Checkpoint**: Bulk operations are fully functional - MVP COMPLETE

---

## Phase 8: User Story 6 - Image Capture (Priority: P2)

**Goal**: Capture images via drag-drop and clipboard with thumbnail generation

**Independent Test**: Drag image onto inbox, verify thumbnail appears and file is stored

### Implementation for User Story 6

- [ ] T065 [P] [US6] Implement captureImage handler in src/main/inbox/capture.ts
- [ ] T066 [P] [US6] Add thumbnail generation with sharp in src/main/inbox/capture.ts
- [ ] T067 [US6] Add CAPTURE_IMAGE IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T068 [US6] Store image file in vault/attachments/inbox/{itemId}/ directory
- [ ] T069 [US6] Extract image metadata (dimensions, format) using sharp
- [ ] T070 [US6] Add captureImage method to src/renderer/src/services/inbox-service.ts
- [ ] T071 [US6] Add drag-drop handler to InboxPage in src/renderer/src/pages/inbox.tsx
- [ ] T072 [US6] Add clipboard paste handler (Cmd+V) for images in src/renderer/src/pages/inbox.tsx
- [ ] T073 [US6] Display image thumbnail in inbox list item component

**Checkpoint**: Image capture with thumbnails is fully functional

---

## Phase 9: User Story 7 - Voice Memo Capture with Transcription (Priority: P2)

**Goal**: Record voice memos with automatic transcription via Whisper API

**Independent Test**: Click record, speak, stop, verify audio saved and transcription appears

### Implementation for User Story 7

- [ ] T074 [P] [US7] Create src/main/inbox/transcription.ts with Whisper API integration
- [ ] T075 [P] [US7] Implement captureVoice handler in src/main/inbox/capture.ts
- [ ] T076 [US7] Add CAPTURE_VOICE IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T077 [US7] Store audio file in vault/attachments/inbox/{itemId}/ directory
- [ ] T078 [US7] Implement async transcription with status updates in src/main/inbox/transcription.ts
- [ ] T079 [US7] Add RETRY_TRANSCRIPTION IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T080 [US7] Emit TRANSCRIPTION_COMPLETE event when done in src/main/inbox/transcription.ts
- [ ] T081 [US7] Add captureVoice method to src/renderer/src/services/inbox-service.ts
- [ ] T082 [US7] Create voice recording component in src/renderer/src/components/voice-recorder.tsx
- [ ] T083 [US7] Add recording controls to capture area in src/renderer/src/pages/inbox.tsx
- [ ] T084 [US7] Display transcription status (pending/processing/complete/failed) in list item
- [ ] T085 [US7] Add retry transcription button for failed items

**Checkpoint**: Voice capture with transcription is fully functional

---

## Phase 10: User Story 8 - Stale Item Highlighting (Priority: P2)

**Goal**: Highlight items older than 7 days, allow configurable threshold

**Independent Test**: Create items with backdated timestamps, verify stale indicator displays

### Implementation for User Story 8

- [ ] T086 [P] [US8] Add isStale computed field to list query in src/main/ipc/inbox-handlers.ts
- [ ] T087 [P] [US8] Create src/main/inbox/stats.ts with stale detection logic
- [ ] T088 [US8] Add GET_STALE_THRESHOLD IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T089 [US8] Add SET_STALE_THRESHOLD IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T090 [US8] Implement FILE_ALL_STALE IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T091 [US8] Add stale threshold methods to src/renderer/src/services/inbox-service.ts
- [ ] T092 [US8] Update stale styling in list/card view components (already exists, verify works)
- [ ] T093 [US8] Connect "File all stale" button to real API in src/renderer/src/pages/inbox.tsx

**Checkpoint**: Stale item highlighting is fully functional

---

## Phase 11: User Story 9 - Global Capture Shortcut (Priority: P2)

**Goal**: Cmd+Shift+Space opens quick capture window from anywhere

**Independent Test**: Press shortcut while other app focused, enter content, verify item in inbox

### Implementation for User Story 9

- [ ] T094 [P] [US9] Register global shortcut (Cmd+Shift+Space) in src/main/index.ts
- [ ] T095 [US9] Create quick capture window in src/main/index.ts
- [ ] T096 [US9] Create quick capture mini window component in src/renderer/src/components/quick-capture.tsx
- [ ] T097 [US9] Auto-detect clipboard URL content in quick capture window
- [ ] T098 [US9] Handle Escape to close and Enter to submit in quick capture
- [ ] T099 [US9] Send capture request from quick capture window to main process

**Checkpoint**: Global capture shortcut is fully functional

---

## Phase 12: User Story 10 - Item Preview (Priority: P2)

**Goal**: Preview panel shows full content for links, notes, images, voice

**Independent Test**: Click each item type, verify appropriate preview content displays

### Implementation for User Story 10

- [ ] T100 [P] [US10] Add full content field to GET response in src/main/ipc/inbox-handlers.ts
- [ ] T101 [US10] Fetch full metadata for preview in src/renderer/src/hooks/use-inbox.ts
- [ ] T102 [US10] Connect PreviewPanel to real item data in src/renderer/src/components/preview/preview-panel.tsx
- [ ] T103 [US10] Render link content in reader-friendly format in preview
- [ ] T104 [US10] Display full-size image in preview
- [ ] T105 [US10] Add audio player for voice items in preview

**Checkpoint**: Item preview is fully functional

---

## Phase 13: User Story 11 - Tag Items Before Filing (Priority: P3)

**Goal**: Add tags to inbox items with autocomplete

**Independent Test**: Add tags to item, file item, verify tags preserved on filed item

### Implementation for User Story 11

- [ ] T106 [P] [US11] Implement addTag function in src/main/inbox/capture.ts
- [ ] T107 [P] [US11] Implement removeTag function in src/main/inbox/capture.ts
- [ ] T108 [US11] Add ADD_TAG IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T109 [US11] Add REMOVE_TAG IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T110 [US11] Add GET_TAGS IPC handler (for autocomplete) in src/main/ipc/inbox-handlers.ts
- [ ] T111 [US11] Add tag methods to src/renderer/src/services/inbox-service.ts
- [ ] T112 [US11] Create tag input component with autocomplete in src/renderer/src/components/tag-input.tsx
- [ ] T113 [US11] Add tag editing to item detail/preview
- [ ] T114 [US11] Preserve tags when filing items in src/main/inbox/filing.ts

**Checkpoint**: Tagging is fully functional

---

## Phase 14: User Story 12 - Web Clipper (Priority: P2)

**Goal**: Capture selected text from web pages with source attribution

**Independent Test**: Select text, use clip shortcut, verify quoted text with source in inbox

### Implementation for User Story 12

- [ ] T115 [P] [US12] Implement captureClip handler in src/main/inbox/capture.ts
- [ ] T116 [US12] Add CAPTURE_CLIP IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T117 [US12] Store captured images from clip selection in attachments
- [ ] T118 [US12] Preserve HTML formatting in clip content
- [ ] T119 [US12] Add captureClip method to src/renderer/src/services/inbox-service.ts
- [ ] T120 [US12] Create clip display component with quote styling in src/renderer/src/components/clip-card.tsx
- [ ] T121 [US12] Add source attribution link to clip items

**Checkpoint**: Web clipper is fully functional

---

## Phase 15: User Story 13 - PDF Capture (Priority: P2)

**Goal**: Import PDFs with thumbnail generation and text extraction

**Independent Test**: Drag PDF onto inbox, verify thumbnail and text excerpt display

### Implementation for User Story 13

- [ ] T122 [P] [US13] Create src/main/inbox/pdf.ts with PDF handling
- [ ] T123 [US13] Implement capturePdf handler in src/main/inbox/capture.ts
- [ ] T124 [US13] Extract text content using pdf-parse in src/main/inbox/pdf.ts
- [ ] T125 [US13] Generate first-page thumbnail using pdfjs-dist in src/main/inbox/pdf.ts
- [ ] T126 [US13] Add CAPTURE_PDF IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T127 [US13] Handle password-protected PDFs with error message
- [ ] T128 [US13] Add size limit warning (>50MB) in capture handler
- [ ] T129 [US13] Add capturePdf method to src/renderer/src/services/inbox-service.ts
- [ ] T130 [US13] Display PDF metadata (page count, size) in list item

**Checkpoint**: PDF capture is fully functional

---

## Phase 16: User Story 14 - Tweet/Social Post Capture (Priority: P2)

**Goal**: Rich display of social media posts with author info and media

**Independent Test**: Paste Twitter URL, verify post content and author info displays

### Implementation for User Story 14

- [ ] T131 [P] [US14] Create src/main/inbox/social.ts with social platform detection
- [ ] T132 [US14] Implement Twitter/X extraction using oEmbed in src/main/inbox/social.ts
- [ ] T133 [US14] Add platform-specific metadata extraction for supported platforms
- [ ] T134 [US14] Integrate social detection into link capture flow in src/main/inbox/capture.ts
- [ ] T135 [US14] Create social post display component in src/renderer/src/components/social-card.tsx
- [ ] T136 [US14] Display author avatar, handle, and formatted text in social card
- [ ] T137 [US14] Handle graceful fallback when social extraction fails

**Checkpoint**: Social post capture is fully functional

---

## Phase 17: User Story 15 - Smart Filing Suggestions (Priority: P2)

**Goal**: AI-powered folder/tag suggestions based on content similarity

**Independent Test**: Select item, open filing panel, verify relevant suggestions appear

### Implementation for User Story 15

- [ ] T138 [P] [US15] Create src/main/inbox/suggestions.ts with suggestion logic
- [ ] T139 [US15] Implement content embedding using OpenAI embeddings
- [ ] T140 [US15] Compare embeddings with existing notes/folders for similarity
- [ ] T141 [US15] Add GET_SUGGESTIONS IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T142 [US15] Learn from filing history to improve suggestions
- [ ] T143 [US15] Add getSuggestions method to src/renderer/src/services/inbox-service.ts
- [ ] T144 [US15] Display suggestions in FilingPanel in src/renderer/src/components/filing/filing-panel.tsx
- [ ] T145 [US15] Show reasoning on hover for each suggestion
- [ ] T146 [US15] Track accepted/rejected suggestions for learning

**Checkpoint**: Smart filing suggestions are fully functional

---

## Phase 18: User Story 16 - Remind Me Later / Snooze (Priority: P2)

**Goal**: Snooze items to resurface at specified time

**Independent Test**: Snooze item, verify hidden, wait for time, verify reappears

### Implementation for User Story 16

- [ ] T147 [P] [US16] Create src/main/inbox/snooze.ts with snooze logic
- [ ] T148 [US16] Implement snoozeItem function in src/main/inbox/snooze.ts
- [ ] T149 [US16] Implement unsnoozeItem function in src/main/inbox/snooze.ts
- [ ] T150 [US16] Add snooze due check on app startup in src/main/inbox/snooze.ts
- [ ] T151 [US16] Add periodic snooze check (every 1 minute) in src/main/index.ts
- [ ] T152 [US16] Add SNOOZE IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T153 [US16] Add UNSNOOZE IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T154 [US16] Add GET_SNOOZED IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T155 [US16] Emit SNOOZE_DUE event when snoozed items become due
- [ ] T156 [US16] Add snooze methods to src/renderer/src/services/inbox-service.ts
- [ ] T157 [US16] Create snooze picker component in src/renderer/src/components/snooze-picker.tsx
- [ ] T158 [US16] Add snooze button to item actions
- [ ] T159 [US16] Add "Snoozed" filter option to inbox list

**Checkpoint**: Snooze functionality is fully functional

---

## Phase 19: User Story 17 - Inbox Stats Dashboard (Priority: P3)

**Goal**: Display capture and processing statistics

**Independent Test**: Capture items over time, verify stats panel shows accurate counts

### Implementation for User Story 17

- [ ] T160 [P] [US17] Implement incrementCaptureStat function in src/main/inbox/stats.ts
- [ ] T161 [P] [US17] Implement incrementProcessedStat function in src/main/inbox/stats.ts
- [ ] T162 [US17] Add GET_STATS IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T163 [US17] Calculate average time-to-process in src/main/inbox/stats.ts
- [ ] T164 [US17] Add getStats method to src/renderer/src/services/inbox-service.ts
- [ ] T165 [US17] Create stats panel component in src/renderer/src/components/inbox-stats.tsx
- [ ] T166 [US17] Add stats icon/button to inbox header
- [ ] T167 [US17] Display items by type breakdown in stats panel

**Checkpoint**: Stats dashboard is fully functional

---

## Phase 20: User Story 18 - Capture Patterns / Insights (Priority: P3)

**Goal**: Heatmap and insights about capture behavior

**Independent Test**: Capture items at various times, verify patterns view shows heatmap

### Implementation for User Story 18

- [ ] T168 [P] [US18] Implement generateTimeHeatmap function in src/main/inbox/stats.ts
- [ ] T169 [P] [US18] Implement getTopDomains function in src/main/inbox/stats.ts
- [ ] T170 [P] [US18] Implement getTopTags function in src/main/inbox/stats.ts
- [ ] T171 [US18] Add GET_PATTERNS IPC handler in src/main/ipc/inbox-handlers.ts
- [ ] T172 [US18] Calculate type distribution with trends in src/main/inbox/stats.ts
- [ ] T173 [US18] Add getPatterns method to src/renderer/src/services/inbox-service.ts
- [ ] T174 [US18] Create patterns view component in src/renderer/src/components/inbox-patterns.tsx
- [ ] T175 [US18] Display capture time heatmap (24x7 grid)
- [ ] T176 [US18] Show minimum data threshold message when <10 items

**Checkpoint**: Capture patterns view is fully functional

---

## Phase 21: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T177 [P] Update InboxItem type in src/renderer/src/types/index.ts to match backend schema
- [ ] T178 [P] Add error boundary for inbox page in src/renderer/src/pages/inbox.tsx
- [ ] T179 [P] Add loading skeletons for inbox list during initial load
- [ ] T180 Implement offline queue for link metadata fetch in src/main/inbox/metadata.ts
- [ ] T181 Add keyboard shortcut help (?) in inbox page
- [ ] T182 Performance optimization: lazy load thumbnails on scroll
- [ ] T183 Remove sample data file src/renderer/src/data/sample-inbox-items.ts after migration
- [ ] T184 Verify quickstart.md validation steps work correctly

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup - BLOCKS all user stories
- **User Stories (Phases 3-20)**: All depend on Foundational phase completion
  - User stories can proceed in priority order (P1 first, then P2, then P3)
  - Or in parallel if team capacity allows
- **Polish (Phase 21)**: Depends on all desired user stories being complete

### User Story Dependencies

All user stories depend only on Foundational phase. Stories are designed to be independently testable:

- **US1 (Link Capture)**: Foundation only
- **US2 (Text Capture)**: Foundation only
- **US3 (Filing)**: Requires US1 or US2 (needs items to file)
- **US4 (Delete)**: Requires US1 or US2 (needs items to delete)
- **US5 (Bulk)**: Requires US1 or US2 (needs items for bulk ops)
- **US6-US18**: Foundation only (can run in parallel with US1-US5)

### Within Each User Story

- Models/schemas before services
- Main process before renderer
- IPC handlers before UI components
- Core implementation before integration

### Parallel Opportunities

**Phase 1 - All tasks can run in parallel:**

```bash
Task T001, T002, T003, T004 - different concerns, no conflicts
```

**Phase 2 - Schema tasks then IPC setup:**

```bash
# Schema (parallel):
Task T005, T006, T007, T008

# Then migration:
Task T009

# Then IPC setup (parallel):
Task T010, T011, T012, T013
Task T014, T015, T016, T017
```

**User Story phases - Main process tasks in parallel:**

```bash
# US1 example:
Task T018, T019 - different files (metadata.ts, capture.ts)
```

---

## Parallel Example: User Story 1

```bash
# Launch main process tasks in parallel:
Task: "Create src/main/inbox/metadata.ts with metascraper setup"
Task: "Implement fetchUrlMetadata function in src/main/inbox/metadata.ts"

# Then sequential IPC handlers:
Task: "Add CAPTURE_LINK IPC handler"
Task: "Add LIST IPC handler"

# Then renderer tasks:
Task: "Add captureLink method to inbox-service.ts"
Task: "Update useInbox hook"
Task: "Replace sample data in InboxPage"
```

---

## Implementation Strategy

### MVP First (User Stories 1-5)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL)
3. Complete Phase 3: US1 - Link Capture
4. Complete Phase 4: US2 - Text Capture
5. Complete Phase 5: US3 - Filing
6. Complete Phase 6: US4 - Delete
7. Complete Phase 7: US5 - Bulk Operations
8. **STOP and VALIDATE**: Core inbox is complete

### Incremental Delivery

After MVP:

- Add US6 (Image) + US7 (Voice) → Media capture
- Add US8 (Stale) + US16 (Snooze) → Time management
- Add US9 (Global) → Quick access
- Add US10 (Preview) → Better browsing
- Add US11-US15 → Advanced features
- Add US17-US18 → Analytics

### Story Points Estimate

| Phase      | Stories      | Complexity | Estimate |
| ---------- | ------------ | ---------- | -------- |
| Setup      | -            | Low        | 0.5 day  |
| Foundation | -            | Medium     | 1 day    |
| US1-US5    | P1 MVP       | Medium     | 4 days   |
| US6-US10   | P2 Core      | Medium     | 4 days   |
| US11-US16  | P2 Advanced  | High       | 5 days   |
| US17-US18  | P3 Analytics | Medium     | 2 days   |
| Polish     | -            | Low        | 1 day    |

**Total: ~17.5 days (3.5 weeks)**

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Existing UI components exist in src/renderer/src/components/ - connect to real API
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
