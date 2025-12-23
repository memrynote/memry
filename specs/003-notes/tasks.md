# Tasks: Notes System

**Input**: Design documents from `/specs/003-notes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested - test tasks are omitted. Implementation focuses on feature delivery.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Main process**: `src/main/`
- **Renderer process**: `src/renderer/src/`
- **Shared**: `src/shared/`
- **Preload**: `src/preload/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and dependency installation

- [ ] T001 Install Tiptap extensions per research.md in package.json
- [ ] T002 [P] Verify better-sqlite3 native module compatibility with `pnpm rebuild`
- [ ] T003 [P] Update TypeScript config for new contracts in tsconfig.json

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**CRITICAL**: No user story work can begin until this phase is complete

### Database Schema & Migrations

- [ ] T004 Add `emoji` column to noteCache table in src/shared/db/schema/notes-cache.ts
- [ ] T005 Create noteProperties table (rebuildable cache from frontmatter) in src/shared/db/schema/notes-cache.ts
- [ ] T006 Create propertyDefinitions table (vault-wide schema, source of truth) in src/shared/db/schema/notes-cache.ts
- [ ] T007 Generate and apply database migrations with `pnpm db:generate && pnpm db:push`

### Properties Sync Layer (Required for External Edit Support)

> **Design Doc**: See `specs/003-notes/properties-design.md` for full architecture.
> **Pattern**: Follows existing tag sync pattern - frontmatter = source of truth, DB = cache.

- [ ] T007a Add extractProperties() function in src/main/vault/frontmatter.ts
- [ ] T007b Add inferPropertyType() utility (type inference for external edits) in src/main/vault/frontmatter.ts
- [ ] T007c Add setNoteProperties() query function (sync from frontmatter) in src/shared/db/queries/notes.ts
- [ ] T007d Add getNoteProperties() query function in src/shared/db/queries/notes.ts
- [ ] T007e Add property definition CRUD functions in src/shared/db/queries/notes.ts
- [ ] T007f Extend handleFileChange() to sync properties in src/main/vault/watcher.ts
- [ ] T007g Extend updateNote() to save properties to frontmatter in src/main/vault/notes.ts
- [ ] T007h Extend createNote() to support initial properties in src/main/vault/notes.ts

### Contracts & Types

- [ ] T008 [P] Copy contracts from specs/003-notes/contracts/notes-api.ts to src/shared/contracts/notes-api.ts
- [ ] T009 [P] Add IPC channel constants to src/shared/ipc-channels.ts from contracts

### Core Service Layer

- [ ] T010 Extend notes.ts with emoji and properties support in src/main/vault/notes.ts
- [ ] T011 Add note property query functions in src/shared/db/queries/notes.ts
- [ ] T012 Create markdown↔Tiptap conversion utilities in src/renderer/src/lib/markdown-convert.ts

### IPC Infrastructure

- [ ] T013 Add new IPC handlers for properties in src/main/ipc/notes-handlers.ts
- [ ] T014 Expose properties API in src/preload/index.ts
- [ ] T015 Update type declarations in src/preload/index.d.ts

### Renderer Services

- [ ] T016 Extend notes-service.ts with properties methods in src/renderer/src/services/notes-service.ts

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Rich Text Note Editing (Priority: P1) 🎯 MVP

**Goal**: Users can create and edit notes with rich text formatting (headings, bold, italic, lists, code blocks)

**Independent Test**: Create a new note, add various formatting (headings, bold text, bulleted lists, code blocks), and verify the formatting renders correctly in the editor and persists after reload.

### Implementation for User Story 1

- [ ] T017 [P] [US1] Create NoteEditor component with Tiptap in src/renderer/src/components/note/note-editor.tsx
- [ ] T018 [P] [US1] Create NoteHeader component for title/emoji display in src/renderer/src/components/note/note-header.tsx
- [ ] T019 [US1] Configure Tiptap StarterKit extension with headings H1-H6 in src/renderer/src/components/note/note-editor.tsx
- [ ] T020 [US1] Add CodeBlockLowlight extension for syntax highlighting in src/renderer/src/components/note/note-editor.tsx
- [ ] T021 [US1] Create editor toolbar component with formatting buttons in src/renderer/src/components/note/editor-toolbar.tsx
- [ ] T022 [US1] Implement keyboard shortcuts for formatting (Cmd+B, Cmd+I, etc.) in src/renderer/src/components/note/note-editor.tsx
- [ ] T023 [US1] Create use-note-editor hook for editor state in src/renderer/src/hooks/use-note-editor.ts
- [ ] T024 [US1] Integrate NoteEditor into NotePage in src/renderer/src/pages/note.tsx
- [ ] T025 [US1] Style editor with Tailwind for consistent typography in src/renderer/src/components/note/note-editor.tsx

**Checkpoint**: User Story 1 complete - rich text editing functional with all formatting options

---

## Phase 4: User Story 2 - Auto-Save (Priority: P1)

**Goal**: Notes save automatically 1 second after user stops typing with save status indicator

**Independent Test**: Create a note, type content, wait for save indicator to show "Saved", close and reopen the note to verify content persists.

### Implementation for User Story 2

- [ ] T026 [P] [US2] Install use-debounce package if not present via `pnpm add use-debounce`
- [ ] T027 [US2] Implement debounced auto-save in use-note-editor hook in src/renderer/src/hooks/use-note-editor.ts
- [ ] T028 [US2] Create SaveStatus component (Saving.../Saved/Error) in src/renderer/src/components/note/save-status.tsx
- [ ] T029 [US2] Add save queue for handling rapid edits in src/renderer/src/hooks/use-note-editor.ts
- [ ] T030 [US2] Handle save errors with toast notification in src/renderer/src/hooks/use-note-editor.ts
- [ ] T031 [US2] Integrate SaveStatus into NoteHeader in src/renderer/src/components/note/note-header.tsx

**Checkpoint**: User Story 2 complete - auto-save works reliably with status feedback

---

## Phase 5: User Story 3 - Tags (Priority: P1)

**Goal**: Users can add/remove tags with autocomplete and filter notes by tag

**Independent Test**: Add tags to a note, verify they appear in the UI and persist, then filter the notes list by a tag.

### Implementation for User Story 3

- [ ] T032 [P] [US3] Create TagInput component with autocomplete in src/renderer/src/components/note/tag-input.tsx
- [ ] T033 [P] [US3] Create TagBadge component for displaying tags in src/renderer/src/components/note/tag-badge.tsx
- [ ] T034 [US3] Implement tag autocomplete suggestions from existing tags in src/renderer/src/components/note/tag-input.tsx
- [ ] T035 [US3] Add tag normalization (lowercase) in tag-input component in src/renderer/src/components/note/tag-input.tsx
- [ ] T036 [US3] Create NoteProperties panel that includes tags in src/renderer/src/components/note/note-properties.tsx
- [ ] T037 [US3] Add getTags IPC handler for autocomplete in src/main/ipc/notes-handlers.ts
- [ ] T038 [US3] Integrate TagInput into NotePage in src/renderer/src/pages/note.tsx
- [ ] T039 [US3] Add tag filter functionality to notes list in src/renderer/src/hooks/use-notes.ts

**Checkpoint**: User Story 3 complete - tags work with autocomplete and filtering

---

## Phase 6: User Story 4 - Wiki-Style Linking (Priority: P1)

**Goal**: Users can create [[wiki-style links]] that navigate to other notes

**Independent Test**: Type [[, select a note from autocomplete, click the link to navigate, verify linked note opens in new tab.

### Implementation for User Story 4

- [ ] T040 [P] [US4] Enhance WikiLink Tiptap extension in src/renderer/src/components/journal/extensions/wiki-link/
- [ ] T041 [US4] Create WikiLinkAutocomplete popover component in src/renderer/src/components/note/wiki-link-autocomplete.tsx
- [ ] T042 [US4] Implement note title search for autocomplete in src/renderer/src/services/notes-service.ts
- [ ] T043 [US4] Add aliased link support [[Title|display text]] in wiki-link extension
- [ ] T044 [US4] Implement link click handler to open note in new tab in src/renderer/src/components/note/note-editor.tsx
- [ ] T045 [US4] Add "create new note" option for non-existent links in src/renderer/src/components/note/wiki-link-autocomplete.tsx
- [ ] T046 [US4] Store outgoing links on note save in src/main/vault/notes.ts
- [ ] T047 [US4] Style wiki links with distinctive appearance in src/renderer/src/components/journal/extensions/wiki-link/

**Checkpoint**: User Story 4 complete - wiki links work with autocomplete and navigation

---

## Phase 7: User Story 5 - Backlinks (Priority: P1)

**Goal**: Users can see what other notes link to the current note (backlinks panel)

**Independent Test**: Create Note A that links to Note B, open Note B, verify Note A appears in backlinks section with context snippet.

### Implementation for User Story 5

- [ ] T048 [P] [US5] Create NoteBacklinks panel component in src/renderer/src/components/note/note-backlinks.tsx
- [ ] T049 [US5] Add getLinks IPC handler for incoming/outgoing links in src/main/ipc/notes-handlers.ts
- [ ] T050 [US5] Implement backlink context snippet extraction in src/shared/db/queries/notes.ts
- [ ] T051 [US5] Add clickable backlink entries that open source note in src/renderer/src/components/note/note-backlinks.tsx
- [ ] T052 [US5] Implement backlink auto-refresh when linked notes change in src/renderer/src/hooks/use-note-editor.ts
- [ ] T053 [US5] Add progressive loading for notes with many backlinks in src/renderer/src/components/note/note-backlinks.tsx
- [ ] T054 [US5] Integrate NoteBacklinks panel into NotePage in src/renderer/src/pages/note.tsx

**Checkpoint**: User Story 5 complete - backlinks display with context and navigation. **P1 MVP COMPLETE**

---

## Phase 8: User Story 6 - Custom Properties (Priority: P2)

**Goal**: Users can add typed properties (text, number, date, checkbox, select, rating) to notes

**Independent Test**: Add a property (e.g., "Status: Draft"), change its value, verify it persists and displays correctly after reload.

### Implementation for User Story 6

- [ ] T055 [P] [US6] Create PropertyInput component for each property type in src/renderer/src/components/note/property-input.tsx
- [ ] T056 [P] [US6] Create PropertyRow component for property name + value in src/renderer/src/components/note/property-row.tsx
- [ ] T057 [US6] Implement date picker for date properties in src/renderer/src/components/note/property-input.tsx
- [ ] T058 [US6] Implement star rating component for rating properties in src/renderer/src/components/note/property-input.tsx
- [ ] T059 [US6] Implement select/multiselect dropdowns in src/renderer/src/components/note/property-input.tsx
- [ ] T060 [US6] Create AddProperty dialog for new property creation in src/renderer/src/components/note/add-property-dialog.tsx
- [ ] T061 [US6] Add setProperties IPC handler in src/main/ipc/notes-handlers.ts
- [ ] T062 [US6] Extend NoteProperties panel to display custom properties in src/renderer/src/components/note/note-properties.tsx
- [ ] T063 [US6] Persist property definitions for reuse in src/main/ipc/notes-handlers.ts

**Checkpoint**: User Story 6 complete - custom properties work with all supported types

---

## Phase 9: User Story 7 - Emoji Icons (Priority: P2)

**Goal**: Users can assign emoji icons to notes for visual identification

**Independent Test**: Click emoji placeholder, select emoji, verify it appears on note header and in notes list.

### Implementation for User Story 7

- [ ] T064 [P] [US7] Install emoji-mart packages via `pnpm add @emoji-mart/react @emoji-mart/data`
- [ ] T065 [US7] Create EmojiPicker component in src/renderer/src/components/note/emoji-picker.tsx
- [ ] T066 [US7] Add emoji click handler to NoteHeader in src/renderer/src/components/note/note-header.tsx
- [ ] T067 [US7] Display emoji in notes list items in src/renderer/src/components/notes-tree.tsx
- [ ] T068 [US7] Persist emoji to frontmatter on selection in src/renderer/src/hooks/use-note-editor.ts

**Checkpoint**: User Story 7 complete - emoji icons work throughout the UI

---

## Phase 10: User Story 8 - Attachments (Priority: P2)

**Goal**: Users can drag-drop images/files into notes and view them inline

**Independent Test**: Drag an image into a note, verify it displays inline, confirm file exists in vault/attachments folder.

### Implementation for User Story 8

- [ ] T069 [P] [US8] Create attachment upload handler in src/main/vault/attachments.ts
- [ ] T070 [US8] Add drag-drop zone to editor in src/renderer/src/components/note/note-editor.tsx
- [ ] T071 [US8] Implement uploadAttachment IPC handler in src/main/ipc/notes-handlers.ts
- [ ] T072 [US8] Insert markdown image syntax after upload in src/renderer/src/components/note/note-editor.tsx
- [ ] T073 [US8] Add Tiptap Image extension for inline rendering in src/renderer/src/components/note/note-editor.tsx
- [ ] T074 [US8] Handle non-image files as download links in src/renderer/src/components/note/note-editor.tsx
- [ ] T075 [US8] Add file size validation (10MB limit) in src/main/vault/attachments.ts

**Checkpoint**: User Story 8 complete - attachments work with inline image display

---

## Phase 11: User Story 9 - Heading Outline (Priority: P2)

**Goal**: Users can see and navigate via a heading outline panel for long notes

**Independent Test**: Create note with multiple headings, open outline panel, click headings to navigate.

### Implementation for User Story 9

- [ ] T076 [P] [US9] Create NoteOutline panel component in src/renderer/src/components/note/note-outline.tsx
- [ ] T077 [US9] Extract headings from Tiptap editor state in src/renderer/src/components/note/note-outline.tsx
- [ ] T078 [US9] Implement scroll-to-heading on outline click in src/renderer/src/components/note/note-outline.tsx
- [ ] T079 [US9] Display hierarchical heading structure (H1 > H2 > H3) in src/renderer/src/components/note/note-outline.tsx
- [ ] T080 [US9] Integrate NoteOutline toggle into NotePage in src/renderer/src/pages/note.tsx

**Checkpoint**: User Story 9 complete - outline navigation works for long notes

---

## Phase 12: User Story 10 - Folder Organization (Priority: P2)

**Goal**: Users can organize notes in folders with drag-drop

**Independent Test**: Create a folder, move a note into it, verify folder appears in sidebar tree with note inside.

### Implementation for User Story 10

- [ ] T081 [P] [US10] Create FolderTree component for sidebar in src/renderer/src/components/folder-tree.tsx
- [ ] T082 [P] [US10] Add folder CRUD IPC handlers in src/main/ipc/notes-handlers.ts
- [ ] T083 [US10] Implement folder creation dialog in src/renderer/src/components/folder-tree.tsx
- [ ] T084 [US10] Add drag-drop note moving between folders in src/renderer/src/components/folder-tree.tsx
- [ ] T085 [US10] Implement folder rename functionality in src/renderer/src/components/folder-tree.tsx
- [ ] T086 [US10] Add folder delete (empty only) functionality in src/renderer/src/components/folder-tree.tsx
- [ ] T087 [US10] Replace/enhance notes-tree.tsx with FolderTree in sidebar

**Checkpoint**: User Story 10 complete - folder organization works with full CRUD

---

## Phase 13: User Story 11 - Recently Edited Notes (Priority: P3)

**Goal**: Users can see and access recently edited notes

**Independent Test**: Edit several notes, view recent notes list, verify order matches edit times.

### Implementation for User Story 11

- [ ] T088 [P] [US11] Create RecentNotes component in src/renderer/src/components/recent-notes.tsx
- [ ] T089 [US11] Add recent notes query (sort by modifiedAt DESC) in src/shared/db/queries/notes.ts
- [ ] T090 [US11] Integrate RecentNotes into sidebar or home view in src/renderer/src/pages/inbox.tsx

**Checkpoint**: User Story 11 complete - recent notes accessible

---

## Phase 14: User Story 12 - Note Templates (Priority: P3)

**Goal**: Users can create notes from templates

**Independent Test**: Create a template, create new note from template, verify structure is applied.

### Implementation for User Story 12

- [ ] T091 [P] [US12] Create template storage in vault/.memry/templates/ in src/main/vault/templates.ts
- [ ] T092 [US12] Create TemplateSelector dialog in src/renderer/src/components/note/template-selector.tsx
- [ ] T093 [US12] Add template CRUD IPC handlers in src/main/ipc/notes-handlers.ts
- [ ] T094 [US12] Integrate template selection into new note creation flow in src/renderer/src/pages/note.tsx

**Checkpoint**: User Story 12 complete - templates work for quick note creation

---

## Phase 15: User Story 13 - Export Notes (Priority: P3)

**Goal**: Users can export notes as PDF or HTML

**Independent Test**: Export formatted note to PDF, verify output renders correctly.

### Implementation for User Story 13

- [ ] T095 [P] [US13] Add PDF export using Electron print-to-PDF in src/main/ipc/notes-handlers.ts
- [ ] T096 [US13] Create ExportDialog with format selection in src/renderer/src/components/note/export-dialog.tsx
- [ ] T097 [US13] Add HTML export with embedded styles in src/main/ipc/notes-handlers.ts
- [ ] T098 [US13] Add export button to NotePage header in src/renderer/src/pages/note.tsx

**Checkpoint**: User Story 13 complete - export works for PDF and HTML

---

## Phase 16: User Story 14 - Version History (Priority: P3)

**Goal**: Users can view and restore previous versions of notes

**Independent Test**: Edit note multiple times, view version history, restore previous version.

### Implementation for User Story 14

- [ ] T099 [P] [US14] Create note snapshots table in src/shared/db/schema/notes-cache.ts
- [ ] T100 [US14] Save snapshots on significant edits in src/main/vault/notes.ts
- [ ] T101 [US14] Create VersionHistory panel in src/renderer/src/components/note/version-history.tsx
- [ ] T102 [US14] Add version preview and restore functionality in src/renderer/src/components/note/version-history.tsx
- [ ] T103 [US14] Add version history IPC handlers in src/main/ipc/notes-handlers.ts

**Checkpoint**: User Story 14 complete - version history with restore capability

---

## Phase 17: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T104 [P] Accessibility audit - add ARIA labels to all interactive elements
- [ ] T105 [P] Keyboard navigation for all panels and dialogs
- [ ] T106 Performance optimization - virtualize long notes list
- [ ] T107 [P] Error boundary for editor crashes
- [ ] T108 External edit conflict detection and resolution UI
- [ ] T109 Run quickstart.md validation scenarios
- [ ] T110 Update CLAUDE.md with notes system patterns

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-16)**: All depend on Foundational phase completion
  - User stories can proceed in parallel if staffed
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Phase 17)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (Rich Text)**: Can start after Foundational - No dependencies on other stories
- **US2 (Auto-Save)**: Depends on US1 (needs editor to save)
- **US3 (Tags)**: Can start after Foundational - Independent of US1/US2
- **US4 (Wiki Links)**: Can start after Foundational - Independent
- **US5 (Backlinks)**: Depends on US4 (needs wiki links to create backlinks)
- **US6 (Properties)**: Can start after Foundational - Independent
- **US7 (Emoji)**: Can start after Foundational - Independent
- **US8 (Attachments)**: Depends on US1 (needs editor for inline display)
- **US9 (Outline)**: Depends on US1 (needs headings from editor)
- **US10 (Folders)**: Can start after Foundational - Independent
- **US11 (Recent)**: Can start after Foundational - Independent
- **US12 (Templates)**: Can start after Foundational - Independent
- **US13 (Export)**: Depends on US1 (needs editor content)
- **US14 (Version History)**: Can start after Foundational - Independent

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel (within Phase 2)
- Independent user stories can start in parallel after Foundational:
  - **Parallel Group A**: US1, US3, US4, US6, US7, US10, US11, US12, US14
  - **After US1**: US2, US8, US9, US13
  - **After US4**: US5

---

## Parallel Example: Foundational Phase

```bash
# Launch all parallelizable foundational tasks together:
Task: "Copy contracts from specs/003-notes/contracts/notes-api.ts to src/shared/contracts/notes-api.ts"
Task: "Add IPC channel constants to src/shared/ipc-channels.ts from contracts"
```

## Parallel Example: User Story 1

```bash
# Launch parallelizable US1 tasks together:
Task: "Create NoteEditor component with Tiptap in src/renderer/src/components/note/note-editor.tsx"
Task: "Create NoteHeader component for title/emoji display in src/renderer/src/components/note/note-header.tsx"
```

---

## Implementation Strategy

### MVP First (User Stories 1-5)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 - Rich Text Editing
4. Complete Phase 4: User Story 2 - Auto-Save
5. Complete Phase 5: User Story 3 - Tags
6. Complete Phase 6: User Story 4 - Wiki Links
7. Complete Phase 7: User Story 5 - Backlinks
8. **STOP and VALIDATE**: Test all P1 stories independently
9. Deploy/demo if ready - **MVP COMPLETE**

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 (Rich Text) → Test → Core editing works
3. Add US2 (Auto-Save) → Test → Data safety ensured
4. Add US3 (Tags) → Test → Organization available
5. Add US4 (Wiki Links) → Test → Linking works
6. Add US5 (Backlinks) → Test → Knowledge graph complete (**MVP**)
7. Add P2 stories incrementally
8. Add P3 stories as time permits

### Parallel Team Strategy

With multiple developers after Foundational:

- **Developer A**: US1 → US2 → US8 → US9 → US13
- **Developer B**: US3 → US6 → US7
- **Developer C**: US4 → US5 → US10 → US11 → US12 → US14

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- ~90% of backend infrastructure already exists (see research.md)
- Focus is on UI integration and remaining IPC handlers

## Architecture Decisions

### Properties Storage (T005-T007h)

**Design Doc**: `specs/003-notes/properties-design.md`

| Component | Storage | Purpose |
|-----------|---------|---------|
| Property VALUES | Frontmatter (YAML) | Source of truth - portable, external-edit friendly |
| Property CACHE | `noteProperties` table | Fast queries, filtering, sorting (rebuildable) |
| Property SCHEMA | `propertyDefinitions` table | Vault-wide type definitions |

**External Edit Flow**:
1. User edits frontmatter in VS Code/Obsidian
2. chokidar detects file change
3. `handleFileChange()` parses frontmatter
4. `extractProperties()` extracts properties
5. `inferPropertyType()` determines/confirms types
6. `setNoteProperties()` syncs to DB cache
7. Event emitted with `source: 'external'`

**Type Inference**: When user adds property externally, type is inferred from value (boolean → checkbox, number → number, array → multiselect, ISO string → date, URL → url, else → text).
