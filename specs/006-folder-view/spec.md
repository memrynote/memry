# Specification: Folder View (Bases) System

**Feature**: Database-like table view for folders
**Inspiration**: Obsidian Bases, Notion Databases, Airtable
**Priority**: P1
**Estimated Effort**: 5.5 days (43 hours)
**Storage**: `.folder.md` files (YAML frontmatter) - portable and sync-friendly

---

## Overview

The Folder View feature provides a spreadsheet-like interface for viewing and managing notes within folders. When a user clicks on a folder in the sidebar, instead of just selecting it, a new tab opens showing all notes in that folder (and subfolders) in a table format with sortable, filterable, and customizable columns.

**Key Design Decision**: Configuration is stored in `.folder.md` files alongside notes, not in a database table. This ensures:

- Configs sync with vault (Dropbox, Git, iCloud)
- Users can manually edit YAML if needed
- Configs survive database reindex

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
- Sort persists across sessions (saved to `.folder.md`)

### US3: Filter Notes by Properties

**As a** user with many notes
**I want to** filter by property values
**So that** I can focus on specific subsets of notes

**Acceptance Criteria**:

- Filter button opens filter builder
- Add multiple filter conditions with AND/OR/NOT logic
- Filter operators match property type (contains for text, > for numbers)
- Filters persist across sessions (saved to `.folder.md`)
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
- All customizations persist per-folder (saved to `.folder.md`)

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

### US7: Multiple Named Views (Post-MVP)

**As a** power user
**I want to** create multiple views with different configurations
**So that** I can quickly switch between different perspectives

**Acceptance Criteria**:

- Multiple named views per folder
- View switcher tabs
- Each view has own columns, filters, sort
- Views saved to `.folder.md`

---

## Non-Goals (Out of Scope for MVP)

1. **Root folder view**: Clicking the "Notes" root folder does NOT open a folder view
2. **Grid/Gallery view**: Only table view in first version
3. **Kanban view**: Grouped by property - future enhancement
4. **Inline property editing**: Cannot edit properties in table cells (view only)
5. **Creating notes from table**: Use existing "New Note" button
6. **Drag-drop rows**: Cannot move notes by dragging table rows
7. **Formulas**: Computed columns - post-MVP
8. **Summaries**: Column aggregations - post-MVP

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
│            getViews  listNotes  getProperties               │
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
│    ├── GET_CONFIG ──► read .folder.md file                 │
│    ├── SET_CONFIG ──► write .folder.md file                │
│    ├── LIST_WITH_PROPERTIES ──► note_cache + note_props    │
│    └── GET_AVAILABLE_PROPERTIES ──► note_properties        │
└────────────────────────────────────────────────────────────┘
```

### Storage: `.folder.md` Files

Configuration is stored in `.folder.md` YAML frontmatter:

```yaml
# notes/projects/.folder.md
---
template: project-template
inherit: true

# View configuration
views:
  - name: 'All Projects'
    type: table
    default: true
    columns:
      - id: title
        width: 250
      - id: folder
        width: 120
      - id: status
        width: 100
      - id: modified
        width: 130
    order:
      - property: modified
        direction: desc

  - name: 'Active Only'
    type: table
    columns:
      - id: title
        width: 300
      - id: priority
        width: 80
    filters:
      and:
        - status != "done"
        - status != "archived"
    order:
      - property: priority
        direction: desc

properties:
  status:
    displayName: 'Status'
  priority:
    displayName: 'Priority'
---
```

### Key Technologies

| Technology       | Purpose                                          |
| ---------------- | ------------------------------------------------ |
| TanStack Table   | Headless table with sorting, filtering, resizing |
| TanStack Virtual | Row virtualization for large folders             |
| @dnd-kit         | Column drag-and-drop reordering                  |
| gray-matter      | Parse/serialize YAML frontmatter                 |
| Zod              | Request/response validation                      |

### Cache (Optional Performance Optimization)

For faster reads, parsed configs can be cached in `index.db`:

```sql
CREATE TABLE folder_view_cache (
  path TEXT PRIMARY KEY,
  config_hash TEXT NOT NULL,
  parsed_config TEXT NOT NULL,
  cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Cache is invalidated when `.folder.md` content hash changes.

### IPC Channels

| Channel                                | Direction       | Purpose                            |
| -------------------------------------- | --------------- | ---------------------------------- |
| `folder-view:get-config`               | Renderer → Main | Read views from .folder.md         |
| `folder-view:set-config`               | Renderer → Main | Write views to .folder.md          |
| `folder-view:list-with-properties`     | Renderer → Main | Get notes with property values     |
| `folder-view:get-available-properties` | Renderer → Main | Get properties for column selector |
| `folder-view:get-views`                | Renderer → Main | Get all views for folder           |
| `folder-view:set-view`                 | Renderer → Main | Add/update a single view           |
| `folder-view:delete-view`              | Renderer → Main | Delete a view by name              |

---

## UI Design

### Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ← Back    📁 projects (24 notes)                    [+ New Note] [⚙]    │
├─────────────────────────────────────────────────────────────────────────┤
│ [All Projects] [Active Only] [+ New View]                               │
├─────────────────────────────────────────────────────────────────────────┤
│ [+ Columns ▼]  [Filter ▼] (2)  Search: [________________]               │
├─────────────────────────────────────────────────────────────────────────┤
│ Title          │ Folder    │ Tags         │ Status   │ Modified        │
│ ↓──────────────│───────────│──────────────│──────────│─────────────────│
│ 📝 Project A   │ /2024     │ #work #imp   │ ● Active │ Today 2:30 PM   │
│ 📝 Project B   │ /2024/q1  │ #work        │ ○ Draft  │ Yesterday       │
│ 📝 Meeting...  │ /         │ #meeting     │ ● Done   │ Dec 28          │
│                │           │              │          │                 │
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
├── ViewSwitcher (tabs for multiple views)
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
5. Reads `.folder.md` for views config (or uses default)
6. Fetches notes with properties
7. Renders table with active view

### Column Resize

1. User drags column border
2. Column width updates in real-time
3. On mouse up, width saved to `.folder.md`
4. Save is debounced (300ms) to avoid excessive writes

### Display Name Edit

1. User double-clicks column header
2. Header becomes editable input
3. User types new name
4. On Enter/blur, saves to `.folder.md` properties section
5. On Escape, cancels edit

### Sort

1. User clicks column header
2. If no sort: sort ascending
3. If ascending: sort descending
4. If descending: clear sort
5. Update table order
6. Save to `.folder.md` view.order

### Filter

1. User clicks Filter button
2. Filter dropdown opens
3. User adds condition (property, operator, value)
4. Support AND/OR/NOT nesting
5. Table filters in real-time
6. Save to `.folder.md` view.filters

---

## Edge Cases

### Folder Renamed

When folder is renamed:

1. `.folder.md` file moves with folder automatically (it's inside the folder)
2. Invalidate any cache entries for old path
3. Active folder view tab updates title

### Folder Deleted

When folder is deleted:

1. `.folder.md` file deleted with folder automatically
2. Clean up cache entries
3. Close any open folder view tabs for this folder
4. Show "Folder not found" if already viewing

### Note Deleted While Viewing

1. Remove row from table (animate out)
2. Update note count
3. If all notes deleted, show empty state

### Property Type Changed

1. Re-fetch notes on next load
2. Cells re-render with new type renderer
3. Invalid filters auto-removed

### External .folder.md Edit

1. File watcher detects change
2. Invalidate cache
3. Prompt user to reload or auto-reload

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
4. Cache parsed `.folder.md` configs
5. Avoid re-reading file on every config change

---

## Future Enhancements

1. **Grid/Gallery View**: Cards with thumbnails
2. **Kanban View**: Columns grouped by property
3. **Inline Editing**: Edit properties in cells
4. **Formulas**: Computed columns with expressions
5. **Summaries**: Column aggregations (sum, average, count)
6. **Group By**: Group rows by property value
7. **Export to CSV**: Export table data
8. **Column Templates**: Save/apply column presets

---

## Dependencies

### Existing

- TanStack Virtual (already installed)
- @dnd-kit (already installed)
- gray-matter (already installed)

### New

- @tanstack/react-table (to be installed)

---

## Testing Strategy

### Unit Tests

- Column config validation
- Filter expression evaluation
- Relative folder path computation
- YAML serialization/parsing

### Integration Tests

- IPC handler responses
- .folder.md read/write operations
- Config persistence across sessions

### E2E Tests

- Folder click opens view
- Sort/filter/search work
- Column customization persists to .folder.md
- Notes open on double-click
- Vault sync works (manual test)

---

## Rollout Plan

### Phase 1: MVP (2.5 days)

- Basic table view
- Built-in columns
- Column customization
- Multi-column sorting
- Tab integration
- `.folder.md` storage

### Phase 2: Filtering (1 day)

- Advanced filtering with AND/OR/NOT
- Filter persistence

### Phase 3: Multiple Views (0.5 day)

- Named views
- View switcher
- View management

### Phase 4: Performance & Polish (1.5 days)

- Row virtualization
- Empty states
- Error handling
- Edge cases
- Keyboard navigation
- Context menu
