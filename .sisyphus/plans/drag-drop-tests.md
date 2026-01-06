# Test Plan: Sidebar Drag & Drop Reordering

## Feature Summary

The sidebar drag-and-drop feature allows users to:

- Reorder notes within the same folder
- Reorder folders within the same parent
- Move notes between folders via drag-drop
- Move folders into other folders
- Multi-select items and drag them together

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        UI Layer                                  │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │   notes-tree.tsx    │    │  virtualized-notes-tree.tsx     │ │
│  │   (orchestration)   │    │  (rendering & drag UI)          │ │
│  └─────────────────────┘    └─────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                      Service Layer                               │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              notes-service.ts                                │ │
│  │   getPositions(), getAllPositions(), reorder()              │ │
│  └─────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                       IPC Layer                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              notes-handlers.ts                               │ │
│  │   GET_POSITIONS, GET_ALL_POSITIONS, REORDER                 │ │
│  └─────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                      Database Layer                              │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              note-positions.ts (queries)                     │ │
│  │   note_positions table (path, folder_path, position)        │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Test Files to Create/Update

| Priority | File                                                          | Type      | Status |
| -------- | ------------------------------------------------------------- | --------- | ------ |
| 1        | `src/shared/db/queries/note-positions.test.ts`                | Unit      | NEW    |
| 2        | `src/main/ipc/notes-handlers.test.ts`                         | Unit      | UPDATE |
| 3        | `src/renderer/src/services/notes-service.test.ts`             | Unit      | UPDATE |
| 4        | `src/renderer/src/components/virtualized-notes-tree.test.tsx` | Component | NEW    |
| 5        | `src/renderer/src/components/notes-tree.test.tsx`             | Component | NEW    |
| 6        | `tests/e2e/notes.e2e.ts`                                      | E2E       | UPDATE |

---

## 1. Database Queries Unit Tests (NEW)

**File**: `src/shared/db/queries/note-positions.test.ts`

### Test Cases

```typescript
describe('note-positions queries', () => {
  describe('getNotePosition', () => {
    it('should return position for existing note path')
    it('should return undefined for non-existent path')
  })

  describe('getNotesInFolder', () => {
    it('should return notes sorted by position ascending')
    it('should return empty array for empty folder')
    it('should only return notes in specified folder')
  })

  describe('getNextPositionInFolder', () => {
    it('should return 0 for empty folder')
    it('should return max+1 for folder with notes')
  })

  describe('setNotePosition', () => {
    it('should insert new position record')
    it('should update existing position record')
  })

  describe('reorderNotesInFolder', () => {
    it('should set positions based on array order')
    it('should handle empty array')
    it('should update positions for all notes in array')
  })

  describe('deleteNotePosition', () => {
    it('should delete existing position')
    it('should return false for non-existent position')
  })

  describe('moveNoteToFolder', () => {
    it('should move note to new folder with auto-position')
    it('should move note to new folder with explicit position')
  })

  describe('insertNoteAtPosition', () => {
    it('should shift existing notes to make room')
    it('should insert note at specified position')
    it('should not shift notes before insertion point')
  })

  describe('getAllNotePositions', () => {
    it('should return all position records')
    it('should return empty array when no positions')
  })
})
```

### Implementation Notes

- Use `createTestDataDb()` from `@tests/utils/test-db`
- Each test should use fresh in-memory database
- Test with realistic note paths like `notes/folder/note.md`

---

## 2. IPC Handlers Unit Tests (UPDATE)

**File**: `src/main/ipc/notes-handlers.test.ts`

### New Test Cases to Add

```typescript
describe('Position handlers', () => {
  describe('GET_POSITIONS handler', () => {
    it('should return positions for folder')
    it('should return empty array for folder with no positions')
    it('should validate folderPath input')
  })

  describe('GET_ALL_POSITIONS handler', () => {
    it('should return all positions as path->position map')
    it('should return empty object when no positions exist')
    it('should handle database errors gracefully')
  })

  describe('REORDER handler', () => {
    it('should reorder notes in folder')
    it('should validate folderPath and notePaths input')
    it('should return success on valid reorder')
    it('should handle reorder errors gracefully')
  })
})
```

### Implementation Notes

- Mock `getDatabase()` to return mock db
- Mock `note-positions` query functions
- Follow existing handler test patterns in file

---

## 3. Service Layer Unit Tests (UPDATE)

**File**: `src/renderer/src/services/notes-service.test.ts`

### New Test Cases to Add

```typescript
describe('Position methods', () => {
  describe('getPositions', () => {
    it('should call notes.getPositions with folderPath')
    it('should return positions map from IPC response')
  })

  describe('getAllPositions', () => {
    it('should call notes.getAllPositions')
    it('should return success and positions from response')
    it('should handle error responses')
  })

  describe('reorder', () => {
    it('should call notes.reorder with folderPath and notePaths')
    it('should return success response')
    it('should handle error responses')
  })
})
```

### Implementation Notes

- Mock `window.api.notes` methods
- Follow existing service test patterns in file

---

## 4. VirtualizedNotesTree Component Tests (NEW)

**File**: `src/renderer/src/components/virtualized-notes-tree.test.tsx`

### Test Cases

```typescript
describe('VirtualizedNotesTree', () => {
  describe('Rendering', () => {
    it('should render folder rows for folders in tree')
    it('should render note rows for notes in tree')
    it('should apply correct indentation based on level')
    it('should show folder icons (open/closed) based on expanded state')
    it('should show note emoji when present')
    it('should show file icon when no emoji')
  })

  describe('Folder expansion', () => {
    it('should expand folder on click')
    it('should collapse folder on click when expanded')
    it('should persist expanded state to localStorage')
    it('should restore expanded state from localStorage')
  })

  describe('Selection', () => {
    it('should select single item on click')
    it('should toggle selection with Cmd/Ctrl+click')
    it('should range select with Shift+click')
    it('should show selection count badge when multiple selected')
    it('should open note tab on single note selection')
  })

  describe('Drag handles', () => {
    it('should show drag handle on folder hover')
    it('should show drag handle on note hover')
    it('should hide drag handles when isDragDisabled is true')
  })

  describe('Drag state', () => {
    it('should set draggedId on drag start')
    it('should apply opacity to dragged item')
    it('should clear drag state on drag end')
  })

  describe('Drop indicators', () => {
    it('should show "before" indicator in top third of row')
    it('should show "after" indicator in bottom third of row')
    it('should show "inside" indicator for folders in middle third')
    it('should show "after" indicator for notes in middle third')
    it('should clear drop indicator on drag leave')
  })

  describe('Drop handling', () => {
    it('should call onMove with correct operation on drop')
    it('should include draggedId, targetId, and position')
    it('should clear drag state after drop')
  })

  describe('Context menu', () => {
    it('should show single item actions for single selection')
    it('should show bulk delete option for multi-selection')
    it('should call correct callback on menu item click')
  })

  describe('Keyboard navigation', () => {
    it('should delete selected items on Delete key')
    it('should delete selected items on Backspace key')
    it('should not delete when no items selected')
  })
})
```

### Implementation Notes

- Use `renderWithProviders` from `@tests/utils/render`
- Mock `useTabActions` hook
- Create mock tree structures for testing
- Use `fireEvent` for drag events
- Use `userEvent` for clicks and keyboard

---

## 5. NotesTree Component Tests (NEW)

**File**: `src/renderer/src/components/notes-tree.test.tsx`

### Test Cases (Public-facing handlers focus)

```typescript
describe('NotesTree', () => {
  describe('Tree building', () => {
    it('should build tree from notes and folders')
    it('should sort notes by position when available')
    it('should fallback to modified date when no position')
    it('should sort folders by position')
  })

  describe('handleMove', () => {
    describe('Note reordering (same folder)', () => {
      it('should reorder note before target in same folder')
      it('should reorder note after target in same folder')
      it('should call notesService.reorder with correct paths')
      it('should update positions state after reorder')
    })

    describe('Folder reordering (same parent)', () => {
      it('should reorder folder before sibling')
      it('should reorder folder after sibling')
      it('should call notesService.reorder for folders')
    })

    describe('Note moving (different folder)', () => {
      it('should move note to target folder on "inside" drop')
      it('should move note to parent folder on "before/after" folder drop')
      it('should call moveNote mutation with correct folder')
    })

    describe('Folder moving', () => {
      it('should move folder into another folder')
      it('should prevent moving folder into itself')
      it('should prevent moving folder into descendant')
      it('should call renameFolder with new path')
    })

    describe('Multi-selection move', () => {
      it('should move all selected notes together')
      it('should move all selected folders together')
      it('should handle mixed note/folder selection')
      it('should clear selection after bulk move')
    })
  })

  describe('Position fetching', () => {
    it('should fetch positions on mount')
    it('should update positions after reorder')
    it('should handle position fetch errors')
  })

  describe('Integration with VirtualizedNotesTree', () => {
    it('should pass correct props to VirtualizedNotesTree')
    it('should use virtualization when tree has 100+ items')
    it('should use standard tree when under 100 items')
  })
})
```

### Implementation Notes

- Use `renderWithProviders` with mocked hooks
- Mock `useNotesList`, `useNoteFoldersQuery`, `useNoteMutations`
- Mock `notesService` methods
- Focus on handler logic, not rendering details

---

## 6. E2E Tests (UPDATE)

**File**: `tests/e2e/notes.e2e.ts`

### New Test Cases to Add

```typescript
test.describe('Sidebar Drag & Drop', () => {
  test('should reorder notes within same folder via API', async ({ page }) => {
    // Create notes, verify initial order
    // Call reorder API
    // Verify new order persists
  })

  test('should move note to different folder', async ({ page }) => {
    // Create note in folder A
    // Move to folder B via API
    // Verify note appears in folder B
  })

  test('should persist order after page reload', async ({ page }) => {
    // Create notes
    // Reorder via API
    // Reload page
    // Verify order maintained
  })

  test('should reorder folders', async ({ page }) => {
    // Create folders
    // Reorder via API
    // Verify new order
  })

  test('should handle concurrent reorder operations', async ({ page }) => {
    // Create multiple notes
    // Issue multiple reorder calls
    // Verify final state is consistent
  })
})
```

### Implementation Notes

- Use existing E2E helper functions
- Test via IPC/API calls, not mouse simulation
- Focus on state persistence and consistency

---

## Test Data Factories

### Create in `tests/utils/fixtures/note-positions.ts`

```typescript
export interface MockNotePosition {
  path: string
  folderPath: string
  position: number
}

export function createMockNotePosition(overrides?: Partial<MockNotePosition>): MockNotePosition {
  return {
    path: 'notes/test-note.md',
    folderPath: '',
    position: 0,
    ...overrides
  }
}

export function createMockPositionsInFolder(folderPath: string, count: number): MockNotePosition[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `notes/${folderPath ? folderPath + '/' : ''}note-${i}.md`,
    folderPath,
    position: i
  }))
}
```

---

## Execution Order

1. **note-positions.test.ts** - Foundation, tests database layer
2. **notes-handlers.test.ts** - Tests IPC handlers use queries correctly
3. **notes-service.test.ts** - Tests service calls IPC correctly
4. **virtualized-notes-tree.test.tsx** - Tests UI component in isolation
5. **notes-tree.test.tsx** - Tests orchestration logic
6. **notes.e2e.ts** - End-to-end validation

---

## Commands

```bash
# Run specific test file
pnpm vitest src/shared/db/queries/note-positions.test.ts

# Run all new tests
pnpm vitest note-positions virtualized-notes-tree notes-tree

# Run with coverage
pnpm vitest --coverage

# Run E2E tests
pnpm test:e2e
```

---

## Estimated Effort

| Test File                       | Est. Tests | Est. Time |
| ------------------------------- | ---------- | --------- |
| note-positions.test.ts          | ~15        | 1-2 hours |
| notes-handlers.test.ts (update) | ~8         | 30 min    |
| notes-service.test.ts (update)  | ~6         | 20 min    |
| virtualized-notes-tree.test.tsx | ~25        | 2-3 hours |
| notes-tree.test.tsx             | ~20        | 2-3 hours |
| notes.e2e.ts (update)           | ~5         | 1 hour    |

**Total**: ~79 tests, ~8-10 hours

---

## Success Criteria

- [ ] All new tests pass
- [ ] No regressions in existing tests
- [ ] Coverage for all query functions
- [ ] Coverage for all IPC handlers
- [ ] Coverage for drag-drop UI states
- [ ] Coverage for reorder/move operations
- [ ] E2E validation of persistence
