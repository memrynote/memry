# Specification: Folder View (Bases) System

**Feature**: Database-like table view for folders
**Inspiration**: Obsidian Bases, Notion Databases, Airtable
**Priority**: P1
**Estimated Effort**: 4 days (32 hours)

---

## Overview

The Folder View feature provides a spreadsheet-like interface for viewing and managing notes within folders. When a user clicks on a folder in the sidebar, instead of just selecting it, a new tab opens showing all notes in that folder (and subfolders) in a table format with sortable, filterable, and customizable columns.

---

## User Stories

### US1: View Notes in Table Format

**As a** user with many notes in a folder
**I want to** see all notes displayed in a table with columns
**So that** I can quickly scan and find notes based on their properties

**Acceptance Criteria**:

- Clicking a folder in sidebar opens folder view tab
- Table shows all notes in folder and subfolders
- Built-in columns: Title, Folder, Tags, Modified, Created, Words
- Property columns: Any frontmatter property can be added as column
- Each property type renders appropriately (text, dates, checkboxes, etc.)

### US2: Sort Notes by Any Column

**As a** user browsing notes
**I want to** sort by any column
**So that** I can find the most recent, alphabetically ordered, or prioritized notes

**Acceptance Criteria**:

- Click column header to sort ascending
- Click again to sort descending
- Click again to clear sort
- Shift+click for multi-column sort
- Sort persists across sessions

### US3: Filter Notes by Properties

**As a** user with many notes
**I want to** filter by property values
**So that** I can focus on specific subsets of notes

**Acceptance Criteria**:

- Filter button opens filter builder
- Add multiple filter conditions
- Filter operators match property type (contains for text, > for numbers)
- Filters persist across sessions
- Clear filters button

### US4: Customize Columns

**As a** user with specific workflow needs
**I want to** add, remove, resize, and reorder columns
**So that** I see the information most relevant to me

**Acceptance Criteria**:

- Column selector dropdown to add/remove columns
- Drag column borders to resize
- Drag column headers to reorder
- Double-click header to edit display name
- All customizations persist per-folder

### US5: Open Notes from Table

**As a** user browsing notes
**I want to** open notes from the table
**So that** I can view and edit their content

**Acceptance Criteria**:

- Single-click selects row
- Double-click opens note in new tab
- Enter key opens selected note
- Context menu with "Open", "Open in new tab" options

### US6: See Subfolder Context

**As a** user with nested folder structure
**I want to** see which subfolder each note is in
**So that** I understand my folder organization

**Acceptance Criteria**:

- "Folder" column shows relative path from current folder
- Notes directly in folder show "/"
- Notes in subfolders show "/subfolder/path"

---

## Non-Goals (Out of Scope)

1. **Root folder view**: Clicking the "Notes" root folder does NOT open a folder view
2. **Grid/Gallery view**: Only table view in first version
3. **Kanban view**: Grouped by property - future enhancement
4. **Inline property editing**: Cannot edit properties in table cells (view only)
5. **Creating notes from table**: Use existing "New Note" button
6. **Drag-drop rows**: Cannot move notes by dragging table rows

---

## Technical Design

### Architecture

```
┌────────────────────────────────────────────────────────────┐
│                     RENDERER PROCESS                        │
├────────────────────────────────────────────────────────────┤
│  NotesTree ──click──► openTab('folder', folderPath)        │
│                              │                              │
│                              ▼                              │
│                     FolderViewPage                          │
│                         │                                   │
│                         ▼                                   │
│                   useFolderView(path)                       │
│                    /     |      \                           │
│                   ▼      ▼       ▼                          │
│            getConfig  listNotes  getProperties              │
│                   \      |      /                           │
│                    ▼     ▼     ▼                            │
│                   FolderTableView                           │
│                   (TanStack Table)                          │
└────────────────────────────────────────────────────────────┘
                           │ IPC
                           ▼
┌────────────────────────────────────────────────────────────┐
│                      MAIN PROCESS                           │
├────────────────────────────────────────────────────────────┤
│  folder-view-handlers.ts                                    │
│    ├── GET_CONFIG ──► folder_view_config table             │
│    ├── SET_CONFIG ──► folder_view_config table             │
│    ├── LIST_WITH_PROPERTIES ──► note_cache + note_props    │
│    └── GET_AVAILABLE_PROPERTIES ──► note_properties        │
└────────────────────────────────────────────────────────────┘
```

### Key Technologies

| Technology       | Purpose                                          |
| ---------------- | ------------------------------------------------ |
| TanStack Table   | Headless table with sorting, filtering, resizing |
| TanStack Virtual | Row virtualization for large folders             |
| @dnd-kit         | Column drag-and-drop reordering                  |
| Drizzle ORM      | Database queries                                 |
| Zod              | Request/response validation                      |

### Database

New table in `index.db`:

```sql
CREATE TABLE folder_view_config (
  path TEXT PRIMARY KEY,
  view_type TEXT NOT NULL DEFAULT 'table',
  columns TEXT NOT NULL DEFAULT '[]',
  sort_column TEXT,
  sort_order TEXT DEFAULT 'desc',
  filters TEXT DEFAULT '[]',
  group_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### IPC Channels

| Channel                                | Direction       | Purpose                            |
| -------------------------------------- | --------------- | ---------------------------------- |
| `folder-view:get-config`               | Renderer → Main | Get folder view configuration      |
| `folder-view:set-config`               | Renderer → Main | Save folder view configuration     |
| `folder-view:list-with-properties`     | Renderer → Main | Get notes with property values     |
| `folder-view:get-available-properties` | Renderer → Main | Get properties for column selector |

---

## UI Design

### Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ← Back    📁 projects (24 notes)                    [+ New Note] [⚙]    │
├─────────────────────────────────────────────────────────────────────────┤
│ [+ Columns ▼]  [Filter ▼] (2)  Search: [________________]               │
├─────────────────────────────────────────────────────────────────────────┤
│ Title          │ Folder    │ Tags         │ Status   │ Modified        │
│ ↓──────────────│───────────│──────────────│──────────│─────────────────│
│ 📝 Project A   │ /2024     │ #work #imp   │ ● Active │ Today 2:30 PM   │
│ 📝 Project B   │ /2024/q1  │ #work        │ ○ Draft  │ Yesterday       │
│ 📝 Meeting...  │ /         │ #meeting     │ ● Done   │ Dec 28          │
│                │           │              │          │                 │
│                                                                         │
│                     (Scroll for more rows)                              │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Hierarchy

```
FolderViewPage
├── FolderViewHeader
│   ├── BackButton (if nested folder)
│   ├── FolderIcon + FolderName
│   ├── NoteCount
│   └── Actions (NewNote, Settings)
│
├── FolderViewToolbar
│   ├── ColumnSelector
│   ├── FilterBuilder
│   └── SearchInput
│
└── FolderTableView
    ├── TableHeader
    │   └── ColumnHeader[] (sortable, resizable, editable)
    │
    └── TableBody (virtualized)
        └── TableRow[]
            └── PropertyCell (renders by type)
```

### Property Cell Rendering

| Type        | Render                        |
| ----------- | ----------------------------- |
| Title       | Emoji + title text, clickable |
| Folder      | Relative path badge           |
| Tags        | Colored tag badges            |
| text        | Plain text, ellipsis          |
| number      | Right-aligned                 |
| checkbox    | ✓ or ✗ icon                   |
| date        | Relative date                 |
| select      | Colored badge                 |
| multiselect | Multiple badges               |
| url         | Link with icon                |
| rating      | ★★★☆☆                         |

---

## Interactions

### Folder Click

1. User clicks folder in sidebar (not root)
2. NotesTree detects folder selection
3. Opens new tab with type 'folder'
4. FolderViewPage loads with folderPath
5. Fetches config (or creates default)
6. Fetches notes with properties
7. Renders table

### Column Resize

1. User drags column border
2. Column width updates in real-time
3. On mouse up, width saved to config
4. Config debounced to avoid excessive saves

### Display Name Edit

1. User double-clicks column header
2. Header becomes editable input
3. User types new name
4. On Enter/blur, saves to config
5. On Escape, cancels edit

### Sort

1. User clicks column header
2. If no sort: sort ascending
3. If ascending: sort descending
4. If descending: clear sort
5. Update table order
6. Save to config

### Filter

1. User clicks Filter button
2. Filter dropdown opens
3. User adds condition (property, operator, value)
4. Table filters in real-time
5. Save to config

---

## Edge Cases

### Folder Renamed

When folder is renamed:

1. Update `folder_view_config.path` for exact match
2. Update child folder paths (LIKE old_path/%)
3. Active folder view tab updates title

### Folder Deleted

When folder is deleted:

1. Delete `folder_view_config` for folder and children
2. Close any open folder view tabs for this folder
3. Show "Folder not found" if already viewing

### Note Deleted While Viewing

1. Remove row from table (animate out)
2. Update note count
3. If all notes deleted, show empty state

### Property Type Changed

1. Re-fetch notes on next load
2. Cells re-render with new type renderer
3. Invalid filters auto-removed

---

## Performance Considerations

### Large Folders (1000+ notes)

1. **Virtual scrolling**: Only render visible rows + buffer
2. **Lazy property loading**: Fetch properties only for visible columns
3. **Debounced search**: 200ms debounce on search input
4. **Debounced config save**: 300ms debounce on resize/reorder

### Optimizations

1. Memoize column definitions
2. Memoize cell renderers
3. Use stable row keys (note.id)
4. Avoid re-fetching on every config change

---

## Future Enhancements

1. **Grid/Gallery View**: Cards with thumbnails
2. **Kanban View**: Columns grouped by property
3. **Inline Editing**: Edit properties in cells
4. **Column Templates**: Save/apply column presets
5. **Computed Columns**: Formulas and aggregations
6. **Export to CSV**: Export table data
7. **Saved Views**: Multiple saved configurations per folder

---

## Dependencies

### Existing

- TanStack Virtual (already installed)
- @dnd-kit (already installed)
- Drizzle ORM (already installed)

### New

- @tanstack/react-table (to be installed)

---

## Testing Strategy

### Unit Tests

- Column config validation
- Filter operator logic
- Relative folder path computation

### Integration Tests

- IPC handler responses
- Database queries
- Config persistence

### E2E Tests

- Folder click opens view
- Sort/filter/search work
- Column customization persists
- Notes open on double-click

---

## Rollout Plan

### Phase 1: MVP (2 days)

- Basic table view
- Built-in columns
- Sorting
- Tab integration

### Phase 2: Customization (1 day)

- Property columns
- Column resize/reorder
- Display name editing
- Column selector

### Phase 3: Advanced (1 day)

- Filtering
- Search
- Virtualization
- Context menu

### Phase 4: Polish (as needed)

- Empty states
- Error handling
- Performance tuning
- Edge cases
