# Feature Specification: Notes System

**Feature Branch**: `003-notes`
**Created**: 2025-12-18
**Status**: Draft
**Input**: User description: "Build the notes system that connects to the existing NotePage component and enables rich note-taking with properties, tags, and bidirectional linking"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Rich Text Note Editing (Priority: P1)

As a user, I want to create and edit notes with rich text formatting (headings, bold, italic, lists, code blocks) so I can structure my thoughts and information clearly.

**Why this priority**: Core note-taking functionality is the foundation of the entire notes system. Without the ability to create and edit notes with rich formatting, no other features are useful.

**Independent Test**: Can be fully tested by creating a new note, adding various formatting (headings, bold text, bulleted lists, code blocks), and verifying the formatting renders correctly. Delivers immediate value as a standalone writing tool.

**Acceptance Scenarios**:

1. **Given** the user is viewing an empty note, **When** they type text and apply heading formatting, **Then** the text displays as a heading with appropriate visual styling
2. **Given** the user selects text, **When** they apply bold or italic formatting via toolbar or keyboard shortcut, **Then** the selected text becomes bold or italic
3. **Given** the user is editing a note, **When** they create a bulleted or numbered list, **Then** list items are properly indented and formatted
4. **Given** the user types a code block using backtick syntax, **When** they complete the block, **Then** code is displayed with monospace font and syntax highlighting

---

### User Story 2 - Auto-Save (Priority: P1)

As a user, I want my notes saved automatically as I type so I never lose my work due to forgetting to save or unexpected issues.

**Why this priority**: Data integrity is critical. Users expect modern apps to save automatically. Losing work destroys trust and makes the app unusable.

**Independent Test**: Can be tested by creating a note, typing content, waiting for save indicator, then closing and reopening to verify content persists. Delivers peace of mind that work is never lost.

**Acceptance Scenarios**:

1. **Given** the user is editing a note, **When** they pause typing for 1 second, **Then** the note content is automatically saved
2. **Given** a note is saving, **When** save completes successfully, **Then** a "Saved" indicator briefly appears
3. **Given** the user has unsaved changes, **When** the application crashes or closes unexpectedly, **Then** the content from the last successful save is preserved
4. **Given** a save operation is in progress, **When** the user continues typing, **Then** a new save is queued and executes after the current save completes

---

### User Story 3 - Tags (Priority: P1)

As a user, I want to add tags to my notes so I can organize and filter them by topic, project, or category.

**Why this priority**: Tags are the primary organizational tool for finding and grouping related notes. Essential for any note collection larger than a handful of notes.

**Independent Test**: Can be tested by adding tags to a note, verifying they appear in the UI, then filtering the notes list by a tag. Delivers organizational capability immediately.

**Acceptance Scenarios**:

1. **Given** a note without tags, **When** the user adds a tag via the tag input, **Then** the tag appears on the note and is persisted
2. **Given** the user is typing a tag, **When** they begin typing, **Then** autocomplete suggestions appear showing existing tags
3. **Given** a note has tags, **When** the user clicks a tag in the notes list, **Then** the list filters to show only notes with that tag
4. **Given** a note has a tag, **When** the user removes the tag, **Then** the tag is removed from the note and the filter updates accordingly

---

### User Story 4 - Wiki-Style Linking (Priority: P1)

As a user, I want to link notes together using [[wiki-style links]] so I can create connections between related ideas and navigate between notes.

**Why this priority**: Bidirectional linking is what transforms a collection of notes into a knowledge graph. It's the core differentiator from simple note apps.

**Independent Test**: Can be tested by typing [[, selecting a note from autocomplete, clicking the link to navigate, and verifying navigation works. Delivers connected note-taking immediately.

**Acceptance Scenarios**:

1. **Given** the user is editing a note, **When** they type "[[", **Then** an autocomplete dropdown appears with note titles
2. **Given** the autocomplete is showing, **When** the user selects a note, **Then** [[Note Title]] is inserted at the cursor
3. **Given** a note contains a wiki link, **When** the user clicks the link, **Then** the linked note opens in a new tab
4. **Given** a wiki link references a non-existent note, **When** the user clicks the link, **Then** they are offered the option to create the new note

---

### User Story 5 - Backlinks (Priority: P1)

As a user, I want to see what other notes link to the current note (backlinks) so I can discover connections and navigate my knowledge graph.

**Why this priority**: Backlinks complete the bidirectional linking story. Without them, links are one-way and users can't discover incoming connections.

**Independent Test**: Can be tested by creating Note A that links to Note B, opening Note B, and verifying Note A appears in the backlinks section. Delivers knowledge discovery immediately.

**Acceptance Scenarios**:

1. **Given** a note has incoming links, **When** the user views the note, **Then** a backlinks section shows all notes that link to this note
2. **Given** the backlinks section is visible, **When** the user clicks a backlink entry, **Then** the source note opens in a new tab
3. **Given** a note previously linked here is updated to remove the link, **When** the backlinks are refreshed, **Then** that note no longer appears in backlinks
4. **Given** a note has many backlinks, **When** viewing the backlinks section, **Then** each entry shows a snippet of context around the link

---

### User Story 6 - Custom Properties (Priority: P2)

As a user, I want to add custom properties to notes (like Notion database fields) so I can track structured data like status, rating, or dates.

**Why this priority**: Properties enable database-like functionality, allowing users to sort, filter, and view notes in structured ways. Important for power users.

**Independent Test**: Can be tested by adding a property (e.g., "Status: Draft"), changing its value, and verifying it persists and displays correctly.

**Acceptance Scenarios**:

1. **Given** a note without properties, **When** the user adds a new property, **Then** they can choose a property type (text, number, date, checkbox, select, rating) and enter a name
2. **Given** a note has a checkbox property, **When** the user clicks the checkbox, **Then** the value toggles and persists
3. **Given** a note has a date property, **When** the user clicks the date field, **Then** a date picker appears
4. **Given** a note has a rating property, **When** the user clicks stars, **Then** the rating value updates (1-5 scale)

---

### User Story 7 - Emoji Icons (Priority: P2)

As a user, I want to assign an emoji icon to each note so I can visually identify notes quickly in lists and tabs.

**Why this priority**: Visual recognition speeds up navigation and makes the interface more engaging. Low effort with high user satisfaction impact.

**Independent Test**: Can be tested by clicking the emoji icon area, selecting an emoji, and verifying it appears on the note and in the notes list.

**Acceptance Scenarios**:

1. **Given** a note without an emoji, **When** the user clicks the emoji placeholder, **Then** an emoji picker appears
2. **Given** the emoji picker is open, **When** the user selects an emoji, **Then** it becomes the note's icon and appears in the note header and list
3. **Given** a note has an emoji, **When** the user clicks it and selects a different emoji, **Then** the icon updates

---

### User Story 8 - Attachments (Priority: P2)

As a user, I want to embed images and attachments in my notes so I can keep related files together with my text content.

**Why this priority**: Images and files are essential for many note-taking use cases (meeting notes, research, documentation). Significantly expands utility.

**Independent Test**: Can be tested by dragging an image into a note, verifying it displays inline, and confirming the file is stored in the attachments folder.

**Acceptance Scenarios**:

1. **Given** the user is editing a note, **When** they drag an image file into the editor, **Then** the image is uploaded and displayed inline
2. **Given** an image is embedded, **When** the user clicks it, **Then** the image opens in a larger view or system viewer
3. **Given** the user drags a non-image file, **When** they drop it in the editor, **Then** a download link is inserted
4. **Given** an attachment is uploaded, **Then** the file is stored in the vault/attachments directory with a unique name

---

### User Story 9 - Heading Outline (Priority: P2)

As a user, I want to see an outline of headings in long notes so I can quickly navigate to specific sections.

**Why this priority**: Navigation becomes difficult in long notes. An outline provides structure and quick access to sections.

**Independent Test**: Can be tested by creating a note with multiple headings, opening the outline panel, and clicking headings to navigate.

**Acceptance Scenarios**:

1. **Given** a note contains multiple headings, **When** the user opens the outline panel, **Then** a hierarchical list of headings is displayed
2. **Given** the outline is visible, **When** the user clicks a heading in the outline, **Then** the editor scrolls to that heading
3. **Given** headings are nested (H1 > H2 > H3), **Then** the outline reflects this hierarchy with indentation

---

### User Story 10 - Folder Organization (Priority: P2)

As a user, I want to organize notes in folders so I can group related notes together in a hierarchical structure.

**Why this priority**: Folders provide a familiar organizational paradigm. Important for users with many notes who prefer hierarchical organization over flat tags.

**Independent Test**: Can be tested by creating a folder, moving a note into it, and verifying the folder appears in the sidebar tree.

**Acceptance Scenarios**:

1. **Given** the sidebar is visible, **When** the user creates a new folder, **Then** the folder appears in the folder tree
2. **Given** a note exists, **When** the user drags it into a folder, **Then** the note moves to that folder
3. **Given** a folder exists, **When** the user renames it, **Then** the folder name updates in the tree and the underlying directory renames
4. **Given** a folder is empty, **When** the user deletes it, **Then** the folder is removed from the tree

---

### User Story 11 - Recently Edited Notes (Priority: P3)

As a user, I want to see recently edited notes so I can quickly access notes I've been working on.

**Why this priority**: Convenient but not essential. Users can navigate via other means (search, folders, tags).

**Independent Test**: Can be tested by editing several notes, then viewing the recent notes list to verify order matches edit times.

**Acceptance Scenarios**:

1. **Given** the user has edited notes, **When** they view the recent notes list, **Then** notes appear ordered by last modified time
2. **Given** a note is edited, **When** the recent list refreshes, **Then** that note moves to the top

---

### User Story 12 - Note Templates (Priority: P3)

As a user, I want templates for common note types so I can quickly create notes with predefined structure.

**Why this priority**: Time-saver for users with repetitive note structures (meeting notes, daily logs) but not essential for core functionality.

**Independent Test**: Can be tested by creating a template, then creating a new note from that template and verifying the structure is applied.

**Acceptance Scenarios**:

1. **Given** templates exist, **When** the user creates a new note, **Then** they can choose to start from a template
2. **Given** the user selects a template, **When** the note is created, **Then** it contains the template's predefined content

---

### User Story 13 - Export Notes (Priority: P3)

As a user, I want to export notes as PDF or HTML so I can share them or use them outside the application.

**Why this priority**: Useful for sharing and portability but not needed for daily note-taking workflow.

**Independent Test**: Can be tested by exporting a formatted note to PDF and verifying the output renders correctly.

**Acceptance Scenarios**:

1. **Given** a note is open, **When** the user chooses export to PDF, **Then** a PDF file is generated preserving formatting
2. **Given** a note is open, **When** the user chooses export to HTML, **Then** an HTML file is generated with embedded styles

---

### User Story 14 - Version History (Priority: P3)

As a user, I want version history so I can see previous edits and restore earlier versions if needed.

**Why this priority**: Safety net for accidental deletions or changes. Nice to have but auto-save handles most data loss scenarios.

**Independent Test**: Can be tested by editing a note multiple times, viewing version history, and restoring a previous version.

**Acceptance Scenarios**:

1. **Given** a note has been edited, **When** the user opens version history, **Then** they see a list of previous versions with timestamps
2. **Given** the version list is visible, **When** the user selects a version, **Then** they can preview it and optionally restore it

---

### Edge Cases

- What happens when a note file is edited externally while open in the app? **System detects file change and shows a conflict warning with options to reload or keep current version.**
- What happens when creating a link to a note that is subsequently deleted? **Broken links are visually indicated; clicking offers to recreate the note.**
- What happens when a very long note (10,000+ words) is edited? **Editor remains responsive with virtualized rendering; no UI stutter.**
- What happens when a note has 50+ backlinks? **Backlinks section loads progressively; does not block note opening.**
- What happens when two instances of the app edit the same note? **Last save wins with conflict detection on external changes.**
- What happens when the user types [[]] with no search term? **Autocomplete shows all notes sorted by recent access.**
- What happens when attachment upload fails? **Error message shown; content not lost; retry option available.**
- What happens when disk is full during save? **Error shown; content remains in memory; user prompted to free space.**

## Requirements *(mandatory)*

### Functional Requirements

#### Note CRUD
- **FR-001**: System MUST allow users to create new notes with a generated unique identifier
- **FR-002**: System MUST parse and display note content with YAML frontmatter metadata
- **FR-003**: System MUST save notes automatically 1 second after the user stops typing
- **FR-004**: System MUST use atomic writes (write to temp file, then rename) to prevent data corruption
- **FR-005**: System MUST update the modified timestamp on each save
- **FR-006**: System MUST move deleted notes to system trash (recoverable deletion)
- **FR-007**: System MUST allow renaming notes while preserving their unique identifier

#### Rich Text Editing
- **FR-008**: System MUST support headings (H1-H6), bold, italic, and strikethrough formatting
- **FR-009**: System MUST support ordered and unordered lists with proper nesting
- **FR-010**: System MUST support fenced code blocks with syntax highlighting
- **FR-011**: System MUST support inline code formatting
- **FR-012**: System MUST support blockquotes and horizontal rules

#### Wiki Links
- **FR-013**: System MUST recognize [[Note Title]] syntax as wiki links
- **FR-014**: System MUST recognize [[Note Title|display text]] syntax for aliased links
- **FR-015**: System MUST show autocomplete when user types "[["
- **FR-016**: System MUST open linked notes in a new tab when clicked
- **FR-017**: System MUST offer to create non-existent linked notes when clicked

#### Backlinks
- **FR-018**: System MUST compute and store outgoing links for each note on save
- **FR-019**: System MUST compute and display incoming links (backlinks) for each note
- **FR-020**: System MUST show a context snippet around each backlink
- **FR-021**: System MUST update backlinks when source notes are edited or deleted

#### Tags
- **FR-022**: System MUST store tags in note frontmatter
- **FR-023**: System MUST provide tag autocomplete with existing tags
- **FR-024**: System MUST normalize tags to lowercase
- **FR-025**: System MUST allow filtering notes list by tag
- **FR-026**: System MUST assign colors to tags for visual distinction

#### Properties
- **FR-027**: System MUST support text, number, checkbox, date, select, multiselect, url, and rating property types
- **FR-028**: System MUST store properties in note frontmatter
- **FR-029**: System MUST provide appropriate input controls for each property type
- **FR-030**: System MUST allow adding, editing, and removing properties from notes

#### Attachments
- **FR-031**: System MUST allow drag-and-drop upload of images and files
- **FR-032**: System MUST store attachments in vault/attachments/ directory
- **FR-033**: System MUST insert markdown image/link syntax for uploaded files
- **FR-034**: System MUST render embedded images inline in the editor

#### Organization
- **FR-035**: System MUST support folder hierarchy for organizing notes
- **FR-036**: System MUST display folder tree in sidebar
- **FR-037**: System MUST allow drag-and-drop of notes between folders
- **FR-038**: System MUST assign emoji icons to notes stored in frontmatter
- **FR-039**: System MUST provide emoji picker for icon selection

#### Outline
- **FR-040**: System MUST generate heading outline for notes with headings
- **FR-041**: System MUST allow clicking outline items to scroll to that heading

### Key Entities

- **Note**: A markdown document with YAML frontmatter containing id, title, emoji, created/modified timestamps, tags array, and properties object. Content stored as markdown with wiki-link syntax.

- **NoteIndex**: A cached representation of note metadata for fast querying. Contains denormalized tags, properties, outgoing links, and incoming links (backlinks). Updated on each note save.

- **Tag**: A user-defined label with a name (lowercase, no spaces) and color. Note count is computed from index.

- **PropertyDefinition**: Schema for a custom property including name, type (text/number/checkbox/date/select/multiselect/url/rating), options for select types, and optional default value.

- **Attachment**: A file stored in the attachments directory, referenced by notes via markdown syntax.

- **Folder**: A directory in the vault/notes/ hierarchy containing note files or other folders.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can open any note (including 100KB notes) and begin editing in under 100 milliseconds
- **SC-002**: Auto-save completes without causing any visible UI stutter or lag during continuous typing
- **SC-003**: Searching 10,000 notes by title, tag, or content returns results in under 50 milliseconds
- **SC-004**: Notes with 50+ backlinks load and display the backlinks section without blocking initial note display
- **SC-005**: Users can complete the workflow of creating a note, adding a tag, linking to another note, and saving in under 60 seconds on first use
- **SC-006**: Zero data loss: all auto-saved content survives application crashes and unexpected closures
- **SC-007**: Wiki link autocomplete appears within 100 milliseconds of typing "[["
- **SC-008**: Attachment uploads of files up to 10MB complete and display inline within 3 seconds
- **SC-009**: 95% of users can discover and use wiki linking without consulting documentation (intuitive [[syntax]])
- **SC-010**: Note index rebuilds from 10,000 files in under 5 seconds on application startup

## Assumptions

- Notes are stored as markdown files in a local vault directory (file-based, not cloud-synced in this phase)
- The existing NotePage component provides the container/layout; this feature implements the editor and data layer
- Users have sufficient disk space for note content and attachments
- The application has read/write access to the vault directory
- A single user accesses notes at a time (no real-time collaboration in this phase)
- The Electron main process handles file system operations; renderer process handles UI
- SQLite or similar will be used for the note index cache (implementation detail, not specified)
