# Quickstart: Folder View (Bases) Feature

This guide provides step-by-step validation for the Folder View feature.

**Storage**: Configuration is stored in `.folder.md` files (YAML frontmatter), not in a database table.

---

## Prerequisites

1. Vault is open with at least one folder containing notes
2. Notes have some properties defined (status, priority, etc.)
3. Application is running in development mode

---

## Phase 1: Setup Validation

### T001-T003: Dependencies and Structure

```bash
# Verify @tanstack/react-table is installed
pnpm list @tanstack/react-table

# Verify directory structure exists
ls -la src/renderer/src/components/folder-view/
ls -la src/renderer/src/pages/folder-view.tsx
```

**Expected**: Package installed, directories and placeholder file exist.

---

## Phase 2: .folder.md Schema Validation

### T004-T011: Schema Extension and Cache

```bash
# Verify .folder.md can be parsed with view fields
cat notes/[folder-name]/.folder.md

# Example expected content:
# ---
# template: default
# views:
#   - name: "Default"
#     type: table
#     columns:
#       - id: title
#         width: 250
# ---

# If using cache, verify cache table exists (optional)
sqlite3 ~/.memry/vaults/[vault-name]/index.db ".schema folder_view_cache"
```

**Expected**: .folder.md files can store view configuration in YAML frontmatter.

---

## Phase 3-5: Backend Validation

### T012-T028: IPC and Service Layer

1. Open Developer Tools (Cmd+Option+I)
2. In Console, run:

```javascript
// Test getConfig - reads from .folder.md
await window.api.folderView.getConfig('projects')
// Expected: { views: [...], isDefault: true/false }

// Test setConfig - writes to .folder.md
await window.api.folderView.setView('projects', {
  name: 'Default',
  type: 'table',
  columns: [
    { id: 'title', width: 250 },
    { id: 'modified', width: 130 }
  ],
  order: [{ property: 'modified', direction: 'desc' }]
})
// Expected: { success: true }

// Verify .folder.md was updated
// Check file: vault/notes/projects/.folder.md

// Test listWithProperties
await window.api.folderView.listWithProperties({ folderPath: 'projects' })
// Expected: { notes: [...], total: N, hasMore: false }

// Test getAvailableProperties
await window.api.folderView.getAvailableProperties('projects')
// Expected: { builtIn: [...], properties: [...] }
```

### Verify .folder.md File

After running setConfig, check the file manually:

```bash
cat vault/notes/projects/.folder.md
```

Expected content:

```yaml
---
template: default
views:
  - name: 'Default'
    type: table
    columns:
      - id: title
        width: 250
      - id: modified
        width: 130
    order:
      - property: modified
        direction: desc
---
```

---

## Phase 6: Tab Integration Validation

### T029-T031: Folder Click Opens Tab

1. Open sidebar with notes tree
2. Click on a folder (not root "Notes")
3. Verify:
   - New tab opens with folder name as title
   - Tab icon is folder icon
   - Tab content shows FolderViewPage

**Expected**: Clicking folder opens folder view tab.

---

## Phase 7-8: Basic Table Validation

### T032-T039: Table Displays Notes

1. Click a folder with notes
2. Verify:
   - Table header shows column names
   - Table body shows note rows
   - Each row has title, folder, tags, modified columns
   - Row count matches folder note count

**Expected**: Table displays notes with correct data.

---

## Phase 9: Cell Rendering Validation

### T040-T051: Property Types Render Correctly

Create notes with various property types and verify:

| Property Type | Test Value    | Expected Render      |
| ------------- | ------------- | -------------------- |
| text          | "Hello World" | Plain text           |
| number        | 42            | Right-aligned "42"   |
| checkbox      | true          | Green checkmark icon |
| checkbox      | false         | Gray X icon          |
| date          | "2025-12-25"  | "Dec 25" or "Today"  |
| select        | "draft"       | Colored badge        |
| multiselect   | ["a", "b"]    | Multiple badges      |
| url           | "https://..." | Clickable link       |
| rating        | 4             | "★★★★☆"              |

---

## Phase 10: Column Header Validation

### T052-T054: Interactive Headers

1. **Sorting**: Click column header
   - First click: Sort ascending (▲)
   - Second click: Sort descending (▼)
   - Third click: Clear sort

2. **Resizing**: Drag column border
   - Width changes during drag
   - Width persists after release
   - **Verify**: Check `.folder.md` file updated with new width

3. **Display Name Edit**: Double-click header
   - Input appears
   - Type new name
   - Press Enter to save
   - **Verify**: Check `.folder.md` properties section updated

---

## Phase 11-12: Column Management Validation

### T055-T061: Add/Remove/Reorder Columns

1. **Add Column**:
   - Click column selector dropdown
   - Select a hidden column
   - Verify column appears in table
   - **Verify**: `.folder.md` updated with new column

2. **Remove Column**:
   - Click column selector
   - Uncheck visible column
   - Verify column removed from table

3. **Reorder**:
   - Drag column header
   - Drop in new position
   - Verify order persisted
   - **Verify**: `.folder.md` columns array order changed

---

## Phase 13-14: Sort and Filter Validation

### T062-T072: Sorting and Filtering

1. **Sort**:
   - Click "Modified" header
   - Verify rows reorder by date
   - Close and reopen tab
   - **Verify**: Sort persisted in `.folder.md` view.order

2. **Filter**:
   - Click filter button
   - Add filter: "status == done"
   - Add nested filter with OR
   - Verify only matching notes shown
   - **Verify**: Filter saved to `.folder.md` view.filters

---

## Phase 15-16: Search and Multiple Views

### T073-T081: Search and Views

1. **Search**:
   - Type in search box
   - Verify table filters in real-time

2. **Multiple Views**:
   - Click "+ New View" button
   - Name the view "Active Only"
   - Configure different columns/filters
   - Switch between views using tabs
   - **Verify**: Both views saved to `.folder.md`

---

## Phase 17-19: Navigation and Performance

### T082-T093: Keyboard and Virtualization

1. **Keyboard**:
   - Press ↓ to move selection down
   - Press ↑ to move selection up
   - Press Enter to open note in new tab
   - Press Escape to clear selection

2. **Context Menu**:
   - Right-click a row
   - Verify menu appears with actions
   - Click "Open in new tab"

3. **Large Folder** (100+ notes):
   - Scroll through table
   - Verify smooth scrolling (virtualization)
   - Verify no lag

---

## Phase 20-21: States and Toolbar

### T094-T101: Empty States and Actions

1. **Empty Folder**:
   - Click empty folder
   - Verify "No notes" message
   - Click "Create note" button

2. **Filtered Empty**:
   - Apply filter that matches nothing
   - Verify "No notes match filters" message
   - Click "Clear filters"

3. **New Note**:
   - Click "New Note" button
   - Verify note created in folder
   - Verify note opened in tab

---

## Phase 25: Edge Cases Validation

### T115-T123: Edge Cases

1. **Folder Rename**:
   - Rename folder in sidebar
   - Verify folder view updates title
   - Verify `.folder.md` moved with folder (automatic)
   - View config should still work

2. **Folder Delete**:
   - Delete folder (with confirmation)
   - Verify tab closes or shows error
   - `.folder.md` deleted automatically with folder

3. **External .folder.md Edit**:
   - Manually edit `.folder.md` file in text editor
   - Add a new view or change column width
   - Return to app
   - Verify changes reflected (may need refresh)

---

## Full Feature Checklist

### Core Features

- [ ] Folder click opens table view
- [ ] Notes display with properties
- [ ] Built-in columns work (title, folder, tags, dates)
- [ ] Custom property columns work

### Column Customization

- [ ] Column resize persists to `.folder.md`
- [ ] Column reorder persists to `.folder.md`
- [ ] Display name edit persists to `.folder.md`

### Sorting & Filtering

- [ ] Sorting works and persists
- [ ] Multi-column sorting works
- [ ] Filtering with AND/OR/NOT works
- [ ] Filters persist to `.folder.md`
- [ ] Global search works

### Multiple Views

- [ ] Can create named views
- [ ] View switcher works
- [ ] Each view has independent config
- [ ] All views saved to `.folder.md`

### Navigation

- [ ] Double-click opens note in new tab
- [ ] Keyboard navigation works
- [ ] Context menu works

### States

- [ ] Empty state displays correctly
- [ ] Loading state shows skeleton
- [ ] Large folders perform well (virtualization)

### Persistence

- [ ] Config survives app restart
- [ ] Config survives vault reindex
- [ ] `.folder.md` can be manually edited
- [ ] Config syncs with vault (Dropbox/Git)

### Edge Cases

- [ ] Folder rename preserves config
- [ ] Folder delete cleans up properly
- [ ] External file changes detected

---

## Troubleshooting

### Table not loading

1. Check console for errors
2. Verify folder path is correct (not including "notes/")
3. Try creating a new `.folder.md` manually with valid YAML

### Columns not persisting

1. Check if `.folder.md` file exists in the folder
2. Verify file is writable (permissions)
3. Check YAML syntax is valid
4. Look for errors in console during save

### .folder.md not updating

1. Verify debounce completed (wait 300ms after action)
2. Check file watcher isn't blocking writes
3. Try manual save via dev console: `window.api.folderView.setView(...)`

### Performance issues

1. Verify virtualization is enabled (check 100+ rows)
2. Check for excessive re-renders in React DevTools
3. Verify cache is working (if implemented)
4. Limit columns to reduce property fetching

### Sync conflicts

If using Dropbox/Git and `.folder.md` has conflicts:

1. Manually resolve YAML conflicts
2. Ensure valid YAML structure
3. Reload folder view in app
