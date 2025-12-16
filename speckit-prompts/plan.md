# Memry Plan Prompts

Use these prompts with `/speckit.plan` to create technical implementation plans with Memry's specific tech stack.

---

## Base Tech Stack (Use for ALL features)

```
/speckit.plan

**Tech Stack - Memry Desktop Application**:

**Platform**: Electron 33+ desktop application (macOS, Windows, Linux)
**Runtime**: Node.js 20+ (main process), Chromium (renderer)

**Frontend (Renderer Process)**:
- Framework: React 19 with TypeScript 5.x (strict mode)
- Build Tool: electron-vite
- UI Components: shadcn/ui with Tailwind CSS 4.x
- State Management: React Context + useReducer (already implemented)
- Rich Text Editor: Tiptap (with extensions) or BlockNote
- Drag & Drop: @dnd-kit
- Date Handling: date-fns
- Notifications: sonner (toast)
- Theming: next-themes (dark mode support)

**Backend (Main Process)**:
- File System: Node.js fs/promises with atomic writes
- Database: better-sqlite3 (for indexes, metadata, tasks)
- File Watching: chokidar (vault file change detection)
- Encryption: Node.js crypto (AES-256-GCM) + argon2 (key derivation)
- IPC: Electron contextBridge + ipcMain/ipcRenderer

**Storage Strategy**:
- Notes/Journals: Plain Markdown files in user's vault folder
- Tasks/Projects: SQLite database at vault/.memry/memry.db
- Search Index: SQLite FTS5 at vault/.memry/search.db
- App Config: vault/.memry/config.json
- Encryption Keys: OS keychain (keytar) - never stored in files

**Testing**:
- Unit Tests: Vitest
- E2E Tests: Playwright (Electron mode)
- Type Checking: tsc --noEmit

**Project Structure** (existing):
src/
├── main/           # Electron main process (Node.js)
│   ├── index.ts    # App entry, window management
│   ├── ipc/        # IPC handlers (NEW)
│   ├── services/   # File system, database, encryption (NEW)
│   └── vault/      # Vault management (NEW)
├── preload/        # Context bridge (security boundary)
│   ├── index.ts    # Exposed APIs
│   └── index.d.ts  # Type definitions
└── renderer/       # React frontend (existing, complete)
    └── src/
        ├── components/
        ├── contexts/
        ├── hooks/
        ├── pages/
        └── lib/

**Constraints**:
- Renderer MUST NOT have direct Node.js/fs access (context isolation)
- All file operations through IPC
- Atomic writes (write to temp, then rename)
- Max 100ms UI response time
- SQLite for structured data, Markdown for content
- No network requests without explicit user action
```

---

## Feature-Specific Plan Prompts

### Vault File System Plan

```
/speckit.plan The vault file system for Memry.

**Additional Context**:
- Vault is a user-selected folder containing all PKM data
- Structure: /notes, /journal, /inbox, /attachments, /.memry (internal)
- Files are plain Markdown, human-readable without Memry
- Must handle external file changes (user edits in VSCode, Obsidian)

**Key Technical Decisions**:
- Use chokidar for file watching with debouncing
- Atomic writes via write-to-temp-then-rename pattern
- File metadata stored in YAML frontmatter (parsed with gray-matter)
- .memry folder for SQLite databases and config (hidden from user)

**IPC API needed**:
- vault:initialize(path) → create vault structure
- vault:select() → open folder picker, validate, return path
- vault:getConfig() → read vault config
- vault:setConfig(config) → update vault config
- file:read(relativePath) → read file content
- file:write(relativePath, content) → atomic write
- file:delete(relativePath) → move to trash
- file:list(folder) → list files in folder
- file:watch(callback) → subscribe to file changes
```

---

### Note Persistence Plan

```
/speckit.plan Note persistence layer for Memry.

**Additional Context**:
- Notes stored as: vault/notes/{title-slug}.md
- Support nested folders: vault/notes/projects/website.md
- Wiki-links [[note-name]] parsed and indexed for backlinks
- Tags #tag parsed and indexed for filtering

**Key Technical Decisions**:
- gray-matter for frontmatter parsing
- remark/unified for Markdown AST (extract links, tags)
- SQLite table for note metadata + backlink index
- Debounced auto-save (1 second after last keystroke)

**Data Model**:
- Note: id, title, slug, path, created, modified, tags[], backlinks[]
- NoteLink: sourceId, targetId, context (for backlink preview)

**IPC API needed**:
- note:create(title, folder?) → create note, return path
- note:read(path) → return content + metadata
- note:update(path, content) → atomic save
- note:delete(path) → move to trash
- note:rename(oldPath, newTitle) → rename + update all links
- note:list(folder?) → list notes with metadata
- note:search(query) → full-text search
- note:getBacklinks(path) → get notes linking to this one
```

---

### Journal Persistence Plan

```
/speckit.plan Journal persistence layer for Memry.

**Additional Context**:
- One file per day: vault/journal/YYYY/MM/YYYY-MM-DD.md
- Auto-create today's entry on first write
- Support navigation between dates
- Parse task checkboxes for integration

**Key Technical Decisions**:
- Date-based file path generation
- Create parent folders (year/month) as needed
- Same frontmatter parsing as notes
- Index by date for calendar heatmap data

**Data Model**:
- JournalEntry: date, path, wordCount, hasContent, linkedNotes[]

**IPC API needed**:
- journal:getEntry(date) → read or create entry
- journal:saveEntry(date, content) → atomic save
- journal:listEntries(startDate, endDate) → for calendar view
- journal:getStats(year, month?) → word counts, streak data
```

---

### Task Persistence Plan

```
/speckit.plan Task persistence layer for Memry.

**Additional Context**:
- Tasks stored in SQLite: vault/.memry/memry.db
- Complex queries: filter by project, date, priority, status
- Recurring tasks with next occurrence calculation
- Task order persisted for manual sorting

**Key Technical Decisions**:
- better-sqlite3 for synchronous, fast queries
- Separate tables: tasks, projects, task_order
- JSON column for repeatConfig (flexible schema)
- Soft delete with archivedAt timestamp

**Data Model** (match existing TypeScript types):
- Task: id, title, description, projectId, statusId, priority,
        dueDate, dueTime, isRepeating, repeatConfig,
        linkedNoteIds, parentId, subtaskIds,
        createdAt, completedAt, archivedAt, sortOrder
- Project: id, name, description, icon, color, isDefault, isArchived
- Status: id, name, color, projectId, sortOrder

**IPC API needed**:
- task:create(task) → insert task, return with id
- task:update(id, changes) → partial update
- task:delete(id) → soft delete (archive)
- task:list(filters) → filtered task list
- task:reorder(taskIds) → update sort order
- project:create/update/delete/list → project CRUD
- task:complete(id) → mark done, handle recurrence
```

---

### Encryption Plan

```
/speckit.plan End-to-end encryption layer for Memry.

**Additional Context**:
- User sets master password → derives encryption key
- Individual files encrypted (not whole-vault archive)
- Transparent encrypt-on-write, decrypt-on-read
- Key stored in OS keychain, never in files

**Key Technical Decisions**:
- argon2 (via argon2 npm package) for key derivation
- AES-256-GCM via Node.js crypto
- keytar for OS keychain access
- Encrypted files: same name with .enc extension OR encrypted content with magic header
- Verification: store hash of known value to verify correct password

**Security Model**:
- Master password → Argon2id → 256-bit key
- Each file: random IV + AES-GCM encrypt + auth tag
- Key never written to disk, only derived and held in memory
- Auto-lock after configurable inactivity timeout
- Clear keys from memory on lock

**IPC API needed**:
- encryption:setup(password) → derive key, store in keychain
- encryption:unlock(password) → verify, load key to memory
- encryption:lock() → clear key from memory
- encryption:isSetup() → check if encryption configured
- encryption:isUnlocked() → check current state
- encryption:changePassword(old, new) → re-derive, re-encrypt verification
```

---

### Search & Indexing Plan

```
/speckit.plan Full-text search and indexing for Memry.

**Additional Context**:
- Index all Markdown content from notes and journals
- Support tag filtering, date ranges, fuzzy matching
- Incremental updates on file changes
- Search-as-you-type with results in <100ms

**Key Technical Decisions**:
- SQLite FTS5 for full-text search
- Separate search.db to keep index isolated
- Index fields: title, content, tags, path, type, modified
- Rebuild index on vault switch/corruption

**Index Schema**:
CREATE VIRTUAL TABLE search_index USING fts5(
  id, type, title, content, tags, path, modified,
  tokenize='porter unicode61'
);

**IPC API needed**:
- search:query(text, filters?) → search results with snippets
- search:reindex() → full rebuild
- search:updateFile(path) → incremental update
- search:removeFile(path) → remove from index
- search:suggest(prefix) → autocomplete suggestions
```

---

## Usage

1. First, run `/speckit.specify` to create the feature spec
2. Copy the relevant plan prompt above
3. Run `/speckit.plan <paste prompt>`
4. The command will generate: plan.md, research.md, data-model.md, contracts/
5. Review generated artifacts
6. Run `/speckit.tasks` to break into actionable tasks
7. Run `/speckit.implement` to execute

## Tech Stack Quick Reference

| Layer | Technology | Purpose |
|-------|------------|---------|
| UI Framework | React 19 | Component rendering |
| UI Components | shadcn/ui | Pre-built accessible components |
| Styling | Tailwind CSS 4 | Utility-first CSS |
| Build | electron-vite | Fast dev/build for Electron |
| Desktop | Electron 33+ | Cross-platform desktop |
| Database | better-sqlite3 | Tasks, metadata, indexes |
| Search | SQLite FTS5 | Full-text search |
| File Watch | chokidar | Vault file monitoring |
| Encryption | crypto + argon2 | E2EE implementation |
| Key Storage | keytar | OS keychain access |
| Markdown | gray-matter + remark | Frontmatter + AST parsing |
| Testing | Vitest + Playwright | Unit + E2E tests |
