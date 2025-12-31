# Tasks: Folder View (Bases) System

**Input**: Design documents from `/specs/006-folder-view/`
**Prerequisites**: data-model.md, contracts/folder-view-api.ts

**Tests**: Tests are not explicitly requested. Test tasks are NOT included.

**Organization**: Tasks are grouped by phase to enable systematic implementation with clear checkpoints.

**Storage**: Configuration stored in `.folder.md` files (portable, sync-friendly)

## Format: `[ID] [P?] [Phase] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Phase]**: Which phase this task belongs to
- Include exact file paths in descriptions

## Path Conventions

- **Electron app**: `src/main/`, `src/renderer/src/`, `src/shared/`, `src/preload/`
- Following established patterns from 001-core-data-layer and 005-inbox-capture

---

## Phase 1: Setup & Dependencies

**Purpose**: Install dependencies and prepare project structure

- [x] T001 [P] Install @tanstack/react-table dependency: `pnpm add @tanstack/react-table`
- [x] T002 [P] Create `src/renderer/src/components/folder-view/` directory structure
- [x] T003 [P] Create `src/renderer/src/pages/folder-view.tsx` empty placeholder component

**Checkpoint**: Dependencies installed, directories created ✅

---

## Phase 2: Extend .folder.md Schema

**Purpose**: Extend existing folder config to support view configuration

**CRITICAL**: This phase MUST complete before Phase 3 can begin

### Schema Extension

- [x] T004 Update `FolderConfig` interface in `src/shared/contracts/templates-api.ts`:
  - Add `views?: ViewConfig[]` field
  - Add `formulas?: Record<string, string>` field
  - Add `properties?: Record<string, PropertyDisplay>` field
  - Add `summaries?: Record<string, SummaryConfig>` field
- [x] T005 Create `src/shared/contracts/folder-view-api.ts` with full type definitions:
  - ViewConfig interface (name, type, columns, filters, order, groupBy)
  - ColumnConfig interface (id, width, displayName)
  - FilterExpression type (string | {and} | {or} | {not})
  - OrderConfig interface (property, direction)
  - GroupByConfig interface
  - PropertyDisplay interface
  - SummaryConfig interface
  - NoteWithProperties interface
- [x] T006 Update `parseFolderConfig` in `src/main/vault/folders.ts` to parse view fields
- [x] T007 Update `serializeFolderConfig` in `src/main/vault/folders.ts` to serialize view fields

### Cache Table (Optional Performance Optimization)

- [ ] T008 Create `src/shared/db/schema/folder-view-cache.ts` with cache table schema:
  - path (PK), config_hash, parsed_config, cached_at
- [ ] T009 Export folder-view-cache schema from `src/shared/db/schema/index-schema.ts`
- [ ] T010 Run `pnpm db:generate:index` to create migration
- [ ] T011 Run `pnpm db:push:index` to apply migration (development)

**Checkpoint**: .folder.md can store view configuration ✅

---

## Phase 3: IPC Contracts & Channels

**Purpose**: Define API contracts and IPC channel constants

- [x] T012 [P] Add FolderViewChannels to `src/shared/ipc-channels.ts`:
  - GET_CONFIG: 'folder-view:get-config'
  - SET_CONFIG: 'folder-view:set-config'
  - LIST_WITH_PROPERTIES: 'folder-view:list-with-properties'
  - GET_AVAILABLE_PROPERTIES: 'folder-view:get-available-properties'
  - GET_VIEWS: 'folder-view:get-views'
  - SET_VIEW: 'folder-view:set-view'
  - DELETE_VIEW: 'folder-view:delete-view'
- [x] T013 [P] Add Zod validation schemas to `src/shared/contracts/folder-view-api.ts`:
  - ViewConfigSchema
  - ColumnConfigSchema
  - FilterExpressionSchema
  - OrderConfigSchema
  - Request/Response types

**Checkpoint**: API contracts are defined ✅

---

## Phase 4: Backend Handlers

**Purpose**: Implement IPC handlers for folder view operations

### File Operations

- [ ] T014 [P] Create `src/main/vault/folder-views.ts` with view config functions:
  - readFolderViews(folderPath) - read views from .folder.md
  - writeFolderViews(folderPath, views) - write views to .folder.md
  - getDefaultView() - return default view config
  - validateViewConfig(config) - validate view structure
- [ ] T015 [P] Create `src/shared/db/queries/folder-view.ts` with query functions:
  - listNotesWithProperties(db, folderPath, options)
  - getAvailableProperties(db, folderPath)

### IPC Handlers

- [x] T016 Create `src/main/ipc/folder-view-handlers.ts` with handler structure
- [x] T017 Implement GET_CONFIG handler:
  - Read .folder.md
  - Return views array or default view if none
- [x] T018 Implement SET_CONFIG handler:
  - Validate config
  - Write to .folder.md
  - Update cache (if using)
- [x] T019 Implement LIST_WITH_PROPERTIES handler:
  - Query notes in folder (recursive with LIKE)
  - Join with note_properties
  - Compute relative folder path
  - Exclude journal entries (date IS NULL)
- [x] T020 Implement GET_AVAILABLE_PROPERTIES handler:
  - Get distinct property names used in folder
  - Include usage count
  - Join with property_definitions for type info
- [x] T021 Implement GET_VIEWS handler:
  - Return all views for folder
- [x] T022 Implement SET_VIEW handler:
  - Add or update a single view by name
- [x] T023 Implement DELETE_VIEW handler:
  - Remove a view by name
- [x] T024 Register folder-view handlers in `src/main/ipc/index.ts`

### Cache Operations (Optional)

- [ ] T025 Create cache update functions in `src/main/vault/folder-views.ts`:
  - updateFolderViewCache(path, config)
  - invalidateFolderViewCache(path)
  - getFolderViewFromCache(path, hash)

**Checkpoint**: Backend handlers are functional ✅

---

## Phase 5: Preload & Service Layer

**Purpose**: Expose API to renderer and create service wrapper

- [x] T026 Add folderView API to `src/preload/index.ts`:
  - getConfig(folderPath)
  - setConfig(folderPath, config)
  - getViews(folderPath)
  - setView(folderPath, view)
  - deleteView(folderPath, viewName)
  - listWithProperties(folderPath, options)
  - getAvailableProperties(folderPath)
- [x] T027 Add TypeScript declarations to `src/preload/index.d.ts`
- [ ] T028 Create `src/renderer/src/services/folder-view-service.ts` IPC client wrapper

**Checkpoint**: Renderer can communicate with backend ✅

---

## Phase 6: Tab System Integration

**Purpose**: Add folder tab type and routing

- [x] T029 Add 'folder' to TabType union in `src/renderer/src/contexts/tabs/types.ts`
- [x] T030 Add folder case to TabContent switch in `src/renderer/src/components/split-view/tab-content.tsx` and `src/renderer/src/App.tsx` (TabContentRenderer):
  - Route to FolderViewPage component
  - Pass folderPath from tab.entityId
- [x] T031 Modify `src/renderer/src/components/notes-tree.tsx` handleSelectionChange:
  - Detect folder click (id starts with 'folder-')
  - Skip root folder (notes/) - do not open view
  - Open folder tab with path, title, icon
  - Use isPreview: true for single-click

**Checkpoint**: Clicking folder opens folder view tab ✅

---

## Phase 7: Core Hook

**Purpose**: Create data fetching hook for folder view

- [x] T032 Create `src/renderer/src/hooks/use-folder-view.ts` with:
  - useFolderView(folderPath) hook
  - Fetch views on mount
  - Track activeViewIndex
  - Fetch notes with properties
  - Fetch available properties
  - Handle loading/error states
  - Provide updateView function
  - Provide addView, deleteView functions
  - Provide refresh function
- [x] T033 Add debounced config save (300ms) for column resize/reorder operations

**Checkpoint**: Data fetching hook is ready ✅

---

## Phase 8: Basic Table View

**Purpose**: Implement core table component using TanStack Table

### Page Component

- [x] T034 Implement `src/renderer/src/pages/folder-view.tsx`:
  - FolderViewPage component with folderPath prop
  - Header with folder name, note count, back button (for nested)
  - View switcher (tabs for multiple views)
  - Toolbar placeholder
  - Table container
  - Loading skeleton
  - Empty state

### Table Component

- [x] T035 Create `src/renderer/src/components/folder-view/folder-table-view.tsx`:
  - Use useReactTable from @tanstack/react-table
  - Enable getCoreRowModel
  - Enable getSortedRowModel
  - Enable getFilteredRowModel
  - Enable column resizing (columnResizeMode: 'onChange')
  - Map columns from config to TanStack column definitions
- [x] T036 Implement table header rendering with column headers
- [x] T037 Implement table body rendering with rows
- [x] T038 Add row click handler (single-click = select, double-click = open note in new tab)
- [x] T039 Add row hover styling

**Checkpoint**: Basic table displays notes ✅

---

## Phase 9: Property Cell Renderers

**Purpose**: Render different property types appropriately

- [x] T040 Create `src/renderer/src/components/folder-view/property-cell.tsx` base component
- [x] T041 [P] Implement TextCell - plain text with ellipsis overflow
- [x] T042 [P] Implement NumberCell - right-aligned, formatted number
- [x] T043 [P] Implement CheckboxCell - green checkmark or gray X icon
- [x] T044 [P] Implement DateCell - relative date format (Today, Yesterday, Dec 25)
- [x] T045 [P] Implement SelectCell - colored badge
- [x] T046 [P] Implement MultiSelectCell - multiple colored badges
- [x] T047 [P] Implement UrlCell - clickable link with external icon
- [x] T048 [P] Implement RatingCell - star rating display (★★★☆☆)
- [x] T049 Implement TitleCell - emoji + title, clickable
- [x] T050 Implement FolderCell - relative folder path display
- [x] T051 Implement TagsCell - multiple tag badges

**Checkpoint**: All property types render correctly ✅

---

## Phase 10: Column Header

**Purpose**: Sortable column headers with display name editing

- [x] T052 Create `src/renderer/src/components/folder-view/column-header.tsx`:
  - Display column name
  - Sort indicator (▲/▼/none)
  - Click to toggle sort
  - Shift+click for multi-sort
- [x] T053 Add resize handle to column header:
  - Draggable border on right edge
  - Visual feedback during resize
  - Persist width on resize end
- [x] T054 Add display name editing:
  - Double-click header to edit
  - Inline input field
  - Save on Enter/blur
  - Cancel on Escape
  - Persist to .folder.md via properties.{id}.displayName

**Checkpoint**: Column headers are interactive ✅

---

## Phase 11: Column Selector

**Purpose**: Add/remove columns from view

- [x] T055 Create `src/renderer/src/components/folder-view/column-selector.tsx`:
  - Dropdown button in toolbar
  - List of available columns (visible + hidden)
  - Checkboxes to toggle visibility
  - Grouped: Built-in columns, Property columns, Formula columns
- [x] T056 Add "Add Property Column" section:
  - Search/filter available properties
  - Show usage count for each property
  - Click to add column with default config
- [x] T057 Persist column visibility changes to .folder.md view config

**Checkpoint**: Users can add/remove columns ✅

---

## Phase 12: Column Reordering

**Purpose**: Drag-and-drop column reorder

- [x] T058 Add drag handles to column headers
- [x] T059 Implement column drag-and-drop using @dnd-kit:
  - DndContext wrapper
  - SortableContext for columns
  - useSortable hook per column
- [x] T060 Update column order in .folder.md on drop
- [x] T061 Visual feedback during drag (placeholder, opacity)

**Checkpoint**: Columns can be reordered by dragging ✅

---

## Phase 13: Multi-Column Sorting

**Purpose**: Column-based sorting with persistence

- [x] T062 Implement single-column sort:
  - Click header to sort ascending
  - Click again for descending
  - Click again to clear sort
- [x] T063 Implement multi-column sort:
  - Shift+click to add sort column
  - Show sort order number on headers
  - Support order: [{property, direction}, ...] array
- [x] T064 Persist sort configuration to .folder.md view.order
- [x] T065 Apply initial sort from saved config on load

**Checkpoint**: Sorting works and persists ✅

---

## Phase 14: Advanced Filtering

**Purpose**: Filter notes with AND/OR/NOT expressions

### Filter UI

- [ ] T066 Create `src/renderer/src/components/folder-view/filter-builder.tsx`:
  - Dropdown button in toolbar
  - Visual filter tree builder
  - Add filter group (AND/OR)
  - Add filter condition
  - Nesting support
- [ ] T067 Create `src/renderer/src/components/folder-view/filter-row.tsx`:
  - Property selector dropdown
  - Operator selector (based on property type)
  - Value input (type-appropriate)
  - Remove filter button
  - Nesting indicator

### Filter Logic

- [ ] T068 Create `src/renderer/src/lib/filter-evaluator.ts`:
  - evaluateFilter(note, filterExpression) function
  - Support AND, OR, NOT nesting
  - Support all operators per type
- [ ] T069 Implement filter operators per property type:
  - Text: ==, !=, contains, startsWith, endsWith, isEmpty
  - Number: ==, !=, >, >=, <, <=
  - Checkbox: isChecked, isUnchecked
  - Date: ==, before, after, isEmpty
  - Select: ==, !=
  - Tags/Array: contains, isEmpty
- [ ] T070 Apply filters client-side using filter evaluator
- [ ] T071 Persist filters to .folder.md view.filters
- [ ] T072 Show active filter indicator on filter button

**Checkpoint**: Advanced filtering works and persists

---

## Phase 15: Global Search

**Purpose**: Quick search across all visible columns

- [ ] T073 Add search input to toolbar
- [ ] T074 Implement global filter using TanStack Table globalFilter
- [ ] T075 Highlight matching text in cells (optional enhancement)
- [ ] T076 Debounce search input (200ms)

**Checkpoint**: Global search filters table

---

## Phase 16: Multiple Named Views

**Purpose**: Support multiple views per folder with view switcher

- [ ] T077 Create `src/renderer/src/components/folder-view/view-switcher.tsx`:
  - Tab-style view selector
  - Show view names
  - Click to switch active view
  - Default view indicator
- [ ] T078 Add "New View" button:
  - Create new view with default config
  - Prompt for view name
  - Set as active
- [ ] T079 Add view management dropdown per view tab:
  - Rename view
  - Duplicate view
  - Set as default
  - Delete view (with confirmation)
- [ ] T080 Persist activeViewIndex in component state (not in .folder.md)
- [ ] T081 Save/load correct view config when switching

**Checkpoint**: Multiple named views work

---

## Phase 17: Keyboard Navigation

**Purpose**: Navigate table with keyboard

- [ ] T082 Implement arrow key navigation (up/down to move selection)
- [ ] T083 Implement Enter key to open selected note in new tab
- [ ] T084 Implement Escape to clear selection
- [ ] T085 Implement Cmd/Ctrl+A to select all rows
- [ ] T086 Add focus ring styling for keyboard navigation

**Checkpoint**: Table is keyboard accessible

---

## Phase 18: Context Menu

**Purpose**: Right-click actions on rows

- [ ] T087 Create `src/renderer/src/components/folder-view/row-context-menu.tsx`:
  - Open note
  - Open in new tab
  - Reveal in sidebar
  - Copy link
  - Move to folder...
  - Delete note
- [ ] T088 Integrate context menu with table rows
- [ ] T089 Handle multi-select context menu (bulk actions)

**Checkpoint**: Context menu provides quick actions

---

## Phase 19: Row Virtualization

**Purpose**: Performance optimization for large folders

- [ ] T090 Integrate @tanstack/react-virtual with table:
  - useVirtualizer for row virtualization
  - Render only visible rows + buffer
- [ ] T091 Handle scroll container properly for virtualization
- [ ] T092 Maintain selection state during virtual scroll
- [ ] T093 Test with 500+ notes to verify performance

**Checkpoint**: Large folders perform well

---

## Phase 20: Empty & Loading States

**Purpose**: Polish UI states

- [ ] T094 Implement loading skeleton:
  - Shimmer rows while data loads
  - Match expected column widths
- [ ] T095 Implement empty state:
  - "No notes in this folder" message
  - Create note button
  - Helpful tips
- [ ] T096 Implement filtered empty state:
  - "No notes match your filters"
  - Clear filters button
- [ ] T097 Implement error state:
  - Error message display
  - Retry button

**Checkpoint**: All UI states are handled gracefully

---

## Phase 21: Actions & Toolbar

**Purpose**: Folder-level actions

- [ ] T098 Add "New Note" button to header:
  - Create note in current folder
  - Use folder's default template if set
  - Open new note in tab
- [ ] T099 Add view settings dropdown:
  - Density toggle (comfortable/compact)
  - Show/hide column borders
  - Reset to default columns
- [ ] T100 Add note count display in header
- [ ] T101 Add "Refresh" button (manual data refresh)

**Checkpoint**: Toolbar actions are functional

---

## Phase 22: Formulas (Computed Columns)

**Purpose**: Support computed columns with expressions

### Expression Parser

- [ ] T102 Create `src/renderer/src/lib/expression-parser.ts`:
  - Parse expression string to AST
  - Support operators: +, -, \*, /, ==, !=, <, >, <=, >=, &&, ||
  - Support function calls: today(), dateDiff(), if(), coalesce()
- [ ] T103 Create `src/renderer/src/lib/expression-evaluator.ts`:
  - Evaluate AST with note context
  - Provide built-in functions
  - Handle errors gracefully

### Formula Columns

- [ ] T104 Add formula column support to column selector:
  - Show formula.{name} columns
  - Add new formula option
- [ ] T105 Create formula editor modal:
  - Expression input with syntax highlighting
  - Preview result on sample note
  - Save formula to .folder.md formulas section
- [ ] T106 Render formula columns in table:
  - Evaluate formula per row
  - Cache results for performance
  - Handle evaluation errors

**Checkpoint**: Computed columns work

---

## Phase 23: Column Summaries

**Purpose**: Show aggregated values in footer row

- [ ] T107 Create `src/renderer/src/components/folder-view/summary-row.tsx`:
  - Sticky footer row
  - Show summary per column (if configured)
- [ ] T108 Implement summary types:
  - sum, average, min, max, count
  - countBy (count per value)
  - countUnique
  - custom (expression)
- [ ] T109 Add summary configuration to column selector
- [ ] T110 Persist summaries to .folder.md

**Checkpoint**: Column summaries work

---

## Phase 24: Group By

**Purpose**: Group rows by property value

- [ ] T111 Create `src/renderer/src/components/folder-view/grouped-table.tsx`:
  - Group rows by property value
  - Collapsible group headers
  - Show group count
- [ ] T112 Add groupBy selector to toolbar
- [ ] T113 Persist groupBy to .folder.md view.groupBy
- [ ] T114 Support group summaries (per group)

**Checkpoint**: Grouping works

---

## Phase 25: Polish & Edge Cases

**Purpose**: Handle edge cases and improve UX

- [ ] T115 Handle folder not found (deleted while viewing)
- [ ] T116 Handle note property type changes (re-render cells correctly)
- [ ] T117 Add tooltip to truncated cell content
- [ ] T118 Add sticky header (stays visible on scroll)
- [ ] T119 Add column minimum width constraints
- [ ] T120 Add column maximum width constraints (optional)
- [ ] T121 Animate row removal when note is deleted
- [ ] T122 Handle external .folder.md changes (file watcher)
- [ ] T123 Handle external note changes (file watcher events)

**Checkpoint**: Edge cases are handled

---

## Phase 26: Integration Testing

**Purpose**: Verify feature works end-to-end

- [ ] T124 Test folder click opens folder view
- [ ] T125 Test notes display with correct properties
- [ ] T126 Test column add/remove/reorder persists to .folder.md
- [ ] T127 Test sorting persists across sessions
- [ ] T128 Test filtering with AND/OR/NOT works correctly
- [ ] T129 Test multiple views work
- [ ] T130 Test double-click opens note in new tab
- [ ] T131 Test .folder.md can be manually edited
- [ ] T132 Test with 100+ notes for performance
- [ ] T133 Test vault sync (verify .folder.md syncs correctly)

**Checkpoint**: Feature is complete and tested

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup)
    │
    ▼
Phase 2 (.folder.md Schema)
    │
    ▼
Phase 3 (Contracts) ──────────────────────┐
    │                                      │
    ▼                                      ▼
Phase 4 (Backend) ◄───────────────────────┘
    │
    ▼
Phase 5 (Preload/Service)
    │
    ▼
Phase 6 (Tab Integration)
    │
    ▼
Phase 7 (Hook)
    │
    ▼
Phase 8 (Basic Table)
    │
    ├──────────────────────────┐
    ▼                          ▼
Phase 9 (Cells)          Phase 10 (Headers)
    │                          │
    └──────────┬───────────────┘
               ▼
    Phase 11 (Column Selector)
               │
               ▼
    Phase 12 (Reordering)
               │
    ┌──────────┼───────────────┐
    ▼          ▼               ▼
Phase 13   Phase 14       Phase 15
(Sort)     (Filter)       (Search)
    │          │               │
    └──────────┼───────────────┘
               ▼
    Phase 16 (Multiple Views)
               │
    ┌──────────┼───────────────┐
    ▼          ▼               ▼
Phase 17   Phase 18       Phase 19
(Keyboard) (Context)      (Virtual)
    │          │               │
    └──────────┼───────────────┘
               ▼
    Phase 20 (States)
               │
               ▼
    Phase 21 (Toolbar)
               │
    ┌──────────┼───────────────┐
    ▼          ▼               ▼
Phase 22   Phase 23       Phase 24
(Formulas) (Summaries)    (GroupBy)
    │          │               │
    └──────────┼───────────────┘
               ▼
    Phase 25 (Polish)
               │
               ▼
    Phase 26 (Testing)
```

---

## Story Points Estimate

| Phase                      | Tasks | Complexity | Estimate  |
| -------------------------- | ----- | ---------- | --------- |
| Phase 1: Setup             | 3     | Low        | 0.5 hour  |
| Phase 2: .folder.md Schema | 8     | Medium     | 2 hours   |
| Phase 3: Contracts         | 2     | Medium     | 1 hour    |
| Phase 4: Backend           | 12    | Medium     | 3 hours   |
| Phase 5: Preload           | 3     | Low        | 1 hour    |
| Phase 6: Tab Integration   | 3     | Low        | 1 hour    |
| Phase 7: Hook              | 2     | Medium     | 1.5 hours |
| Phase 8: Basic Table       | 6     | High       | 3 hours   |
| Phase 9: Cells             | 12    | Medium     | 2.5 hours |
| Phase 10: Headers          | 3     | Medium     | 1.5 hours |
| Phase 11: Column Selector  | 3     | Medium     | 1.5 hours |
| Phase 12: Reordering       | 4     | Medium     | 1.5 hours |
| Phase 13: Sorting          | 4     | Low        | 1 hour    |
| Phase 14: Filtering        | 7     | High       | 3 hours   |
| Phase 15: Search           | 4     | Low        | 1 hour    |
| Phase 16: Multiple Views   | 5     | Medium     | 2 hours   |
| Phase 17: Keyboard         | 5     | Medium     | 1.5 hours |
| Phase 18: Context Menu     | 3     | Low        | 1 hour    |
| Phase 19: Virtualization   | 4     | Medium     | 1.5 hours |
| Phase 20: States           | 4     | Low        | 1 hour    |
| Phase 21: Toolbar          | 4     | Low        | 1 hour    |
| Phase 22: Formulas         | 5     | High       | 3 hours   |
| Phase 23: Summaries        | 4     | Medium     | 2 hours   |
| Phase 24: GroupBy          | 4     | Medium     | 2 hours   |
| Phase 25: Polish           | 9     | Medium     | 2 hours   |
| Phase 26: Testing          | 10    | Low        | 2 hours   |

**Total: 133 tasks, ~43 hours (5.5 days)**

---

## MVP Definition

**Minimum Viable Product** includes Phases 1-13:

- .folder.md schema extension ✓
- Tab integration ✓
- Basic table view ✓
- All property types render ✓
- Column headers with sorting ✓
- Column customization ✓
- Multi-column sorting ✓

**MVP Estimate: ~20 hours (2.5 days)**

**Post-MVP Priorities:**

1. Advanced filtering (Phase 14) - high value
2. Multiple views (Phase 16) - key differentiator
3. Performance (Phase 19) - required for large vaults
4. Formulas (Phase 22) - power user feature

---

## Notes

- [P] tasks can run in parallel (different files, no dependencies)
- Each phase should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate
- Configuration stored in `.folder.md` files - portable and sync-friendly
- @tanstack/react-table provides most table features out-of-box
- @dnd-kit is already installed for drag-and-drop
- @tanstack/react-virtual is already installed for virtualization
- Expression parser can be simple initially, extend later
