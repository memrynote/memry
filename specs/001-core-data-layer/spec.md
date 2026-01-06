# Feature Specification: Core Data Layer

**Feature Branch**: `001-core-data-layer`
**Created**: 2025-12-17
**Status**: Draft
**Input**: User description: "Build the core data layer for Memry that manages local storage with file system integration and SQLite database"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Store Notes as Portable Markdown Files (Priority: P1)

As a user, I want my notes stored as markdown files in a vault folder so I can edit them with any text editor and they're not locked into Memry.

**Why this priority**: This is the foundational capability that enables local-first architecture. Without portable file storage, users cannot trust the app with their data. This directly supports the constitutional principle of "No Vendor Lock-In."

**Independent Test**: Can be fully tested by creating a note in Memry, then opening the same file in VS Code or any text editor. The file should be readable markdown with standard frontmatter.

**Acceptance Scenarios**:

1. **Given** I am using Memry for the first time, **When** I create a new note titled "My First Note," **Then** a markdown file appears in my vault folder with that title and readable content.
2. **Given** I have notes in Memry, **When** I open the vault folder in Finder/Explorer, **Then** I see my notes as individual .md files that I can open in any text editor.
3. **Given** I have a note open in VS Code, **When** I read its content, **Then** I can understand the structure (frontmatter + content) without Memry-specific knowledge.

---

### User Story 2 - Detect External File Changes (Priority: P1)

As a user, I want Memry to detect when I edit files externally (VS Code, Finder, git pull) and reflect changes immediately without manual refresh.

**Why this priority**: Users work with multiple tools. If Memry doesn't detect external changes, it becomes a data silo and creates confusion about which version is current. This is essential for the "window into your files" philosophy.

**Independent Test**: Can be fully tested by editing a note file in VS Code while Memry is open. Changes should appear in Memry within 500ms without any user action.

**Acceptance Scenarios**:

1. **Given** I have a note open in Memry, **When** I edit and save the same file in VS Code, **Then** Memry shows the updated content within 500ms without me clicking anything.
2. **Given** I have Memry open, **When** I create a new .md file directly in my vault folder using Finder, **Then** the new note appears in Memry's list within 500ms.
3. **Given** I have notes in Memry, **When** I delete a file from my vault folder using Finder, **Then** the note disappears from Memry within 500ms.
4. **Given** I am using git for version control, **When** I run `git pull` and files change, **Then** Memry reflects all changes without requiring restart or refresh.

---

### User Story 3 - Track File Renames Without Breaking Links (Priority: P1)

As a user, I want file renames to be tracked properly so my internal links and references don't break.

**Why this priority**: Users frequently rename files as their thinking evolves. If renaming breaks internal links, users will avoid organizing their notes, reducing the tool's value.

**Independent Test**: Can be fully tested by renaming a file that has backlinks pointing to it. After rename, clicking those backlinks should still navigate to the renamed file.

**Acceptance Scenarios**:

1. **Given** I have "Note A" that links to "Note B," **When** I rename "Note B" to "Note B Updated" in Finder, **Then** the link in "Note A" still works and navigates to the renamed file.
2. **Given** I rename a file in Memry, **When** I check the vault folder, **Then** the file is renamed on disk and any notes linking to it still function.
3. **Given** a note has a unique identifier in its frontmatter, **When** I rename the file, **Then** the identifier remains unchanged and the system tracks the new location.

---

### User Story 4 - Fast Search Across All Notes (Priority: P1)

As a user, I want fast search and filtering without waiting for the app to read every file.

**Why this priority**: With hundreds or thousands of notes, searching must be instantaneous. Slow search makes the app frustrating and unusable as a knowledge management tool.

**Independent Test**: Can be fully tested by having 1,000+ notes and searching for a term. Results should appear in under 50ms.

**Acceptance Scenarios**:

1. **Given** I have 1,000 notes in my vault, **When** I search for "meeting notes," **Then** relevant results appear in under 50 milliseconds.
2. **Given** I start typing in the search box, **When** I type each character, **Then** results update in real-time without noticeable delay.
3. **Given** I search for a phrase, **When** results appear, **Then** they include matches in both note titles and note content.

---

### User Story 5 - Choose Vault Location (Priority: P2)

As a user, I want to choose where my vault folder is located (Documents, Dropbox, iCloud, etc.).

**Why this priority**: Users have different preferences for file organization and cloud sync. Some want Dropbox sync, others prefer iCloud, and some want local-only storage.

**Independent Test**: Can be fully tested by selecting different folder locations during setup and verifying files are created there.

**Acceptance Scenarios**:

1. **Given** I am launching Memry for the first time, **When** the app starts, **Then** I see a folder picker dialog asking me to choose my vault location.
2. **Given** I want to use Dropbox, **When** I select a folder inside Dropbox, **Then** Memry uses that location and my notes sync via Dropbox.
3. **Given** I selected an invalid location (no write permission), **When** I click confirm, **Then** I see a clear error message explaining the problem.

---

### User Story 6 - Remember Vault Location (Priority: P2)

As a user, I want the app to remember my vault location between sessions.

**Why this priority**: Having to re-select the vault every time would be extremely frustrating and error-prone.

**Independent Test**: Can be fully tested by closing and reopening the app. The vault should load automatically without prompts.

**Acceptance Scenarios**:

1. **Given** I have previously selected a vault location, **When** I close and reopen Memry, **Then** my vault loads automatically without asking for location again.
2. **Given** I moved my vault folder to a new location, **When** I open Memry, **Then** I can update the vault location from settings.

---

### User Story 7 - See Indexing Progress (Priority: P2)

As a user, I want to see a loading indicator while the vault is being indexed on first open.

**Why this priority**: Without feedback, users might think the app is frozen during initial indexing of large vaults.

**Independent Test**: Can be fully tested by opening a vault with 1,000 files and observing the loading indicator.

**Acceptance Scenarios**:

1. **Given** I open a vault with many files for the first time, **When** indexing is in progress, **Then** I see a loading indicator showing progress.
2. **Given** indexing is in progress, **When** I look at the indicator, **Then** I understand approximately how long it will take.
3. **Given** indexing completes, **When** the loading indicator disappears, **Then** I can immediately search and access all my notes.

---

### User Story 8 - Automatic Database Recovery (Priority: P2)

As a user, I want the database to rebuild automatically if it gets corrupted.

**Why this priority**: Database corruption should never cause data loss or require technical intervention. The source of truth is the files, so recovery should be automatic.

**Independent Test**: Can be fully tested by manually corrupting the index file and reopening the app. It should rebuild without user intervention.

**Acceptance Scenarios**:

1. **Given** the index database is corrupted, **When** I open Memry, **Then** it automatically rebuilds the index from my files without losing any data.
2. **Given** automatic recovery occurs, **When** it completes, **Then** I see a notification that recovery happened and all notes are available.

---

### User Story 9 - Multiple Vaults (Priority: P3)

As a user, I want to have multiple vaults I can switch between.

**Why this priority**: Power users may want separate vaults for work and personal notes, or for different projects.

**Independent Test**: Can be fully tested by creating two vaults and switching between them.

**Acceptance Scenarios**:

1. **Given** I have multiple vault folders, **When** I access vault settings, **Then** I can add additional vaults and switch between them.
2. **Given** I switch vaults, **When** the new vault loads, **Then** I see only notes from that vault with correct search results.

---

### User Story 10 - Exclude Folders from Indexing (Priority: P3)

As a user, I want to exclude certain folders from indexing (node_modules, .git).

**Why this priority**: Users may store their vault in a development project or have folders that shouldn't be indexed.

**Independent Test**: Can be fully tested by configuring exclusions and verifying excluded files don't appear in search.

**Acceptance Scenarios**:

1. **Given** I have a .git folder in my vault, **When** Memry indexes, **Then** files inside .git are not indexed or shown.
2. **Given** I configure node_modules as excluded, **When** I search, **Then** no results from node_modules appear.
3. **Given** I want to exclude a custom folder, **When** I add it to exclusions in settings, **Then** that folder is no longer indexed.

---

### Edge Cases

- What happens when a file has no frontmatter? The system adds a unique identifier on first edit.
- What happens when a file has a duplicate identifier (copy-paste)? The system generates a new unique identifier for the duplicate.
- What happens when a binary file is placed in the notes folder? The system ignores it gracefully without errors.
- What happens when a very large file (>10MB) is opened? The UI remains responsive; the file loads progressively or shows a warning.
- What happens with unicode filenames and content? The system handles international characters correctly.
- What happens when a file is locked by another application? The system handles gracefully and retries, or informs the user.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST store notes as plain markdown files with YAML frontmatter in a user-selected vault folder.
- **FR-002**: System MUST allow users to select their vault folder location on first launch via a native folder picker.
- **FR-003**: System MUST persist the vault location between application sessions.
- **FR-004**: System MUST detect file changes made outside the application (create, modify, delete, rename) within 500ms.
- **FR-005**: System MUST track file identity across renames using a unique identifier in frontmatter, not file path.
- **FR-006**: System MUST provide full-text search across all notes that returns results within 50ms for 10,000 notes.
- **FR-007**: System MUST maintain a searchable index that can be completely rebuilt from source files at any time.
- **FR-008**: System MUST store structured data (tasks, projects, settings) in a separate data store that is the source of truth for that data.
- **FR-009**: System MUST show progress indication during initial vault indexing.
- **FR-010**: System MUST automatically recover from index corruption by rebuilding from source files.
- **FR-011**: System MUST ignore specified folders from indexing (e.g., .git, node_modules, .DS_Store).
- **FR-012**: System MUST add a unique identifier to files that don't have one when they are first edited.
- **FR-013**: System MUST generate new unique identifiers for files with duplicate identifiers.
- **FR-014**: System MUST write files atomically (write to temporary location, then rename) to prevent data loss.
- **FR-015**: System MUST support switching between multiple vaults.
- **FR-016**: System MUST handle large files (>10MB) without freezing the user interface.
- **FR-017**: System MUST support unicode characters in filenames and content.

### Key Entities

- **Note**: A markdown document with frontmatter containing a unique identifier, title, creation date, and modification date. Stored as a .md file. Can contain tags and custom properties.
- **Journal Entry**: A specialized note type for daily journaling, named by date (YYYY-MM-DD.md). Stored in a journal subfolder.
- **Attachment**: A binary file (image, PDF, voice recording) associated with notes. Stored in an attachments subfolder.
- **Vault**: A folder on the user's file system containing notes, journal entries, attachments, and app data. The user can have multiple vaults.
- **Task**: A structured data item representing a to-do item. Stored in the data store, not as files.
- **Project**: A container for grouping related tasks. Stored in the data store.
- **Tag**: A label that can be applied to notes for categorization. Stored in note frontmatter.
- **Internal Link**: A reference from one note to another, identified by the target's unique identifier.

### Assumptions

- Users have read/write access to their selected vault folder.
- The vault folder is on a local or locally-mounted file system (not a network share with high latency).
- Files in the vault are text-based markdown or recognized binary formats.
- Users understand that the app data folder inside the vault (.memry) should not be manually edited.
- Standard default exclusion patterns (.git, node_modules, .DS_Store, *.tmp) cover most use cases.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can create, edit, and delete notes that are immediately accessible in other text editors as standard markdown files.
- **SC-002**: File changes made in external editors appear in the app within 500 milliseconds, measured from file save to UI update.
- **SC-003**: Initial vault indexing completes within 5 seconds for 1,000 files.
- **SC-004**: Full-text search returns results within 50 milliseconds for a vault containing 10,000 notes.
- **SC-005**: File renames preserve all internal links 100% of the time when files have unique identifiers.
- **SC-006**: App closes with pending changes without losing any user data (zero data loss tolerance).
- **SC-007**: Corrupted index triggers automatic recovery within 10 seconds for 1,000 files, with no user intervention required.
- **SC-008**: 95% of users can complete vault setup on first launch without consulting documentation.
- **SC-009**: App startup to usable state (vault loaded, search available) completes in under 3 seconds.
- **SC-010**: UI remains responsive (60fps scrolling, <100ms interaction response) even with 1,000+ items visible.
