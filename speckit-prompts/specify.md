# Memry Specify Prompts

Use these prompts with `/speckit.specify` to create feature specifications for Memry's backend infrastructure.

---

## Feature 1: Vault File System Foundation

```
/speckit.specify Implement the vault file system foundation for Memry - a local-first PKM application.

**What users need**:
- A dedicated folder on their machine (vault) that stores all their notes, journals, and tasks
- Files stored as plain Markdown so they can open them in any text editor
- Automatic vault initialization with sensible folder structure
- Ability to choose and change vault location

**User journeys**:
1. First-time user opens Memry → prompted to create or select vault location → vault initialized with folders
2. User creates a note → file appears in vault/notes/ folder as markdown
3. User opens vault folder in Finder/Explorer → sees organized, human-readable files
4. User changes vault location in settings → all data moves to new location seamlessly

**Key behaviors**:
- Vault structure: /notes, /journal, /inbox, /attachments, /.memry (config/index)
- Files must be readable without Memry (standard Markdown with YAML frontmatter)
- File changes should be detected and synced to app state
- Atomic writes to prevent data corruption
- Handle file conflicts gracefully

**Success looks like**:
- User's data is always accessible even if Memry is uninstalled
- No data loss on crashes or unexpected shutdowns
- Files can be edited externally and changes appear in app
```

---

## Feature 2: Note Persistence Layer

```
/speckit.specify Implement note persistence for Memry - saving, loading, and managing notes as Markdown files in the vault.

**What users need**:
- Create notes that are automatically saved to the vault
- Notes stored as Markdown files with metadata in YAML frontmatter
- Wiki-links [[other-note]] that create bidirectional connections
- Tags (#tag) that are indexed and searchable
- Title derived from filename or H1 heading

**User journeys**:
1. User creates new note → types content → note auto-saves to vault/notes/note-title.md
2. User adds [[link-to-note]] → backlinks panel shows this connection on both notes
3. User searches for #project-alpha → all notes with that tag appear
4. User renames note → all wiki-links to that note update automatically
5. User opens vault in Obsidian → notes display correctly with links working

**File format example**:
---
id: uuid-here
created: 2025-12-15T10:30:00Z
modified: 2025-12-15T14:22:00Z
tags: [project-alpha, meeting-notes]
---

# Meeting Notes - Project Alpha

Content here with [[linked-note]] references...

**Key behaviors**:
- Auto-save with debouncing (save 1 second after typing stops)
- Parse and index wiki-links for backlink resolution
- Parse and index tags for tag-based filtering
- Handle duplicate filenames gracefully
- Support nested folders within notes directory
```

---

## Feature 3: Journal Persistence Layer

```
/speckit.specify Implement journal persistence for Memry - daily journal entries stored as dated Markdown files.

**What users need**:
- One journal file per day, automatically created when they write
- Navigate between days (previous/next, calendar picker)
- Journal files named by date for easy browsing in file manager
- Daily notes that connect to tasks and notes from that day

**User journeys**:
1. User opens journal tab → today's entry loads (or creates if new)
2. User types in journal → content auto-saves to vault/journal/2025/12/2025-12-15.md
3. User navigates to previous day → that day's journal loads
4. User opens vault/journal/ in Finder → sees organized year/month/date structure
5. User references a note [[project-plan]] in journal → backlink appears on that note

**File format example**:
---
date: 2025-12-15
weather: sunny (optional, user-added)
mood: productive (optional, user-added)
---

# December 15, 2025

## Morning
Started the day with...

## Tasks completed
- [x] Review PR #123
- [ ] Write documentation

## Notes referenced
- [[project-plan]]
- [[meeting-notes]]

**Key behaviors**:
- Date-based file naming: YYYY-MM-DD.md
- Folder structure: journal/YYYY/MM/YYYY-MM-DD.md
- Auto-create today's file on first write
- Parse task checkboxes for task integration
- Index wiki-links for bidirectional linking
```

---

## Feature 4: Task Persistence Layer

```
/speckit.specify Implement task persistence for Memry - storing tasks with support for projects, priorities, due dates, and recurrence.

**What users need**:
- Tasks that persist across app restarts
- Tasks organized by projects
- Due dates, priorities, and completion status
- Recurring task support (daily, weekly, monthly)
- Tasks can link to notes for context

**User journeys**:
1. User creates task "Review PR" with due date tomorrow → task saved and appears in Today view tomorrow
2. User creates project "Website Redesign" → adds tasks to it → tasks grouped under project
3. User completes a recurring task → next occurrence automatically created
4. User links task to [[meeting-notes]] → can jump to context from task
5. User opens tasks.json in text editor → sees structured, readable task data

**Storage approach**:
- Tasks stored in vault/.memry/tasks.json (or SQLite: vault/.memry/memry.db)
- Projects stored alongside tasks
- Maintain human-readable format where possible
- Support export to standard formats (Todoist, Things, etc.)

**Key behaviors**:
- CRUD operations for tasks and projects
- Filter by: today, upcoming, project, priority, completed
- Sort by: due date, priority, created date, manual order
- Subtask support with parent-child relationships
- Completion history for analytics
```

---

## Feature 5: End-to-End Encryption Layer

```
/speckit.specify Implement end-to-end encryption for Memry vault - protecting user data with user-controlled encryption keys.

**What users need**:
- Option to encrypt their entire vault with a password/key
- Encryption happens locally - keys never leave their device
- Ability to unlock vault on app startup
- Emergency recovery options (recovery key, key file)

**User journeys**:
1. User enables encryption → creates master password → vault encrypted at rest
2. User opens Memry → enters password → vault unlocked for session
3. User forgets password → uses recovery key to regain access
4. User exports vault → encrypted archive that can be decrypted with password
5. User disables encryption → vault decrypted and stored as plain Markdown again

**Security requirements**:
- AES-256-GCM for file encryption
- Argon2id for key derivation from password
- Individual file encryption (not whole-vault archive)
- Encrypted filenames option for maximum privacy
- Secure memory handling (clear keys from memory when locked)

**Key behaviors**:
- Encrypt on write, decrypt on read (transparent to app logic)
- Lock vault after inactivity timeout (configurable)
- Support hardware keys (YubiKey) for unlocking
- Never store master password - only derived key verification
- Encrypted files have .encrypted extension or stored in encrypted container
```

---

## Feature 6: Inbox & Quick Capture

```
/speckit.specify Implement inbox and quick capture for Memry - fast capture of thoughts, links, and content for later processing.

**What users need**:
- Quickly capture thoughts without deciding where they go
- Capture links with automatic metadata extraction
- Process inbox items by filing to notes, tasks, or trash
- Global hotkey capture even when app is in background

**User journeys**:
1. User presses global hotkey → quick capture window appears → types thought → saved to inbox
2. User pastes URL → link saved with auto-extracted title and preview
3. User opens inbox → sees all captured items → files note to "Projects" folder
4. User bulk-selects stale items (7+ days) → moves to archive or deletes
5. User captures voice memo → transcribed and saved to inbox

**Storage format**:
- Inbox items in vault/.memry/inbox.json or vault/inbox/ as individual files
- Each item has: id, type, content, created, processed status
- Link items include: url, title, description, favicon

**Key behaviors**:
- Capture types: text note, link, image, voice memo
- Quick capture window with minimal UI (just text input)
- Background capture via global keyboard shortcut
- Auto-extract metadata from URLs
- Tag suggestions based on content
```

---

## Feature 7: Search & Indexing

```
/speckit.specify Implement full-text search and indexing for Memry - fast search across all vault content.

**What users need**:
- Instant search across all notes, journals, and tasks
- Search by content, title, tags, and metadata
- Fuzzy matching for typos and partial matches
- Search results with context preview

**User journeys**:
1. User types in search bar → results appear instantly as they type
2. User searches "meeting" → sees all notes/journals containing "meeting" with highlighted excerpts
3. User filters search to #project-alpha → only tagged items shown
4. User searches for [[broken-link]] → finds notes with unresolved links
5. User searches date range → finds journal entries from that period

**Index requirements**:
- Full-text index of all Markdown content
- Separate indexes for: titles, tags, wiki-links, dates
- Index stored in vault/.memry/search.index (SQLite FTS5 or similar)
- Incremental index updates on file changes

**Key behaviors**:
- Search-as-you-type with debouncing
- Fuzzy matching with typo tolerance
- Boolean operators (AND, OR, NOT)
- Filter by: type (note/journal/task), date range, tags, folder
- Sort results by: relevance, date modified, date created
```

---

## Usage

1. Copy the desired feature prompt
2. Run `/speckit.specify <paste prompt>`
3. The command will create a feature branch and specification
4. Review the generated spec.md
5. Run `/speckit.clarify` if there are unresolved questions
6. Proceed to `/speckit.plan` with tech stack details
