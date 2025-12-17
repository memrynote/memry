# Notes System Specification

Note management with properties, tags, backlinks, and wiki-style linking.

```
/speckit.specify

Build the notes system that connects to the existing NotePage component and enables rich note-taking with properties, tags, and bidirectional linking:

## USER STORIES

### P1 - Critical
1. As a user, I want to create and edit notes with rich text (headings, bold, lists, code blocks)
2. As a user, I want my notes saved automatically as I type without losing work
3. As a user, I want to add tags to notes for organization and filtering
4. As a user, I want to link notes together using [[wiki-style links]]
5. As a user, I want to see what other notes link to the current note (backlinks)

### P2 - Important
6. As a user, I want to add custom properties to notes (like Notion databases)
7. As a user, I want an emoji icon for each note for visual recognition
8. As a user, I want to embed images and attachments in my notes
9. As a user, I want to see an outline of headings for navigation in long notes
10. As a user, I want to organize notes in folders

### P3 - Nice to Have
11. As a user, I want to see recently edited notes for quick access
12. As a user, I want templates for common note types
13. As a user, I want to export notes as PDF or HTML
14. As a user, I want version history to see previous edits

## DATA MODELS

### Note (File-based)
Note content is stored as markdown files. Metadata in frontmatter:

```yaml
---
id: "550e8400-e29b-41d4-a716-446655440000"
title: "Meeting Notes - Q4 Planning"
emoji: "📝"
created: "2024-01-15T10:30:00Z"
modified: "2024-01-15T14:22:00Z"
tags:
  - work
  - meeting
  - q4
properties:
  status: "Draft"
  author: "John"
  project: "Q4 Planning"
  rating: 5
---

# Meeting Notes - Q4 Planning

Content goes here with [[links to other notes]]...
```

### NoteIndex (Database cache)
```typescript
interface NoteIndex {
  id: string              // From frontmatter
  path: string            // Relative path in vault
  title: string
  emoji: string | null
  createdAt: Date
  modifiedAt: Date
  contentHash: string     // For change detection
  wordCount: number
  characterCount: number

  // Denormalized for fast queries
  tags: string[]
  properties: Record<string, PropertyValue>

  // Computed
  outgoingLinks: string[]   // IDs of notes this links to
  incomingLinks: string[]   // IDs of notes linking here (backlinks)
}

type PropertyValue = string | number | boolean | Date | string[]
```

### Property Schema
```typescript
interface PropertyDefinition {
  name: string
  type: "text" | "number" | "checkbox" | "date" | "select" | "multiselect" | "url" | "rating"
  options?: string[]      // For select/multiselect
  defaultValue?: PropertyValue
}
```

### Tag
```typescript
interface Tag {
  name: string            // Lowercase, no spaces
  color: string           // Hex color for display
  noteCount: number       // Computed
}
```

## FUNCTIONAL REQUIREMENTS

### Note CRUD
- Create note: generate UUID, create file with frontmatter template
- Read note: parse frontmatter + content, return structured data
- Update note:
  - Auto-save with debounce (1 second after typing stops)
  - Atomic write (write to temp file, then rename)
  - Update modifiedAt timestamp
- Delete note: move to system trash (recoverable)
- Rename note: update filename, preserve UUID

### Auto-save Implementation
```
On content change:
  1. Update in-memory state immediately (for UI)
  2. Cancel any pending save timer
  3. Start new 1-second debounce timer
  4. On timer fire:
     a. Stringify frontmatter + content to markdown
     b. Write to temp file (note.md.tmp)
     c. Atomic rename to actual file
     d. Update index.db with new hash/metadata
  5. Show "Saved" indicator briefly
```

### Wiki Links
- Syntax: [[Note Title]] or [[Note Title|display text]]
- On type "[[": show autocomplete with note titles
- Clicking link opens target note in new tab
- If target doesn't exist, offer to create it
- Backlinks computed on index update

### Backlink Computation
```
On note save:
  1. Parse content for [[links]]
  2. Resolve each link to target note ID
  3. Update outgoingLinks for this note
  4. For each target, add this note to their incomingLinks
  5. Store in index.db for fast retrieval
```

### Tags
- Add tag via UI or typing #tag in content
- Tags are case-insensitive, stored lowercase
- Auto-complete existing tags
- Create new tag on-the-fly
- Tag color assigned automatically (or user chooses)
- Tag filtering in note list

### Properties
- Built-in property types: text, number, checkbox, date, select, multiselect, url, rating
- Add property: choose type, enter name
- Edit property value inline
- Delete property (removes from frontmatter)
- Properties stored in frontmatter YAML
- Sort/filter notes by property values

### Folders
- Create folder in vault/notes/
- Move notes between folders
- Rename folders
- Delete folder (must be empty or move contents)
- Folder shown in sidebar tree

### Attachments
- Drag image/file into editor
- File copied to vault/attachments/
- Markdown link inserted: ![image](../attachments/filename.png)
- Click attachment to open in system viewer
- Attachment cleanup: detect orphaned files

## NON-FUNCTIONAL REQUIREMENTS

### Performance
- Open note in <100ms (even 100KB notes)
- Auto-save doesn't cause UI stutter
- Backlink computation in background (not blocking)
- 10,000 notes searchable in <50ms

### Reliability
- Never lose unsaved content (keep in memory until save confirmed)
- Recover from crashed save (check for .tmp files on startup)
- Handle concurrent edits (file changed externally during edit)

## ACCEPTANCE CRITERIA

### Basic Editing
- [ ] Create new note from sidebar "+" button
- [ ] Edit title updates filename and frontmatter
- [ ] Rich text formatting (bold, italic, headings) works
- [ ] Changes auto-save after 1 second of inactivity
- [ ] "Saved" indicator appears after save

### Tags
- [ ] Adding tag updates frontmatter and shows in UI
- [ ] Tag autocomplete shows existing tags
- [ ] Clicking tag filters note list
- [ ] Removing tag updates frontmatter

### Wiki Links
- [ ] Typing "[[" shows note autocomplete
- [ ] Selecting note inserts [[Note Title]]
- [ ] Clicking link opens note in new tab
- [ ] Backlinks section shows all linking notes
- [ ] Clicking backlink snippet opens source note

### Properties
- [ ] Add text property shows in info section
- [ ] Add date property shows date picker
- [ ] Checkbox property toggles correctly
- [ ] Rating property shows star picker
- [ ] Property changes persist to frontmatter

### Attachments
- [ ] Drag image into editor uploads and inserts
- [ ] Image renders in editor
- [ ] Click image opens in viewer
- [ ] Attachment stored in attachments folder

### Edge Cases
- [ ] Very long note (10,000 words) edits smoothly
- [ ] Note with 50 backlinks loads without delay
- [ ] External edit while note open shows conflict warning
- [ ] Creating link to non-existent note offers to create it
- [ ] Emoji picker works with keyboard and mouse
```
