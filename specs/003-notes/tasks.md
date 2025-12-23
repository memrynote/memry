# Tasks: Notes System

**Input**: Design documents from `/specs/003-notes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested - test tasks are omitted. Implementation focuses on feature delivery.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

**Editor**: BlockNote is already installed and used (`@blocknote/core`, `@blocknote/react`, `@blocknote/shadcn` v0.44.2). ContentArea component exists at `src/renderer/src/components/note/content-area/ContentArea.tsx`.

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

**Purpose**: Project initialization and dependency verification

**Note**: BlockNote is already installed. No additional editor dependencies needed.

- [ ] T001 [P] Verify better-sqlite3 native module compatibility with `pnpm rebuild`
- [ ] T002 [P] Update TypeScript config for new contracts in tsconfig.json

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**CRITICAL**: No user story work can begin until this phase is complete

### Database Schema & Migrations

- [ ] T003 Add `emoji` column to noteCache table in src/shared/db/schema/notes-cache.ts
- [ ] T004 Create noteProperties table (rebuildable cache from frontmatter) in src/shared/db/schema/notes-cache.ts
- [ ] T005 Create propertyDefinitions table (vault-wide schema, source of truth) in src/shared/db/schema/notes-cache.ts
- [ ] T006 Generate and apply database migrations with `pnpm db:generate && pnpm db:push`

### Properties Sync Layer (Required for External Edit Support)

> **Design Doc**: See `specs/003-notes/properties-design.md` for full architecture.
> **Pattern**: Follows existing tag sync pattern - frontmatter = source of truth, DB = cache.

- [ ] T006a Add extractProperties() function in src/main/vault/frontmatter.ts
- [ ] T006b Add inferPropertyType() utility (type inference for external edits) in src/main/vault/frontmatter.ts
- [ ] T006c Add setNoteProperties() query function (sync from frontmatter) in src/shared/db/queries/notes.ts
- [ ] T006d Add getNoteProperties() query function in src/shared/db/queries/notes.ts
- [ ] T006e Add property definition CRUD functions in src/shared/db/queries/notes.ts
- [ ] T006f Extend handleFileChange() to sync properties in src/main/vault/watcher.ts
- [ ] T006g Extend updateNote() to save properties to frontmatter in src/main/vault/notes.ts
- [ ] T006h Extend createNote() to support initial properties in src/main/vault/notes.ts

### Contracts & Types

- [ ] T007 [P] Copy contracts from specs/003-notes/contracts/notes-api.ts to src/shared/contracts/notes-api.ts
- [ ] T008 [P] Add IPC channel constants to src/shared/ipc-channels.ts from contracts

### Core Service Layer

- [ ] T009 Extend notes.ts with emoji and properties support in src/main/vault/notes.ts
- [ ] T010 Add note property query functions in src/shared/db/queries/notes.ts
- [ ] T011 Extend BlockNote markdown serialization for wiki-link syntax in src/renderer/src/components/note/content-area/

### IPC Infrastructure

- [ ] T012 Add new IPC handlers for properties in src/main/ipc/notes-handlers.ts
- [ ] T013 Expose properties API in src/preload/index.ts
- [ ] T014 Update type declarations in src/preload/index.d.ts

### Renderer Services

- [ ] T015 Extend notes-service.ts with properties methods in src/renderer/src/services/notes-service.ts

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Rich Text Note Editing (Priority: P1) MVP

**Goal**: Users can create and edit notes with rich text formatting (headings, bold, italic, lists, code blocks)

**Status**: ContentArea with BlockNote already exists. Tasks focus on enhancements and integration.

**Independent Test**: Create a new note, add various formatting (headings, bold text, bulleted lists, code blocks), and verify the formatting renders correctly in the editor and persists after reload.

### Implementation for User Story 1

- [ ] T016 [P] [US1] Create NoteHeader component for title/emoji display in src/renderer/src/components/note/note-header.tsx
- [ ] T017 [US1] Configure BlockNote editor with custom theme and placeholders in src/renderer/src/components/note/content-area/ContentArea.tsx
- [ ] T018 [US1] Add BlockNote dark mode support via theme prop in src/renderer/src/components/note/content-area/ContentArea.tsx
- [ ] T019 [US1] Create use-note-editor hook for editor state management in src/renderer/src/hooks/use-note-editor.ts
- [ ] T020 [US1] Verify NoteEditor integration in NotePage in src/renderer/src/pages/note.tsx
- [ ] T021 [US1] Style BlockNote with Tailwind CSS variables in src/renderer/src/assets/base.css

**Checkpoint**: User Story 1 complete - rich text editing functional with all formatting options

---

## Phase 4: User Story 2 - Auto-Save (Priority: P1)

**Goal**: Notes save automatically 1 second after user stops typing with save status indicator

**Status**: Basic debounced save (500ms) exists in note.tsx. Tasks focus on status UI and robustness.

**Independent Test**: Create a note, type content, wait for save indicator to show "Saved", close and reopen the note to verify content persists.

### Implementation for User Story 2

- [ ] T022 [P] [US2] Install use-debounce package if not present via `pnpm add use-debounce`
- [ ] T023 [US2] Enhance debounced auto-save in use-note-editor hook in src/renderer/src/hooks/use-note-editor.ts
- [ ] T024 [US2] Create SaveStatus component (Saving.../Saved/Error) in src/renderer/src/components/note/save-status.tsx
- [ ] T025 [US2] Add save queue for handling rapid edits in src/renderer/src/hooks/use-note-editor.ts
- [ ] T026 [US2] Handle save errors with toast notification in src/renderer/src/hooks/use-note-editor.ts
- [ ] T027 [US2] Integrate SaveStatus into NoteHeader in src/renderer/src/components/note/note-header.tsx

**Checkpoint**: User Story 2 complete - auto-save works reliably with status feedback

---

## Phase 5: User Story 3 - Tags (Priority: P1)

**Goal**: Users can add/remove tags with autocomplete and filter notes by tag

**Independent Test**: Add tags to a note, verify they appear in the UI and persist, then filter the notes list by a tag.

### Implementation for User Story 3

- [ ] T028 [P] [US3] Create TagInput component with autocomplete in src/renderer/src/components/note/tag-input.tsx
- [ ] T029 [P] [US3] Create TagBadge component for displaying tags in src/renderer/src/components/note/tag-badge.tsx
- [ ] T030 [US3] Implement tag autocomplete suggestions from existing tags in src/renderer/src/components/note/tag-input.tsx
- [ ] T031 [US3] Add tag normalization (lowercase) in tag-input component in src/renderer/src/components/note/tag-input.tsx
- [ ] T032 [US3] Create NoteProperties panel that includes tags in src/renderer/src/components/note/note-properties.tsx
- [ ] T033 [US3] Add getTags IPC handler for autocomplete in src/main/ipc/notes-handlers.ts
- [ ] T034 [US3] Integrate TagInput into NotePage in src/renderer/src/pages/note.tsx
- [ ] T035 [US3] Add tag filter functionality to notes list in src/renderer/src/hooks/use-notes.ts

**Checkpoint**: User Story 3 complete - tags work with autocomplete and filtering

---

## Phase 6: User Story 4 - Wiki-Style Linking (Priority: P1)

**Goal**: Users can create [[wiki-style links]] that navigate to other notes

**Approach**: Create custom BlockNote inline content for wiki-links using createInlineContentSpec

**Independent Test**: Type [[, select a note from autocomplete, click the link to navigate, verify linked note opens in new tab.

### Implementation for User Story 4

- [ ] T036 [P] [US4] Create WikiLink inline content spec for BlockNote in src/renderer/src/components/note/content-area/wiki-link-inline.ts
- [ ] T037 [US4] Create WikiLinkAutocomplete popover component in src/renderer/src/components/note/wiki-link-autocomplete.tsx
- [ ] T038 [US4] Integrate wiki-link inline content into BlockNote editor schema in src/renderer/src/components/note/content-area/ContentArea.tsx
- [ ] T039 [US4] Implement note title search for autocomplete in src/renderer/src/services/notes-service.ts
- [ ] T040 [US4] Add aliased link support [[Title|display text]] in wiki-link inline content
- [ ] T041 [US4] Implement link click handler to open note in new tab in src/renderer/src/components/note/content-area/ContentArea.tsx
- [ ] T042 [US4] Add "create new note" option for non-existent links in src/renderer/src/components/note/wiki-link-autocomplete.tsx
- [ ] T043 [US4] Store outgoing links on note save in src/main/vault/notes.ts
- [ ] T044 [US4] Style wiki links with distinctive appearance via CSS in src/renderer/src/assets/base.css

**Checkpoint**: User Story 4 complete - wiki links work with autocomplete and navigation

---

## Phase 7: User Story 5 - Backlinks (Priority: P1)

**Goal**: Users can see what other notes link to the current note (backlinks panel)

**Independent Test**: Create Note A that links to Note B, open Note B, verify Note A appears in backlinks section with context snippet.

### Implementation for User Story 5

- [ ] T045 [P] [US5] Create NoteBacklinks panel component in src/renderer/src/components/note/note-backlinks.tsx
- [ ] T046 [US5] Add getLinks IPC handler for incoming/outgoing links in src/main/ipc/notes-handlers.ts
- [ ] T047 [US5] Implement backlink context snippet extraction in src/shared/db/queries/notes.ts
- [ ] T048 [US5] Add clickable backlink entries that open source note in src/renderer/src/components/note/note-backlinks.tsx
- [ ] T049 [US5] Implement backlink auto-refresh when linked notes change in src/renderer/src/hooks/use-note-editor.ts
- [ ] T050 [US5] Add progressive loading for notes with many backlinks in src/renderer/src/components/note/note-backlinks.tsx
- [ ] T051 [US5] Integrate NoteBacklinks panel into NotePage in src/renderer/src/pages/note.tsx

**Checkpoint**: User Story 5 complete - backlinks display with context and navigation. **P1 MVP COMPLETE**

---

## Phase 8: User Story 6 - Custom Properties (Priority: P2)

**Goal**: Users can add typed properties (text, number, date, checkbox, select, rating) to notes

**Independent Test**: Add a property (e.g., "Status: Draft"), change its value, verify it persists and displays correctly after reload.

### Implementation for User Story 6

- [ ] T052 [P] [US6] Create PropertyInput component for each property type in src/renderer/src/components/note/property-input.tsx
- [ ] T053 [P] [US6] Create PropertyRow component for property name + value in src/renderer/src/components/note/property-row.tsx
- [ ] T054 [US6] Implement date picker for date properties in src/renderer/src/components/note/property-input.tsx
- [ ] T055 [US6] Implement star rating component for rating properties in src/renderer/src/components/note/property-input.tsx
- [ ] T056 [US6] Implement select/multiselect dropdowns in src/renderer/src/components/note/property-input.tsx
- [ ] T057 [US6] Create AddProperty dialog for new property creation in src/renderer/src/components/note/add-property-dialog.tsx
- [ ] T058 [US6] Add setProperties IPC handler in src/main/ipc/notes-handlers.ts
- [ ] T059 [US6] Extend NoteProperties panel to display custom properties in src/renderer/src/components/note/note-properties.tsx
- [ ] T060 [US6] Persist property definitions for reuse in src/main/ipc/notes-handlers.ts

**Checkpoint**: User Story 6 complete - custom properties work with all supported types

---

## Phase 9: User Story 7 - Emoji Icons (Priority: P2)

**Goal**: Users can assign emoji icons to notes for visual identification

**Status**: @emoji-mart/react and @emoji-mart/data already installed.

**Independent Test**: Click emoji placeholder, select emoji, verify it appears on note header and in notes list.

### Implementation for User Story 7

- [ ] T061 [US7] Create EmojiPicker component in src/renderer/src/components/note/emoji-picker.tsx
- [ ] T062 [US7] Add emoji click handler to NoteHeader in src/renderer/src/components/note/note-header.tsx
- [ ] T063 [US7] Display emoji in notes list items in src/renderer/src/components/notes-tree.tsx
- [ ] T064 [US7] Persist emoji to frontmatter on selection in src/renderer/src/hooks/use-note-editor.ts

**Checkpoint**: User Story 7 complete - emoji icons work throughout the UI

---

## Phase 10: User Story 8 - Attachments (Priority: P2)

**Goal**: Users can drag-drop images/files into notes and view them inline

**Approach**: Use BlockNote's built-in image block and insertBlocks API

**Independent Test**: Drag an image into a note, verify it displays inline, confirm file exists in vault/attachments folder.

### Implementation for User Story 8

- [ ] T065 [P] [US8] Create attachment upload handler in src/main/vault/attachments.ts
- [ ] T066 [US8] Add drag-drop zone to BlockNote editor in src/renderer/src/components/note/content-area/ContentArea.tsx
- [ ] T067 [US8] Implement uploadAttachment IPC handler in src/main/ipc/notes-handlers.ts
- [ ] T068 [US8] Insert BlockNote image block after upload in src/renderer/src/components/note/content-area/ContentArea.tsx
- [ ] T069 [US8] Create FileBlock custom block for non-image files in src/renderer/src/components/note/content-area/file-block.ts
- [ ] T070 [US8] Add file size validation (10MB limit) in src/main/vault/attachments.ts

**Checkpoint**: User Story 8 complete - attachments work with inline image display

---

## Phase 11: User Story 9 - Heading Outline (Priority: P2)

**Goal**: Users can see and navigate via a heading outline panel for long notes

**Status**: extractHeadings function already exists in ContentArea.tsx. Tasks focus on UI panel.

**Independent Test**: Create note with multiple headings, open outline panel, click headings to navigate.

### Implementation for User Story 9

- [ ] T071 [P] [US9] Create NoteOutline panel component in src/renderer/src/components/note/note-outline.tsx
- [ ] T072 [US9] Connect headings from ContentArea to NoteOutline in src/renderer/src/pages/note.tsx
- [ ] T073 [US9] Implement scroll-to-heading on outline click in src/renderer/src/components/note/note-outline.tsx
- [ ] T074 [US9] Display hierarchical heading structure (H1 > H2 > H3) in src/renderer/src/components/note/note-outline.tsx
- [ ] T075 [US9] Integrate NoteOutline toggle into NotePage in src/renderer/src/pages/note.tsx

**Checkpoint**: User Story 9 complete - outline navigation works for long notes

---

## Phase 12: User Story 10 - Folder Organization (Priority: P2)

**Goal**: Users can organize notes in folders with drag-drop

**Independent Test**: Create a folder, move a note into it, verify folder appears in sidebar tree with note inside.

### Implementation for User Story 10

- [ ] T076 [P] [US10] Create FolderTree component for sidebar in src/renderer/src/components/folder-tree.tsx
- [ ] T077 [P] [US10] Add folder CRUD IPC handlers in src/main/ipc/notes-handlers.ts
- [ ] T078 [US10] Implement folder creation dialog in src/renderer/src/components/folder-tree.tsx
- [ ] T079 [US10] Add drag-drop note moving between folders in src/renderer/src/components/folder-tree.tsx
- [ ] T080 [US10] Implement folder rename functionality in src/renderer/src/components/folder-tree.tsx
- [ ] T081 [US10] Add folder delete (empty only) functionality in src/renderer/src/components/folder-tree.tsx
- [ ] T082 [US10] Replace/enhance notes-tree.tsx with FolderTree in sidebar

**Checkpoint**: User Story 10 complete - folder organization works with full CRUD

---

## Phase 13: User Story 11 - Recently Edited Notes (Priority: P3)

**Goal**: Users can see and access recently edited notes

**Independent Test**: Edit several notes, view recent notes list, verify order matches edit times.

### Implementation for User Story 11

- [ ] T083 [P] [US11] Create RecentNotes component in src/renderer/src/components/recent-notes.tsx
- [ ] T084 [US11] Add recent notes query (sort by modifiedAt DESC) in src/shared/db/queries/notes.ts
- [ ] T085 [US11] Integrate RecentNotes into sidebar or home view in src/renderer/src/pages/inbox.tsx

**Checkpoint**: User Story 11 complete - recent notes accessible

---

## Phase 14: User Story 12 - Note Templates (Priority: P3)

**Goal**: Users can create notes from templates

**Independent Test**: Create a template, create new note from template, verify structure is applied.

### Implementation for User Story 12

- [ ] T086 [P] [US12] Create template storage in vault/.memry/templates/ in src/main/vault/templates.ts
- [ ] T087 [US12] Create TemplateSelector dialog in src/renderer/src/components/note/template-selector.tsx
- [ ] T088 [US12] Add template CRUD IPC handlers in src/main/ipc/notes-handlers.ts
- [ ] T089 [US12] Integrate template selection into new note creation flow in src/renderer/src/pages/note.tsx

**Checkpoint**: User Story 12 complete - templates work for quick note creation

---

## Phase 15: User Story 13 - Export Notes (Priority: P3)

**Goal**: Users can export notes as PDF or HTML

**Independent Test**: Export formatted note to PDF, verify output renders correctly.

### Implementation for User Story 13

- [ ] T090 [P] [US13] Add PDF export using Electron print-to-PDF in src/main/ipc/notes-handlers.ts
- [ ] T091 [US13] Create ExportDialog with format selection in src/renderer/src/components/note/export-dialog.tsx
- [ ] T092 [US13] Add HTML export with embedded styles in src/main/ipc/notes-handlers.ts
- [ ] T093 [US13] Add export button to NotePage header in src/renderer/src/pages/note.tsx

**Checkpoint**: User Story 13 complete - export works for PDF and HTML

---

## Phase 16: User Story 14 - Version History (Priority: P3)

**Goal**: Users can view and restore previous versions of notes

**Independent Test**: Edit note multiple times, view version history, restore previous version.

### Implementation for User Story 14

- [ ] T094 [P] [US14] Create note snapshots table in src/shared/db/schema/notes-cache.ts
- [ ] T095 [US14] Save snapshots on significant edits in src/main/vault/notes.ts
- [ ] T096 [US14] Create VersionHistory panel in src/renderer/src/components/note/version-history.tsx
- [ ] T097 [US14] Add version preview and restore functionality in src/renderer/src/components/note/version-history.tsx
- [ ] T098 [US14] Add version history IPC handlers in src/main/ipc/notes-handlers.ts

**Checkpoint**: User Story 14 complete - version history with restore capability

---

## Phase 17: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T099 [P] Accessibility audit - add ARIA labels to all interactive elements
- [ ] T100 [P] Keyboard navigation for all panels and dialogs
- [ ] T101 Performance optimization - virtualize long notes list
- [ ] T102 [P] Error boundary for editor crashes
- [ ] T103 External edit conflict detection and resolution UI
- [ ] T104 Run quickstart.md validation scenarios
- [ ] T105 Update CLAUDE.md with notes system patterns

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

- **US1 (Rich Text)**: Can start after Foundational - ContentArea exists, needs enhancements
- **US2 (Auto-Save)**: Depends on US1 (needs editor foundation)
- **US3 (Tags)**: Can start after Foundational - Independent of US1/US2
- **US4 (Wiki Links)**: Depends on US1 (needs BlockNote custom inline content)
- **US5 (Backlinks)**: Depends on US4 (needs wiki links to create backlinks)
- **US6 (Properties)**: Can start after Foundational - Independent
- **US7 (Emoji)**: Can start after Foundational - Independent
- **US8 (Attachments)**: Depends on US1 (needs editor for inline display)
- **US9 (Outline)**: Depends on US1 (headings extraction exists)
- **US10 (Folders)**: Can start after Foundational - Independent
- **US11 (Recent)**: Can start after Foundational - Independent
- **US12 (Templates)**: Can start after Foundational - Independent
- **US13 (Export)**: Depends on US1 (needs editor content)
- **US14 (Version History)**: Can start after Foundational - Independent

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel (within Phase 2)
- Independent user stories can start in parallel after Foundational:
  - **Parallel Group A**: US1, US3, US6, US7, US10, US11, US12, US14
  - **After US1**: US2, US4, US8, US9, US13
  - **After US4**: US5

---

## Existing Infrastructure (Already Implemented)

The following components already exist and can be leveraged:

| Component | Location | Status |
|-----------|----------|--------|
| BlockNote Editor | `src/renderer/src/components/note/content-area/ContentArea.tsx` | Complete |
| Heading Extraction | `extractHeadings()` in ContentArea.tsx | Complete |
| Markdown Serialization | `editor.blocksToMarkdownLossy()` in ContentArea.tsx | Complete |
| Markdown Parsing | `editor.tryParseMarkdownToBlocks()` in ContentArea.tsx | Complete |
| Debounced Save | `handleMarkdownChange()` in note.tsx (500ms) | Partial |
| Tag Display | `TagsRow` component | Complete |
| Backlinks Section | `BacklinksSection` component | Complete |
| Note Links Hook | `useNoteLinks()` hook | Complete |
| Note Tags Hook | `useNoteTags()` hook | Complete |
| Emoji Picker Packages | `@emoji-mart/react`, `@emoji-mart/data` | Installed |

---

## BlockNote Custom Extensions

For wiki-links and other custom features, use BlockNote's extension APIs:

```typescript
// Custom inline content (for wiki-links)
import { createInlineContentSpec } from '@blocknote/core'

const WikiLink = createInlineContentSpec({
  type: 'wikiLink',
  propSchema: {
    target: { default: '' },
    alias: { default: '' }
  },
  content: 'styled'
})

// Custom block (for file attachments)
import { createBlockSpec } from '@blocknote/core'

const FileBlock = createBlockSpec({
  type: 'file',
  propSchema: {
    url: { default: '' },
    name: { default: '' },
    size: { default: 0 }
  },
  content: 'none'
})
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
2. Add US1 (Rich Text) → Test → Core editing works (ContentArea extends)
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
- **BlockNote is the rich text editor** - not Tiptap (despite research.md references)
- Focus is on UI integration, custom BlockNote extensions, and remaining IPC handlers

## Architecture Decisions

### Properties Storage (T004-T006h)

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
