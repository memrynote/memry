# Tasks: Notes System (Refactored)

**Input**: Design documents from `/specs/003-notes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, properties-design.md, contracts/
**Refactored**: 2025-12-23 - Aligned with actual codebase state

**Tests**: Not explicitly requested - test tasks are omitted. Implementation focuses on feature delivery.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

---

## Codebase Inventory Summary

### Existing UI Components (70% Complete)

| Component                | Location                                       | Status                     |
| ------------------------ | ---------------------------------------------- | -------------------------- |
| NoteLayout               | `components/note/note-layout.tsx`              | ✅ UI Complete             |
| RightSidebar             | `components/note/right-sidebar.tsx`            | ✅ UI Complete             |
| OutlineEdge              | `components/note/outline-edge.tsx`             | ✅ UI Complete             |
| ContentArea (BlockNote)  | `components/note/content-area/ContentArea.tsx` | ✅ UI Complete             |
| NoteTitle + EmojiPicker  | `components/note/note-title/`                  | ✅ UI Complete             |
| TagsRow + TagInput       | `components/note/tags-row/`                    | ✅ UI Complete             |
| InfoSection (Properties) | `components/note/info-section/`                | ✅ UI Complete (8 editors) |
| BacklinksSection         | `components/note/backlinks/`                   | ⚠️ UI with Demo Data       |
| RelatedNotesTab          | `components/note/related-notes/`               | ⚠️ UI with Demo Data       |
| LinkedTasksSection       | `components/note/linked-tasks/`                | ✅ Wired to Tasks          |
| AIAgentTab               | `components/note/ai-agent/`                    | ⚠️ UI with Demo Data       |

### Existing Backend Infrastructure

| Component              | Location                                     | Status                       |
| ---------------------- | -------------------------------------------- | ---------------------------- |
| Notes IPC Handlers     | `src/main/ipc/notes-handlers.ts`             | ✅ 24 handlers               |
| Vault Notes Operations | `src/main/vault/notes.ts`                    | ✅ 26 functions              |
| Preload Bridge         | `src/preload/index.ts`                       | ✅ Full API exposed          |
| Notes Service          | `src/renderer/src/services/notes-service.ts` | ✅ 18 methods                |
| useNotes Hook          | `src/renderer/src/hooks/use-notes.ts`        | ✅ Complete                  |
| Notes Schema           | `src/shared/db/schema/notes-cache.ts`        | ⚠️ Missing emoji, properties |
| Notes Queries          | `src/shared/db/queries/notes.ts`             | ⚠️ Missing properties        |

### What's Missing (Backend Wiring Focus)

1. **Database**: `emoji` column, `noteProperties` table, `propertyDefinitions` table
2. **Properties Sync**: Extract/save properties to frontmatter + DB cache
3. **Backend Wiring**: Connect UI callbacks to backend services
4. **Wiki Links**: Custom BlockNote inline content for [[wiki-links]]
5. **Backlinks**: Replace demo data with real backend queries
6. **External Edit**: File watcher → UI event propagation

---

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

## Phase 1: Setup (Verification Only)

**Purpose**: Verify existing dependencies and TypeScript configuration

**Note**: BlockNote is already installed. Most infrastructure exists.

- [x] T001 [P] Verify better-sqlite3 native module compatibility with `pnpm rebuild` ✅ Already working
- [x] T002 [P] TypeScript config for contracts already configured ✅ Exists

---

## Phase 2: Foundational (Database & Properties Infrastructure)

**Purpose**: Core infrastructure that MUST be complete before UI wiring can begin

**CRITICAL**: Properties tables and sync layer must be complete before US3 (Tags) and US6 (Properties)

### Database Schema & Migrations

- [x] T003 Add `emoji` column to noteCache table in src/shared/db/schema/notes-cache.ts
- [x] T004 Create noteProperties table (rebuildable cache from frontmatter) in src/shared/db/schema/notes-cache.ts
- [x] T005 Create propertyDefinitions table (vault-wide schema, source of truth) in src/shared/db/schema/notes-cache.ts
- [x] T006 Generate and apply database migrations with `pnpm db:generate && pnpm db:push`

### Properties Sync Layer (Required for External Edit Support)

> **Design Doc**: See `specs/003-notes/properties-design.md` for full architecture.
> **Pattern**: Follows existing tag sync pattern - frontmatter = source of truth, DB = cache.

- [x] T007 [P] Add extractProperties() function in src/main/vault/frontmatter.ts
- [x] T008 [P] Add inferPropertyType() utility (type inference for external edits) in src/main/vault/frontmatter.ts
- [x] T009 Add setNoteProperties() query function (sync from frontmatter) in src/shared/db/queries/notes.ts
- [x] T010 Add getNoteProperties() query function in src/shared/db/queries/notes.ts
- [x] T011 Add property definition CRUD functions in src/shared/db/queries/notes.ts
- [x] T012 Extend handleFileChange() to sync properties in src/main/vault/watcher.ts
- [x] T013 Extend updateNote() to save properties to frontmatter in src/main/vault/notes.ts
- [x] T014 Extend createNote() to support initial properties in src/main/vault/notes.ts

### IPC Extensions for Properties

- [x] T015 Add getProperties IPC handler in src/main/ipc/notes-handlers.ts
- [x] T016 Add setProperties IPC handler in src/main/ipc/notes-handlers.ts
- [x] T017 Add getPropertyDefinitions IPC handler in src/main/ipc/notes-handlers.ts
- [x] T018 Add createPropertyDefinition IPC handler in src/main/ipc/notes-handlers.ts
- [x] T019 Expose properties API in src/preload/index.ts
- [x] T020 Update type declarations in src/preload/index.d.ts

### Renderer Services Extension

- [x] T021 Extend notes-service.ts with properties methods in src/renderer/src/services/notes-service.ts
- [x] T022 Create useNoteProperties hook in src/renderer/src/hooks/use-note-properties.ts
- [x] T023 Create usePropertyDefinitions hook in src/renderer/src/hooks/use-property-definitions.ts

**Checkpoint**: Foundation ready - user story implementation can now begin ✅ PHASE 2 COMPLETE

---

## Phase 3: User Story 1 - Rich Text Note Editing (Priority: P1) MVP

**Goal**: Users can create and edit notes with rich text formatting

**Status**: ContentArea with BlockNote already exists. Focus on backend wiring.

**Existing Components**:

- ✅ `components/note/content-area/ContentArea.tsx` - Full BlockNote editor
- ✅ `components/note/note-title/NoteTitle.tsx` - Title + emoji UI
- ✅ `pages/note.tsx` - Page wrapper with basic save logic

**Independent Test**: Create a new note, add various formatting, verify persists after reload.

### Backend Wiring for User Story 1

- [x] T024 [US1] ContentArea component exists with all callbacks ✅ Already complete
- [x] T025 [US1] NoteTitle component exists with emoji picker ✅ Already complete
- [x] T026 [US1] Wire NoteTitle emoji change to updateNote() in src/renderer/src/pages/note.tsx
- [x] T027 [US1] Add emoji support to updateNote IPC handler in src/main/ipc/notes-handlers.ts
- [x] T028 [US1] Store emoji in noteCache on save in src/main/vault/notes.ts
- [x] T029 [US1] Create use-note-editor hook for unified editor state in src/renderer/src/hooks/use-note-editor.ts
- [x] T030 [US1] Add BlockNote dark mode support via theme prop in src/renderer/src/components/note/content-area/ContentArea.tsx

**Checkpoint**: User Story 1 complete - rich text editing with emoji support ✅ PHASE 3 COMPLETE

---

## Phase 4: User Story 2 - Auto-Save (Priority: P1)

**Goal**: Notes save automatically 1 second after user stops typing with save status indicator

**Status**: Basic debounced save (500ms) exists in note.tsx. Focus on status UI.

**Existing Components**:

- ✅ `pages/note.tsx` - Has handleMarkdownChange with 500ms debounce
- ⚠️ No SaveStatus component yet

**Independent Test**: Create a note, type content, wait for save indicator, verify content persists.

### Implementation for User Story 2

- [x] T031 [US2] Create SaveStatus component (Saving.../Saved/Error) in src/renderer/src/components/note/save-status.tsx
- [x] T032 [US2] Enhance use-note-editor hook with save state tracking in src/renderer/src/hooks/use-note-editor.ts
- [x] T033 [US2] Add save queue for handling rapid edits in src/renderer/src/hooks/use-note-editor.ts
- [x] T034 [US2] Handle save errors with toast notification in src/renderer/src/hooks/use-note-editor.ts
- [x] T035 [US2] Integrate SaveStatus into note.tsx header in src/renderer/src/pages/note.tsx

**Checkpoint**: User Story 2 complete - auto-save works reliably with status feedback

---

## Phase 5: User Story 3 - Tags (Priority: P1)

**Goal**: Users can add/remove tags with autocomplete and filter notes by tag

**Status**: TagsRow UI complete with all callbacks. Focus on backend wiring.

**Existing Components**:

- ✅ `components/note/tags-row/TagsRow.tsx` - Full tag UI with add/remove/create
- ✅ `components/note/tags-row/TagInputPopup.tsx` - Autocomplete popup
- ✅ `hooks/use-notes.ts` - Has getTags, useNoteTags

**Independent Test**: Add tags to a note, verify they persist and appear in autocomplete.

### Backend Wiring for User Story 3

- [x] T036 [US3] TagsRow component exists with full UI ✅ Already complete
- [x] T037 [US3] TagInputPopup with autocomplete exists ✅ Already complete
- [x] T038 [US3] Wire TagsRow callbacks to updateNote in src/renderer/src/pages/note.tsx
- [x] T039 [US3] Connect tag autocomplete to getTags API in src/renderer/src/pages/note.tsx
- [x] T040 [US3] Add tag filtering to notes list in src/renderer/src/hooks/use-notes.ts

### Additional Tasks (Tag Color Persistence & Cross-Note Refresh)

- [x] T040.1 [US3] Create `tagDefinitions` table in src/shared/db/schema/notes-cache.ts
- [x] T040.2 [US3] Add `getOrCreateTag`, `getAllTagsWithColors`, `ensureTagDefinitions` queries in src/shared/db/queries/notes.ts
- [x] T040.3 [US3] Update `getTagsWithCounts` to return colors in src/main/vault/notes.ts
- [x] T040.4 [US3] Emit `notes:tags-changed` event on tag updates in src/main/vault/notes.ts
- [x] T040.5 [US3] Add `onTagsChanged` event listener in src/preload/index.ts
- [x] T040.6 [US3] Update `useNoteTags` hook to subscribe to tags-changed event in src/renderer/src/hooks/use-notes.ts
- [x] T040.7 [US3] Update note.tsx to use backend colors (remove hash function)
- [x] T040.8 [US3] Generate database migration for tag_definitions table

**Checkpoint**: User Story 3 complete - tags work with autocomplete, persistence, cross-note refresh, and persistent colors ✅ PHASE 5 COMPLETE

---

## Phase 6: User Story 4 - Wiki-Style Linking (Priority: P1)

**Goal**: Users can create [[wiki-style links]] that navigate to other notes

**Approach**: Create custom BlockNote inline content for wiki-links using createInlineContentSpec

**Existing Components**:

- ✅ `components/note/content-area/ContentArea.tsx` - Base editor (needs wiki-link extension)

**Independent Test**: Type [[, select a note from autocomplete, click the link to navigate.

### Implementation for User Story 4

- [x] T041 [P] [US4] Create WikiLink inline content spec in src/renderer/src/components/note/content-area/wiki-link.tsx
- [x] T042 [US4] Create WikiLinkAutocomplete popover component in src/renderer/src/components/note/content-area/wiki-link-menu.tsx
- [x] T043 [US4] Integrate wiki-link inline content into BlockNote schema in src/renderer/src/components/note/content-area/ContentArea.tsx
- [x] T044 [US4] Implement note title search for autocomplete in ContentArea.tsx (uses notesService.list)
- [x] T045 [US4] Add aliased link support [[Title|display text]] in wiki-link inline content
- [x] T046 [US4] Implement link click handler to open note in new tab via wikilink:click event
- [x] T047 [US4] If no matching note exists it creates wikilink but not the note, it should be created when clicked
- [x] T048 [US4] Store outgoing links on note save in src/main/vault/notes.ts (already implemented)
- [x] T049 [US4] Style wiki links with distinctive appearance in src/renderer/src/assets/base.css

How it should work;

- [ ] T050 [US4] User types a single [ and it should add ] automatically (deferred - BlockNote limitation)
- [x] T051 [US4] User types [[ and it should open the autocomplete popover (uses SuggestionMenuController)
- [x] T052 [US4] User can use keyboard to select a suggestion when the popover is visible (BlockNote built-in)
- [x] T053 [US4] User selects a note from suggestions and it is inserted as a wiki link
- [x] T054 [US4] User can click on the wiki link to navigate to the note
- [x] T055 [US4] Typing [[ and starting to type a note title filters the suggestions in real time
- [x] T056 [US4] If no matching note exists, a "Create new note" option appears at the end
- [x] T057 [US4] If no matching note exists it creates wikilink but not the note, it should be created when clicked
- [x] T058 [US4] Wiki links can support aliasing as [[Note Title|display text]] via alias prop
- [ ] T059 [US4] When editing an existing wiki link, the autocomplete popover can be shown again (deferred - complex)
- [x] T060 [US4] If the user pastes or manually types a wiki link pattern, it should be recognized via parse function

**Checkpoint**: User Story 4 complete - wiki links work with autocomplete and navigation

---

## Phase 7: User Story 5 - Backlinks (Priority: P1)

**Goal**: Users can see what other notes link to the current note (backlinks panel)

**Status**: BacklinksSection UI exists with demo data. Focus on backend wiring.

**Existing Components**:

- ✅ `components/note/backlinks/BacklinksSection.tsx` - Full UI with demo data
- ✅ `components/note/backlinks/BacklinkCard.tsx` - Card with snippets
- ✅ `hooks/use-notes.ts` - Has useNoteLinks (outgoing + incoming)

**Independent Test**: Create Note A that links to Note B, open Note B, verify Note A appears in backlinks.

### Backend Wiring for User Story 5

- [x] T050 [US5] BacklinksSection component exists with full UI ✅ Already complete
- [x] T051 [US5] BacklinkCard component exists ✅ Already complete
- [ ] T052 [US5] Replace demo data with useNoteLinks hook in src/renderer/src/components/note/backlinks/BacklinksSection.tsx
- [ ] T053 [US5] Add backlink context snippet extraction in src/shared/db/queries/notes.ts
- [ ] T054 [US5] Add clickable backlink entries that open source note in src/renderer/src/components/note/backlinks/BacklinksSection.tsx
- [ ] T055 [US5] Implement backlink auto-refresh when linked notes change in src/renderer/src/pages/note.tsx

**Checkpoint**: User Story 5 complete - backlinks display with context and navigation. **P1 MVP COMPLETE**

---

## Phase 8: User Story 6 - Custom Properties (Priority: P2)

**Goal**: Users can add typed properties (text, number, date, checkbox, select, rating) to notes

**Status**: InfoSection UI complete with all 8 editors. Focus on backend wiring.

**Existing Components**:

- ✅ `components/note/info-section/InfoSection.tsx` - Full properties panel
- ✅ `components/note/info-section/PropertyRow.tsx` - Property display/edit
- ✅ `components/note/info-section/AddPropertyPopup.tsx` - Add property modal
- ✅ `components/note/info-section/editors/` - 8 type-specific editors (Text, Number, Date, Checkbox, Select, Rating, URL, LongText)

**Independent Test**: Add a property, change its value, verify it persists after reload.

### Backend Wiring for User Story 6

- [x] T056 [US6] InfoSection component exists with full UI ✅ Already complete
- [x] T057 [US6] All 8 property editors exist ✅ Already complete
- [x] T058 [US6] AddPropertyPopup component exists ✅ Already complete
- [x] T059 [US6] Wire InfoSection callbacks to updateNote in src/renderer/src/pages/note.tsx
- [x] T060 [US6] Connect property changes to frontmatter save in src/renderer/src/hooks/use-note-editor.ts
- [x] T061 [US6] Load properties from note frontmatter on mount in src/renderer/src/pages/note.tsx
- [x] T062 [US6] Add setProperties IPC usage in src/renderer/src/services/notes-service.ts
- [x] T063 [US6] Persist property definitions for reuse in src/renderer/src/hooks/use-property-definitions.ts

**Checkpoint**: User Story 6 complete - custom properties work with all supported types ✅ PHASE 8 COMPLETE

---

## Phase 9: User Story 7 - Emoji Icons (Priority: P2)

**Goal**: Users can assign emoji icons to notes for visual identification

**Status**: EmojiPicker exists in note-title. Focus on persistence and display.

**Existing Components**:

- ✅ `components/note/note-title/EmojiPicker.tsx` - Full emoji picker UI
- ✅ `components/note/note-title/EmojiButton.tsx` - Trigger button
- ✅ Packages installed: `@emoji-mart/react`, `@emoji-mart/data`

**Independent Test**: Click emoji placeholder, select emoji, verify it appears in notes list.

### Backend Wiring for User Story 7

- [x] T064 [US7] EmojiPicker component exists ✅ Already complete
- [x] T065 [US7] Wire emoji selection to updateNote in src/renderer/src/pages/note.tsx ✅ Already implemented (handleEmojiChange callback)
- [x] T066 [US7] Display emoji in notes list items in src/renderer/src/components/notes-tree.tsx
- [x] T067 [US7] Persist emoji to frontmatter on selection in src/renderer/src/hooks/use-note-editor.ts ✅ Already implemented (updateEmoji method)

**Checkpoint**: User Story 7 complete - emoji icons work throughout the UI ✅ PHASE 9 COMPLETE

---

## Phase 10: User Story 8 - Attachments (Priority: P2)

**Goal**: Users can drag-drop images/files into notes and view them inline

**Approach**: Use BlockNote's built-in image block and insertBlocks API

**Independent Test**: Drag an image into a note, verify it displays inline, confirm file exists in vault.

### Implementation for User Story 8

- [x] T068 [P] [US8] Create attachment upload handler in src/main/vault/attachments.ts
- [x] T069 [US8] Add drag-drop zone to BlockNote editor in src/renderer/src/components/note/content-area/ContentArea.tsx
- [x] T070 [US8] Implement uploadAttachment IPC handler in src/main/ipc/notes-handlers.ts
- [x] T071 [US8] Insert BlockNote image block after upload in src/renderer/src/components/note/content-area/ContentArea.tsx
- [x] T072 [US8] Create FileBlock custom block for non-image files in src/renderer/src/components/note/content-area/file-block.tsx
- [x] T073 [US8] Add file size validation (10MB limit) in src/main/vault/attachments.ts

**Checkpoint**: User Story 8 complete - attachments work with inline image display

---

## Phase 11: User Story 9 - Heading Outline (Priority: P2)

**Goal**: Users can see and navigate via a heading outline panel for long notes

**Status**: OutlineEdge exists. extractHeadings in ContentArea exists.

**Existing Components**:

- ✅ `components/note/outline-edge.tsx` - Floating outline navigator
- ✅ `components/note/content-area/ContentArea.tsx` - Has extractHeadings function

**Independent Test**: Create note with multiple headings, click outline item, verify scroll to heading.

### Backend Wiring for User Story 9

- [x] T074 [US9] OutlineEdge component exists ✅ Already complete
- [x] T075 [US9] Heading extraction exists in ContentArea ✅ Already complete
- [x] T076 [US9] Connect headings from ContentArea to OutlineEdge in src/renderer/src/pages/note.tsx
- [x] T077 [US9] Implement scroll-to-heading on outline click in src/renderer/src/components/note/outline-edge.tsx
- [x] T078 [US9] Add active heading highlighting based on scroll position in src/renderer/src/hooks/use-active-heading.ts

**Checkpoint**: User Story 9 complete - outline navigation works for long notes ✅ PHASE 11 COMPLETE

---

## Phase 12: User Story 10 - Folder Organization (Priority: P2)

**Goal**: Users can organize notes in folders with drag-drop

**Status**: ✅ PHASE 12 COMPLETE - Full folder organization with drag-drop

**Existing Backend**:

- ✅ `notes:create-folder`, `notes:rename-folder`, `notes:delete-folder` IPC handlers
- ✅ `notes:get-folders` returns folder structure
- ✅ `notes:move` moves notes between folders

**Independent Test**: Create a folder, move a note into it, verify folder appears in sidebar.

### Implementation for User Story 10

- [x] T079 [P] [US10] Create FolderTree component for sidebar - **Implemented in notes-tree.tsx (1033 lines)**
- [x] T080 [US10] Implement folder creation dialog - **Inline creation via context menu + auto-rename**
- [x] T081 [US10] Add drag-drop note moving between folders - **Full drag-drop with multi-select support**
- [x] T082 [US10] Implement folder rename functionality - **Inline editing on double-click or context menu**
- [x] T083 [US10] Add folder delete functionality - **Recursive delete with confirmation dialog**
- [x] T084 [US10] Replace/enhance notes-tree.tsx with FolderTree in sidebar - **NotesTree serves as FolderTree**

**Features Implemented**:

- ✅ Drag notes between folders
- ✅ Drag folders into other folders
- ✅ Multi-select drag (Ctrl/Cmd+Click to select multiple, drag all at once)
- ✅ Visual drop indicators (before/after/inside)
- ✅ Protection against invalid moves (folder into itself/descendants)
- ✅ Dragging disabled during rename operations

**Checkpoint**: User Story 10 complete - folder organization works with full CRUD ✅ PHASE 12 COMPLETE

---

## Phase 13: User Story 11 - Related Notes (Priority: P2)

**Goal**: Users can see AI-suggested related notes based on content similarity

**Status**: RelatedNotesTab UI exists with demo data. Focus on backend + AI integration.

**Existing Components**:

- ✅ `components/note/related-notes/RelatedNotesTab.tsx` - Full UI with demo data
- ✅ `components/note/related-notes/RelatedNoteCard.tsx` - Card component

**Independent Test**: Open a note, view suggested related notes, click to navigate.

### Implementation for User Story 11

- [x] T085 [US11] RelatedNotesTab component exists ✅ Already complete
- [x] T086 [US11] Create getRelatedNotes IPC handler (similarity search) in src/main/ipc/notes-handlers.ts
- [x] T087 [US11] Implement similarity calculation using FTS5 in src/shared/db/queries/notes.ts
- [x] T088 [US11] Replace demo data with real API call in src/renderer/src/components/note/related-notes/RelatedNotesTab.tsx
- [x] T089 [US11] Add hide suggestion functionality with persistence in src/renderer/src/components/note/related-notes/RelatedNotesTab.tsx

**Checkpoint**: User Story 11 complete - related notes display based on content similarity

---

## Phase 14: User Story 12 - Recently Edited Notes (Priority: P3)

**Goal**: Users can see and access recently edited notes

**Independent Test**: Edit several notes, view recent notes list, verify order matches edit times.

### Implementation for User Story 12

- [ ] T090 [P] [US12] Create RecentNotes component in src/renderer/src/components/recent-notes.tsx
- [ ] T091 [US12] Add recent notes query (sort by modifiedAt DESC) - already in listNotes
- [ ] T092 [US12] Integrate RecentNotes into sidebar or home view in src/renderer/src/pages/inbox.tsx

**Checkpoint**: User Story 12 complete - recent notes accessible

---

## Phase 15: User Story 13 - Note Templates (Priority: P3)

**Goal**: Users can create notes from templates

**Independent Test**: Create a template, create new note from template, verify structure is applied.

### Core Template Implementation

- [ ] T093 [P] [US13] Create template storage in vault/.memry/templates/ in src/main/vault/templates.ts
- [ ] T094 [US13] Create TemplateSelector dialog in src/renderer/src/components/note/template-selector.tsx
- [ ] T095 [US13] Add template CRUD IPC handlers in src/main/ipc/notes-handlers.ts
- [ ] T096 [US13] Integrate template selection into new note creation flow in src/renderer/src/pages/note.tsx

### Folder-Level Templates

**Goal**: Folders can have default templates that auto-apply when creating notes

**Design**:

- `.folder.md` file in each folder stores template config as YAML frontmatter
- Template inheritance: child folders inherit parent's template unless overridden
- Auto-apply: skip template picker when folder has a default template

**`.folder.md` Format**:

```yaml
---
template: project-note # Template ID for new notes in this folder
inherit: true # Inherit from parent folder (default: true)
---
```

- [ ] T096.1 [US13] Create FolderConfig type in src/shared/contracts/notes-api.ts
- [ ] T096.2 [US13] Add readFolderConfig() in src/main/vault/folders.ts
- [ ] T096.3 [US13] Add writeFolderConfig() in src/main/vault/folders.ts
- [ ] T096.4 [US13] Implement getFolderTemplate() with inheritance resolution in src/main/vault/folders.ts
- [ ] T096.5 [US13] Add folder config IPC handlers (get/set) in src/main/ipc/notes-handlers.ts
- [ ] T096.6 [US13] Update createNote to auto-apply folder template in src/main/vault/notes.ts
- [ ] T096.7 [US13] Add "Set as folder default" option in TemplateSelector
- [ ] T096.8 [US13] Auto-add missing template properties to existing notes on folder template change

**Checkpoint**: User Story 13 complete - templates work with folder-level defaults

---

## Phase 16: User Story 14 - Folder View (Priority: P3)

**Goal**: Users can view folder contents as a database-style table with filtering and inline preview

**Independent Test**: Click folder in sidebar, see table view with properties as columns, click row to preview note.

### Design

**Folder View Features**:

- Click folder in sidebar → Opens folder view in main content area
- Table view showing all notes with properties as columns
- Simple filtering by property values
- Sorting by any column
- Inline preview panel on row click (single click = preview, double click = open in tab)

**UI Layout**:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 📁 Projects                                          [+ New] [⚙️]      │
├─────────────────────────────────────────────────────────────────────────┤
│ Filter: [All ▼]  [Status: Active ▼]          Sort: [Modified ▼]        │
├───────────────────────────────────────────────┬─────────────────────────┤
│  Table with property columns                  │  Note preview panel     │
│  (left side, resizable)                       │  (right side)           │
└───────────────────────────────────────────────┴─────────────────────────┘
```

### Implementation for User Story 14

- [ ] T097 [P] [US14] Create FolderView page component in src/renderer/src/pages/folder.tsx
- [ ] T098 [US14] Create FolderTable component with property columns in src/renderer/src/components/folder/folder-table.tsx
- [ ] T099 [US14] Add column configuration from folder's template properties
- [ ] T100 [US14] Create FolderPreviewPanel component in src/renderer/src/components/folder/folder-preview.tsx
- [ ] T101 [US14] Implement simple property filtering (dropdown per column)
- [ ] T102 [US14] Implement column sorting (click header to sort)
- [ ] T103 [US14] Add folder view tab type to tab system in src/renderer/src/contexts/tabs/
- [ ] T104 [US14] Wire folder click in notes-tree to open folder view tab
- [ ] T105 [US14] Add IPC handler to list notes with properties for folder in src/main/ipc/notes-handlers.ts

**Checkpoint**: User Story 14 complete - folder view works with table, filtering, and preview

---

## Phase 17: User Story 15 - Export Notes (Priority: P3)

**Goal**: Users can export notes as PDF or HTML

**Independent Test**: Export formatted note to PDF, verify output renders correctly.

### Implementation for User Story 15

- [ ] T106 [P] [US15] Add PDF export using Electron print-to-PDF in src/main/ipc/notes-handlers.ts
- [ ] T107 [US15] Create ExportDialog with format selection in src/renderer/src/components/note/export-dialog.tsx
- [ ] T108 [US15] Add HTML export with embedded styles in src/main/ipc/notes-handlers.ts
- [ ] T109 [US15] Add export button to NotePage header in src/renderer/src/pages/note.tsx

**Checkpoint**: User Story 15 complete - export works for PDF and HTML

---

## Phase 18: User Story 16 - Version History (Priority: P3)

**Goal**: Users can view and restore previous versions of notes

**Independent Test**: Edit note multiple times, view version history, restore previous version.

### Implementation for User Story 16

- [ ] T110 [P] [US16] Create note_snapshots table in src/shared/db/schema/notes-cache.ts
- [ ] T111 [US16] Save snapshots on significant edits in src/main/vault/notes.ts
- [ ] T112 [US16] Create VersionHistory panel in src/renderer/src/components/note/version-history.tsx
- [ ] T113 [US16] Add version preview and restore functionality in src/renderer/src/components/note/version-history.tsx
- [ ] T114 [US16] Add version history IPC handlers in src/main/ipc/notes-handlers.ts

**Checkpoint**: User Story 16 complete - version history with restore capability

---

## Phase 20: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T115 [P] Accessibility audit - add ARIA labels to all interactive elements
- [ ] T116 [P] Keyboard navigation for all panels and dialogs
- [ ] T117 Performance optimization - virtualize long notes list
- [ ] T118 [P] Error boundary for editor crashes
- [ ] T119 External edit conflict detection and resolution UI
- [ ] T120 Run quickstart.md validation scenarios
- [ ] T121 Update CLAUDE.md with notes system patterns

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup) → Already Complete
    ↓
Phase 2 (Foundation) → BLOCKS all user stories
    ↓
Phases 3-18 (User Stories) → Can proceed in priority order
    ↓
Phase 19-20 (Polish) → After all desired stories complete
```

### User Story Dependencies

```
Foundation Complete
    ↓
┌───────────────────────────────────────────────────────────────┐
│ PARALLEL GROUP A (Independent)                                 │
│ • US1 (Rich Text) - ContentArea exists, wire emoji             │
│ • US3 (Tags) - TagsRow exists, wire to backend                 │
│ • US6 (Properties) - InfoSection exists, wire to backend       │
│ • US7 (Emoji) - EmojiPicker exists, wire persistence           │
│ • US10 (Folders) - Backend exists, create FolderTree UI        │
│ • US11 (Related) - RelatedNotesTab exists, wire backend        │
│ • US12 (Recent) - Query exists, create UI                      │
│ • US13 (Templates) - New feature                               │
│ • US15 (Version History) - New feature                         │
└───────────────────────────────────────────────────────────────┘
    ↓
┌───────────────────────────────────────────────────────────────┐
│ SEQUENTIAL GROUP B (Depends on US1)                            │
│ • US2 (Auto-Save) - Depends on use-note-editor hook            │
│ • US4 (Wiki Links) - Depends on BlockNote custom content       │
│ • US8 (Attachments) - Depends on editor integration            │
│ • US9 (Outline) - Depends on heading extraction                │
│ • US14 (Export) - Depends on editor content                    │
└───────────────────────────────────────────────────────────────┘
    ↓
┌───────────────────────────────────────────────────────────────┐
│ SEQUENTIAL GROUP C (Depends on US4)                            │
│ • US5 (Backlinks) - Depends on wiki links being stored         │
└───────────────────────────────────────────────────────────────┘
```

### MVP Path (P1 Stories Only)

```
T003-T023 (Foundation) → T026-T030 (US1) → T031-T035 (US2)
    → T038-T040 (US3) → T041-T049 (US4) → T052-T055 (US5)

Total MVP Tasks: ~45 tasks
```

---

## Component-to-Task Mapping

### Existing UI → Backend Wiring Tasks

| Component        | File Path                           | Wiring Tasks     |
| ---------------- | ----------------------------------- | ---------------- |
| NoteTitle        | `note-title/NoteTitle.tsx`          | T026, T065       |
| EmojiPicker      | `note-title/EmojiPicker.tsx`        | T065, T066, T067 |
| ContentArea      | `content-area/ContentArea.tsx`      | T030, T043, T046 |
| TagsRow          | `tags-row/TagsRow.tsx`              | T038, T039       |
| InfoSection      | `info-section/InfoSection.tsx`      | T059, T060, T061 |
| BacklinksSection | `backlinks/BacklinksSection.tsx`    | T052, T054       |
| OutlineEdge      | `outline-edge.tsx`                  | T076, T077, T078 |
| RelatedNotesTab  | `related-notes/RelatedNotesTab.tsx` | T088, T089       |

### New Components Required

| Component            | File Path                          | Creation Tasks |
| -------------------- | ---------------------------------- | -------------- |
| SaveStatus           | `note/save-status.tsx`             | T031           |
| WikiLinkInline       | `content-area/wiki-link-inline.ts` | T041           |
| WikiLinkAutocomplete | `note/wiki-link-autocomplete.tsx`  | T042           |
| FileBlock            | `content-area/file-block.ts`       | T072           |
| FolderTree           | `components/folder-tree.tsx`       | T079           |
| RecentNotes          | `components/recent-notes.tsx`      | T090           |
| TemplateSelector     | `note/template-selector.tsx`       | T094           |
| ExportDialog         | `note/export-dialog.tsx`           | T098           |
| VersionHistory       | `note/version-history.tsx`         | T103           |

---

## Notes

- **[P]** tasks = different files, no dependencies
- **[Story]** label maps task to specific user story for traceability
- **[x]** = Already complete (existing infrastructure)
- Focus is on **backend wiring** since UI is 70% complete
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- **BlockNote is the rich text editor** - custom extensions use `createInlineContentSpec` and `createBlockSpec`

## Architecture Decisions

### Properties Storage (T004-T014)

**Design Doc**: `specs/003-notes/properties-design.md`

| Component       | Storage                     | Purpose                                            |
| --------------- | --------------------------- | -------------------------------------------------- |
| Property VALUES | Frontmatter (YAML)          | Source of truth - portable, external-edit friendly |
| Property CACHE  | `noteProperties` table      | Fast queries, filtering, sorting (rebuildable)     |
| Property SCHEMA | `propertyDefinitions` table | Vault-wide type definitions                        |

**External Edit Flow**:

1. User edits frontmatter in VS Code/Obsidian
2. chokidar detects file change
3. `handleFileChange()` parses frontmatter
4. `extractProperties()` extracts properties
5. `inferPropertyType()` determines/confirms types
6. `setNoteProperties()` syncs to DB cache
7. Event emitted with `source: 'external'`

### Wiki Links Implementation (T041-T049)

Uses BlockNote's `createInlineContentSpec`:

```typescript
import { createInlineContentSpec } from '@blocknote/core'

const WikiLink = createInlineContentSpec({
  type: 'wikiLink',
  propSchema: {
    target: { default: '' },
    alias: { default: '' }
  },
  content: 'styled'
})
```

### File Attachments (T068-T073)

Uses BlockNote's `createBlockSpec` for non-image files:

```typescript
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
