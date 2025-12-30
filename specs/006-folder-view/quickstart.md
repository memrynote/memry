# Quickstart: Folder View (Bases) Feature

This guide provides step-by-step validation for the Folder View feature.

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

## Phase 2: Database Validation

### T004-T007: Schema and Migration

```bash
# Check migration was generated
ls -la src/main/database/migrations/

# Verify table exists (after running app once)
sqlite3 ~/.memry/vaults/[vault-name]/index.db ".schema folder_view_config"
```

**Expected**: Migration file exists, table schema matches data-model.md.

---

## Phase 3-5: Backend Validation

### T008-T021: IPC and Service Layer

1. Open Developer Tools (Cmd+Option+I)
2. In Console, run:

```javascript
// Test getConfig
await window.api.folderView.getConfig('projects')
// Expected: { config: {...}, isDefault: true } for new folder

// Test setConfig
await window.api.folderView.setConfig({
  path: 'projects',
  viewType: 'table',
  columns: [...],
  sortColumn: null,
  sortOrder: 'desc',
  filters: [],
  groupBy: null
})
// Expected: { success: true, config: {...} }

// Test listWithProperties
await window.api.folderView.listWithProperties({ folderPath: 'projects' })
// Expected: { notes: [...], total: N, hasMore: false }

// Test getAvailableProperties
await window.api.folderView.getAvailableProperties('projects')
// Expected: { builtIn: [...], properties: [...] }
```

---

## Phase 6: Tab Integration Validation

### T022-T024: Folder Click Opens Tab

1. Open sidebar with notes tree
2. Click on a folder (not root "Notes")
3. Verify:
   - New tab opens with folder name as title
   - Tab icon is folder icon
   - Tab content shows FolderViewPage

**Expected**: Clicking folder opens folder view tab.

---

## Phase 7-8: Basic Table Validation

### T025-T032: Table Displays Notes

1. Click a folder with notes
2. Verify:
   - Table header shows column names
   - Table body shows note rows
   - Each row has title, folder, tags, modified columns
   - Row count matches folder note count

**Expected**: Table displays notes with correct data.

---

## Phase 9: Cell Rendering Validation

### T033-T044: Property Types Render Correctly

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

### T045-T047: Interactive Headers

1. **Sorting**: Click column header
   - First click: Sort ascending (▲)
   - Second click: Sort descending (▼)
   - Third click: Clear sort

2. **Resizing**: Drag column border
   - Width changes during drag
   - Width persists after release

3. **Display Name Edit**: Double-click header
   - Input appears
   - Type new name
   - Press Enter to save
   - Verify name persisted

---

## Phase 11-12: Column Management Validation

### T048-T054: Add/Remove/Reorder Columns

1. **Add Column**:
   - Click column selector dropdown
   - Select a hidden column
   - Verify column appears in table

2. **Remove Column**:
   - Click column selector
   - Uncheck visible column
   - Verify column removed from table

3. **Reorder**:
   - Drag column header
   - Drop in new position
   - Verify order persisted

---

## Phase 13-14: Sort and Filter Validation

### T055-T064: Sorting and Filtering

1. **Sort**:
   - Click "Modified" header
   - Verify rows reorder by date
   - Refresh page, verify sort persisted

2. **Filter**:
   - Click filter button
   - Add filter: "title contains test"
   - Verify only matching notes shown
   - Clear filter, verify all notes return

---

## Phase 15-17: Search and Navigation

### T065-T076: Search and Keyboard

1. **Search**:
   - Type in search box
   - Verify table filters in real-time

2. **Keyboard**:
   - Press ↓ to move selection down
   - Press ↑ to move selection up
   - Press Enter to open note in new tab
   - Press Escape to clear selection

3. **Context Menu**:
   - Right-click a row
   - Verify menu appears with actions
   - Click "Open in new tab"

---

## Phase 18-19: Performance and States

### T077-T084: Large Folder and Empty States

1. **Large Folder** (100+ notes):
   - Scroll through table
   - Verify smooth scrolling (virtualization)
   - Verify no lag

2. **Empty Folder**:
   - Click empty folder
   - Verify "No notes" message
   - Click "Create note" button

3. **Filtered Empty**:
   - Apply filter that matches nothing
   - Verify "No notes match filters" message
   - Click "Clear filters"

---

## Phase 20-21: Actions and Edge Cases

### T085-T096: Toolbar and Edge Cases

1. **New Note**:
   - Click "New Note" button
   - Verify note created in folder
   - Verify note opened in tab

2. **Folder Rename**:
   - Rename folder in sidebar
   - Verify folder view updates
   - Verify config preserved

3. **Folder Delete**:
   - Delete folder (with confirmation)
   - Verify tab closes or shows error

---

## Full Feature Checklist

- [ ] Folder click opens table view
- [ ] Notes display with properties
- [ ] Built-in columns work (title, folder, tags, dates)
- [ ] Custom property columns work
- [ ] Column resize persists
- [ ] Column reorder persists
- [ ] Display name edit persists
- [ ] Sorting works and persists
- [ ] Filtering works and persists
- [ ] Global search works
- [ ] Double-click opens note in new tab
- [ ] Keyboard navigation works
- [ ] Context menu works
- [ ] Empty state displays correctly
- [ ] Large folders perform well
- [ ] Folder rename updates config
- [ ] Folder delete cleans up config

---

## Troubleshooting

### Table not loading

1. Check console for errors
2. Verify folder path is correct (not including "notes/")
3. Check database has folder_view_config table

### Columns not persisting

1. Check setConfig is being called
2. Verify config is saved to database
3. Check getConfig returns saved config

### Performance issues

1. Verify virtualization is enabled
2. Check for excessive re-renders in React DevTools
3. Limit initial property fetch to visible columns
