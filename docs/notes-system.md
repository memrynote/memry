# Notes System Architecture

**Status**: Phase 6 Complete - Full-Text Search Implemented
**Branch**: `001-core-data-layer`
**Tasks**: T037-T067 (GitHub Issues #37-#67)

This document describes the notes system implementation for Claude Code reference.

## Overview

Notes are stored as **portable markdown files** with YAML frontmatter. The file system is the **source of truth**, while `index.db` serves as a **rebuildable cache** for fast queries.

```
Vault Folder/
├── notes/
│   ├── My Note.md          # Markdown with YAML frontmatter
│   ├── subfolder/
│   │   └── Nested Note.md
│   └── ...
└── .memry/
    ├── data.db             # Tasks/projects (source of truth)
    └── index.db            # Note cache (rebuildable from files)
```

## Frontmatter Schema

Every note has YAML frontmatter at the top:

```yaml
---
id: "a1b2c3d4e5f6"           # nanoid(12), lowercase alphanumeric
title: "Note Title"           # Optional, defaults to filename
created: "2025-12-18T10:00:00.000Z"
modified: "2025-12-18T15:30:00.000Z"
tags:
  - work
  - important
aliases:
  - "Old Title"
  - "Alternative Name"
customField: "preserved"      # Custom fields are preserved
---

# Note content here

Regular markdown content with [[Wiki Links]] support.
```

## Implementation Components

### 1. Frontmatter Module
**File**: `src/main/vault/frontmatter.ts`

Handles parsing and serialization of markdown files with YAML frontmatter.

```typescript
// Key exports
parseNote(content: string): { frontmatter, body, raw }
serializeNote(frontmatter: NoteFrontmatter, body: string): string
createFrontmatter(title: string, existingId?: string): NoteFrontmatter
ensureFrontmatter(content: string, filePath: string): string
extractWikiLinks(content: string): Array<{ title, raw, position }>
extractTags(frontmatter: NoteFrontmatter): string[]
calculateWordCount(content: string): number
generateContentHash(frontmatter, body): string
createSnippet(content: string, maxLength?: number): string
```

**Features**:
- Auto-generates UUID if missing (`nanoid(12)`)
- Auto-sets `created`/`modified` timestamps
- Preserves custom frontmatter fields (via `[key: string]: unknown`)
- Extracts `[[Wiki Links]]` with positions (supports `[[title]]` and `[[title|display]]`)
- Tags normalized to lowercase
- Validates note ID format (lowercase alphanumeric, 12 chars)

### 2. File Operations
**File**: `src/main/vault/file-ops.ts`

Atomic file operations to prevent data corruption.

```typescript
// Key exports
atomicWrite(filePath: string, content: string): Promise<void>
safeRead(filePath: string): Promise<string | null>
readRequired(filePath: string): Promise<string>
deleteFile(filePath: string): Promise<void>
ensureDirectory(dirPath: string): Promise<void>
fileExists(filePath: string): Promise<boolean>
listMarkdownFiles(dirPath: string): Promise<string[]>
listDirectories(dirPath: string): Promise<string[]>
sanitizeFilename(filename: string): string
generateNotePath(vaultPath: string, title: string, folder?: string): string
generateUniquePath(basePath: string): Promise<string>
```

**Atomic Write Pattern**:
1. Write to temporary file (`.tmp` suffix)
2. Rename temp file to target path
3. If crash occurs, original file is preserved

### 3. Note CRUD Operations
**File**: `src/main/vault/notes.ts`

Main business logic for note operations.

```typescript
// Key exports
createNote(input: NoteCreateInput): Promise<Note>
getNoteById(id: string): Promise<Note | null>
getNoteByPath(path: string): Promise<Note | null>
updateNote(input: NoteUpdateInput): Promise<Note>
renameNote(id: string, newTitle: string): Promise<Note>
moveNote(id: string, newFolder: string): Promise<Note>
deleteNote(id: string): Promise<void>
listNotes(options?: NoteListOptions): Promise<NoteListResponse>
getTagsWithCounts(): Promise<Array<{ tag, count }>>
getNoteLinks(id: string): Promise<NoteLinksResponse>
getFolders(): Promise<string[]>
createFolder(folderPath: string): Promise<void>
renameFolder(oldPath: string, newPath: string): Promise<void>
deleteFolder(folderPath: string): Promise<void>
noteExists(titleOrPath: string): Promise<boolean>
openExternal(id: string): Promise<void>
revealInFinder(id: string): Promise<void>
```

**Key Behaviors**:
- **Create**: Generates ID, writes file, updates cache, indexes FTS, emits event
- **Update**: Atomic write, updates cache, syncs FTS content, emits event
- **Delete**: Removes file, cleans cache (tags, links), removes from FTS, emits event
- **Rename**: Renames file, updates cache path/title, emits RENAMED event
- **Move**: Relocates to different folder, updates cache path, maintains ID
- **Duplicate UUID**: Detected on read, generates new UUID automatically (T046)
- **Folder Ops**: Create, rename, delete folders (delete is recursive)
- **Events**: Uses `NotesChannels.events.*` for IPC notifications

### 4. Database Queries
**File**: `src/shared/db/queries/notes.ts`

Drizzle ORM queries for the note cache.

```typescript
// Cache operations
insertNoteCache(db, note: NewNoteCache): NoteCache
updateNoteCache(db, id: string, updates: Partial<NoteCache>): NoteCache
deleteNoteCache(db, id: string): void
getNoteCacheById(db, id: string): NoteCache | undefined
getNoteCacheByPath(db, path: string): NoteCache | undefined
noteCacheExists(db, id: string): boolean
findDuplicateId(db, id: string, excludePath: string): NoteCache | undefined

// Listing
listNotesFromCache(db, options: ListNotesOptions): NoteCache[]
countNotes(db, folder?: string): number
getAllNoteIds(db): string[]
getNotesModifiedAfter(db, date: string): NoteCache[]

// Tags
setNoteTags(db, noteId: string, tags: string[]): void
getNoteTags(db, noteId: string): string[]
getAllTags(db): Array<{ tag, count }>
findNotesByTag(db, tag: string): NoteCache[]

// Links
setNoteLinks(db, sourceId: string, links: Array<{ targetTitle, targetId? }>): void
getOutgoingLinks(db, noteId: string): NoteLink[]
getIncomingLinks(db, noteId: string): NoteLink[]
resolveNoteByTitle(db, title: string): NoteCache | undefined
updateLinkTargets(db, sourceId: string): void

// Bulk operations
bulkInsertNotes(db, notes: NewNoteCache[]): void
clearNoteCache(db): void
```

### 5. IPC Handlers
**File**: `src/main/ipc/notes-handlers.ts`

Registers all notes IPC channels with Zod validation.

```typescript
// Channels (from NotesChannels.invoke.*)
'notes:create'         -> createNote()
'notes:get'            -> getNoteById()
'notes:get-by-path'    -> getNoteByPath()
'notes:update'         -> updateNote()
'notes:rename'         -> renameNote()
'notes:move'           -> moveNote()
'notes:delete'         -> deleteNote()
'notes:list'           -> listNotes()
'notes:get-tags'       -> getTagsWithCounts()
'notes:get-links'      -> getNoteLinks()
'notes:get-folders'    -> getFolders()
'notes:create-folder'  -> createFolder()
'notes:rename-folder'  -> renameFolder()
'notes:delete-folder'  -> deleteFolder()
'notes:exists'         -> noteExists()
'notes:open-external'  -> openExternal()
'notes:reveal-in-finder' -> revealInFinder()
```

### 6. Preload Bridge
**File**: `src/preload/index.ts`

Exposes notes API to renderer process.

```typescript
window.api.notes = {
  create, get, getByPath, update, rename, move, delete,
  list, getTags, getLinks, getFolders, createFolder,
  renameFolder, deleteFolder, exists, openExternal, revealInFinder
}

// Event subscriptions
window.api.onNoteCreated(callback)
window.api.onNoteUpdated(callback)
window.api.onNoteDeleted(callback)
window.api.onNoteRenamed(callback)
window.api.onNoteMoved(callback)
window.api.onNoteExternalChange(callback)
```

### 7. Renderer Service
**File**: `src/renderer/src/services/notes-service.ts`

Thin wrapper for type safety and convenience.

```typescript
import { notesService } from '@/services/notes-service'

const result = await notesService.create({ title: 'My Note', content: '# Hello' })
const notes = await notesService.list({ sortBy: 'modified', limit: 50 })
```

### 8. React Hooks
**File**: `src/renderer/src/hooks/use-notes.ts`

State management hooks for React components.

```typescript
// Main hook
const {
  notes,           // NoteListItem[]
  currentNote,     // Note | null
  total,           // number
  hasMore,         // boolean
  isLoading,       // boolean
  error,           // string | null
  loadNotes,       // (options?) => Promise<NoteListResponse>
  loadMore,        // () => Promise<void>
  refresh,         // () => Promise<void>
  createNote,      // (input) => Promise<Note | null>
  getNote,         // (id) => Promise<Note | null>
  updateNote,      // (input) => Promise<Note | null>
  renameNote,      // (id, newTitle) => Promise<Note | null>
  moveNote,        // (id, newFolder) => Promise<Note | null>
  deleteNote,      // (id) => Promise<boolean>
  setCurrentNote,  // (note) => void
  clearError       // () => void
} = useNotes({ folder, tags, sortBy, sortOrder, limit, autoLoad })

// Additional hooks
const { tags, isLoading, refresh } = useNoteTags()
const { outgoing, incoming, isLoading } = useNoteLinks(noteId)
const { folders, createFolder, renameFolder, deleteFolder, refresh } = useNoteFolders()
```

**Features**:
- Auto-loads on mount (configurable)
- Subscribes to IPC events automatically
- Updates state when notes change externally
- Pagination with `loadMore()`

### 9. Rename Tracker
**File**: `src/main/vault/rename-tracker.ts`

Detects file renames by matching UUIDs within a 500ms window.

```typescript
// Key exports
trackPendingDelete(id, relativePath, onRealDelete): void
checkForRename(id, newPath): Promise<string | null>
clearPendingDelete(id): void
clearAllPendingDeletes(): void
hasPendingDeletes(): boolean
getPendingDeleteCount(): number
```

**How it works**:
1. When a file is deleted, `trackPendingDelete()` stores the UUID
2. A 500ms timer starts
3. If a new file with the same UUID appears, `checkForRename()` detects it
4. The rename is processed: cache updated, RENAMED event emitted
5. If no match within 500ms, `onRealDelete()` callback executes

### 10. FTS Module
**File**: `src/main/database/fts.ts`

FTS5 full-text search with automatic triggers.

```typescript
// Key exports
initializeFts(db): void                            // Create table and triggers
updateFtsContent(db, noteId, content, tags): void  // Update searchable content
insertFtsNote(db, note): void                      // Insert/replace FTS entry
deleteFtsNote(db, noteId): void                    // Delete from FTS
clearFtsTable(db): void                            // Clear all entries
getFtsCount(db): number                            // Count indexed notes
ftsNoteExists(db, noteId): boolean                 // Check if indexed
```

**Important**: FTS triggers sync id/title automatically, but content/tags must be updated manually via `updateFtsContent()`.

### 11. Search Handlers
**File**: `src/main/ipc/search-handlers.ts`

Complete search IPC layer with recent search tracking.

```typescript
// IPC Channels (SearchChannels.invoke.*)
'search:query'         -> Full search with pagination
'search:quick'         -> Quick search for command palette
'search:suggestions'   -> Get search suggestions by prefix
'search:get-recent'    -> Get recent search queries
'search:clear-recent'  -> Clear recent searches
'search:add-recent'    -> Add to recent searches
'search:get-stats'     -> Get search index stats
'search:rebuild-index' -> Force rebuild search index (TODO)
'search:notes'         -> Search notes only (optimized)
'search:find-by-tag'   -> Find notes by tag
'search:find-backlinks'-> Find notes linking to a note
```

### 12. Search Hooks
**File**: `src/renderer/src/hooks/use-search.ts`

React hooks for search state management.

```typescript
// Main search hook with debouncing
const {
  query, setQuery, results, total, hasMore,
  isLoading, queryTime, error, search, loadMore, clear
} = useSearch({ debounceMs, autoSearch, limit })

// Quick search for command palette
const { query, notes, isLoading, setQuery, clear } = useQuickSearch(debounceMs)

// Search index stats and management
const { stats, isLoading, refresh, rebuildIndex, rebuildProgress } = useSearchStats()

// Recent searches management
const { recent, isLoading, addRecent, clearRecent, refresh } = useRecentSearches()
```

### 13. Search Queries
**File**: `src/shared/db/queries/search.ts`

FTS5 query functions.

```typescript
// Key exports
searchNotes(db, query, options): SearchResultInternal[]
quickSearch(db, query, limit): { notes, tasks }
getSuggestions(db, prefix, limit): string[]
findNotesByTag(db, tag): SearchResultInternal[]
findBacklinks(db, noteId): SearchResultInternal[]
getSearchableCount(db): number
isFtsHealthy(db): boolean
```

## Implementation Details

### Wiki Link Patterns
The `extractWikiLinks()` function supports two patterns:
- `[[Note Title]]` - Simple link
- `[[Note Title|Display Text]]` - Link with custom display text

### Content Hash Algorithm
Uses djb2 hash for change detection:
```typescript
function djb2Hash(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}
```
Used to skip redundant updates when file timestamp changes but content doesn't.

### Duplicate ID Detection (T046)
When `getNoteById()` finds a note with the same ID at a different path:
1. Generates a new UUID for the duplicate
2. Writes the new ID back to the file
3. Updates the cache
4. Returns the note with the new ID

This handles edge cases where users copy files or sync conflicts occur.

### Snippet Generation
`createSnippet()` algorithm:
1. Remove YAML frontmatter
2. Strip markdown formatting (headers, bold, italic, links)
3. Remove code blocks and inline code
4. Collapse multiple whitespace to single space
5. Trim to 200 characters at word boundary

### Tag Case Normalization
Tags are automatically normalized to lowercase during:
- `extractTags()` in frontmatter processing
- `setNoteTags()` in database operations

### Link Resolution Strategy
`resolveNoteByTitle()` uses two-phase resolution:
1. Exact match on title
2. Case-insensitive fallback

This ensures `[[My Note]]` links resolve to `My Note.md` or `my note.md`.

### Modified Timestamp Behavior
- `serializeNote()` updates `modified` timestamp on every write
- Reading a file does NOT update the modified timestamp
- Only explicit updates via `updateNote()` or file changes trigger modified update

### Event Source Distinction
All note events include a `source` field:
- `'internal'` - Change originated from app API
- `'external'` - Change detected by file watcher

Used to prevent UI jitter from self-generated events.

### Atomic File Write Pattern
All file writes use atomic pattern:
1. Write to temp file: `filename.md.{random-hex}.tmp`
2. Rename temp file to target path
3. On error, cleanup temp file

Prevents data corruption if crash occurs during write.

## IPC Channel Constants
**File**: `src/shared/ipc-channels.ts`

Single source of truth for all IPC channel names.

```typescript
export const NotesChannels = {
  invoke: {
    CREATE: 'notes:create',
    GET: 'notes:get',
    // ... all invoke channels
  },
  events: {
    CREATED: 'notes:created',
    UPDATED: 'notes:updated',
    DELETED: 'notes:deleted',
    RENAMED: 'notes:renamed',
    MOVED: 'notes:moved',
    EXTERNAL_CHANGE: 'notes:external-change'
  }
} as const
```

## Data Flow

### Note Creation - Detailed Step-by-Step Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RENDERER PROCESS                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────┐                                                       │
│  │   React Component │                                                       │
│  │   (Note Editor)   │                                                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           │ Step 1: User clicks "Create Note"                               │
│           │         calls createNote({ title: "My Note", content: "# Hi" }) │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │   useNotes Hook   │  src/renderer/src/hooks/use-notes.ts                 │
│  │                   │                                                       │
│  │  - Sets loading   │                                                       │
│  │  - Clears error   │                                                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           │ Step 2: Calls service layer                                     │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │  notesService     │  src/renderer/src/services/notes-service.ts          │
│  │                   │                                                       │
│  │  notesService     │                                                       │
│  │    .create(input) │                                                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           │ Step 3: Calls preload API                                       │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │  window.api      │  src/preload/index.ts                                 │
│  │    .notes        │                                                       │
│  │    .create()     │                                                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
└───────────┼─────────────────────────────────────────────────────────────────┘
            │
            │ Step 4: IPC invoke (crosses process boundary)
            │         Channel: 'notes:create'
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            MAIN PROCESS                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│           │                                                                 │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │  IPC Handler     │  src/main/ipc/notes-handlers.ts                       │
│  │                   │                                                       │
│  │  - Validates with │                                                       │
│  │    Zod schema     │                                                       │
│  │  - Calls CRUD fn  │                                                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           │ Step 5: Calls note CRUD operation                               │
│           ▼                                                                 │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │  createNote()     │  src/main/vault/notes.ts                      │       │
│  │                                                                   │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 6: Validate vault is open                              │ │       │
│  │  │         getStatus() → check isOpen === true                 │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 7: Generate unique ID                                  │ │       │
│  │  │         generateNoteId() → nanoid(12)                       │ │       │
│  │  │         Example: "a1b2c3d4e5f6"                              │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 8: Create frontmatter object                           │ │       │
│  │  │         createFrontmatter(title, id)                        │ │       │
│  │  │                                                             │ │       │
│  │  │         {                                                   │ │       │
│  │  │           id: "a1b2c3d4e5f6",                               │ │       │
│  │  │           title: "My Note",                                 │ │       │
│  │  │           created: "2025-12-18T10:00:00.000Z",              │ │       │
│  │  │           modified: "2025-12-18T10:00:00.000Z",             │ │       │
│  │  │           tags: ["work"]                                    │ │       │
│  │  │         }                                                   │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 9: Generate file path                                  │ │       │
│  │  │         generateNotePath(vaultPath, title, folder)          │ │       │
│  │  │                                                             │ │       │
│  │  │         "/Users/me/vault/notes/My Note.md"                  │ │       │
│  │  │                                                             │ │       │
│  │  │         If exists: generateUniquePath() adds suffix         │ │       │
│  │  │         → "/Users/me/vault/notes/My Note (1).md"            │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 10: Serialize to markdown string                       │ │       │
│  │  │          serializeNote(frontmatter, content)                │ │       │
│  │  │                                                             │ │       │
│  │  │          ---                                                │ │       │
│  │  │          id: "a1b2c3d4e5f6"                                 │ │       │
│  │  │          title: "My Note"                                   │ │       │
│  │  │          created: "2025-12-18T10:00:00.000Z"                │ │       │
│  │  │          modified: "2025-12-18T10:00:00.000Z"               │ │       │
│  │  │          tags:                                              │ │       │
│  │  │            - work                                           │ │       │
│  │  │          ---                                                │ │       │
│  │  │                                                             │ │       │
│  │  │          # Hi                                               │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 11: Ensure directory exists                            │ │       │
│  │  │          ensureDirectory("/Users/me/vault/notes/")          │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 12: Atomic write to file system                        │ │       │
│  │  │          atomicWrite(filePath, serializedContent)           │ │       │
│  │  │                                                             │ │       │
│  │  │          1. Write to temp: "My Note.md.tmp"                 │ │       │
│  │  │          2. Rename temp → "My Note.md"                      │ │       │
│  │  │          3. If crash: original preserved                    │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  └──────────────────────────┼───────────────────────────────────────┘       │
│                             │                                               │
│                             ▼                                               │
│           ┌─────────────────────────────────────────┐                       │
│           │         FILE SYSTEM                      │                       │
│           │                                          │                       │
│           │  /Users/me/vault/                        │                       │
│           │  └── notes/                              │                       │
│           │      └── My Note.md  ← FILE CREATED     │                       │
│           │                                          │                       │
│           └─────────────────────────────────────────┘                       │
│                             │                                               │
│                             │ Step 13: File write success                   │
│                             ▼                                               │
│  ┌──────────────────────────────────────────────────────────────────┐       │
│  │  Continue in createNote()                                         │       │
│  │                                                                   │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 14: Extract metadata for cache                         │ │       │
│  │  │          - extractTags(frontmatter) → ["work"]              │ │       │
│  │  │          - extractWikiLinks(content) → []                   │ │       │
│  │  │          - calculateWordCount(content) → 1                  │ │       │
│  │  │          - generateContentHash(...) → "abc123..."           │ │       │
│  │  │          - createSnippet(content) → "Hi"                    │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 15: Insert into note cache                             │ │       │
│  │  │          insertNoteCache(db, {                              │ │       │
│  │  │            id, path, title, createdAt, modifiedAt,          │ │       │
│  │  │            wordCount, contentHash, snippet                  │ │       │
│  │  │          })                                                 │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │           ┌─────────────────────────────────────────┐            │       │
│  │           │         index.db (SQLite)               │            │       │
│  │           │                                          │            │       │
│  │           │  note_cache: INSERT row                  │            │       │
│  │           │  note_tags:  INSERT "work" tag           │            │       │
│  │           │  note_links: (none for this note)        │            │       │
│  │           │                                          │            │       │
│  │           └─────────────────────────────────────────┘            │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 16: Set tags in database                               │ │       │
│  │  │          setNoteTags(db, noteId, ["work"])                  │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 17: Set links in database                              │ │       │
│  │  │          setNoteLinks(db, noteId, extractedLinks)           │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 18: Emit IPC event to all renderer windows             │ │       │
│  │  │          BrowserWindow.getAllWindows().forEach(win =>       │ │       │
│  │  │            win.webContents.send('notes:created', {          │ │       │
│  │  │              note: noteListItem,                            │ │       │
│  │  │              source: 'internal'                             │ │       │
│  │  │            })                                               │ │       │
│  │  │          )                                                  │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                          │                                        │       │
│  │                          ▼                                        │       │
│  │  ┌─────────────────────────────────────────────────────────────┐ │       │
│  │  │ Step 19: Return Note object                                 │ │       │
│  │  │          return {                                           │ │       │
│  │  │            id: "a1b2c3d4e5f6",                               │ │       │
│  │  │            path: "notes/My Note.md",                        │ │       │
│  │  │            title: "My Note",                                │ │       │
│  │  │            content: "# Hi",                                 │ │       │
│  │  │            frontmatter: {...},                              │ │       │
│  │  │            created: Date,                                   │ │       │
│  │  │            modified: Date,                                  │ │       │
│  │  │            tags: ["work"],                                  │ │       │
│  │  │            aliases: [],                                     │ │       │
│  │  │            wordCount: 1                                     │ │       │
│  │  │          }                                                  │ │       │
│  │  └─────────────────────────────────────────────────────────────┘ │       │
│  │                                                                   │       │
│  └───────────────────────────────────────────────────────────────────┘       │
│                             │                                               │
└─────────────────────────────┼───────────────────────────────────────────────┘
                              │
                              │ Step 20: IPC response returns to renderer
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RENDERER PROCESS                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                             │                                               │
│           ┌─────────────────┴─────────────────┐                             │
│           │                                   │                             │
│           ▼                                   ▼                             │
│  ┌──────────────────┐              ┌──────────────────┐                     │
│  │ IPC Response     │              │ IPC Event        │                     │
│  │ (Promise resolves)│              │ 'notes:created'  │                     │
│  └────────┬─────────┘              └────────┬─────────┘                     │
│           │                                 │                               │
│           │ Step 21                         │ Step 22 (parallel)            │
│           ▼                                 ▼                               │
│  ┌──────────────────┐              ┌──────────────────┐                     │
│  │  notesService    │              │  useNotes Hook   │                     │
│  │  returns result  │              │  event listener  │                     │
│  └────────┬─────────┘              │                  │                     │
│           │                        │  onNoteCreated   │                     │
│           ▼                        │  callback fires  │                     │
│  ┌──────────────────┐              └────────┬─────────┘                     │
│  │  useNotes Hook   │                       │                               │
│  │                  │                       │ Step 23: Update state         │
│  │  - Check success │                       ▼                               │
│  │  - Set loading   │              ┌──────────────────┐                     │
│  │    = false       │              │  setNotes(prev   │                     │
│  │  - Return note   │              │    => [newNote,  │                     │
│  └────────┬─────────┘              │    ...prev])     │                     │
│           │                        │                  │                     │
│           │                        │  setTotal(t+1)   │                     │
│           │                        └────────┬─────────┘                     │
│           │                                 │                               │
│           └────────────┬────────────────────┘                               │
│                        │                                                    │
│                        ▼                                                    │
│           ┌──────────────────┐                                              │
│           │  React Component │                                              │
│           │  re-renders with │                                              │
│           │  new note in     │                                              │
│           │  notes array     │                                              │
│           └──────────────────┘                                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Note Creation - Sequence Summary

| Step | Location | Action |
|------|----------|--------|
| 1 | React Component | User triggers `createNote()` |
| 2 | useNotes Hook | Sets loading state, calls service |
| 3 | Notes Service | Calls `window.api.notes.create()` |
| 4 | Preload → Main | IPC invoke crosses process boundary |
| 5 | IPC Handler | Validates input with Zod schema |
| 6 | notes.ts | Validates vault is open |
| 7 | notes.ts | Generates unique ID (nanoid) |
| 8 | frontmatter.ts | Creates frontmatter object |
| 9 | file-ops.ts | Generates file path |
| 10 | frontmatter.ts | Serializes to markdown string |
| 11 | file-ops.ts | Ensures directory exists |
| 12 | file-ops.ts | **Atomic write to file system** |
| 13 | - | File created on disk |
| 14 | notes.ts | Extracts metadata (tags, links, etc.) |
| 15 | queries/notes.ts | Inserts into note_cache table |
| 16 | queries/notes.ts | Inserts tags into note_tags |
| 17 | queries/notes.ts | Inserts links into note_links |
| 18 | notes.ts | Emits `notes:created` event |
| 19 | notes.ts | Returns Note object |
| 20 | Main → Preload | IPC response returns |
| 21 | Notes Service | Returns result to hook |
| 22 | useNotes Hook | Event listener fires (parallel) |
| 23 | useNotes Hook | Updates React state |

### Reading a Note
```
UI Component
    ↓ useNotes().getNote(id)
Notes Service
    ↓ window.api.notes.get(id)
IPC Handler
    ↓ getNoteById()
Note CRUD
    ├─→ getNoteCacheById() → Get path from cache
    ├─→ safeRead() → Read file content
    ├─→ parseNote() → Parse frontmatter
    └─→ Return full Note object
```

## Error Handling

Custom error types in `src/main/lib/errors.ts`:

```typescript
// Note errors
NoteErrorCode.NOT_FOUND      // Note doesn't exist
NoteErrorCode.ALREADY_EXISTS // Title conflict
NoteErrorCode.INVALID_PATH   // Bad file path
NoteErrorCode.READ_FAILED    // File read error
NoteErrorCode.WRITE_FAILED   // File write error
NoteErrorCode.DELETE_FAILED  // File delete error

// Vault errors
VaultErrorCode.NOT_OPEN      // No vault selected
VaultErrorCode.NOT_FOUND     // Vault path missing
```

## Database Schema

### noteCache Table
```sql
CREATE TABLE note_cache (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  word_count INTEGER DEFAULT 0,
  content_hash TEXT,
  snippet TEXT
);
```

### noteTags Table
```sql
CREATE TABLE note_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL REFERENCES note_cache(id),
  tag TEXT NOT NULL,
  UNIQUE(note_id, tag)
);
```

### noteLinks Table
```sql
CREATE TABLE note_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES note_cache(id),
  target_id TEXT,
  target_title TEXT NOT NULL
);
```

---

## What's Implemented

### Phase 4: File Watcher (US2) - T049-T054 ✓
**Status**: Complete

Implemented:
- `src/main/vault/watcher.ts` - chokidar file watcher with VaultWatcher class
- Debounced event handling (100ms stabilization)
- Cache updates on external file add/change/delete
- Events emitted via `notes:created`, `notes:updated`, `notes:deleted` with `source: 'external'`
- Watcher starts on vault open, stops on vault close

**Features**:
- Watches `notes/` and `journal/` directories recursively
- Filters: only `.md` files
- Ignores: hidden files, `.git`, `node_modules`, `.memry/`
- Debounces rapid changes (100ms per-file batching)
- Updates index.db cache automatically
- Emits IPC events to all renderer windows

### Phase 5: Rename Tracking (US3) - T055-T059 ✓
**Status**: Complete

Implemented:
- `src/main/vault/rename-tracker.ts` - UUID-based rename detection
- Automatic cache path/title update on rename
- RENAMED event emission with `source: 'external'`

**Features**:
- 500ms detection window for rename events
- chokidar emits 'unlink' then 'add' for renames - tracker matches by UUID
- Pending delete tracking with timeout-based real delete processing
- Cache updated with new path and title
- FTS index updated automatically

```typescript
// Key exports from rename-tracker.ts
trackPendingDelete(id: string, relativePath: string, onRealDelete: () => Promise<void>): void
checkForRename(id: string, newPath: string): Promise<string | null>
clearPendingDelete(id: string): void
clearAllPendingDeletes(): void
hasPendingDeletes(): boolean
getPendingDeleteCount(): number
```

### Phase 6: Full-Text Search (US4) - T060-T067 ✓
**Status**: Complete

Implemented:
- `src/main/database/fts.ts` - FTS5 virtual table and triggers
- Automatic index sync via SQLite triggers
- Search query functions

**FTS5 Virtual Table**:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(
  id UNINDEXED,    -- Note UUID (not searchable)
  title,           -- Note title (searchable)
  content,         -- Full note content (searchable)
  tags,            -- Space-separated tags (searchable)
  tokenize='porter unicode61'
);
```

**Automatic Triggers**:
- INSERT on note_cache → Creates FTS entry (content/tags empty initially)
- DELETE on note_cache → Removes FTS entry
- UPDATE title on note_cache → Updates FTS title

**Manual Content Updates** (required because files are source of truth):
```typescript
// Key exports from fts.ts
initializeFts(db: LibSQLDatabase): void          // Create table and triggers
updateFtsContent(db, noteId, content, tags): void // Update content/tags
insertFtsNote(db, note): void                     // Insert complete entry
deleteFtsNote(db, noteId): void                   // Delete from FTS
clearFtsTable(db): void                           // Clear all entries
getFtsCount(db): number                           // Count indexed notes
ftsNoteExists(db, noteId): boolean                // Check if note in FTS
```

**Important**: Content and tags are NOT automatically synced via triggers - must call `updateFtsContent()` explicitly after file changes.

---

## What's NOT Implemented Yet

### Phase 7: Indexing Progress (US7) - T068-T070
**Impact**: No progress indicator for large vaults.

Missing:
- Initial indexer with progress reporting
- INDEX_PROGRESS IPC events
- Progress UI

### Phase 8: Auto Recovery (US8) - T071-T073
**Impact**: Corrupted index requires manual intervention.

Missing:
- Corruption detection
- Automatic rebuild trigger
- Recovery notifications

### UI Integration
**Impact**: UI components may still use mock data.

Components that need updating to use `useNotes()`:
- Note editor component
- Note list/sidebar component
- Note preview component
- Any component importing old `use-notes.ts`

---

## Testing the Implementation

### Quick Test via DevTools
```javascript
// 1. Ensure vault is open
const status = await window.api.vault.getStatus()
console.log('Vault open:', status.isOpen, status.path)

// 2. Create a note
const result = await window.api.notes.create({
  title: 'Test Note',
  content: '# Hello World\n\nThis is a test.',
  tags: ['test', 'demo']
})
console.log('Created:', result)

// 3. List notes
const list = await window.api.notes.list({ limit: 10 })
console.log('Notes:', list.notes)

// 4. Check file system
// Open vault folder in Finder - you should see:
// notes/Test Note.md with YAML frontmatter

// 5. Update the note
const updated = await window.api.notes.update({
  id: result.note.id,
  content: '# Updated Content\n\nModified via API.'
})
console.log('Updated:', updated)

// 6. Search notes
const searchResults = await window.api.search.query({
  query: 'Hello',
  limit: 10
})
console.log('Search results:', searchResults.results)

// 7. Delete the note
const deleted = await window.api.notes.delete(result.note.id)
console.log('Deleted:', deleted)
```

### Verify File Format
Open any `.md` file in the vault. It should look like:

```markdown
---
id: "a1b2c3d4e5f6"
title: "Test Note"
created: "2025-12-18T10:00:00.000Z"
modified: "2025-12-18T10:00:00.000Z"
tags:
  - test
  - demo
---

# Hello World

This is a test.
```

---

## Related Files

| Component | File Path |
|-----------|-----------|
| Frontmatter | `src/main/vault/frontmatter.ts` |
| File Operations | `src/main/vault/file-ops.ts` |
| Note CRUD | `src/main/vault/notes.ts` |
| File Watcher | `src/main/vault/watcher.ts` |
| Rename Tracker | `src/main/vault/rename-tracker.ts` |
| Vault Manager | `src/main/vault/index.ts` |
| DB Queries | `src/shared/db/queries/notes.ts` |
| DB Schema | `src/shared/db/schema/notes-cache.ts` |
| FTS5 Search | `src/main/database/fts.ts` |
| Search Queries | `src/shared/db/queries/search.ts` |
| Search Contract | `src/shared/contracts/search-api.ts` |
| IPC Handlers (Notes) | `src/main/ipc/notes-handlers.ts` |
| IPC Handlers (Search) | `src/main/ipc/search-handlers.ts` |
| IPC Registration | `src/main/ipc/index.ts` |
| Channel Constants | `src/shared/ipc-channels.ts` |
| Preload | `src/preload/index.ts` |
| Preload Types | `src/preload/index.d.ts` |
| API Contract | `src/shared/contracts/notes-api.ts` |
| Renderer Service (Notes) | `src/renderer/src/services/notes-service.ts` |
| Renderer Service (Search) | `src/renderer/src/services/search-service.ts` |
| React Hook (Notes) | `src/renderer/src/hooks/use-notes.ts` |
| React Hook (Search) | `src/renderer/src/hooks/use-search.ts` |

## References

- Spec: `specs/001-core-data-layer/spec.md`
- Data Model: `specs/001-core-data-layer/data-model.md`
- API Contract: `specs/001-core-data-layer/contracts/notes-api.ts`
- Tasks: `specs/001-core-data-layer/tasks.md` (T037-T067)
