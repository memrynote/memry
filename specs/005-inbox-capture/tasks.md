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

- [x] T018 [P] [US1] Create src/main/inbox/metadata.ts with metascraper setup
- [x] T019 [P] [US1] Implement fetchUrlMetadata function in src/main/inbox/metadata.ts
- [x] T020 [US1] Add URL detection logic in src/main/inbox/capture.ts
- [x] T021 [US1] Implement captureLink handler in src/main/inbox/capture.ts
- [x] T022 [US1] Add CAPTURE_LINK IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T023 [US1] Add LIST IPC handler for inbox items in src/main/ipc/inbox-handlers.ts
- [x] T024 [US1] Add GET IPC handler for single item in src/main/ipc/inbox-handlers.ts
- [x] T025 [US1] Implement retry logic for failed metadata fetches in src/main/inbox/metadata.ts
- [x] T026 [US1] Add captureLink method to src/renderer/src/services/inbox-service.ts
- [x] T027 [US1] Update useInbox hook to fetch real data in src/renderer/src/hooks/use-inbox.ts
- [x] T028 [US1] Replace sampleInboxItems with useInbox hook in src/renderer/src/pages/inbox.tsx
- [x] T029 [US1] Add loading state for metadata fetch in src/renderer/src/pages/inbox.tsx
- [x] T030 [US1] Add error state with retry button for failed fetches in src/renderer/src/pages/inbox.tsx

**Checkpoint**: Link capture with metadata extraction is fully functional

---

## Phase 4: User Story 2 - Quick Text Note Capture (Priority: P1)

**Goal**: Capture text notes with markdown preserved, single keypress submission

**Independent Test**: Type text, press Enter, verify note appears in inbox list with formatting preserved

### Implementation for User Story 2

- [x] T031 [P] [US2] Implement captureText handler in src/main/inbox/capture.ts
- [x] T032 [US2] Add CAPTURE_TEXT IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T033 [US2] Add text/URL auto-detection in capture input component
- [x] T034 [US2] Add captureText method to src/renderer/src/services/inbox-service.ts
- [x] T035 [US2] Create capture input component with Enter key handling in src/renderer/src/components/capture-input.tsx
- [x] T036 [US2] Integrate capture input into InboxPage in src/renderer/src/pages/inbox.tsx
- [x] T037 [US2] Add optimistic UI update when capturing text in src/renderer/src/hooks/use-inbox.ts

**Checkpoint**: Text note capture is fully functional

---

## Phase 5: User Story 3 - File Inbox Items (Priority: P1)

**Goal**: File items to folders, convert to notes, or link to existing notes

**Independent Test**: Select item, click File, choose destination, verify item moves and is removed from inbox

### Implementation for User Story 3

- [x] T038 [P] [US3] Create src/main/inbox/filing.ts with filing operations
- [x] T039 [US3] Implement fileToFolder function in src/main/inbox/filing.ts
- [x] T040 [US3] Implement convertToNote function in src/main/inbox/filing.ts
- [x] T041 [US3] Implement linkToNote function in src/main/inbox/filing.ts
- [x] T042 [US3] Add FILE IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T043 [US3] Add CONVERT_TO_NOTE IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T044 [US3] Add LINK_TO_NOTE IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T045 [US3] Create filing_history record on file operations in src/main/inbox/filing.ts
- [x] T046 [US3] Add file methods to src/renderer/src/services/inbox-service.ts
- [x] T047 [US3] Connect FilingPanel to real API in src/renderer/src/components/filing/filing-panel.tsx
- [x] T048 [US3] Add handleFilingComplete with real IPC calls in src/renderer/src/pages/inbox.tsx
- [ ] T049 [US3] Move inbox attachments to notes folder on convert in src/main/inbox/filing.ts

**Checkpoint**: Filing to folders and converting to notes is fully functional

---

## Phase 6: User Story 4 - Delete Inbox Items (Priority: P1)

**Goal**: Delete items with confirmation and permanent removal

**Independent Test**: Select item, click delete, confirm, verify item is permanently removed

### Implementation for User Story 4

- [x] T050 [P] [US4] Implement deleteItem function in src/main/inbox/capture.ts
- [x] T051 [US4] Add DELETE IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T052 [US4] Delete inbox attachments on item delete in src/main/inbox/attachments.ts
- [x] T053 [US4] Add delete method to src/renderer/src/services/inbox-service.ts
- [x] T054 [US4] Connect delete button to real API in src/renderer/src/pages/inbox.tsx
- [x] T055 [US4] Update inbox stats on delete (increment deleted_count) in src/main/inbox/stats.ts

**Checkpoint**: Item deletion is fully functional

---

## Phase 7: User Story 5 - Bulk Select and Process Items (Priority: P1)

**Goal**: Multi-select items with Cmd+A, Cmd+click, bulk file and bulk delete

**Independent Test**: Select multiple items, apply bulk action, verify all selected items are processed

### Implementation for User Story 5

- [x] T056 [P] [US5] Implement bulkFile function in src/main/inbox/filing.ts
- [x] T057 [P] [US5] Implement bulkDelete function in src/main/inbox/capture.ts
- [x] T058 [US5] Add BULK_FILE IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T059 [US5] Add BULK_DELETE IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T060 [US5] Add bulk methods to src/renderer/src/services/inbox-service.ts
- [x] T061 [US5] Connect BulkActionBar to real API in src/renderer/src/components/bulk/bulk-action-bar.tsx
- [x] T062 [US5] Connect BulkFilePanel to real API in src/renderer/src/components/bulk/bulk-file-panel.tsx
- [x] T063 [US5] Update handleBulkFileComplete with real IPC in src/renderer/src/pages/inbox.tsx
- [x] T064 [US5] Update handleBulkDeleteConfirm with real IPC in src/renderer/src/pages/inbox.tsx

**Checkpoint**: Bulk operations are fully functional - MVP COMPLETE

---

## Phase 8: User Story 6 - Image Capture (Priority: P2)

**Goal**: Capture images via drag-drop and clipboard with thumbnail generation

**Independent Test**: Drag image onto inbox, verify thumbnail appears and file is stored

### Implementation for User Story 6

- [x] T065 [P] [US6] Implement captureImage handler in src/main/ipc/inbox-handlers.ts (inline, not capture.ts)
- [x] T066 [P] [US6] Add thumbnail generation with sharp in src/main/ipc/inbox-handlers.ts
- [x] T067 [US6] Add CAPTURE_IMAGE IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T068 [US6] Store image file in vault/attachments/inbox/{itemId}/ directory
- [x] T069 [US6] Extract image metadata (dimensions, format) using sharp
- [x] T070 [US6] Add captureImage method to src/renderer/src/services/inbox-service.ts (already existed)
- [x] T071 [US6] Add drag-drop handler to InboxPage in src/renderer/src/pages/inbox.tsx
- [x] T072 [US6] Add clipboard paste handler (Cmd+V) for images in src/renderer/src/pages/inbox.tsx
- [x] T073 [US6] Display image thumbnail in inbox list item component (card-view.tsx and list-view.tsx)

**Checkpoint**: Image capture with thumbnails is fully functional

---

## Phase 9: User Story 7 - Voice Memo Capture with Transcription (Priority: P2)

**Goal**: Record voice memos with automatic transcription via Whisper API

**Independent Test**: Click record, speak, stop, verify audio saved and transcription appears

### Implementation for User Story 7

- [x] T074 [P] [US7] Create src/main/inbox/transcription.ts with Whisper API integration
- [x] T075 [P] [US7] Implement captureVoice handler in src/main/inbox/capture.ts
- [x] T076 [US7] Add CAPTURE_VOICE IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T077 [US7] Store audio file in vault/attachments/inbox/{itemId}/ directory
- [x] T078 [US7] Implement async transcription with status updates in src/main/inbox/transcription.ts
- [x] T079 [US7] Add RETRY_TRANSCRIPTION IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T080 [US7] Emit TRANSCRIPTION_COMPLETE event when done in src/main/inbox/transcription.ts
- [x] T081 [US7] Add captureVoice method to src/renderer/src/services/inbox-service.ts
- [x] T082 [US7] Create voice recording component in src/renderer/src/components/voice-recorder.tsx
- [x] T083 [US7] Add recording controls to capture area in src/renderer/src/pages/inbox.tsx
- [x] T084 [US7] Display transcription status (pending/processing/complete/failed) in list item
- [x] T085 [US7] Add retry transcription button for failed items

**Checkpoint**: Voice capture with transcription is fully functional

---

## Phase 10: User Story 8 - Stale Item Highlighting (Priority: P2)

**Goal**: Highlight items older than 7 days, allow configurable threshold

**Independent Test**: Create items with backdated timestamps, verify stale indicator displays

### Implementation for User Story 8

- [x] T086 [P] [US8] Add isStale computed field to list query in src/main/ipc/inbox-handlers.ts
- [x] T087 [P] [US8] Create src/main/inbox/stats.ts with stale detection logic
- [x] T088 [US8] Add GET_STALE_THRESHOLD IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T089 [US8] Add SET_STALE_THRESHOLD IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T090 [US8] Implement FILE_ALL_STALE IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T091 [US8] Add stale threshold methods to src/renderer/src/services/inbox-service.ts
- [x] T092 [US8] Update stale styling in list/card view components (already exists, verify works)
- [x] T093 [US8] Connect "File all stale" button to real API in src/renderer/src/pages/inbox.tsx

**Checkpoint**: Stale item highlighting is fully functional

---

## Phase 11: User Story 9 - Global Capture Shortcut (Priority: P2)

**Goal**: Cmd+Shift+Space opens quick capture window from anywhere

**Independent Test**: Press shortcut while other app focused, enter content, verify item in inbox

### Implementation for User Story 9

- [x] T094 [P] [US9] Register global shortcut (Cmd+Shift+Space) in src/main/index.ts
- [x] T095 [US9] Create quick capture window in src/main/index.ts
- [x] T096 [US9] Create quick capture mini window component in src/renderer/src/components/quick-capture.tsx
- [x] T097 [US9] Auto-detect clipboard URL content in quick capture window
- [x] T098 [US9] Handle Escape to close and Enter to submit in quick capture
- [x] T099 [US9] Send capture request from quick capture window to main process

**Checkpoint**: Global capture shortcut is fully functional

---

## Phase 12: User Story 10 - Item Preview (Priority: P2)

**Goal**: Preview panel shows full content for links, notes, images, voice

**Independent Test**: Click each item type, verify appropriate preview content displays

### Implementation for User Story 10

- [x] T100 [P] [US10] Add full content field to GET response in src/main/ipc/inbox-handlers.ts
- [x] T101 [US10] Fetch full metadata for preview in src/renderer/src/hooks/use-inbox.ts
- [x] T102 [US10] Connect PreviewPanel to real item data in src/renderer/src/components/preview/preview-panel.tsx
- [x] T103 [US10] Render link content in reader-friendly format in preview
- [x] T104 [US10] Display full-size image in preview
- [x] T105 [US10] Add audio player for voice items in preview

**Checkpoint**: Item preview is fully functional

---

## Phase 13: User Story 11 - Tag Items Before Filing (Priority: P3)

**Goal**: Add tags to inbox items with autocomplete

**Independent Test**: Add tags to item, file item, verify tags preserved on filed item

### Implementation for User Story 11

- [x] T106 [P] [US11] Implement addTag function in src/main/inbox/capture.ts (Note: implemented in inbox-handlers.ts:575-612)
- [x] T107 [P] [US11] Implement removeTag function in src/main/inbox/capture.ts (Note: implemented in inbox-handlers.ts:617-632)
- [x] T108 [US11] Add ADD_TAG IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T109 [US11] Add REMOVE_TAG IPC handler in src/main/ipc/inbox-handlers.ts
- [x] T110 [US11] Add GET_TAGS IPC handler (for autocomplete) in src/main/ipc/inbox-handlers.ts
- [x] T111 [US11] Add tag methods to src/renderer/src/services/inbox-service.ts
- [x] T112 [US11] Create tag input component with autocomplete in src/renderer/src/components/tag-input.tsx (Note: TagAutocomplete in filing/tag-autocomplete.tsx)
- [x] T113 [US11] Add tag editing to item detail/preview
- [x] T114 [US11] Preserve tags when filing items in src/main/inbox/filing.ts

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

- [x] T131 [P] [US14] Create src/main/inbox/social.ts with social platform detection
- [x] T132 [US14] Implement Twitter/X extraction using oEmbed in src/main/inbox/social.ts
- [x] T133 [US14] Add platform-specific metadata extraction for supported platforms
- [x] T134 [US14] Integrate social detection into link capture flow in src/main/inbox/capture.ts
- [x] T135 [US14] Create social post display component in src/renderer/src/components/social-card.tsx
- [x] T136 [US14] Display author avatar, handle, and formatted text in social card
- [x] T137 [US14] Handle graceful fallback when social extraction fails

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

**Goal**: Snooze inbox items to resurface at specified time

**Independent Test**: Snooze item, verify hidden, wait for time, verify reappears

**Key Concept**: Snooze is for inbox items only — it hides the item temporarily and resurfaces it later. This is different from reminders (Phase 23) which notify about passive content like notes.

### Implementation for User Story 16

#### Backend - Snooze Service

- [ ] T147 [P] [US16] Create src/main/inbox/snooze.ts with snooze service class
- [ ] T148 [US16] Implement snoozeItem function in src/main/inbox/snooze.ts
  - Updates `snoozed_until` and `snooze_reason` columns
  - Validates snooze time is in the future
  - Supports preset durations: laterToday, tomorrow, nextWeek, custom
- [ ] T149 [US16] Implement unsnoozeItem function in src/main/inbox/snooze.ts
  - Clears `snoozed_until` and `snooze_reason`
  - Item immediately returns to inbox view
- [ ] T150 [US16] Implement getSnoozedItems function in src/main/inbox/snooze.ts
  - Returns all items where `snoozed_until` is set and in the future
  - Ordered by snooze due time ascending
- [ ] T151 [US16] Implement getDueSnoozeItems function in src/main/inbox/snooze.ts
  - Returns items where `snoozed_until <= now`
  - Used by the periodic check to surface due items

#### Backend - Snooze Scheduler

- [ ] T152 [US16] Add snooze due check on app startup in src/main/inbox/snooze.ts
  - Process any items that became due while app was closed
  - Clear their snooze status so they appear in inbox
- [ ] T153 [US16] Create snooze scheduler in src/main/inbox/snooze.ts
  - Checks for due items every 1 minute
  - Emits event when items become due
- [ ] T154 [US16] Register snooze scheduler in src/main/index.ts
  - Start scheduler on app ready
  - Stop scheduler on app quit

#### Backend - IPC Handlers

- [ ] T155 [US16] Add SNOOZE IPC handler in src/main/ipc/inbox-handlers.ts
  - Input: itemId, snoozeUntil (ISO string), reason (optional)
  - Returns: updated inbox item
- [ ] T156 [US16] Add UNSNOOZE IPC handler in src/main/ipc/inbox-handlers.ts
  - Input: itemId
  - Returns: updated inbox item
- [ ] T157 [US16] Add GET_SNOOZED IPC handler in src/main/ipc/inbox-handlers.ts
  - Input: none
  - Returns: array of snoozed items with their due times
- [ ] T158 [US16] Emit SNOOZE_DUE event when snoozed items become due
  - Includes item count and item details
  - Triggers notification in renderer

#### Frontend - Service Layer

- [ ] T159 [US16] Add snooze methods to src/renderer/src/services/inbox-service.ts
  - snoozeItem(itemId, snoozeUntil, reason?)
  - unsnoozeItem(itemId)
  - getSnoozedItems()
- [ ] T160 [US16] Add snooze event listener in src/renderer/src/services/inbox-service.ts
  - Listen for SNOOZE_DUE events
  - Refresh inbox list when items become due

#### Frontend - Snooze Picker Component

- [ ] T161 [US16] Create src/renderer/src/components/snooze/snooze-picker.tsx
  - Dropdown with preset options:
    - Later Today (3 hours from now or 6pm, whichever is later)
    - Tomorrow (9am)
    - Next Week (Monday 9am)
    - Pick Date & Time (custom datetime picker)
  - Shows selected snooze time preview before confirming
- [ ] T162 [US16] Create src/renderer/src/components/snooze/snooze-presets.ts
  - Helper functions for calculating preset snooze times
  - laterToday(), tomorrow(), nextWeek(), thisWeekend()
- [ ] T163 [US16] Style snooze picker to match existing UI components

#### Frontend - Integration

- [ ] T164 [US16] Add snooze button to item actions in card-view.tsx and list-view.tsx
  - Clock/bell icon
  - Opens snooze picker on click
- [ ] T165 [US16] Add "Snoozed" filter option to inbox filter dropdown
  - Shows only snoozed items when selected
  - Each item shows when it will resurface
- [ ] T166 [US16] Add snooze badge to snoozed items in list
  - Shows "Snoozed until [date]" or "Returns in 2 days"
- [ ] T167 [US16] Update useInbox hook to exclude snoozed items from main view by default
- [ ] T168 [US16] Add desktop notification when snoozed items become due
  - "X items have returned to your inbox"
  - Clicking notification opens inbox

#### Frontend - Bulk Snooze

- [ ] T169 [US16] Add bulk snooze option to BulkActionBar
  - Opens snooze picker for multiple items
  - All selected items get same snooze time

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

## Phase 23: Reminder System for Notes, Journal & Highlights (Priority: P2)

**Goal**: Allow users to set reminders on notes, journal entries, and highlighted text to be notified at a future time

**Independent Test**: Set reminder on note, wait for time, verify notification appears with link to content

**Key Concept**: Reminders are for proactive "revisit this later" on passive content (notes, journal). This is different from snooze (Phase 18) which hides and resurfaces inbox items.

### User Stories for Reminders

**US-R1**: As a user, I want to set a reminder on a note so I can be notified to revisit it later
**US-R2**: As a user, I want to set a reminder on a journal entry so I can reflect on it at a future date
**US-R3**: As a user, I want to highlight text and set a reminder on that highlight so I can be reminded of specific passages
**US-R4**: As a user, I want to see all my upcoming reminders in one place so I can manage them

### Data Model

#### reminders Table (New)

- [X] T191 [P] [US-R1] Create src/shared/db/schema/reminders.ts with reminders table:

  ```typescript
  reminders = sqliteTable('reminders', {
    id: text('id').primaryKey(),
    targetType: text('target_type').notNull(), // 'note' | 'journal' | 'highlight'
    targetId: text('target_id').notNull(), // noteId, journalEntryId, or highlightId

    // Reminder timing
    remindAt: text('remind_at').notNull(), // ISO datetime

    // Optional context for highlights
    highlightText: text('highlight_text'), // The highlighted text (for display)
    highlightStart: integer('highlight_start'), // Character offset start
    highlightEnd: integer('highlight_end'), // Character offset end

    // Reminder metadata
    title: text('title'), // Custom reminder title (optional)
    note: text('note'), // User note about why they set reminder

    // Status tracking
    status: text('status').default('pending'), // 'pending' | 'triggered' | 'dismissed' | 'snoozed'
    triggeredAt: text('triggered_at'), // When reminder was shown
    dismissedAt: text('dismissed_at'), // When user dismissed
    snoozedUntil: text('snoozed_until'), // If snoozed, when to remind again

    // Timestamps
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    modifiedAt: text('modified_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  })
  ```

- [X] T192 [US-R1] Add indexes for reminders table (target_id, remind_at, status)
- [X] T193 [US-R1] Run drizzle-kit generate to create migration

### Backend - Reminder Service

- [X] T194 [P] [US-R1] Create src/main/lib/reminders.ts with ReminderService class
- [X] T195 [US-R1] Implement createReminder function
  - Validates remind time is in the future
  - Supports note, journal, and highlight target types
  - For highlights: stores text and position offsets
- [X] T196 [US-R1] Implement updateReminder function
  - Change remind time or add/update note
- [X] T197 [US-R1] Implement deleteReminder function
- [X] T198 [US-R1] Implement getReminder function (single)
- [X] T199 [US-R1] Implement listReminders function
  - Filter by status, target type, date range
  - Sort by remind_at ascending
- [X] T200 [US-R4] Implement getUpcomingReminders function
  - Returns pending reminders ordered by remind time
  - Optionally limit to next N days
- [X] T201 [US-R1] Implement getDueReminders function
  - Returns reminders where remind_at <= now and status = 'pending'
- [X] T202 [US-R1] Implement dismissReminder function
  - Sets status to 'dismissed' with timestamp
- [X] T203 [US-R1] Implement snoozeReminder function
  - Sets snoozed_until and keeps status as 'pending'

### Backend - Reminder Scheduler

- [X] T204 [US-R1] Create reminder scheduler in src/main/lib/reminders.ts
  - Checks for due reminders every 1 minute
  - Emits REMINDER_DUE event with reminder details
- [X] T205 [US-R1] Add reminder check on app startup
  - Process any reminders that became due while app was closed
- [X] T206 [US-R1] Register reminder scheduler in src/main/index.ts
  - Start on app ready, stop on app quit

### Backend - IPC Handlers

- [X] T207 [P] [US-R1] Add ReminderChannels to src/shared/ipc-channels.ts
  ```typescript
  ReminderChannels = {
    CREATE: 'reminder:create',
    UPDATE: 'reminder:update',
    DELETE: 'reminder:delete',
    GET: 'reminder:get',
    LIST: 'reminder:list',
    GET_UPCOMING: 'reminder:get-upcoming',
    DISMISS: 'reminder:dismiss',
    SNOOZE: 'reminder:snooze',
    DUE: 'reminder:due' // Event channel
  }
  ```
- [X] T208 [US-R1] Create src/main/ipc/reminder-handlers.ts with all handlers
- [X] T209 [US-R1] Register reminder IPC handlers in src/main/ipc/index.ts
- [X] T210 [US-R1] Add reminder API to preload in src/preload/index.ts

### Frontend - Service Layer

- [X] T211 [US-R1] Create src/renderer/src/services/reminder-service.ts
  - createReminder(targetType, targetId, remindAt, options?)
  - updateReminder(id, updates)
  - deleteReminder(id)
  - getReminder(id)
  - listReminders(filters?)
  - getUpcomingReminders(days?)
  - dismissReminder(id)
  - snoozeReminder(id, snoozeUntil)
- [X] T212 [US-R1] Add reminder event listener for REMINDER_DUE events

### Frontend - Reminder Picker Component

- [X] T213 [US-R1] Create src/renderer/src/components/reminder/reminder-picker.tsx
  - Similar to snooze picker with presets:
    - Tomorrow (9am)
    - Next Week (Monday 9am)
    - In 1 Month
    - Pick Date & Time
  - Optional note field for context
- [X] T214 [US-R1] Create src/renderer/src/components/reminder/reminder-presets.ts
  - Helper functions for common reminder times
- [X] T215 [US-R1] Style reminder picker to match existing UI

### Frontend - Note Reminders Integration

- [X] T216 [US-R1] Add "Set Reminder" button to note header/actions in NotePage
  - Bell icon that opens reminder picker
- [X] T217 [US-R1] Show reminder indicator on notes that have active reminders
  - Small bell badge with tooltip showing when
- [X] T218 [US-R1] Add reminder context menu option on right-click in note
- [X] T219 [US-R1] Create src/renderer/src/hooks/use-note-reminders.ts
  - Fetch reminders for current note
  - Create/update/delete reminders

### Frontend - Highlight Reminders Integration

- [ ] T220 [P] [US-R3] Create src/renderer/src/components/reminder/highlight-reminder-popover.tsx
  - Appears when user selects text and clicks "Remind me"
  - Shows selected text preview
  - Contains reminder picker
- [ ] T221 [US-R3] Add "Set Reminder" option to text selection context menu in editor
  - Only appears when text is selected
  - Captures selection text and position
- [ ] T222 [US-R3] Implement highlight position tracking
  - Store character offsets for highlight
  - Handle position updates when note content changes (best effort)
- [ ] T223 [US-R3] Display highlight indicators in note for text with reminders
  - Subtle underline or background color
  - Tooltip showing reminder details
- [ ] T224 [US-R3] When reminder triggers for highlight, scroll to and highlight the text

### Frontend - Journal Reminders Integration

- [X] T225 [US-R2] Add "Set Reminder" button to journal entry actions
  - "Reflect on this in X days" preset options:
    - In 1 week
    - In 1 month
    - In 3 months
    - In 1 year (anniversary)
- [X] T226 [US-R2] Show reminder indicator on journal entries with active reminders
- [X] T227 [US-R2] Create src/renderer/src/hooks/use-journal-reminders.ts

### Frontend - Reminders List View

- [ ] T228 [US-R4] Create src/renderer/src/components/reminder/reminders-list.tsx
  - Shows all upcoming reminders grouped by:
    - Today
    - Tomorrow
    - This Week
    - Later
  - Each item shows: target title, reminder time, optional note
  - Actions: Edit, Snooze, Dismiss, Go to target
- [ ] T229 [US-R4] Add reminders list to sidebar or as modal/panel
  - Access via bell icon in header
- [ ] T230 [US-R4] Show reminder count badge on bell icon when reminders exist

### Frontend - Notifications

- [ ] T231 [US-R1] Create desktop notification when reminder is due
  - Title: "Reminder: [target title]"
  - Body: highlight text or custom note
  - Click action: Open target in app
- [ ] T232 [US-R1] Create in-app notification toast for due reminders
  - Shows briefly, click to navigate
- [ ] T233 [US-R1] Add snooze options to notification
  - "Snooze 1 hour", "Snooze until tomorrow"

### Edge Cases & Polish

- [ ] T234 [US-R3] Handle highlight reminder when note content changes significantly
  - Try to find closest matching text
  - If not found, show warning but still trigger reminder
- [ ] T235 [US-R1] Handle reminder for deleted note/journal
  - Show reminder with "Content no longer exists" message
  - Allow dismissing
- [ ] T236 [US-R1] Add bulk dismiss option for past-due reminders
- [ ] T237 [US-R1] Add recurring reminder option (daily, weekly, monthly) - Future enhancement marker

**Checkpoint**: Reminder system for notes, journal, and highlights is fully functional

---

## Phase 22: Mixed-Content Folders Enhancement (Future)

**Purpose**: Support storing non-markdown files (PDF, images, audio) directly in note folders

**Background**: Currently, attachments are stored in `attachments/inbox/{itemId}/` and linked in notes.
This enhancement would allow files to be stored alongside .md files in the same folder structure.

- [ ] T185 [P] Design folder structure for mixed content (md, pdf, images, audio coexisting)
- [ ] T186 Update folder view components to display non-markdown files
- [ ] T187 Add option in filing to "Move file to folder" instead of "Create note with link"
- [ ] T188 Update attachment path resolution for items stored in note folders
- [ ] T189 Implement file rename/move for non-markdown assets in folders
- [ ] T190 Add thumbnail generation for files displayed in folder view

**Checkpoint**: Files can be stored directly in note folders without wrapper notes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup - BLOCKS all user stories
- **User Stories (Phases 3-20)**: All depend on Foundational phase completion
  - User stories can proceed in priority order (P1 first, then P2, then P3)
  - Or in parallel if team capacity allows
- **Polish (Phase 21)**: Depends on all desired user stories being complete
- **Phase 23 (Reminders)**: Depends on:
  - Notes system (003-notes) for note reminders
  - Journal system (004-journal) for journal reminders
  - Can be implemented independently of inbox (Phase 18 Snooze)

### User Story Dependencies

All user stories depend only on Foundational phase. Stories are designed to be independently testable:

- **US1 (Link Capture)**: Foundation only
- **US2 (Text Capture)**: Foundation only
- **US3 (Filing)**: Requires US1 or US2 (needs items to file)
- **US4 (Delete)**: Requires US1 or US2 (needs items to delete)
- **US5 (Bulk)**: Requires US1 or US2 (needs items for bulk ops)
- **US6-US18**: Foundation only (can run in parallel with US1-US5)

### Snooze vs Reminder Dependencies

These are independent features:

- **Phase 18 (Snooze)**: Inbox-only feature, no external dependencies
- **Phase 23 (Reminders)**: Cross-feature, depends on notes/journal existing
  - **US-R1 (Note Reminders)**: Requires notes system (003)
  - **US-R2 (Journal Reminders)**: Requires journal system (004)
  - **US-R3 (Highlight Reminders)**: Requires notes editor with selection support

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
| US11-US15  | P2 Advanced  | High       | 4 days   |
| US16       | P2 Snooze    | Medium     | 2 days   |
| US17-US18  | P3 Analytics | Medium     | 2 days   |
| Phase 23   | P2 Reminders | High       | 4 days   |
| Polish     | -            | Low        | 1 day    |

**Total: ~22.5 days (4.5 weeks)**

### Snooze vs Reminders Breakdown

| Feature     | Scope               | Complexity | Estimate |
| ----------- | ------------------- | ---------- | -------- |
| US16 Snooze | Inbox items only    | Medium     | 2 days   |
| US-R1       | Note reminders      | Medium     | 1 day    |
| US-R2       | Journal reminders   | Low        | 0.5 day  |
| US-R3       | Highlight reminders | High       | 1.5 days |
| US-R4       | Reminders list view | Medium     | 1 day    |

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Existing UI components exist in src/renderer/src/components/ - connect to real API
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
