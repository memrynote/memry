# Core Data Layer Specification

Foundation layer managing local storage, file system, and database operations.

```
/speckit.specify

Build the core data layer for Memry that manages local storage with file system integration and SQLite database:

## USER STORIES

### P1 - Critical
1. As a user, I want my notes stored as markdown files in a vault folder so I can edit them with any text editor and they're not locked into Memry
2. As a user, I want Memry to detect when I edit files externally (VS Code, Finder, git pull) and reflect changes immediately without manual refresh
3. As a user, I want file renames to be tracked properly so my internal links and references don't break
4. As a user, I want fast search and filtering without waiting for the app to read every file

### P2 - Important
5. As a user, I want to choose where my vault folder is located (Documents, Dropbox, iCloud, etc.)
6. As a user, I want the app to remember my vault location between sessions
7. As a user, I want to see a loading indicator while the vault is being indexed on first open
8. As a user, I want the database to rebuild automatically if it gets corrupted

### P3 - Nice to Have
9. As a user, I want to have multiple vaults I can switch between
10. As a user, I want to exclude certain folders from indexing (node_modules, .git)

## FUNCTIONAL REQUIREMENTS

### Vault Structure
- User selects vault folder on first launch via native folder picker
- Vault location stored in Electron app data (not in vault itself)
- Standard structure:
  ```
  vault/
  ├── notes/           # User's notes as .md files
  ├── journal/         # Daily journal entries (YYYY-MM-DD.md)
  ├── attachments/     # Images, PDFs, voice recordings
  └── .memry/          # Hidden app data
      ├── index.db     # SQLite: note metadata cache, FTS index
      ├── data.db      # SQLite: tasks, projects, inbox, settings
      └── sync-state/  # Sync metadata (versions, queue)
  ```

### Note File Format
- Plain markdown with YAML frontmatter
- Required frontmatter fields:
  ```yaml
  ---
  id: "550e8400-e29b-41d4-a716-446655440000"  # UUID, never changes
  title: "Note Title"
  created: "2024-01-15T10:30:00Z"
  modified: "2024-01-15T14:22:00Z"
  ---
  ```
- Optional frontmatter fields: tags, properties (custom key-value pairs)
- Auto-generate UUID for files without one (migration from plain markdown)

### SQLite Index Database (index.db)
- Purpose: Fast queries without reading files
- Tables:
  - `notes`: id, path, title, content_hash, created_at, modified_at, frontmatter (JSON)
  - `note_tags`: note_id, tag (many-to-many)
  - `note_links`: source_id, target_id, link_text (for backlinks)
  - `attachments`: id, path, type, size, created_at
- Full-text search using FTS5 virtual table on title + content
- This database is a CACHE - can be deleted and rebuilt from files

### SQLite Data Database (data.db)
- Purpose: Store structured data that doesn't fit file format
- Tables: tasks, projects, statuses, inbox_items, settings, sync_state
- This database is SOURCE OF TRUTH for its data - must be backed up/synced

### File Watcher
- Use chokidar (or @parcel/watcher for performance)
- Watch vault folder recursively
- Detect events: add, change, unlink (delete), rename
- Ignore patterns: .git/**, node_modules/**, .DS_Store, *.tmp
- Debounce rapid changes (300ms stabilization threshold)
- Handle rename as: unlink + add within 1 second with same UUID = rename

### Rename Detection Algorithm
```
On file delete (unlink):
  1. Get file record from index.db by path
  2. If file had frontmatter UUID, store in pending_deletes map with timeout
  3. After 1 second timeout, if no matching create → actual delete

On file create (add):
  1. Read file, parse frontmatter
  2. If file has UUID that exists in pending_deletes:
     - Cancel delete timeout
     - Update path in database (this is a RENAME)
  3. Else: genuinely new file, insert into database
```

### IPC Architecture
- All file/database operations run in Electron main process
- Renderer sends commands via IPC, receives results
- Channels:
  - `vault:open` - Open folder picker, set vault path
  - `vault:index` - Trigger full reindex
  - `notes:list` - Get all notes (metadata only)
  - `notes:read` - Read single note content
  - `notes:write` - Write note content
  - `notes:delete` - Delete note file
  - `notes:search` - Full-text search
  - `db:query` - Generic database query (for tasks, etc.)

## NON-FUNCTIONAL REQUIREMENTS

### Performance
- Initial vault indexing: <5 seconds for 1,000 files
- File change detection to UI update: <500ms
- Search query execution: <50ms for 10,000 notes
- Database queries: <10ms for typical operations

### Reliability
- Atomic file writes (write to temp, then rename)
- Database transactions for multi-step operations
- Graceful handling of locked files
- Recovery from partial writes / corruption

### Storage
- index.db should stay under 100MB for 10,000 notes
- data.db should stay under 50MB for typical usage
- Automatic vacuum/optimization on app close

## ACCEPTANCE CRITERIA

### Vault Setup
- [ ] First launch shows vault folder picker
- [ ] Selected path persists across app restarts
- [ ] Invalid path (no write permission) shows clear error
- [ ] Can change vault location from settings

### File Watching
- [ ] Creating new .md file in vault/notes/ appears in app within 500ms
- [ ] Editing file in VS Code updates app within 500ms
- [ ] Deleting file removes from app within 500ms
- [ ] Renaming file in Finder updates path without losing data
- [ ] Git operations (checkout, pull) trigger appropriate updates

### Database Operations
- [ ] Full reindex completes for 1,000 files in <5 seconds
- [ ] Search "meeting notes" returns relevant results in <50ms
- [ ] Closing app with pending changes doesn't lose data
- [ ] Corrupted index.db triggers automatic rebuild from files

### Edge Cases
- [ ] File with no frontmatter gets UUID added on first edit
- [ ] File with duplicate UUID (copy-paste) gets new UUID
- [ ] Binary file in notes folder is ignored gracefully
- [ ] Very large file (>10MB) doesn't freeze UI
- [ ] Unicode filenames and content work correctly
```
