# Data Model: Notes System

**Feature**: 003-notes
**Date**: 2025-12-23
**Status**: Complete
**Updated**: 2025-12-23 - Added implementation status

## Overview

The notes system uses a hybrid storage model:
- **Markdown files**: Source of truth for note content (vault/notes/)
- **SQLite cache (index.db)**: Fast queries, FTS, metadata cache (rebuildable)

This document defines all entities, their relationships, and validation rules.

---

## Entity Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FILE SYSTEM                                     │
│                                                                              │
│  vault/notes/                                                                │
│  ├── My Note.md          ──────────────────────────────────────────────┐    │
│  ├── folder/                                                            │    │
│  │   └── Nested Note.md  ───────────────────────────────────────────┐  │    │
│  └── ...                                                             │  │    │
│                                                                      │  │    │
│  vault/attachments/                                                  │  │    │
│  ├── abc123-image.png    ◄──────────────────────────────────────┐   │  │    │
│  └── ...                                                         │   │  │    │
└──────────────────────────────────────────────────────────────────┼───┼──┼────┘
                                                                   │   │  │
┌──────────────────────────────────────────────────────────────────┼───┼──┼────┐
│                           index.db (SQLite)                      │   │  │    │
│                                                                  │   │  │    │
│  ┌──────────────────┐    ┌───────────────┐    ┌───────────────┐ │   │  │    │
│  │   noteCache      │    │   noteTags    │    │   noteLinks   │ │   │  │    │
│  ├──────────────────┤    ├───────────────┤    ├───────────────┤ │   │  │    │
│  │ id (PK)          │◄───┤ noteId (FK)   │    │ sourceId (FK) │─┘   │  │    │
│  │ path             │    │ tag           │    │ targetId (FK) │─────┘  │    │
│  │ title            │    └───────────────┘    │ targetTitle   │        │    │
│  │ emoji            │                         └───────────────┘        │    │
│  │ contentHash      │                                                  │    │
│  │ wordCount        │    ┌───────────────────┐                         │    │
│  │ createdAt        │    │  noteProperties   │                         │    │
│  │ modifiedAt       │◄───┤ noteId (FK)       │                         │    │
│  │ indexedAt        │    │ name              │                         │    │
│  └──────────────────┘    │ value             │                         │    │
│           │              │ type              │                         │    │
│           │              └───────────────────┘                         │    │
│           ▼                                                            │    │
│  ┌──────────────────┐    ┌───────────────────┐                         │    │
│  │   fts_notes      │    │ propertyDefinitions│                        │    │
│  ├──────────────────┤    ├───────────────────┤                         │    │
│  │ id (UNINDEXED)   │    │ name (PK)         │                         │    │
│  │ title            │    │ type              │                         │    │
│  │ content          │◄───┤ options           │                         │    │
│  │ tags             │    │ defaultValue      │                         │    │
│  └──────────────────┘    └───────────────────┘                         │    │
│                                                                        │    │
└────────────────────────────────────────────────────────────────────────┼────┘
                                                                         │
                                              References attachment via  ─┘
                                              markdown syntax: ![](../attachments/...)
```

---

## Entities

### 1. Note (File-Based)

The primary entity. Source of truth is the markdown file.

**File Location**: `vault/notes/{path}/{title}.md`

**Frontmatter Schema**:
```yaml
id: string           # nanoid(12), immutable after creation
title: string        # Display title, derived from filename if missing
emoji: string?       # Single emoji character
created: string      # ISO 8601 timestamp
modified: string     # ISO 8601 timestamp, updated on save
tags: string[]       # Lowercase, normalized
aliases: string[]?   # Alternative titles for wiki-link resolution
properties:          # Key-value pairs
  [name]: any        # Value type depends on propertyDefinitions
```

**Content**: Markdown with extensions:
- Wiki links: `[[Title]]` or `[[Title|Display]]`
- Inline tags: `#tagname`
- Attachments: `![alt](../attachments/filename.ext)`

**Validation Rules**:
| Field | Rule |
|-------|------|
| id | Required, 12-char alphanumeric, unique across vault |
| title | Required, 1-255 chars, valid filename characters |
| emoji | Optional, single emoji character |
| created | Required, valid ISO 8601 |
| modified | Required, valid ISO 8601, >= created |
| tags | Array of lowercase strings, max 50 per note |

**State Transitions**:
```
[New] ──create──► [Draft] ──save──► [Saved] ──edit──► [Modified] ──save──► [Saved]
                                       │                                     │
                                       └──────────delete──────────────────►[Deleted]
```

---

### 2. NoteCache (Database)

Cached representation of note metadata for fast queries.

**Table**: `noteCache`

**Schema** (Drizzle):
```typescript
export const noteCache = sqliteTable('note_cache', {
  id: text('id').primaryKey(),                    // UUID from frontmatter
  path: text('path').notNull().unique(),          // Relative to vault root
  title: text('title').notNull(),                 // Display title
  emoji: text('emoji'),                           // NEW: Emoji icon
  contentHash: text('content_hash').notNull(),    // djb2 hash for change detection
  wordCount: integer('word_count').notNull(),     // Excludes code blocks
  createdAt: text('created_at').notNull(),        // ISO timestamp
  modifiedAt: text('modified_at').notNull(),      // ISO timestamp
  indexedAt: text('indexed_at')                   // Auto-set on insert/update
    .notNull()
    .default(sql`(datetime('now'))`),
})
```

**Indexes**:
```sql
CREATE INDEX idx_note_cache_path ON note_cache(path);
CREATE INDEX idx_note_cache_modified ON note_cache(modified_at DESC);
CREATE INDEX idx_note_cache_title ON note_cache(title);
```

---

### 3. NoteTag (Database)

Many-to-many relationship between notes and tags.

**Table**: `noteTags`

**Schema** (Drizzle):
```typescript
export const noteTags = sqliteTable('note_tags', {
  noteId: text('note_id')
    .notNull()
    .references(() => noteCache.id, { onDelete: 'cascade' }),
  tag: text('tag').notNull(),  // Lowercase, normalized
}, (table) => ({
  pk: primaryKey({ columns: [table.noteId, table.tag] }),
}))
```

**Validation Rules**:
| Field | Rule |
|-------|------|
| noteId | Must exist in noteCache |
| tag | Lowercase, 1-50 chars, alphanumeric + hyphens |

---

### 4. NoteLink (Database)

Wiki link tracking for backlinks computation.

**Table**: `noteLinks`

**Schema** (Drizzle):
```typescript
export const noteLinks = sqliteTable('note_links', {
  sourceId: text('source_id')
    .notNull()
    .references(() => noteCache.id, { onDelete: 'cascade' }),
  targetId: text('target_id')
    .references(() => noteCache.id, { onDelete: 'set null' }),
  targetTitle: text('target_title').notNull(),  // Original link text
}, (table) => ({
  pk: primaryKey({ columns: [table.sourceId, table.targetTitle] }),
}))
```

**Resolution Logic**:
1. When note saved, extract all `[[Title]]` patterns
2. Attempt to resolve `targetId` via title match
3. Store `targetTitle` always (for broken link display)
4. `targetId` is null if linked note doesn't exist

---

### 5. NoteProperty (Database) - NEW

Custom properties attached to notes.

**Table**: `noteProperties`

**Schema** (Drizzle):
```typescript
export const noteProperties = sqliteTable('note_properties', {
  noteId: text('note_id')
    .notNull()
    .references(() => noteCache.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  value: text('value'),                           // JSON-encoded for complex types
  type: text('type').notNull(),                   // PropertyType enum
}, (table) => ({
  pk: primaryKey({ columns: [table.noteId, table.name] }),
}))
```

**Property Types**:
```typescript
type PropertyType =
  | 'text'        // string
  | 'number'      // number (stored as string, parsed)
  | 'checkbox'    // "true" | "false"
  | 'date'        // ISO 8601
  | 'select'      // string (from options)
  | 'multiselect' // JSON array of strings
  | 'url'         // string (URL format)
  | 'rating'      // "1" | "2" | "3" | "4" | "5"
```

---

### 6. PropertyDefinition (Database) - NEW

Schema definitions for custom properties.

**Table**: `propertyDefinitions`

**Schema** (Drizzle):
```typescript
export const propertyDefinitions = sqliteTable('property_definitions', {
  name: text('name').primaryKey(),
  type: text('type').notNull(),                   // PropertyType
  options: text('options'),                       // JSON array for select types
  defaultValue: text('default_value'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
})
```

---

### 7. FtsNote (Virtual Table)

FTS5 virtual table for full-text search.

**Table**: `fts_notes`

**Schema** (SQL):
```sql
CREATE VIRTUAL TABLE fts_notes USING fts5(
  id UNINDEXED,          -- Note UUID (not searchable)
  title,                 -- Searchable
  content,               -- Searchable (markdown stripped)
  tags,                  -- Space-separated (searchable)
  tokenize='porter unicode61'
);
```

**Triggers** (existing):
- INSERT on noteCache → INSERT to fts_notes
- DELETE on noteCache → DELETE from fts_notes
- UPDATE title on noteCache → UPDATE fts_notes

**Manual Sync Required**:
- `content` column must be updated via `updateFtsContent()`
- `tags` column must be updated via `updateFtsContent()`

---

### 8. Attachment (File-Based)

Files embedded in notes.

**File Location**: `vault/attachments/{prefix}-{filename}`

**Naming Convention**:
- `{prefix}`: 6-char nanoid for uniqueness
- `{filename}`: Original filename, sanitized

**Reference in Notes**:
```markdown
![Image description](../attachments/abc123-photo.png)
[Download file](../attachments/def456-document.pdf)
```

**Validation Rules**:
| Rule | Value |
|------|-------|
| Max file size | 10MB |
| Allowed image types | png, jpg, jpeg, gif, webp, svg |
| Allowed file types | pdf, doc, docx, xls, xlsx, txt, md |

---

### 9. Folder (File-Based)

Directory structure for organizing notes.

**Location**: `vault/notes/{folder-path}/`

**Operations**:
- Create: `fs.mkdir(path, { recursive: true })`
- Rename: `fs.rename(oldPath, newPath)`
- Delete: `fs.rm(path, { recursive: true })` (only if empty)
- List: `fs.readdir(path, { withFileTypes: true })`

---

## Type Definitions

### Note (Full)
```typescript
interface Note {
  id: string                    // nanoid(12)
  path: string                  // Relative path from vault root
  title: string                 // Display title
  emoji?: string                // Emoji icon
  content: string               // Markdown content (without frontmatter)
  tags: string[]                // Lowercase tags
  properties: Record<string, unknown>  // Custom properties
  createdAt: string             // ISO timestamp
  modifiedAt: string            // ISO timestamp
  aliases?: string[]            // Alternative titles
}
```

### NoteListItem (Summary)
```typescript
interface NoteListItem {
  id: string
  path: string
  title: string
  emoji?: string
  snippet: string               // First 200 chars, markdown stripped
  wordCount: number
  tags: string[]
  modifiedAt: string
}
```

### NoteLink
```typescript
interface NoteLink {
  sourceId: string
  targetId: string | null
  targetTitle: string
  exists: boolean               // Computed: targetId !== null
}
```

### Backlink
```typescript
interface Backlink {
  sourceId: string
  sourceTitle: string
  sourcePath: string
  context: string               // Snippet around the link
}
```

### PropertyValue
```typescript
interface PropertyValue {
  name: string
  value: unknown
  type: PropertyType
}
```

---

## Query Patterns

### List Notes with Filtering
```typescript
// Filter by folder
WHERE path LIKE 'folder/%'

// Filter by tag (requires subquery for AND logic)
WHERE id IN (SELECT note_id FROM note_tags WHERE tag = 'work')
  AND id IN (SELECT note_id FROM note_tags WHERE tag = 'urgent')

// Sort by modified
ORDER BY modified_at DESC

// Pagination
LIMIT 50 OFFSET 0
```

### Get Backlinks
```typescript
// Notes that link TO this note
SELECT nc.id, nc.title, nc.path, nl.target_title
FROM note_links nl
JOIN note_cache nc ON nl.source_id = nc.id
WHERE nl.target_id = ?
```

### Full-Text Search
```typescript
// FTS5 query
SELECT id, snippet(fts_notes, 2, '<mark>', '</mark>', '...', 32) as snippet
FROM fts_notes
WHERE fts_notes MATCH 'search query'
ORDER BY rank
LIMIT 20
```

### Tag Statistics
```typescript
SELECT tag, COUNT(*) as count
FROM note_tags
GROUP BY tag
ORDER BY count DESC
```

---

## Implementation Status

### Implemented (in codebase)

| Entity | Table/File | Status |
|--------|-----------|--------|
| Note | `vault/notes/*.md` | ✅ Complete |
| NoteCache | `note_cache` table | ✅ Complete (missing emoji) |
| NoteTag | `note_tags` table | ✅ Complete |
| NoteLink | `note_links` table | ✅ Complete |
| FtsNote | `fts_notes` virtual table | ✅ Complete |
| Folder | `vault/notes/*/` | ✅ Complete |
| Attachment | `vault/attachments/` | ⚠️ Folder exists, no upload handler |

### Not Yet Implemented

| Entity | Table | Task |
|--------|-------|------|
| NoteProperty | `note_properties` | T004 |
| PropertyDefinition | `property_definitions` | T005 |
| NoteCache.emoji | `emoji` column | T003 |

---

## Migration Plan

### New Tables to Create

1. **noteProperties** - Custom property values per note (Task T004)
2. **propertyDefinitions** - Property schema definitions (Task T005)

### Schema Changes

1. **noteCache** - Add `emoji` column (Task T003):
```sql
ALTER TABLE note_cache ADD COLUMN emoji TEXT;
```

### Data Migration

None required - new columns are optional, existing data remains valid.

---

## Related Files

### Schema Definitions
- `src/shared/db/schema/notes-cache.ts` - Drizzle schema (needs T003-T005)
- `src/shared/contracts/notes-api.ts` - Zod validation schemas

### Query Functions
- `src/shared/db/queries/notes.ts` - 35 query functions implemented

### Vault Operations
- `src/main/vault/notes.ts` - 26 vault functions implemented
- `src/main/vault/frontmatter.ts` - YAML parsing (needs extractProperties)
