# Search System Overhaul - Implementation Plan

## Overview

Complete redesign of the search system to deliver a Notion-style command palette with advanced filtering, time-grouped results, and search operators.

**Trigger**: `Cmd+P` (existing shortcut preserved)

---

## Design Reference

### Image 1 - Main Interface

```
┌─────────────────────────────────────────────────────────────────────┐
│ 🔍 Search or ask a question in Kaan...                          [⊕] │
├─────────────────────────────────────────────────────────────────────┤
│ ↕ Sort ∨  Aa Title only  📄 In ∨  📅 Date ∨                         │
├─────────────────────────────────────────────────────────────────────┤
│ Today                                                               │
│  🌴 CarRentalVendor — Integration                                   │
│  🚗 FilomCarRentalInVendor WrongName — Integration                  │
│  📄 New page — Integration / ... / Copy of Custom Client Vendor     │
├─────────────────────────────────────────────────────────────────────┤
│ Yesterday                                                           │
│  📄 @Last Tuesday 11:22 PM                                          │
│  📄 Tasks: Notes System (Refactored)                                │
├─────────────────────────────────────────────────────────────────────┤
│ Past week                                                           │
│  📄 New page                                              2d ago    │
├─────────────────────────────────────────────────────────────────────┤
│ Past 30 days                                                        │
│  😊 New page                                          Dec 30, 2025  │
│  📄 New page                                                    ↵   │
│  📄 New page                                          Dec 30, 2025  │
├─────────────────────────────────────────────────────────────────────┤
│ ↑↓ Select   ↵ Open   ⌘↵ Open in new tab                            │
└─────────────────────────────────────────────────────────────────────┘
```

### Image 2 - Search Operators Help Panel

```
┌────────────────────────────────────┐
│ Search options                 (i) │
│                                    │
│ path: match path of the file       │
│ file: match file name              │
│ tag: search for tags               │
│ line: search keywords on same line │
│ section: search keywords under     │
│          same heading              │
│ [property] match property          │
├────────────────────────────────────┤
│ History                        ✕   │
│ tag:#dailyNote                     │
└────────────────────────────────────┘
```

---

## Architecture Decisions

| Decision          | Choice                | Rationale                                                          |
| ----------------- | --------------------- | ------------------------------------------------------------------ |
| UI Library        | **cmdk**              | Built-in keyboard nav, accessibility, groups, already in E2E tests |
| Filter UI         | **Popover dropdowns** | Matches design, cleaner than inline                                |
| Operator parsing  | **Frontend**          | Parse operators in renderer, send structured query to backend      |
| Time grouping     | **Frontend**          | Backend returns `modifiedAt`, frontend groups by relative date     |
| Created by filter | **Skip**              | Not needed for V1, no multi-user support yet                       |

---

## Phase 1 - Core Implementation

### P1.1 - Install & Configure cmdk

**Files to modify:**

- `package.json` - Add cmdk dependency

**Tasks:**

```
T001: Install cmdk package
      - pnpm add cmdk
      - Verify compatibility with React 19
```

---

### P1.2 - Search Operator Parser

**New file:** `src/renderer/src/lib/search-query-parser.ts`

**Purpose:** Parse search query string into structured filters

**Interface:**

```typescript
interface ParsedSearchQuery {
  // Raw text query (operators removed)
  text: string

  // Extracted operators
  operators: {
    path?: string // path:/notes/projects
    file?: string // file:meeting
    tags?: string[] // tag:work tag:urgent
    properties?: {
      // [status]:done [rating]:5
      name: string
      value: string
    }[]
  }

  // Original query for display
  raw: string
}

function parseSearchQuery(query: string): ParsedSearchQuery
```

**Parsing rules:**

- `path:value` - Match note path contains value
- `file:value` - Match filename contains value
- `tag:value` or `tag:#value` - Filter by tag
- `[property]:value` - Filter by frontmatter property
- Remaining text = FTS query

**Tasks:**

```
T002: Create search-query-parser.ts
      - Implement parseSearchQuery function
      - Handle quoted values: path:"my folder/notes"
      - Handle multiple operators: tag:work tag:urgent
      - Strip operators from text query

T003: Create search-query-parser.test.ts
      - Test single operators
      - Test multiple operators
      - Test quoted values
      - Test edge cases (empty, only operators, etc.)
```

---

### P1.3 - Update Search Contract & Backend

**Files to modify:**

- `src/shared/contracts/search-api.ts`
- `src/shared/db/queries/search.ts`
- `src/main/ipc/search-handlers.ts`

**New schema additions:**

```typescript
// In search-api.ts
export const AdvancedSearchSchema = z.object({
  text: z.string().max(500),
  operators: z
    .object({
      path: z.string().optional(),
      file: z.string().optional(),
      tags: z.array(z.string()).optional(),
      properties: z
        .array(
          z.object({
            name: z.string(),
            value: z.string()
          })
        )
        .optional()
    })
    .optional(),
  // Existing filters
  sortBy: z.enum(['relevance', 'modified', 'created', 'title']).default('modified'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  titleOnly: z.boolean().default(false),
  folder: z.string().optional(),
  dateRange: z
    .object({
      start: z.string().optional(), // ISO date
      end: z.string().optional()
    })
    .optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0)
})
```

**Tasks:**

```
T004: Update SearchQuerySchema in search-api.ts
      - Add operators object
      - Add titleOnly filter
      - Add sortDirection
      - Update sortBy options

T005: Update searchNotes() in queries/search.ts
      - Add path filtering: WHERE nc.path LIKE ?
      - Add file filtering: Extract filename, LIKE match
      - Add tag filtering: JOIN note_tags WHERE tag IN (?)
      - Add property filtering: JOIN note_properties WHERE name = ? AND value = ?
      - Add titleOnly mode: Search only fts_notes.title
      - Add date range filtering

T006: Update search-handlers.ts
      - Handle new AdvancedSearchSchema
      - Validate operators
      - Pass structured query to searchNotes()

T007: Update search service & hooks
      - src/renderer/src/services/search-service.ts
      - src/renderer/src/hooks/use-search.ts
      - Add advancedSearch method
```

---

### P1.4 - New Search Modal Component (cmdk-based)

**Files to create:**

- `src/renderer/src/components/search/command-palette.tsx` (main component)
- `src/renderer/src/components/search/search-filters.tsx` (filter bar)
- `src/renderer/src/components/search/search-result-group.tsx` (time-grouped results)
- `src/renderer/src/components/search/search-operators-help.tsx` (help panel)

**Component structure:**

```
CommandPalette
├── Command.Dialog (cmdk)
│   ├── SearchInput (with operator detection)
│   ├── FilterBar
│   │   ├── SortDropdown
│   │   ├── TitleOnlyToggle
│   │   ├── FolderDropdown (In)
│   │   └── DateDropdown
│   ├── Command.List
│   │   ├── SearchResultGroup (Today)
│   │   │   └── SearchResultItem[]
│   │   ├── SearchResultGroup (Yesterday)
│   │   │   └── SearchResultItem[]
│   │   ├── SearchResultGroup (Past week)
│   │   │   └── SearchResultItem[]
│   │   └── SearchResultGroup (Past 30 days / Older)
│   │       └── SearchResultItem[]
│   ├── OperatorsHelpPanel (toggleable)
│   └── FooterShortcuts
└── Recent searches (when query empty)
```

**Tasks:**

```
T008: Create command-palette.tsx
      - Use Command.Dialog from cmdk
      - Integrate with useSearchShortcut hook
      - Handle Cmd+P open/close
      - Implement shouldFilter={false} for FTS backend
      - Debounce search input (200ms)

T009: Create search-filters.tsx
      - SortDropdown: relevance, modified, created, title
      - TitleOnlyToggle: checkbox/switch
      - FolderDropdown: list folders from vault
      - DateDropdown: Today, Yesterday, Past week, Past month, Custom
      - Use Radix Popover for dropdowns

T010: Create search-result-group.tsx
      - Group results by relative date
      - Collapsible sections
      - Show count per group

T011: Update search-result-item.tsx
      - Display emoji/icon
      - Show title with highlight
      - Show breadcrumb path
      - Show relative date (2d ago, Dec 30, 2025)
      - Handle selection state from cmdk

T012: Create search-operators-help.tsx
      - Toggleable panel (? button or info icon)
      - List all available operators with descriptions
      - Show search history
      - Clear history button

T013: Create footer-shortcuts.tsx
      - ↑↓ Select
      - ↵ Open
      - ⌘↵ Open in new tab
      - Keyboard shortcut display component
```

---

### P1.5 - Time Grouping Utility

**New file:** `src/renderer/src/lib/date-grouping.ts`

**Purpose:** Group search results by relative date

```typescript
type DateGroup = 'today' | 'yesterday' | 'past-week' | 'past-30-days' | 'older'

interface GroupedResults {
  today: SearchResultNote[]
  yesterday: SearchResultNote[]
  pastWeek: SearchResultNote[]
  past30Days: SearchResultNote[]
  older: SearchResultNote[]
}

function groupResultsByDate(results: SearchResultNote[]): GroupedResults
function getDateGroupLabel(group: DateGroup): string
```

**Tasks:**

```
T014: Create date-grouping.ts
      - Implement groupResultsByDate
      - Use date-fns for date comparison
      - Handle timezone correctly

T015: Create date-grouping.test.ts
      - Test boundary conditions (midnight)
      - Test each group category
      - Test empty results
```

---

### P1.6 - Integration & Migration

**Files to modify:**

- `src/renderer/src/components/search/search-modal.tsx` (deprecate or redirect)
- `src/renderer/src/hooks/use-search-shortcut.ts`
- App root component (register new modal)

**Tasks:**

```
T016: Wire up CommandPalette to replace SearchModal
      - Update useSearchShortcut to open CommandPalette
      - Ensure all existing functionality preserved
      - Handle tab opening (same tab, new tab)

T017: Update E2E tests
      - tests/e2e/search.e2e.ts
      - Update selectors for cmdk structure
      - Add tests for new filters
      - Add tests for operators

T018: Deprecate old SearchModal
      - Keep search-modal.tsx as backup during transition
      - Remove after validation complete
```

---

### P1.7 - Styling

**Files to modify:**

- `src/renderer/src/styles/` or inline Tailwind

**Tasks:**

```
T019: Style cmdk components
      - Use [cmdk-*] CSS selectors
      - Match existing app design system
      - Smooth animations (scale, fade)
      - Dark mode support

T020: Style filter dropdowns
      - Consistent with existing popovers
      - Clear visual hierarchy
      - Active state indicators
```

---

## Phase 2 - Advanced Operators (Future)

### P2.1 - Line-Level Search (`line:`)

**Concept:** Find notes where keywords appear on the same line

**Requirements:**

- Index content with line boundaries preserved
- New FTS column or separate index for line-level search
- Query: `line:"meeting agenda"` finds lines containing both words

**Tasks:**

```
T021: Design line-level indexing schema
      - Option A: Store lines as separate FTS rows with note_id
      - Option B: Use FTS5 detail=full for position info

T022: Implement line content indexer
      - Parse note content into lines
      - Index each line with note reference
      - Update on note save

T023: Implement line: operator in search query
      - Parse line: operator
      - Query line index
      - Return note results with line snippets
```

---

### P2.2 - Section-Level Search (`section:`)

**Concept:** Find notes where keywords appear under the same heading

**Requirements:**

- Parse markdown headings (# ## ### etc.)
- Index sections with heading context
- Query: `section:"project updates"` finds sections containing both words

**Tasks:**

```
T024: Design section indexing schema
      - Store section boundaries (heading level, start/end positions)
      - Associate content with parent headings

T025: Implement markdown section parser
      - Extract headings and their content
      - Handle nested headings
      - Update on note save

T026: Implement section: operator in search query
      - Parse section: operator
      - Query section index
      - Return note results with section context
```

---

## File Change Summary

### New Files (Phase 1)

| File                                                           | Purpose                    |
| -------------------------------------------------------------- | -------------------------- |
| `src/renderer/src/lib/search-query-parser.ts`                  | Parse operators from query |
| `src/renderer/src/lib/search-query-parser.test.ts`             | Parser tests               |
| `src/renderer/src/lib/date-grouping.ts`                        | Group results by date      |
| `src/renderer/src/lib/date-grouping.test.ts`                   | Grouping tests             |
| `src/renderer/src/components/search/command-palette.tsx`       | Main cmdk component        |
| `src/renderer/src/components/search/search-filters.tsx`        | Filter bar                 |
| `src/renderer/src/components/search/search-result-group.tsx`   | Grouped results            |
| `src/renderer/src/components/search/search-operators-help.tsx` | Help panel                 |
| `src/renderer/src/components/search/footer-shortcuts.tsx`      | Keyboard hints             |

### Modified Files (Phase 1)

| File                                                        | Changes                  |
| ----------------------------------------------------------- | ------------------------ |
| `package.json`                                              | Add cmdk                 |
| `src/shared/contracts/search-api.ts`                        | Add AdvancedSearchSchema |
| `src/shared/db/queries/search.ts`                           | Add operator filtering   |
| `src/main/ipc/search-handlers.ts`                           | Handle advanced search   |
| `src/renderer/src/services/search-service.ts`               | Add advancedSearch       |
| `src/renderer/src/hooks/use-search.ts`                      | Add useAdvancedSearch    |
| `src/renderer/src/hooks/use-search-shortcut.ts`             | Point to new modal       |
| `src/renderer/src/components/search/search-result-item.tsx` | Update for new design    |
| `tests/e2e/search.e2e.ts`                                   | Update for new UI        |

### Deprecated Files

| File                                                  | Status                           |
| ----------------------------------------------------- | -------------------------------- |
| `src/renderer/src/components/search/search-modal.tsx` | Replace with command-palette.tsx |

---

## Dependencies

```
cmdk (new)
├── Peer: react ^18 || ^19 ✓
└── Uses: @radix-ui/react-dialog (already installed)

date-fns (existing) - for date grouping
@radix-ui/react-popover (existing) - for filter dropdowns
```

---

## Risks & Mitigations

| Risk                                | Likelihood | Impact | Mitigation                             |
| ----------------------------------- | ---------- | ------ | -------------------------------------- |
| cmdk React 19 compatibility         | Low        | High   | Test early, fallback to forked version |
| FTS performance with operators      | Medium     | Medium | Profile queries, add indexes if needed |
| Complex operator parsing edge cases | Medium     | Low    | Comprehensive test coverage            |
| E2E test breakage                   | High       | Medium | Update tests incrementally             |

---

## Estimated Effort

| Phase                  | Tasks        | Estimated Time |
| ---------------------- | ------------ | -------------- |
| P1.1 Install cmdk      | T001         | 0.5h           |
| P1.2 Query parser      | T002-T003    | 3h             |
| P1.3 Backend updates   | T004-T007    | 4h             |
| P1.4 New UI components | T008-T013    | 8h             |
| P1.5 Date grouping     | T014-T015    | 2h             |
| P1.6 Integration       | T016-T018    | 3h             |
| P1.7 Styling           | T019-T020    | 3h             |
| **Phase 1 Total**      | **18 tasks** | **~24h**       |
| P2.1 Line search       | T021-T023    | 8h             |
| P2.2 Section search    | T024-T026    | 8h             |
| **Phase 2 Total**      | **6 tasks**  | **~16h**       |

---

## Success Criteria

### Phase 1 Complete When:

- [ ] `Cmd+P` opens new command palette
- [ ] Filter bar works (Sort, Title only, In, Date)
- [ ] Results grouped by time (Today, Yesterday, etc.)
- [ ] Operators work: `path:`, `file:`, `tag:`, `[property]:`
- [ ] Keyboard navigation works (↑↓, Enter, Cmd+Enter)
- [ ] Recent searches preserved
- [ ] All existing E2E tests pass (with updates)
- [ ] No TypeScript errors
- [ ] No regressions in search functionality

### Phase 2 Complete When:

- [ ] `line:` operator returns same-line matches
- [ ] `section:` operator returns same-section matches
- [ ] Help panel documents all operators
- [ ] Performance acceptable with new indexes
