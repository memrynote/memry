# Tasks: Comprehensive Test Coverage

**Input**: Full codebase analysis of memry application
**Prerequisites**: Vitest 4.0.16 (already installed), Playwright (to install)
**Created**: 2026-01-02
**Coverage Target**: 80%
**Test Location**: Co-located (`src/**/*.test.ts`)

**Organization**: Tasks are grouped by test type and priority to enable incremental implementation.

---

## Codebase Inventory Summary

### Testing Targets by Layer

| Layer                       | Files      | Lines (est.) | Test Type   | Priority |
| --------------------------- | ---------- | ------------ | ----------- | -------- |
| Renderer Pure Functions     | 22 files   | ~8,000       | Unit        | **P0**   |
| Main Process Pure Functions | 6 files    | ~300         | Unit        | P1       |
| Database Queries            | 6 files    | ~4,500       | Integration | **P0**   |
| Vault Operations            | 11 files   | ~3,500       | Integration | P1       |
| Inbox System                | 9 files    | ~1,500       | Integration | P2       |
| IPC Handlers                | 14 files   | ~2,000       | Integration | P2       |
| API Contracts               | 12 files   | ~1,200       | Contract    | P1       |
| React Hooks                 | 50+ files  | ~5,000       | Component   | P2       |
| UI Components               | 100+ files | ~15,000      | Component   | P3       |
| E2E Flows                   | -          | -            | E2E         | P2       |

### Dependencies to Install

```json
{
  "devDependencies": {
    "@testing-library/react": "^16.x",
    "@testing-library/jest-dom": "^6.x",
    "@testing-library/user-event": "^14.x",
    "@vitest/coverage-v8": "^4.x",
    "@vitest/ui": "^4.x",
    "jsdom": "^25.x",
    "happy-dom": "^15.x",
    "@playwright/test": "^1.x"
  }
}
```

---

## Format: `[ID] [P?] Description`

- **[P]**: Can run in parallel (independent of other tasks)
- **Priority**: P0 (critical) > P1 (high) > P2 (medium) > P3 (low)
- Include exact file paths in descriptions

## Path Conventions

- **Main process**: `src/main/`
- **Renderer process**: `src/renderer/src/`
- **Shared**: `src/shared/`
- **Preload**: `src/preload/`
- **Test files**: Co-located as `*.test.ts`

---

## Phase 1: Test Infrastructure Setup

**Purpose**: Configure Vitest, Playwright, and test utilities for the entire codebase

### Configuration Files

- [x] T001 [P] Create vitest.config.ts with workspace configuration for main/renderer/shared
- [x] T002 [P] Create vitest.workspace.ts to define test projects (unit, integration, component)
- [x] T003 [P] Create playwright.config.ts for Electron E2E testing
- [x] T004 [P] Create tests/setup.ts with global test utilities and matchers
- [x] T005 [P] Create tests/setup-dom.ts with JSDOM/happy-dom configuration for React tests

### Package.json Scripts

- [ ] T006 Add test scripts to package.json:
  - `test` - Run all tests
  - `test:unit` - Run unit tests only
  - `test:integration` - Run integration tests only
  - `test:component` - Run component tests only
  - `test:e2e` - Run Playwright E2E tests
  - `test:watch` - Watch mode for development
  - `test:coverage` - Generate coverage report
  - `test:ui` - Open Vitest UI

### Test Utilities & Mocks

- [x] T007 [P] Create tests/utils/test-db.ts - In-memory SQLite database factory for integration tests
- [x] T008 [P] Create tests/utils/test-vault.ts - Temporary vault directory factory
- [x] T009 [P] Create tests/utils/mock-electron.ts - Electron API mocks (shell, dialog, BrowserWindow)
- [x] T010 [P] Create tests/utils/mock-ipc.ts - IPC communication mocks (ipcMain, ipcRenderer)
- [x] T011 [P] Create tests/utils/fixtures/ directory with sample data files
- [x] T012 [P] Create tests/utils/render.tsx - Custom render wrapper for React components

### TypeScript Configuration

- [x] T013 Update tsconfig.json to include test files with proper paths
- [x] T014 [P] Create tests/tsconfig.json for test-specific TypeScript settings

### Install Dependencies

- [x] T015 Install test dependencies: `pnpm add -D @testing-library/react @testing-library/jest-dom @testing-library/user-event @vitest/coverage-v8 @vitest/ui jsdom happy-dom @playwright/test`

**Checkpoint**: Test infrastructure ready - can run `pnpm test` successfully

---

## Phase 2: Unit Tests - Core Parsers & Evaluators (P0)

**Purpose**: Test the most critical pure functions that handle parsing and evaluation logic

### 2.1 Expression Parser Tests

**File**: `src/renderer/src/lib/expression-parser.ts` (572 lines, 4 exports)

- [x] T016 [P] Create expression-parser.test.ts with test structure
- [x] T017 [P] Test tokenizer: numeric literals, string literals, identifiers
- [x] T018 [P] Test tokenizer: operators (+, -, \*, /, %, ==, !=, <, >, <=, >=, &&, ||, !)
- [x] T019 [P] Test tokenizer: parentheses, brackets, commas, dots
- [x] T020 [P] Test tokenizer: whitespace handling and edge cases
- [x] T021 Test parser: literal expressions (numbers, strings, booleans, null)
- [x] T022 Test parser: identifier expressions
- [x] T023 Test parser: member access (dot notation, bracket notation)
- [x] T024 Test parser: binary expressions with correct precedence
- [x] T025 Test parser: unary expressions (!, -)
- [x] T026 Test parser: function calls with arguments
- [x] T027 Test parser: conditional (ternary) expressions
- [x] T028 Test parser: nested expressions and complex combinations
- [x] T029 Test parser: error handling for invalid syntax
- [x] T030 Test validateExpression() function

### 2.2 Natural Date Parser Tests

**File**: `src/renderer/src/lib/natural-date-parser.ts` (429 lines, 8 exports)

- [x] T031 [P] Create natural-date-parser.test.ts with test structure
- [x] T032 [P] Test parseNaturalDate: "today", "tomorrow", "yesterday"
- [x] T033 [P] Test parseNaturalDate: day names ("monday", "next friday", "last tuesday")
- [x] T034 [P] Test parseNaturalDate: relative dates ("in 3 days", "2 weeks ago")
- [x] T035 [P] Test parseNaturalDate: month + day ("dec 25", "january 1st")
- [x] T036 [P] Test parseNaturalDate: full dates ("2026-01-15", "01/15/2026")
- [x] T037 [P] Test parseNaturalDate: time parsing ("3pm", "15:30", "noon")
- [x] T038 [P] Test parseNaturalDate: combined date+time ("tomorrow at 3pm")
- [x] T039 Test parseNaturalDate: edge cases (end of month, leap years)
- [x] T040 Test parseNaturalDate: invalid inputs and error handling
- [x] T041 Test helper functions: nextSaturday, nextMonday, addWeeks, addMonths

### 2.3 Filter Evaluator Tests

**File**: `src/renderer/src/lib/filter-evaluator.ts` (594 lines, 17 exports)

- [x] T042 [P] Create filter-evaluator.test.ts with test structure
- [x] T043 [P] Test evaluateFilter: text operators (equals, contains, startsWith, endsWith)
- [x] T044 [P] Test evaluateFilter: number operators (=, !=, <, >, <=, >=)
- [x] T045 [P] Test evaluateFilter: date operators (is, before, after, between)
- [x] T046 [P] Test evaluateFilter: boolean operators (is true, is false)
- [x] T047 [P] Test evaluateFilter: select operators (is, isNot, isAny)
- [x] T048 [P] Test evaluateFilter: array operators (contains, isEmpty)
- [x] T049 Test evaluateFilter: AND logic with multiple conditions
- [x] T050 Test evaluateFilter: OR logic with multiple conditions
- [x] T051 Test evaluateFilter: NOT logic (negation)
- [x] T052 Test evaluateFilter: nested expressions (AND within OR, etc.)
- [x] T053 Test parseExpression() - filter string to AST
- [x] T054 Test serializeCondition() - AST to string
- [x] T055 Test utility functions: getOperatorsForType, countFilterConditions, isFilterEmpty
- [x] T056 Test createSimpleFilter, combineFiltersAnd, combineFiltersOr

### 2.4 Expression Evaluator Tests

**File**: `src/renderer/src/lib/expression-evaluator.ts` (802 lines, 8 exports)

- [x] T057 [P] Create expression-evaluator.test.ts with test structure
- [x] T058 [P] Test evaluateFormula: arithmetic operations (+, -, \*, /, %)
- [x] T059 [P] Test evaluateFormula: comparison operations
- [x] T060 [P] Test evaluateFormula: logical operations (&&, ||, !)
- [x] T061 [P] Test evaluateFormula: property access from context
- [x] T062 [P] Test evaluateFormula: conditional (ternary) expressions
- [x] T063 Test built-in math functions: abs, round, floor, ceil, min, max, sum, avg
- [x] T064 Test built-in string functions: upper, lower, trim, length, concat, substring
- [x] T065 Test built-in date functions: now, today, date, year, month, day, formatDate
- [x] T066 Test built-in array functions: first, last, count, join
- [x] T067 Test built-in conditional functions: if, switch, coalesce
- [x] T068 Test built-in type functions: number, text, boolean
- [x] T069 Test error handling: undefined properties, invalid functions
- [x] T070 Test caching behavior and clearExpressionCache()

### 2.5 Task Utils Tests

**File**: `src/renderer/src/lib/task-utils.ts` (1647 lines, 78+ exports)

- [x] T071 [P] Create task-utils.test.ts with test structure
- [x] T072 [P] Test date helpers: startOfDay, addDays, subDays, isSameDay
- [x] T073 [P] Test date helpers: isWithinInterval, isBefore, isAfter, differenceInDays
- [x] T074 [P] Test date helpers: nextSaturday, nextMonday, addWeeks, addMonths
- [x] T075 [P] Test date helpers: startOfWeek, endOfWeek, startOfMonth, endOfMonth
- [x] T076 [P] Test formatting: formatTime, formatDateShort, formatDayName, formatDueDate
- [x] T077 [P] Test status helpers: isTaskCompleted, getDefaultTodoStatus, getDefaultDoneStatus
- [x] T078 Test sorting: sortTasksByPriorityAndDate, sortTasksForDay, sortTasksByTimeAndPriority
- [x] T079 Test sorting: sortOverdueTasks, sortTasksAdvanced with all sort options
- [x] T080 Test grouping: groupTasksByDueDate, groupTasksByStatus, groupTasksByCompletion
- [x] T081 Test grouping: groupTasksByCalendarDate, groupCompletedByPeriod, groupArchivedByMonth
- [x] T082 Test calendar: getCalendarDays (generates correct days for any month)
- [x] T083 Test filtering: filterBySearch, filterByProjects, filterByPriorities
- [x] T084 Test filtering: filterByDueDateRange, filterByStatuses, filterByCompletion
- [x] T085 Test filtering: filterByRepeatType, filterByHasTime, applyFiltersAndSort
- [x] T086 Test today/upcoming: getTodayTasks, getUpcomingTasks, getDayHeaderText
- [x] T087 Test completed: getCompletedTasks, getArchivedTasks, getCompletionStats
- [x] T088 Test completed: calculateStreak (consecutive completion days)
- [x] T089 Test counts: getTaskCounts, formatTaskSubtitle, hasActiveFilters, countActiveFilters

### 2.6 Repeat Utils Tests

**File**: `src/renderer/src/lib/repeat-utils.ts` (438 lines, 16 exports)

- [x] T090 [P] Create repeat-utils.test.ts with test structure
- [x] T091 [P] Test calculateNextOccurrence: daily repeat
- [x] T092 [P] Test calculateNextOccurrence: weekly repeat (single day, multiple days)
- [x] T093 [P] Test calculateNextOccurrence: monthly repeat (specific date)
- [x] T094 [P] Test calculateNextOccurrence: monthly repeat (nth weekday, e.g., "2nd Tuesday")
- [x] T095 [P] Test calculateNextOccurrence: monthly repeat (last weekday of month)
- [x] T096 [P] Test calculateNextOccurrence: yearly repeat
- [x] T097 Test calculateNextOccurrence: with interval (every 2 weeks, every 3 months)
- [x] T098 Test calculateNextOccurrence: edge cases (Feb 29, month end dates)
- [x] T099 Test calculateNextOccurrences: generate multiple future occurrences
- [x] T100 Test getRepeatDisplayText: human-readable repeat descriptions
- [x] T101 Test getRepeatPresets: verify all preset configurations
- [x] T102 Test createDefaultRepeatConfig: default values
- [x] T103 Test shouldCreateNextOccurrence: determines when to generate next task
- [x] T104 Test getRepeatProgress: progress tracking for repeating tasks

### 2.7 Quick Add Parser Tests

**File**: `src/renderer/src/lib/quick-add-parser.ts` (404 lines, 11 exports)

- [x] T105 [P] Create quick-add-parser.test.ts with test structure
- [x] T106 [P] Test parseQuickAdd: date syntax (!today, !tomorrow, !mon, !dec25)
- [x] T107 [P] Test parseQuickAdd: priority syntax (!!high, !!medium, !!low, !!1, !!2, !!3)
- [x] T108 [P] Test parseQuickAdd: project syntax (#project-name, #inbox)
- [x] T109 [P] Test parseQuickAdd: tag syntax (+tag1, +tag2)
- [x] T110 [P] Test parseQuickAdd: combined syntax ("Buy groceries !tomorrow !!high #personal +shopping")
- [x] T111 Test parseQuickAdd: partial matches during typing
- [x] T112 Test parseDateKeyword, parsePriorityKeyword separately
- [x] T113 Test findProjectByName: fuzzy project matching
- [x] T114 Test hasSpecialSyntax: detection of special characters
- [x] T115 Test getParsePreview: preview of parsed result
- [x] T116 Test autocomplete options: getDateOptions, getPriorityOptions, getProjectOptions

### 2.8 Subtask Utils Tests

**File**: `src/renderer/src/lib/subtask-utils.ts` (678 lines, 24 exports)

- [x] T117 [P] Create subtask-utils.test.ts with test structure
- [x] T118 [P] Test helpers: isSubtask, hasSubtasks, getSubtasks, getParentTask
- [x] T119 [P] Test helpers: getTopLevelTasks, canHaveSubtasks
- [x] T120 [P] Test buildTaskTree: hierarchical tree construction
- [x] T121 [P] Test getAllSubtaskIds: recursive ID collection
- [x] T122 Test calculateProgress: percentage of completed subtasks
- [x] T123 Test validateSubtaskRelationship: circular reference prevention
- [x] T124 Test filterTasksWithSubtasks: filter preserving parent-child relationships
- [x] T125 Test sortTasksWithSubtasks: sort maintaining hierarchy
- [x] T126 Test createSubtask: create with proper parent reference
- [x] T127 Test createMultipleSubtasks: batch creation
- [x] T128 Test reorderSubtasks: position updates
- [x] T129 Test promoteToTask: convert subtask to top-level task
- [x] T130 Test demoteToSubtask: convert task to subtask
- [x] T131 Test deleteSubtask, deleteParentWithSubtasks: cascade delete
- [x] T132 Test completeParentWithSubtasks: completion cascade
- [x] T133 Test getIncompleteSubtasks, hasIncompleteSubtasks, getPotentialParents

**Checkpoint**: Core parser tests complete - highest-value unit tests done

---

## Phase 3: Unit Tests - Utility Functions (P1)

**Purpose**: Test remaining renderer utility functions

### 3.1 Subtask Bulk Utils Tests

**File**: `src/renderer/src/lib/subtask-bulk-utils.ts` (384 lines, 12 exports)

- [x] T134 [P] Create subtask-bulk-utils.test.ts
- [x] T135 [P] Test checkAllSubtasksComplete, getIncompleteSubtaskCount
- [x] T136 [P] Test completeAllSubtasks, markAllSubtasksIncomplete
- [x] T137 Test setDueDateForAllSubtasks, setPriorityForAllSubtasks
- [x] T138 Test deleteAllSubtasks
- [x] T139 Test duplicateTaskWithSubtasks: deep copy with new IDs
- [x] T140 Test completeParentTask, uncompleteParentTask

### 3.2 Tag Utils Tests

**File**: `src/renderer/src/lib/tag-utils.ts` (75 lines, 6 exports)

- [x] T141 [P] Create tag-utils.test.ts
- [x] T142 [P] Test isValidTagName: valid/invalid tag names
- [x] T143 [P] Test normalizeTagName: lowercase, trim, special chars
- [x] T144 [P] Test formatTagDisplay: display formatting
- [x] T145 Test extractTagsFromText: extract #tags from content
- [x] T146 Test sanitizeTagInput, isTagTerminator

### 3.3 Fuzzy Search Tests

**File**: `src/renderer/src/lib/fuzzy-search.ts` (136 lines, 3 exports)

- [x] T147 [P] Create fuzzy-search.test.ts
- [x] T148 [P] Test fuzzySearch: exact matches score highest
- [x] T149 [P] Test fuzzySearch: word boundary matches
- [x] T150 [P] Test fuzzySearch: consecutive character matches
- [x] T151 Test fuzzySearch: case insensitivity
- [x] T152 Test fuzzySearch: scoring algorithm accuracy
- [x] T153 Test highlightMatches: generates correct highlight indices

### 3.4 Journal Utils Tests

**File**: `src/renderer/src/lib/journal-utils.ts` (404 lines, 22 exports)

- [x] T154 [P] Create journal-utils.test.ts
- [x] T155 [P] Test getTodayString, formatDateToISO, parseISODate
- [x] T156 [P] Test addDays, generateDateRange
- [x] T157 [P] Test generateMorePastDays, generateMoreFutureDays
- [x] T158 Test formatDayHeader, formatDateParts, getMonthName
- [x] T159 Test getOpacityForDistance, getDateDistance
- [x] T160 Test getTimeBasedGreeting: morning/afternoon/evening
- [x] T161 Test isYesterday, isTomorrow, getSpecialDayLabel
- [x] T162 Test getDaysInMonth, getMonthStats

### 3.5 Inbox Utils Tests

**File**: `src/renderer/src/lib/inbox-utils.ts` (96 lines, 5 exports)

- [x] T163 [P] Create inbox-utils.test.ts
- [x] T164 [P] Test groupItemsByTimePeriod: today, yesterday, this week, older
- [x] T165 [P] Test formatTimestamp: relative time formatting
- [x] T166 Test formatDuration: duration formatting (voice memos)
- [x] T167 Test extractDomain: domain extraction from URLs

### 3.6 Stale Utils Tests

**File**: `src/renderer/src/lib/stale-utils.ts` (100 lines, 9 exports)

- [x] T168 [P] Create stale-utils.test.ts
- [x] T169 [P] Test getDaysInInbox, isStale (7-day threshold)
- [x] T170 [P] Test formatAge: "2 days", "1 week"
- [x] T171 Test getStaleItems, getNonStaleItems: filtering
- [x] T172 Test getRandomNudgeMessage, getNudgeMessage

### 3.7 Lookup Utils Tests

**File**: `src/renderer/src/lib/lookup-utils.ts` (97 lines, 8 exports)

- [x] T173 [P] Create lookup-utils.test.ts
- [x] T174 [P] Test createProjectMap, createCompletionStatusMap: O(1) lookup
- [x] T175 [P] Test isTaskCompletedFast, getProjectFromMap
- [x] T176 Test createLookupContext, getTaskContext

### 3.8 Wiki Link Utils Tests

**File**: `src/renderer/src/lib/wiki-link-utils.ts` (63 lines, 5 exports)

- [x] T177 [P] Create wiki-link-utils.test.ts
- [x] T178 [P] Test formatWikiLinkTitle: title formatting
- [x] T179 [P] Test parseWikiLinkSyntax: [[link]] and [[link|alias]] parsing
- [x] T180 Test createWikiLinkHTML: HTML generation
- [x] T181 Test formatRelativeTime: relative date display

### 3.9 Summary Evaluator Tests

**File**: `src/renderer/src/lib/summary-evaluator.ts` (520 lines, 9 exports)

- [ ] T182 [P] Create summary-evaluator.test.ts
- [ ] T183 [P] Test computeSummary: SUM aggregation
- [ ] T184 [P] Test computeSummary: AVERAGE aggregation
- [ ] T185 [P] Test computeSummary: MIN, MAX aggregations
- [ ] T186 [P] Test computeSummary: COUNT, COUNT_VALUES, COUNT_UNIQUE
- [ ] T187 Test computeSummary: COUNT_BY (grouped counts)
- [ ] T188 Test getColumnValues: extract values from rows
- [ ] T189 Test formatSummaryValue: number/date/text formatting
- [ ] T190 Test getSummaryTypesForColumn: valid types per column type

### 3.10 Additional Utility Tests

**File**: `src/renderer/src/lib/section-visibility.ts` (155 lines)

- [x] T191 [P] Create section-visibility.test.ts
- [x] T192 Test getSectionVisibility, shouldShowOverdueCelebration, getEmptyStateMessage

**File**: `src/renderer/src/lib/virtual-list-utils.ts` (470 lines)

- [x] T193 [P] Create virtual-list-utils.test.ts
- [x] T194 Test flattenTasksByDueDate, flattenTodayTasks, flattenTasksByStatus
- [x] T195 Test estimateItemHeight, getTaskIdsFromVirtualItems

**File**: `src/renderer/src/lib/virtualized-tree-utils.ts` (226 lines)

- [ ] T196 [P] Create virtualized-tree-utils.test.ts
- [ ] T197 Test countTreeItems, flattenTree, getAllFolderIds
- [ ] T198 Test getParentFolderId, estimateTreeHeight, shouldVirtualize

**File**: `src/renderer/src/lib/ai-clustering.ts` (219 lines)

- [ ] T199 [P] Create ai-clustering.test.ts
- [ ] T200 Test detectClusters: type-based clustering
- [ ] T201 Test detectClusters: domain-based clustering
- [ ] T202 Test getClusterKey

**Checkpoint**: All renderer utility unit tests complete

---

## Phase 4: Unit Tests - Main Process Pure Functions (P1)

**Purpose**: Test pure functions in the main process

### 4.1 ID Utils Tests

**File**: `src/main/lib/id.ts`

- [ ] T203 [P] Create src/main/lib/id.test.ts
- [ ] T204 [P] Test generateId: 21-char URL-safe format
- [ ] T205 [P] Test generateNoteId: 12-char lowercase alphanumeric
- [ ] T206 [P] Test generateJournalId: j{YYYY-MM-DD} format
- [ ] T207 [P] Test generateShortId: 8-char format
- [ ] T208 Test validators: isValidNoteId, isValidId, isValidJournalId

### 4.2 Error Classes Tests

**File**: `src/main/lib/errors.ts`

- [ ] T209 [P] Create src/main/lib/errors.test.ts
- [ ] T210 [P] Test VaultError class with all error codes
- [ ] T211 [P] Test NoteError class with all error codes
- [ ] T212 [P] Test DatabaseError class with all error codes
- [ ] T213 Test type guards: isVaultError, isNoteError, isDatabaseError, isWatcherError

### 4.3 Path Utils Tests

**File**: `src/main/lib/paths.ts`

- [ ] T214 [P] Create src/main/lib/paths.test.ts
- [ ] T215 [P] Test sanitizePath: directory traversal prevention
- [ ] T216 [P] Test getRelativePath, isPathInVault
- [ ] T217 [P] Test safeFileName: filename sanitization
- [ ] T218 Test isMarkdownFile, getTitleFromPath
- [ ] T219 Test safeJoin, ensureMarkdownExtension, toMemryFileUrl

### 4.4 URL Utils Tests

**File**: `src/main/lib/url-utils.ts`

- [ ] T220 [P] Create src/main/lib/url-utils.test.ts
- [ ] T221 [P] Test isValidUrl, parseUrl
- [ ] T222 [P] Test extractDomain, extractBaseDomain
- [ ] T223 [P] Test detectSocialPlatform: Twitter, LinkedIn, Mastodon, Bluesky
- [ ] T224 [P] Test isSocialPost
- [ ] T225 Test normalizeUrl: tracking parameter removal
- [ ] T226 Test isPdfUrl, isImageUrl, isVideoUrl, isAudioUrl
- [ ] T227 Test getUrlContentType

### 4.5 Export Utils Tests

**File**: `src/main/lib/export-utils.ts`

- [ ] T228 [P] Create src/main/lib/export-utils.test.ts
- [ ] T229 [P] Test markdownToHtml: markdown conversion
- [ ] T230 [P] Test escapeHtml: HTML entity escaping
- [ ] T231 Test getEmbeddedStyles: CSS generation
- [ ] T232 Test renderNoteAsHtml: complete HTML document
- [ ] T233 Test sanitizeFilename: export filename cleaning

### 4.6 Frontmatter Tests

**File**: `src/main/vault/frontmatter.ts`

- [ ] T234 [P] Create src/main/vault/frontmatter.test.ts
- [ ] T235 [P] Test parseNote: YAML frontmatter extraction
- [ ] T236 [P] Test parseNote: content without frontmatter
- [ ] T237 [P] Test serializeNote: frontmatter + content serialization
- [ ] T238 [P] Test createFrontmatter: default frontmatter generation
- [ ] T239 Test ensureFrontmatter: add frontmatter if missing
- [ ] T240 Test validateNoteId, extractTitleFromPath
- [ ] T241 Test extractWikiLinks: [[link]] extraction
- [ ] T242 Test extractTags: tag normalization
- [ ] T243 Test calculateWordCount: word counting (exclude code)
- [ ] T244 Test generateContentHash: djb2 hash
- [ ] T245 Test extractProperties, inferPropertyType
- [ ] T246 Test serializePropertyValue, deserializePropertyValue
- [ ] T247 Test createSnippet: preview generation

**Checkpoint**: All pure function unit tests complete

---

## Phase 5: Integration Tests - Database Layer (P0)

**Purpose**: Test database queries with real SQLite (in-memory or temp file)

### 5.1 Test Database Setup

- [ ] T248 Create tests/utils/test-db.ts with:
  - `createTestDatabase()` - Create in-memory database
  - `seedTestData(db)` - Seed with test fixtures
  - `cleanupTestDatabase(db)` - Cleanup after tests

### 5.2 Tasks Queries Tests

**File**: `src/shared/db/queries/tasks.ts`

- [ ] T249 Create src/shared/db/queries/tasks.test.ts
- [ ] T250 [P] Test insertTask, getTaskById, taskExists
- [ ] T251 [P] Test updateTask: all updateable fields
- [ ] T252 [P] Test deleteTask: cascade effects
- [ ] T253 Test listTasks: basic listing with pagination
- [ ] T254 Test listTasks: filter by project, status, parent
- [ ] T255 Test listTasks: filter by completion, archive status
- [ ] T256 Test listTasks: filter by due dates (today, overdue, upcoming)
- [ ] T257 Test listTasks: filter by tags, search query
- [ ] T258 Test listTasks: sorting (dueDate, priority, createdAt)
- [ ] T259 Test countTasks with filters
- [ ] T260 Test getTasksByProject, getSubtasks, countSubtasks
- [ ] T261 Test getTodayTasks, getTasksByDueDate, countOverdueTasksBeforeDate
- [ ] T262 Test getOverdueTasks, getUpcomingTasks
- [ ] T263 Test completeTask, uncompleteTask: status transitions
- [ ] T264 Test archiveTask, unarchiveTask
- [ ] T265 Test moveTask: project/status change
- [ ] T266 Test reorderTasks: position updates
- [ ] T267 Test duplicateTask, duplicateSubtask
- [ ] T268 Test setTaskTags, getTaskTags, getAllTaskTags
- [ ] T269 Test setTaskNotes, getTaskNoteIds, getTasksLinkedToNote
- [ ] T270 Test bulkCompleteTasks, bulkDeleteTasks, bulkMoveTasks, bulkArchiveTasks
- [ ] T271 Test getTaskStats, getNextTaskPosition

### 5.3 Notes Queries Tests

**File**: `src/shared/db/queries/notes.ts`

- [ ] T272 Create src/shared/db/queries/notes.test.ts
- [ ] T273 [P] Test insertNoteCache, getNoteCacheById, getNoteCacheByPath
- [ ] T274 [P] Test updateNoteCache, deleteNoteCache, noteCacheExists
- [ ] T275 Test listNotesFromCache: pagination, folder filter
- [ ] T276 Test listNotesFromCache: tag filter, search
- [ ] T277 Test listNotesFromCache: sorting options
- [ ] T278 Test countNotes with filters
- [ ] T279 Test setNoteTags, getNoteTags, getAllTags
- [ ] T280 Test findNotesByTag, findNotesWithTagInfo
- [ ] T281 Test pinNoteToTag, unpinNoteFromTag
- [ ] T282 Test renameTag, deleteTag, removeTagFromNote
- [ ] T283 Test getOrCreateTag, getAllTagsWithColors, updateTagColor
- [ ] T284 Test setNoteLinks, getOutgoingLinks, getIncomingLinks
- [ ] T285 Test deleteLinksToNote, resolveNoteByTitle, updateLinkTargets
- [ ] T286 Test bulkInsertNotes, clearNoteCache
- [ ] T287 Test setNoteProperties, getNoteProperties, getNotePropertiesAsRecord
- [ ] T288 Test property definitions: insertPropertyDefinition, updatePropertyDefinition
- [ ] T289 Test property definitions: getPropertyDefinition, getAllPropertyDefinitions
- [ ] T290 Test filterNotesByProperty: text, number, date, select filters
- [ ] T291 Test snapshot operations: insertNoteSnapshot, getNoteSnapshots
- [ ] T292 Test snapshot operations: getLatestSnapshot, snapshotExistsWithHash
- [ ] T293 Test snapshot operations: pruneOldSnapshots
- [ ] T294 Test journal queries: getJournalEntryByDate, journalEntryExistsByDate
- [ ] T295 Test journal queries: getHeatmapData, getJournalMonthEntries
- [ ] T296 Test journal queries: getJournalYearStats, getJournalStreak

### 5.4 Projects Queries Tests

**File**: `src/shared/db/queries/projects.ts`

- [ ] T297 Create src/shared/db/queries/projects.test.ts
- [ ] T298 [P] Test insertProject, getProjectById, projectExists
- [ ] T299 [P] Test updateProject, deleteProject (cascade)
- [ ] T300 Test getInboxProject, listProjects
- [ ] T301 Test getProjectsWithStats: task counts
- [ ] T302 Test archiveProject, unarchiveProject
- [ ] T303 Test reorderProjects, getNextProjectPosition
- [ ] T304 Test insertStatus, updateStatus, deleteStatus
- [ ] T305 Test getStatusesByProject, getDefaultStatus, getDoneStatus
- [ ] T306 Test getEquivalentStatus: status mapping between projects
- [ ] T307 Test reorderStatuses, setDefaultStatus, setDoneStatus
- [ ] T308 Test createDefaultStatuses, countTasksInStatus
- [ ] T309 Test getProjectWithStatuses, getProjectsWithStatuses

### 5.5 Search Queries Tests

**File**: `src/shared/db/queries/search.ts`

- [ ] T310 Create src/shared/db/queries/search.test.ts
- [ ] T311 [P] Test searchNotes: basic FTS5 search
- [ ] T312 [P] Test searchNotes: BM25 ranking
- [ ] T313 [P] Test searchNotes: phrase matching
- [ ] T314 Test searchNotes: prefix matching
- [ ] T315 Test quickSearch: optimized for command palette
- [ ] T316 Test getSuggestions: tags, titles autocomplete
- [ ] T317 Test findNotesByTag
- [ ] T318 Test findBacklinks: incoming link discovery
- [ ] T319 Test getSearchableCount, isFtsHealthy
- [ ] T320 Test highlightTerms, extractSnippet
- [ ] T321 Test escapeSearchQuery, buildPrefixQuery

### 5.6 Bookmarks Queries Tests

**File**: `src/shared/db/queries/bookmarks.ts`

- [ ] T322 Create src/shared/db/queries/bookmarks.test.ts
- [ ] T323 [P] Test insertBookmark, deleteBookmark, deleteBookmarkByItem
- [ ] T324 [P] Test getBookmarkById, getBookmarkByItem, isBookmarked
- [ ] T325 Test listBookmarks: pagination, type filter
- [ ] T326 Test countBookmarks, listBookmarksByType
- [ ] T327 Test reorderBookmarks, updateBookmarkPosition
- [ ] T328 Test bulkCreateBookmarks, bulkDeleteBookmarks
- [ ] T329 Test toggleBookmark, deleteOrphanedBookmarks

### 5.7 Settings Queries Tests

**File**: `src/shared/db/queries/settings.ts`

- [ ] T330 Create src/shared/db/queries/settings.test.ts
- [ ] T331 [P] Test getSetting, setSetting, deleteSetting
- [ ] T332 Test saved filters: insertSavedFilter, updateSavedFilter
- [ ] T333 Test saved filters: getSavedFilterById, listSavedFilters
- [ ] T334 Test saved filters: reorderSavedFilters

### 5.8 FTS Integration Tests

**File**: `src/main/database/fts.ts`

- [ ] T335 Create src/main/database/fts.test.ts
- [ ] T336 [P] Test createFtsTable: FTS5 virtual table creation
- [ ] T337 [P] Test insertFtsNote, updateFtsContent, deleteFtsNote
- [ ] T338 Test FTS query: basic search
- [ ] T339 Test FTS query: boolean operators (AND, OR, NOT)
- [ ] T340 Test FTS query: prefix matching
- [ ] T341 Test clearFtsTable, getFtsCount, ftsNoteExists

**Checkpoint**: Database integration tests complete

---

## Phase 6: Integration Tests - Vault Operations (P1)

**Purpose**: Test file system operations with temporary directories

### 6.1 File Operations Tests

**File**: `src/main/vault/file-ops.ts`

- [ ] T342 Create src/main/vault/file-ops.test.ts
- [ ] T343 [P] Test atomicWrite: write via temp file + rename
- [ ] T344 [P] Test atomicWrite: handles existing file
- [ ] T345 [P] Test safeRead, readRequired: success and error cases
- [ ] T346 Test ensureDirectory: recursive creation
- [ ] T347 Test listMarkdownFiles: recursive .md discovery
- [ ] T348 Test listDirectories: subdirectory listing
- [ ] T349 Test deleteFile, fileExists, directoryExists, getFileStats
- [ ] T350 Test sanitizeFilename: special character handling
- [ ] T351 Test generateNotePath: path generation with folders
- [ ] T352 Test generateUniquePath: collision handling

### 6.2 Vault Init Tests

**File**: `src/main/vault/init.ts`

- [ ] T353 Create src/main/vault/init.test.ts
- [ ] T354 [P] Test getMemryDir, getDataDbPath, getIndexDbPath, getConfigPath
- [ ] T355 [P] Test isVaultInitialized: .memry folder detection
- [ ] T356 [P] Test isValidDirectory, hasWritePermission
- [ ] T357 Test initVault: creates vault structure
- [ ] T358 Test readVaultConfig, writeVaultConfig: JSON config
- [ ] T359 Test getVaultName, countMarkdownFiles

### 6.3 Notes Operations Tests

**File**: `src/main/vault/notes.ts`

- [ ] T360 Create src/main/vault/notes.test.ts
- [ ] T361 [P] Test createNote: file creation + cache insert
- [ ] T362 [P] Test getNoteById, getNoteByPath
- [ ] T363 [P] Test updateNote: content + metadata update
- [ ] T364 Test renameNote: file rename + cache update
- [ ] T365 Test moveNote: folder move + cache update
- [ ] T366 Test deleteNote: file + cache deletion
- [ ] T367 Test listNotes: with pagination and filters
- [ ] T368 Test getTagsWithCounts: tag aggregation
- [ ] T369 Test getNoteLinks: outgoing + incoming
- [ ] T370 Test folder operations: getFolders, createFolder, renameFolder, deleteFolder
- [ ] T371 Test noteExists: by title and path
- [ ] T372 Test snapshot operations: createSnapshot, getVersionHistory, restoreVersion

### 6.4 Indexer Tests

**File**: `src/main/vault/indexer.ts`

- [ ] T373 Create src/main/vault/indexer.test.ts
- [ ] T374 Test indexVault: full vault indexing
- [ ] T375 Test needsInitialIndex: empty cache detection
- [ ] T376 Test rebuildIndex: cache rebuild

### 6.5 Journal Tests

**File**: `src/main/vault/journal.ts`

- [ ] T377 Create src/main/vault/journal.test.ts
- [ ] T378 [P] Test getJournalPath: date-based path generation
- [ ] T379 [P] Test parseJournalEntry, serializeJournalEntry
- [ ] T380 [P] Test createJournalFrontmatter
- [ ] T381 Test readJournalEntry, writeJournalEntry
- [ ] T382 Test deleteJournalEntryFile, journalEntryExists
- [ ] T383 Test calculateActivityLevelFromContent, extractPreview

### 6.6 Templates Tests

**File**: `src/main/vault/templates.ts`

- [ ] T384 Create src/main/vault/templates.test.ts
- [ ] T385 [P] Test getTemplatesDir, ensureTemplatesDir
- [ ] T386 [P] Test listTemplates, getTemplate
- [ ] T387 Test createTemplate, updateTemplate, deleteTemplate
- [ ] T388 Test duplicateTemplate
- [ ] T389 Test applyTemplate: property and content application

### 6.7 Attachments Tests

**File**: `src/main/vault/attachments.ts`

- [ ] T390 Create src/main/vault/attachments.test.ts
- [ ] T391 [P] Test getNoteAttachmentsDir, getAttachmentPath
- [ ] T392 [P] Test generateUniqueFilename
- [ ] T393 Test saveAttachment, deleteAttachment
- [ ] T394 Test listNoteAttachments, attachmentExists
- [ ] T395 Test validation: isAllowedFileType, validateFileSize
- [ ] T396 Test getRelativeAttachmentPath, getAbsoluteAttachmentUrl

### 6.8 Folders Tests

**File**: `src/main/vault/folders.ts`

- [ ] T397 Create src/main/vault/folders.test.ts
- [ ] T398 [P] Test readFolderConfig, writeFolderConfig
- [ ] T399 Test getFolderTemplate: inheritance resolution
- [ ] T400 Test setFolderTemplate
- [ ] T401 Test isFolderConfigFile

**Checkpoint**: Vault integration tests complete

---

## Phase 7: Integration Tests - Inbox System (P2)

**Purpose**: Test inbox capture and processing with mocked dependencies

### 7.1 Inbox Stats Tests

**File**: `src/main/inbox/stats.ts`

- [ ] T402 Create src/main/inbox/stats.test.ts
- [ ] T403 [P] Test getStaleThreshold, setStaleThreshold
- [ ] T404 [P] Test isStale, getStaleCutoffDate
- [ ] T405 Test getStaleItemIds, countStaleItems
- [ ] T406 Test stat tracking: incrementCaptureCount, incrementProcessedCount
- [ ] T407 Test getTodayStats, getTodayActivity
- [ ] T408 Test getAverageTimeToProcess

### 7.2 Inbox Snooze Tests

**File**: `src/main/inbox/snooze.ts`

- [ ] T409 Create src/main/inbox/snooze.test.ts
- [ ] T410 [P] Test snoozeItem, unsnoozeItem
- [ ] T411 [P] Test getSnoozedItems, getDueSnoozeItems
- [ ] T412 Test bulkSnoozeItems
- [ ] T413 Test checkDueItemsOnStartup
- [ ] T414 Test scheduler: startSnoozeScheduler, stopSnoozeScheduler

### 7.3 Inbox Attachments Tests

**File**: `src/main/inbox/attachments.ts`

- [ ] T415 Create src/main/inbox/attachments.test.ts
- [ ] T416 [P] Test getInboxAttachmentsDir, getItemAttachmentsDir
- [ ] T417 [P] Test storeInboxAttachment, storeThumbnail
- [ ] T418 Test deleteInboxAttachments, listInboxAttachments
- [ ] T419 Test moveAttachmentsToNote
- [ ] T420 Test resolveAttachmentUrl, hasAttachments

### 7.4 Inbox Filing Tests

**File**: `src/main/inbox/filing.ts`

- [ ] T421 Create src/main/inbox/filing.test.ts
- [ ] T422 [P] Test fileToFolder: file item to folder
- [ ] T423 [P] Test convertToNote: standalone note creation
- [ ] T424 Test linkToNote, linkToNotes: existing note linking
- [ ] T425 Test bulkFileToFolder

### 7.5 Inbox Metadata Tests

**File**: `src/main/inbox/metadata.ts`

- [ ] T426 Create src/main/inbox/metadata.test.ts (mock fetch)
- [ ] T427 [P] Test fetchUrlMetadata: metascraper integration
- [ ] T428 [P] Test isValidUrl, extractDomain
- [ ] T429 Test downloadImage: image download

### 7.6 Social Extraction Tests

**File**: `src/main/inbox/social.ts`

- [ ] T430 Create src/main/inbox/social.test.ts (mock fetch)
- [ ] T431 [P] Test detectSocialPlatform, isSocialPost
- [ ] T432 [P] Test extractSocialPost: Twitter/X
- [ ] T433 Test extractSocialPost: Mastodon, Bluesky
- [ ] T434 Test createFallbackSocialMetadata

**Checkpoint**: Inbox integration tests complete

---

## Phase 8: Integration Tests - IPC Layer (P2)

**Purpose**: Test IPC handlers with mocked Electron APIs

### 8.1 IPC Test Utilities

- [ ] T435 Create tests/utils/mock-ipc.ts with:
  - `MockIpcMain` - Mock ipcMain.handle
  - `MockIpcRenderer` - Mock ipcRenderer.invoke
  - `createTestIpcContext()` - Full IPC mock context

### 8.2 Notes Handlers Tests

**File**: `src/main/ipc/notes-handlers.ts`

- [ ] T436 Create src/main/ipc/notes-handlers.test.ts
- [ ] T437 [P] Test CREATE handler: validation + note creation
- [ ] T438 [P] Test GET, GET_BY_PATH handlers
- [ ] T439 [P] Test UPDATE handler: all update scenarios
- [ ] T440 Test DELETE handler: cascading effects
- [ ] T441 Test LIST handler: filters and pagination
- [ ] T442 Test folder handlers: GET_FOLDERS, CREATE_FOLDER, etc.
- [ ] T443 Test version handlers: GET_VERSION_HISTORY, RESTORE_VERSION

### 8.3 Tasks Handlers Tests

**File**: `src/main/ipc/tasks-handlers.ts`

- [ ] T444 Create src/main/ipc/tasks-handlers.test.ts
- [ ] T445 [P] Test CREATE, GET, UPDATE, DELETE handlers
- [ ] T446 [P] Test COMPLETE, UNCOMPLETE handlers
- [ ] T447 Test LIST with filters
- [ ] T448 Test bulk operations: BULK_COMPLETE, BULK_DELETE, BULK_MOVE

### 8.4 Vault Handlers Tests

**File**: `src/main/ipc/vault-handlers.ts`

- [ ] T449 Create src/main/ipc/vault-handlers.test.ts
- [ ] T450 [P] Test SELECT, CREATE handlers
- [ ] T451 Test GET_ALL, GET_STATUS, GET_CONFIG handlers
- [ ] T452 Test SWITCH, CLOSE handlers
- [ ] T453 Test REINDEX handler

### 8.5 Inbox Handlers Tests

**File**: `src/main/ipc/inbox-handlers.ts`

- [ ] T454 Create src/main/ipc/inbox-handlers.test.ts
- [ ] T455 [P] Test CAPTURE_TEXT, CAPTURE_LINK handlers
- [ ] T456 [P] Test LIST, GET, UPDATE handlers
- [ ] T457 Test FILE, ARCHIVE handlers
- [ ] T458 Test SNOOZE, UNSNOOZE handlers
- [ ] T459 Test bulk handlers

### 8.6 Search Handlers Tests

**File**: `src/main/ipc/search-handlers.ts`

- [ ] T460 Create src/main/ipc/search-handlers.test.ts
- [ ] T461 [P] Test SEARCH, QUICK_SEARCH handlers
- [ ] T462 Test SUGGESTIONS handler
- [ ] T463 Test REBUILD_INDEX handler

**Checkpoint**: IPC integration tests complete

---

## Phase 9: Contract Tests - Zod Schemas (P1)

**Purpose**: Validate API contracts and ensure type safety

### 9.1 Notes API Contract Tests

**File**: `src/shared/contracts/notes-api.ts`

- [x] T464 Create src/shared/contracts/notes-api.test.ts
- [x] T465 [P] Test NoteCreateSchema: valid/invalid inputs
- [x] T466 [P] Test NoteUpdateSchema: partial updates
- [x] T467 Test NoteListSchema: filter options
- [x] T468 Test error messages for invalid data

### 9.2 Tasks API Contract Tests

**File**: `src/shared/contracts/tasks-api.ts`

- [x] T469 Create src/shared/contracts/tasks-api.test.ts
- [x] T470 [P] Test TaskCreateSchema, TaskUpdateSchema
- [x] T471 [P] Test RepeatConfigSchema: all repeat patterns
- [x] T472 Test ProjectCreateSchema, StatusCreateSchema

### 9.3 Inbox API Contract Tests

**File**: `src/shared/contracts/inbox-api.ts`

- [x] T473 Create src/shared/contracts/inbox-api.test.ts
- [x] T474 [P] Test capture schemas: Text, Link, Image, Voice, Clip, PDF
- [x] T475 Test InboxListSchema, SnoozeSchema

### 9.4 Other Contract Tests

- [x] T476 [P] Create src/shared/contracts/folder-view-api.test.ts
- [x] T477 [P] Create src/shared/contracts/journal-api.test.ts
- [x] T478 [P] Create src/shared/contracts/reminders-api.test.ts
- [x] T479 [P] Create src/shared/contracts/search-api.test.ts
- [x] T480 [P] Create src/shared/contracts/vault-api.test.ts
- [x] T481 [P] Create src/shared/contracts/bookmarks-api.test.ts
- [x] T482 [P] Create src/shared/contracts/tags-api.test.ts
- [x] T483 [P] Create src/shared/contracts/templates-api.test.ts
- [x] T484 [P] Create src/shared/contracts/saved-filters-api.test.ts

**Checkpoint**: Contract tests complete

---

## Phase 10: React Hook Tests (P2)

**Purpose**: Test React hooks with @testing-library/react

### 10.1 Hook Test Utilities

- [ ] T485 Create tests/utils/hook-test-wrapper.tsx with:
  - Mock IPC context provider
  - React Query provider
  - Theme provider

### 10.2 Core Hook Tests

- [ ] T486 Create src/renderer/src/hooks/use-notes.test.ts
- [ ] T487 Test useNotes: list, create, update, delete
- [ ] T488 Test useNoteTags, useNoteLinks
- [ ] T489 Test useNote: single note fetching

- [ ] T490 Create src/renderer/src/hooks/use-tasks.test.ts
- [ ] T491 Test useTasks: list with filters
- [ ] T492 Test useCreateTask, useUpdateTask, useDeleteTask
- [ ] T493 Test useCompleteTask, useBulkComplete

- [ ] T494 Create src/renderer/src/hooks/use-journal.test.ts
- [ ] T495 Test useJournalEntry, useCreateJournalEntry
- [ ] T496 Test useJournalHeatmap, useJournalMonthEntries

- [ ] T497 Create src/renderer/src/hooks/use-inbox.test.ts
- [ ] T498 Test useInboxItems, useCapture\*
- [ ] T499 Test useFileItem, useSnoozeItem

- [ ] T500 Create src/renderer/src/hooks/use-search.test.ts
- [ ] T501 Test useSearch, useQuickSearch, useSuggestions

### 10.3 Utility Hook Tests

- [ ] T502 Create src/renderer/src/hooks/use-keyboard-shortcuts.test.ts
- [ ] T503 Test shortcut registration and execution
- [ ] T504 Test conflict detection

- [ ] T505 Create src/renderer/src/hooks/use-bookmarks.test.ts
- [ ] T506 Test useBookmarks, useToggleBookmark

- [ ] T507 Create src/renderer/src/hooks/use-reminders.test.ts
- [ ] T508 Test useReminders, useCreateReminder

**Checkpoint**: Hook tests complete

---

## Phase 11: Component Tests (P3)

**Purpose**: Test key UI components with @testing-library/react

### 11.1 Note Components Tests

- [ ] T509 Create src/renderer/src/components/note/note-title.test.tsx
- [ ] T510 Test title editing, emoji picker integration

- [ ] T511 Create src/renderer/src/components/note/tags-row.test.tsx
- [ ] T512 Test tag add/remove, autocomplete

- [ ] T513 Create src/renderer/src/components/note/info-section.test.tsx
- [ ] T514 Test property editors (all 8 types)

### 11.2 Task Components Tests

- [ ] T515 Create src/renderer/src/components/task/task-card.test.tsx
- [ ] T516 Test task display, completion toggle

- [ ] T517 Create src/renderer/src/components/task/task-quick-add.test.tsx
- [ ] T518 Test quick add parsing preview

### 11.3 Inbox Components Tests

- [ ] T519 Create src/renderer/src/components/inbox/inbox-card.test.tsx
- [ ] T520 Test card display for all item types

### 11.4 Common Components Tests

- [ ] T521 Create src/renderer/src/components/notes-tree.test.tsx
- [ ] T522 Test folder tree, drag-drop, context menu

- [ ] T523 Create src/renderer/src/components/command-palette.test.tsx
- [ ] T524 Test search, navigation, keyboard shortcuts

**Checkpoint**: Component tests complete

---

## Phase 12: E2E Tests with Playwright (P2)

**Purpose**: Full application testing with Playwright Electron support

### 12.1 E2E Infrastructure

- [ ] T525 Create playwright.config.ts for Electron
- [ ] T526 Create tests/e2e/fixtures/test-vault/ with sample data
- [ ] T527 Create tests/e2e/utils/electron-helpers.ts

### 12.2 Vault E2E Tests

- [ ] T528 Create tests/e2e/vault.spec.ts
- [ ] T529 Test vault creation flow
- [ ] T530 Test vault opening/switching
- [ ] T531 Test vault reindexing

### 12.3 Notes E2E Tests

- [ ] T532 Create tests/e2e/notes.spec.ts
- [ ] T533 Test note creation with title, content, tags
- [ ] T534 Test note editing with auto-save
- [ ] T535 Test wiki-link creation and navigation
- [ ] T536 Test backlinks display
- [ ] T537 Test note deletion and undo

### 12.4 Tasks E2E Tests

- [ ] T538 Create tests/e2e/tasks.spec.ts
- [ ] T539 Test task creation with quick-add syntax
- [ ] T540 Test task completion, uncomplete
- [ ] T541 Test task drag-drop between statuses
- [ ] T542 Test subtask creation and management
- [ ] T543 Test recurring task creation

### 12.5 Inbox E2E Tests

- [ ] T544 Create tests/e2e/inbox.spec.ts
- [ ] T545 Test text capture
- [ ] T546 Test link capture with metadata
- [ ] T547 Test filing to folder
- [ ] T548 Test snooze and unsnooze

### 12.6 Journal E2E Tests

- [ ] T549 Create tests/e2e/journal.spec.ts
- [ ] T550 Test journal entry creation
- [ ] T551 Test calendar navigation
- [ ] T552 Test heatmap display

### 12.7 Search E2E Tests

- [ ] T553 Create tests/e2e/search.spec.ts
- [ ] T554 Test global search
- [ ] T555 Test command palette
- [ ] T556 Test search result navigation

### 12.8 Cross-Feature E2E Tests

- [ ] T557 Create tests/e2e/integration.spec.ts
- [ ] T558 Test inbox → note conversion flow
- [ ] T559 Test task → note linking
- [ ] T560 Test reminder notification flow

**Checkpoint**: E2E tests complete

---

## Phase 13: Coverage & CI Integration (P1)

**Purpose**: Ensure coverage targets and CI automation

### 13.1 Coverage Configuration

- [ ] T561 Configure coverage thresholds in vitest.config.ts:
  - Global: 80% lines, 80% branches
  - src/renderer/src/lib/: 90% (pure functions)
  - src/shared/db/queries/: 85% (database layer)
- [ ] T562 Configure coverage exclusions:
  - `**/*.d.ts`
  - `**/index.ts` (barrel exports)
  - `**/*.stories.tsx`
  - `tests/**`

### 13.2 CI Pipeline

- [ ] T563 Create .github/workflows/test.yml with:
  - Unit tests on PR
  - Integration tests on PR
  - E2E tests on main branch
  - Coverage reporting

- [ ] T564 Add coverage badge to README.md
- [ ] T565 Configure Codecov or Coveralls integration

### 13.3 Documentation

- [ ] T566 Create docs/testing.md with:
  - Test architecture overview
  - How to run tests locally
  - How to write new tests
  - Mocking patterns

- [ ] T567 Document test data fixtures
- [ ] T568 Document E2E test best practices

### 13.4 Quality Gates

- [ ] T569 Configure pre-commit hook to run affected tests
- [ ] T570 Configure PR checks to require passing tests
- [ ] T571 Add test coverage to PR template

**Checkpoint**: CI/CD integration complete - FULL TEST COVERAGE ACHIEVED

---

## Phase 14: Coverage Completion Sweep (Missing Modules & Features)

**Purpose**: Close remaining coverage gaps so every module and feature has explicit tests.

### 14.1 Main Process Core Services (P1)

- [ ] T572 Create src/main/lib/embeddings.test.ts
- [ ] T573 [P] Test initEmbeddingModel: progress events, cache dir, error handling
- [ ] T574 [P] Test generateEmbedding: length guard, truncation, dimension check
- [ ] T575 Test model state helpers: isModelLoaded, isModelLoading, getModelInfo, unloadModel

- [ ] T576 Create src/main/lib/reminders.test.ts
- [ ] T577 [P] Test CRUD: createReminder, updateReminder, deleteReminder, getReminder
- [ ] T578 [P] Test list queries: listReminders, getRemindersForTarget, filters (status/date)
- [ ] T579 Test scheduler lifecycle: startReminderScheduler, stopReminderScheduler, due processing
- [ ] T580 Test snooze/dismiss flows + event emission
- [ ] T581 Test inbox item creation + notification click navigation (mock Notification/BrowserWindow)

- [ ] T582 Create src/main/store.test.ts
- [ ] T583 [P] Test vault CRUD: getVaults, upsertVault, removeVault, findVault
- [ ] T584 Test get/set currentVault and touchVault timestamp updates

### 14.2 Database Bootstrap & Seed (P1)

- [ ] T585 Create src/main/database/client.test.ts
- [ ] T586 [P] Test initDatabase/initIndexDatabase pragmas + close lifecycle
- [ ] T587 [P] Test checkIndexHealth: missing/corrupt/healthy states
- [ ] T588 Test withTimeout: resolves result and rejects on timeout

- [ ] T589 Create src/main/database/migrate.test.ts
- [ ] T590 [P] Test runMigrations creates core tables
- [ ] T591 [P] Test runIndexMigrations creates note cache + vec_notes tables

- [ ] T592 Create src/main/database/seed.test.ts
- [ ] T593 [P] Test seedDefaults idempotency and inbox project creation
- [ ] T594 Test seedSampleProject and seedPerformanceTestProject outputs

### 14.3 Vault Watcher & Rename Tracking (P1)

- [ ] T595 Create src/main/vault/rename-tracker.test.ts
- [ ] T596 [P] Test trackPendingDelete timeout triggers onRealDelete
- [ ] T597 [P] Test checkForRename updates cache and emits RENAMED event
- [ ] T598 Test clearPendingDelete/clearAllPendingDeletes/hasPendingDeletes

- [ ] T599 Create src/main/vault/watcher.test.ts
- [ ] T600 [P] Test handleFileChange: frontmatter parse + cache updates
- [ ] T601 [P] Test add/unlink events: create/delete note cache + tags/links sync
- [ ] T602 Test rename flow integration with rename-tracker
- [ ] T603 Test watcher startup/shutdown and resource cleanup

### 14.4 Inbox Capture & Processing Additions (P2)

- [ ] T604 Create src/main/inbox/capture.test.ts
- [ ] T605 [P] Test captureText/link/image/voice/pdf flows
- [ ] T606 Test metadata fetch + attachment handling integration

- [ ] T607 Create src/main/inbox/suggestions.test.ts
- [ ] T608 [P] Test suggestion generation, ranking, and deduping
- [ ] T609 Test source mapping (recent notes, tags, projects)

- [ ] T610 Create src/main/inbox/transcription.test.ts
- [ ] T611 [P] Test transcription pipeline with mocked provider
- [ ] T612 Test error handling, retries, and timeouts

### 14.5 IPC Handlers Coverage Expansion (P1)

- [ ] T613 Create src/main/ipc/journal-handlers.test.ts
- [ ] T614 [P] Test journal handlers: CREATE/UPDATE/DELETE/GET/LIST, reminders integration

- [ ] T615 Create src/main/ipc/tags-handlers.test.ts
- [ ] T616 [P] Test tags handlers: LIST/CREATE/UPDATE/DELETE, suggestions

- [ ] T617 Create src/main/ipc/templates-handlers.test.ts
- [ ] T618 [P] Test templates handlers: CREATE/UPDATE/DELETE/GET/LIST, apply template

- [ ] T619 Create src/main/ipc/saved-filters-handlers.test.ts
- [ ] T620 [P] Test saved filter handlers: CRUD, reorder, share scope

- [ ] T621 Create src/main/ipc/settings-handlers.test.ts
- [ ] T622 [P] Test settings handlers: GET/SET/RESET, embedding progress events

- [ ] T623 Create src/main/ipc/folder-view-handlers.test.ts
- [ ] T624 [P] Test folder-view handlers: list notes with properties, filters, sorting

- [ ] T625 Create src/main/ipc/reminder-handlers.test.ts
- [ ] T626 [P] Test reminder handlers: CREATE/UPDATE/DELETE/LIST, SNOOZE/DISMISS, events

- [ ] T627 Create src/main/ipc/bookmarks-handlers.test.ts
- [ ] T628 [P] Test bookmark handlers: CREATE/DELETE/TOGGLE/LIST/REORDER/BULK

- [ ] T629 Create src/main/ipc/validate.test.ts
- [ ] T630 [P] Test createValidatedHandler/createHandler/createStringHandler/withErrorHandling

### 14.6 Renderer Service Layer Tests (P2)

- [ ] T631 Create src/renderer/src/services/notes-service.test.ts
- [ ] T632 [P] Test notes-service API mapping + event subscriptions

- [ ] T633 Create src/renderer/src/services/tasks-service.test.ts
- [ ] T634 [P] Test tasks-service CRUD + bulk operations mapping

- [ ] T635 Create src/renderer/src/services/journal-service.test.ts
- [ ] T636 [P] Test journal-service list/read/write mapping

- [ ] T637 Create src/renderer/src/services/inbox-service.test.ts
- [ ] T638 [P] Test inbox-service capture, file, snooze, metadata mapping

- [ ] T639 Create src/renderer/src/services/reminder-service.test.ts
- [ ] T640 [P] Test reminder-service CRUD + event subscriptions

- [ ] T641 Create src/renderer/src/services/templates-service.test.ts
- [ ] T642 [P] Test templates-service CRUD + folder default mapping

- [ ] T643 Create src/renderer/src/services/saved-filters-service.test.ts
- [ ] T644 [P] Test saved-filters-service CRUD + reorder mapping

- [ ] T645 Create src/renderer/src/services/tags-service.test.ts
- [ ] T646 [P] Test tags-service list/update mapping

- [ ] T647 Create src/renderer/src/services/search-service.test.ts
- [ ] T648 [P] Test search-service search/quick-search/suggestions mapping

- [ ] T649 Create src/renderer/src/services/vault-service.test.ts
- [ ] T650 [P] Test vault-service create/open/switch/status mapping

- [ ] T651 Create src/renderer/src/services/ai-connections-service.test.ts
- [ ] T652 [P] Test ai-connections-service CRUD + connection test mapping

### 14.7 Renderer Hooks Coverage Expansion (P2)

- [ ] T653 Create src/renderer/src/hooks/use-active-heading.test.ts
- [ ] T654 Create src/renderer/src/hooks/use-all-tags.test.ts
- [ ] T655 Create src/renderer/src/hooks/use-autocomplete.test.ts
- [ ] T656 Create src/renderer/src/hooks/use-bulk-actions.test.ts
- [ ] T657 Create src/renderer/src/hooks/use-chord-shortcuts.test.ts
- [ ] T658 Create src/renderer/src/hooks/use-display-density.test.ts
- [ ] T659 Create src/renderer/src/hooks/use-drag-handlers.test.ts
- [ ] T660 Create src/renderer/src/hooks/use-expanded-tasks.test.ts
- [ ] T661 Create src/renderer/src/hooks/use-focus-management.test.ts
- [ ] T662 Create src/renderer/src/hooks/use-focus-trap.test.ts
- [ ] T663 Create src/renderer/src/hooks/use-folder-suggestions.test.ts
- [ ] T664 Create src/renderer/src/hooks/use-folder-view.test.ts
- [ ] T665 Create src/renderer/src/hooks/use-journal-properties.test.ts
- [ ] T666 Create src/renderer/src/hooks/use-journal-reminders.test.ts
- [ ] T667 Create src/renderer/src/hooks/use-journal-scroll.test.ts
- [ ] T668 Create src/renderer/src/hooks/use-journal-settings.test.ts
- [ ] T669 Create src/renderer/src/hooks/use-keyboard-shortcuts-base.test.ts
- [ ] T670 Create src/renderer/src/hooks/use-new-note-shortcut.test.ts
- [ ] T671 Create src/renderer/src/hooks/use-note-editor.test.ts
- [ ] T672 Create src/renderer/src/hooks/use-note-properties.test.ts
- [ ] T673 Create src/renderer/src/hooks/use-note-reminders.test.ts
- [ ] T674 Create src/renderer/src/hooks/use-overdue-celebration.test.ts
- [ ] T675 Create src/renderer/src/hooks/use-pages.test.ts
- [ ] T676 Create src/renderer/src/hooks/use-pane-navigation.test.ts
- [ ] T677 Create src/renderer/src/hooks/use-property-definitions.test.ts
- [ ] T678 Create src/renderer/src/hooks/use-reduced-motion.test.ts
- [ ] T679 Create src/renderer/src/hooks/use-reminder-notifications.test.ts
- [ ] T680 Create src/renderer/src/hooks/use-reveal-in-sidebar.test.ts
- [ ] T681 Create src/renderer/src/hooks/use-search-shortcut.test.ts
- [ ] T682 Create src/renderer/src/hooks/use-sidebar-navigation.test.ts
- [ ] T683 Create src/renderer/src/hooks/use-subtask-management.test.ts
- [ ] T684 Create src/renderer/src/hooks/use-tab-keyboard-shortcuts.test.ts
- [ ] T685 Create src/renderer/src/hooks/use-tag-detail.test.ts
- [ ] T686 Create src/renderer/src/hooks/use-tags.test.ts
- [ ] T687 Create src/renderer/src/hooks/use-task-filters.test.ts
- [ ] T688 Create src/renderer/src/hooks/use-task-order.test.ts
- [ ] T689 Create src/renderer/src/hooks/use-task-selection.test.ts
- [ ] T690 Create src/renderer/src/hooks/use-task-settings.test.ts
- [ ] T691 Create src/renderer/src/hooks/use-tasks-linked-to-note.test.ts
- [ ] T692 Create src/renderer/src/hooks/use-templates.test.ts
- [ ] T693 Create src/renderer/src/hooks/use-throttled-tab-switch.test.ts
- [ ] T694 Create src/renderer/src/hooks/use-undo.test.ts
- [ ] T695 Create src/renderer/src/hooks/use-vault.test.ts
- [ ] T696 Create src/renderer/src/lib/hooks/use-mobile.test.ts
- [ ] T697 Create src/renderer/src/lib/utils.test.ts

### 14.8 Page + Component Tests (P3)

- [ ] T698 Create src/renderer/src/pages/folder-view.test.tsx
- [ ] T699 Create src/renderer/src/pages/inbox.test.tsx
- [ ] T700 Create src/renderer/src/pages/journal.test.tsx
- [ ] T701 Create src/renderer/src/pages/tasks.test.tsx
- [ ] T702 Create src/renderer/src/pages/settings.test.tsx
- [ ] T703 Create src/renderer/src/pages/templates.test.tsx
- [ ] T704 Create src/renderer/src/pages/template-editor.test.tsx

- [ ] T705 Create src/renderer/src/components/folder-view/folder-table-view.test.tsx
- [ ] T706 Create src/renderer/src/components/folder-view/grouped-table.test.tsx
- [ ] T707 Create src/renderer/src/components/reminder/reminder-picker.test.tsx
- [ ] T708 Create src/renderer/src/components/reminder/highlight-reminder-popover.test.tsx
- [ ] T709 Create src/renderer/src/components/sidebar/sidebar-bookmark-list.test.tsx
- [ ] T710 Create src/renderer/src/components/note/version-history.test.tsx
- [ ] T711 Create src/renderer/src/components/note/export-dialog.test.tsx
- [ ] T712 Create src/renderer/src/components/note/template-selector.test.tsx
- [ ] T713 Create src/renderer/src/components/inbox/inbox-list.test.tsx
- [ ] T714 Create src/renderer/src/components/search/search-modal.test.tsx
- [ ] T715 Create src/renderer/src/components/vault-switcher.test.tsx
- [ ] T716 Create src/renderer/src/components/vault-onboarding.test.tsx
- [ ] T717 Create src/renderer/src/components/note/backlinks/backlinks-section.test.tsx
- [ ] T718 Create src/renderer/src/components/note/related-notes/related-notes-tab.test.tsx
- [ ] T719 Create src/renderer/src/components/note/note-reminder-button.test.tsx
- [ ] T720 Create src/renderer/src/components/journal/journal-reminder-button.test.tsx

### 14.9 E2E Coverage Expansion (P2)

- [ ] T721 Create tests/e2e/folder-view.spec.ts
- [ ] T722 Create tests/e2e/templates.spec.ts
- [ ] T723 Create tests/e2e/reminders.spec.ts
- [ ] T724 Create tests/e2e/bookmarks.spec.ts
- [ ] T725 Create tests/e2e/settings.spec.ts
- [ ] T726 Create tests/e2e/export-version.spec.ts
- [ ] T727 Create tests/e2e/attachments.spec.ts
- [ ] T728 Create tests/e2e/tags-properties.spec.ts
- [ ] T729 Create tests/e2e/saved-filters.spec.ts

**Checkpoint**: Phase 14 complete - coverage gaps closed

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Infrastructure) → BLOCKS all other phases
    ↓
┌───────────────────────────────────────────────────────────────┐
│ PARALLEL GROUP A (Unit Tests - No Dependencies)               │
│ • Phase 2 (Core Parsers)                                      │
│ • Phase 3 (Utility Functions)                                 │
│ • Phase 4 (Main Process Utils)                                │
└───────────────────────────────────────────────────────────────┘
    ↓
Phase 5 (Database Integration) → Requires Phase 1
    ↓
┌───────────────────────────────────────────────────────────────┐
│ PARALLEL GROUP B (Integration Tests)                          │
│ • Phase 6 (Vault Operations) - Requires Phase 5               │
│ • Phase 7 (Inbox System) - Requires Phase 5, 6                │
│ • Phase 8 (IPC Layer) - Requires Phase 5, 6                   │
│ • Phase 9 (Contract Tests) - Independent                      │
└───────────────────────────────────────────────────────────────┘
    ↓
┌───────────────────────────────────────────────────────────────┐
│ PARALLEL GROUP C (Component Tests)                            │
│ • Phase 10 (React Hooks) - Requires Phase 1                   │
│ • Phase 11 (UI Components) - Requires Phase 10                │
└───────────────────────────────────────────────────────────────┘
    ↓
Phase 12 (E2E Tests) → Requires all previous phases
    ↓
Phase 13 (Coverage & CI) → Final integration
```

**Note**: Phase 14 spans multiple layers; run it after Phase 1 alongside Phases 4-12, and complete before Phase 13 thresholds.

### Priority Execution Path

**MVP Test Coverage (P0 + P1):**

```
Phase 1 → Phase 2 → Phase 4 → Phase 5 → Phase 9 → Phase 14 (P1 items) → Phase 13

~180 tasks for critical coverage
```

**Full Coverage:**

```
All 14 phases → ~300 tasks total (estimate)
```

---

## File-to-Test Mapping Summary

### Renderer Pure Functions (22 files → 22 test files)

| Source File               | Test File                      | Tasks     |
| ------------------------- | ------------------------------ | --------- |
| expression-parser.ts      | expression-parser.test.ts      | T016-T030 |
| natural-date-parser.ts    | natural-date-parser.test.ts    | T031-T041 |
| filter-evaluator.ts       | filter-evaluator.test.ts       | T042-T056 |
| expression-evaluator.ts   | expression-evaluator.test.ts   | T057-T070 |
| task-utils.ts             | task-utils.test.ts             | T071-T089 |
| repeat-utils.ts           | repeat-utils.test.ts           | T090-T104 |
| quick-add-parser.ts       | quick-add-parser.test.ts       | T105-T116 |
| subtask-utils.ts          | subtask-utils.test.ts          | T117-T133 |
| subtask-bulk-utils.ts     | subtask-bulk-utils.test.ts     | T134-T140 |
| tag-utils.ts              | tag-utils.test.ts              | T141-T146 |
| fuzzy-search.ts           | fuzzy-search.test.ts           | T147-T153 |
| journal-utils.ts          | journal-utils.test.ts          | T154-T162 |
| inbox-utils.ts            | inbox-utils.test.ts            | T163-T167 |
| stale-utils.ts            | stale-utils.test.ts            | T168-T172 |
| lookup-utils.ts           | lookup-utils.test.ts           | T173-T176 |
| wiki-link-utils.ts        | wiki-link-utils.test.ts        | T177-T181 |
| summary-evaluator.ts      | summary-evaluator.test.ts      | T182-T190 |
| section-visibility.ts     | section-visibility.test.ts     | T191-T192 |
| virtual-list-utils.ts     | virtual-list-utils.test.ts     | T193-T195 |
| virtualized-tree-utils.ts | virtualized-tree-utils.test.ts | T196-T198 |
| ai-clustering.ts          | ai-clustering.test.ts          | T199-T202 |

### Main Process (17 files → 17 test files)

| Source File          | Test File                 | Tasks     |
| -------------------- | ------------------------- | --------- |
| lib/id.ts            | lib/id.test.ts            | T203-T208 |
| lib/errors.ts        | lib/errors.test.ts        | T209-T213 |
| lib/paths.ts         | lib/paths.test.ts         | T214-T219 |
| lib/url-utils.ts     | lib/url-utils.test.ts     | T220-T227 |
| lib/export-utils.ts  | lib/export-utils.test.ts  | T228-T233 |
| vault/frontmatter.ts | vault/frontmatter.test.ts | T234-T247 |
| vault/file-ops.ts    | vault/file-ops.test.ts    | T342-T352 |
| vault/init.ts        | vault/init.test.ts        | T353-T359 |
| vault/notes.ts       | vault/notes.test.ts       | T360-T372 |
| vault/indexer.ts     | vault/indexer.test.ts     | T373-T376 |
| vault/journal.ts     | vault/journal.test.ts     | T377-T383 |
| vault/templates.ts   | vault/templates.test.ts   | T384-T389 |
| vault/attachments.ts | vault/attachments.test.ts | T390-T396 |
| vault/folders.ts     | vault/folders.test.ts     | T397-T401 |
| inbox/stats.ts       | inbox/stats.test.ts       | T402-T408 |
| inbox/snooze.ts      | inbox/snooze.test.ts      | T409-T414 |
| inbox/attachments.ts | inbox/attachments.test.ts | T415-T420 |

### Addendum: Phase 14 Coverage Map

- Main process: embeddings, reminders, store, database client/migrate/seed, vault watcher/rename-tracker, inbox capture/suggestions/transcription
- IPC: journal, tags, templates, saved-filters, settings, folder-view, reminders, bookmarks, validate helpers
- Renderer: service wrappers, remaining hooks, page/component tests, utility additions (use-mobile, cn)
- E2E: folder view, templates, reminders, bookmarks, settings, export/version, attachments, tags/properties, saved filters

---

## Notes

- **[P]** tasks = Can run in parallel (different files, no dependencies)
- **Priority levels**: P0 (critical) > P1 (high) > P2 (medium) > P3 (low)
- Focus on **pure functions first** - highest ROI with minimal setup
- Database tests use **in-memory SQLite** for isolation
- E2E tests use **Playwright with Electron** support
- Target **80% coverage** with higher thresholds for critical paths
- Co-located tests: `src/path/to/file.ts` → `src/path/to/file.test.ts`
