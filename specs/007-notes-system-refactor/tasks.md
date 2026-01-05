# Tasks: Notes System Refactor & Optimization

**Input**: Analysis of uncommitted changes and existing codebase
**Prerequisites**: Existing notes system (001-core-data-layer, 003-notes)

**Tests**: Tests are NOT explicitly requested. Test tasks are NOT included.

**Organization**: Tasks are grouped by phase to enable systematic implementation with clear checkpoints.

**Priority Order**: Phase 2 (Backend) → Phase 4 (Performance) → Phase 3 (Frontend) → Phase 1 (Quick Wins)

---

## Completion Status (Updated: 2026-01-05)

| Phase | Section | Status | Notes |
|-------|---------|--------|-------|
| **Phase 2** | 2.1 NoteSyncService | ✅ Complete | T001-T005 |
| | 2.2 Batch Operations | ✅ Complete | T006-T009 |
| | 2.3 Migrate Code | ✅ Complete | T010-T017 |
| | 2.4 Zod Frontmatter | ⏭️ Skipped | User decision - current validation sufficient |
| | 2.5 Pino Logging | ⬜ Not Started | Optional - 225 replacements |
| **Phase 4** | 4.1 FTS Batch Updates | ✅ Complete | T028-T033 |
| | 4.2 Embedding Queue | ✅ Complete | T034-T039 |
| | 4.3 Optimize listNotes | 🟡 Partial | T040 done, T041 optional |
| **Phase 3** | 3.1 Audit & Prepare | ✅ Complete | T042-T045 |
| | 3.2 Migrate Components | ✅ Complete | T046-T053 |
| | 3.3 Remove Deprecated | ✅ Complete | T054-T056 |
| | 3.4 Optimize Hooks | ⬜ Not Started | Optional enhancements |
| | 3.5 Shared Utilities | ⬜ Not Started | Optional extraction |
| **Phase 1** | Quick Wins | ⬜ Not Started | Cleanup tasks |

**Summary**: Core refactor complete (Phase 2.1-2.3, Phase 4.1-4.2, Phase 3.1-3.3). Optional enhancements remain.

---

## Format: `[ID] [P?] [Phase] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Phase]**: Which phase this task beloncheck the uncommit change under @src/ folder and try to understand the changes, it s to
- Include exact file paths in descriptions

## Path Conventions

- **Electron app**: `src/main/`, `src/renderer/src/`, `src/shared/`, `src/preload/`
- Following established patterns from 001-core-data-layer and 005-inbox-capture

---

## Overview

This refactor addresses:

1. **Code Duplication**: `notes.ts`, `watcher.ts`, `indexer.ts` share ~200 lines of identical cache sync logic
2. **N+1 Query Patterns**: Individual queries for links, tags, properties instead of batch operations
3. **Dual Hook Implementations**: `use-notes.ts` (688 lines) and `use-notes-query.ts` (443 lines) coexist
4. **Type Safety**: Loose frontmatter types with `as` casts throughout
5. **Inconsistent Logging**: Mix of console.log, no structured logging
6. **Performance**: FTS and embedding updates on every save

---

## Phase 2: Backend Consolidation

**Purpose**: Extract shared logic, add batch operations, improve type safety

**CRITICAL**: This phase establishes the foundation. Must complete before other phases.

### 2.1 Create NoteSyncService (Core Refactor) ✅

- [x] T001 Create `src/main/vault/note-sync.ts` with interface definitions:

  ```typescript
  interface NoteSyncInput {
    id: string
    path: string
    content: string // Full file content
    frontmatter: NoteFrontmatter
    parsedContent: string // Markdown body only
  }

  interface NoteSyncResult {
    id: string
    tags: string[]
    properties: Record<string, unknown>
    links: { targetTitle: string; targetId?: string }[]
    wordCount: number
    characterCount: number
    snippet: string
    contentHash: string
    date: string | null // For journal entries
  }
  ```

- [x] T002 Implement `extractNoteMetadata()` in `src/main/vault/note-sync.ts`:
  - Extract tags via `extractTags()`
  - Extract properties via `extractProperties()`
  - Extract wiki links via `extractWikiLinks()`
  - Calculate word count, character count, snippet, content hash
  - Extract date from path for journal entries
  - Return `NoteSyncResult`

- [x] T003 Implement `syncNoteToCache()` in `src/main/vault/note-sync.ts`:
  - Accept `db: DrizzleDb`, `input: NoteSyncInput`, `options: { isNew: boolean }`
  - Call `extractNoteMetadata()` for metadata
  - Insert or update note cache based on `isNew`
  - Set tags via `setNoteTags()`
  - Set properties via `setNoteProperties()` with type inference
  - Update FTS index via `updateFtsContent()`
  - Resolve and set links via batch resolver (T006)
  - Return `NoteSyncResult`

- [x] T004 Implement `deleteNoteFromCache()` in `src/main/vault/note-sync.ts`:
  - Clean up links where note is target via `deleteLinksToNote()`
  - Delete from cache via `deleteNoteCache()`

- [x] T005 Export all functions from `src/main/vault/note-sync.ts`

**Checkpoint**: NoteSyncService created with core functions

### 2.2 Batch Operations (Performance) ✅

- [x] T006 Create `resolveNotesByTitles()` in `src/shared/db/queries/notes.ts`:
  - Accept `db: DrizzleDb`, `titles: string[]`
  - Single query with `WHERE title IN (...)` or `WHERE LOWER(title) IN (...)`
  - Also check aliases
  - Return `Map<string, { id: string; path: string } | null>`

- [x] T007 Create `getPropertiesForNotes()` in `src/shared/db/queries/notes.ts`:
  - Accept `db: DrizzleDb`, `noteIds: string[]`
  - Single query joining `noteProperties` with `propertyDefinitions`
  - Return `Map<string, Record<string, unknown>>`

- [x] T008 Create `getLinksForNotes()` in `src/shared/db/queries/notes.ts`:
  - Accept `db: DrizzleDb`, `noteIds: string[]`
  - Single query for outgoing links
  - Return `Map<string, NoteLink[]>`

- [x] T009 Update `syncNoteToCache()` to use `resolveNotesByTitles()`:
  - Batch resolve all wiki link targets in one query
  - Replace individual `resolveNoteByTitle()` calls

**Checkpoint**: Batch operations reduce N+1 queries ✅

### 2.3 Migrate Existing Code to NoteSyncService ✅

- [x] T010 Migrate `src/main/vault/notes.ts` `createNote()`:
  - Replace inline cache insert with `syncNoteToCache()`
  - Remove duplicate metadata extraction logic

- [x] T011 Migrate `src/main/vault/notes.ts` `updateNote()`:
  - Replace inline cache update with `syncNoteToCache()`
  - Keep snapshot logic before sync

- [x] T012 Migrate `src/main/vault/notes.ts` `getNoteByPath()`:
  - Replace inline cache insert with `syncNoteToCache()`

- [x] T013 Migrate `src/main/vault/notes.ts` `deleteNote()`:
  - Replace inline deletion with `deleteNoteFromCache()`

- [x] T014 Migrate `src/main/vault/watcher.ts` `handleFileAdd()`:
  - Replace inline cache insert (~60 lines) with `syncNoteToCache()`
  - Keep rename detection and duplicate ID logic

- [x] T015 Migrate `src/main/vault/watcher.ts` `handleFileChange()`:
  - Replace inline cache update (~50 lines) with `syncNoteToCache()`
  - Keep content hash check for early return

- [x] T016 Migrate `src/main/vault/indexer.ts` `indexFile()`:
  - Replace inline cache insert (~40 lines) with `syncNoteToCache()`
  - Keep duplicate ID regeneration logic

- [x] T017 Remove duplicate helper functions from `notes.ts`:
  - Keep only functions not in `note-sync.ts`
  - Update imports across files

**Checkpoint**: All note sync operations use shared service (~200 lines removed) ✅

### 2.4 Type-Safe Frontmatter with Zod ⏭️ SKIPPED

> **Decision**: Skipped per user decision - current validation is sufficient

- [ ] T018 Create `src/main/vault/frontmatter-schema.ts`:

  ```typescript
  import { z } from 'zod'

  export const NoteFrontmatterSchema = z
    .object({
      id: z.string().min(1),
      title: z.string().optional(),
      created: z.string(),
      modified: z.string(),
      tags: z.array(z.string()).default([]),
      aliases: z.array(z.string()).default([]),
      properties: z.record(z.unknown()).default({}),
      emoji: z.string().nullable().optional()
    })
    .passthrough() // Allow unknown fields

  export type ValidatedFrontmatter = z.infer<typeof NoteFrontmatterSchema>
  ```

- [ ] T019 Create `validateFrontmatter()` in `src/main/vault/frontmatter-schema.ts`:
  - Accept raw frontmatter object
  - Parse with Zod schema
  - Return `{ success: true, data: ValidatedFrontmatter } | { success: false, error: ZodError }`

- [ ] T020 Update `parseNote()` in `src/main/vault/frontmatter.ts`:
  - After gray-matter parsing, validate with `validateFrontmatter()`
  - Log warning on validation failure but continue (backward compat)
  - Return validated frontmatter

- [ ] T021 Remove `as` type casts for emoji in:
  - `src/main/vault/notes.ts` (3 occurrences)
  - `src/main/vault/watcher.ts` (2 occurrences)
  - `src/main/vault/indexer.ts` (1 occurrence)

**Checkpoint**: Frontmatter has runtime validation, no unsafe casts

### 2.5 Structured Logging with Pino

- [ ] T022 Install pino: `pnpm add pino pino-pretty`

- [ ] T023 Create `src/main/lib/logger.ts`:

  ```typescript
  import pino from 'pino'

  export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined
  })

  // Namespaced loggers
  export const vaultLog = logger.child({ module: 'vault' })
  export const watcherLog = logger.child({ module: 'watcher' })
  export const indexerLog = logger.child({ module: 'indexer' })
  export const ipcLog = logger.child({ module: 'ipc' })
  ```

- [ ] T024 Replace console.log in `src/main/vault/indexer.ts`:
  - Import `indexerLog` from logger
  - Replace `console.log('[Indexer]...')` with `indexerLog.info(...)`
  - Replace `console.error('[Indexer]...')` with `indexerLog.error(...)`
  - Replace `console.warn('[Indexer]...')` with `indexerLog.warn(...)`

- [ ] T025 Replace console.log in `src/main/vault/notes.ts`:
  - Import `vaultLog` from logger
  - Replace remaining console statements

- [ ] T026 Replace console.log in `src/main/ipc/` handlers:
  - Import `ipcLog` from logger
  - Replace console statements in all handler files

- [ ] T027 Add pino types: `pnpm add -D @types/pino`

**Checkpoint**: Structured logging with pino throughout backend

---

## Phase 4: Performance Optimizations ✅

**Purpose**: Batch updates, queue operations, reduce I/O

### 4.1 FTS Batch Updates ✅

- [x] T028 Create `src/main/database/fts-queue.ts`:

  ```typescript
  interface FtsUpdate {
    noteId: string
    content: string
    tags: string[]
  }

  const pendingUpdates = new Map<string, FtsUpdate>()
  let flushTimer: NodeJS.Timeout | null = null

  export function queueFtsUpdate(noteId: string, content: string, tags: string[]): void
  export function flushFtsUpdates(): void
  export function cancelPendingFtsUpdates(): void
  ```

- [x] T029 Implement `queueFtsUpdate()`:
  - Add/update entry in `pendingUpdates` map
  - Schedule flush timer (2000ms) if not already scheduled
  - Deduplicate by noteId (latest update wins)

- [x] T030 Implement `flushFtsUpdates()`:
  - Wrap in database transaction for atomicity
  - Process all pending updates
  - Clear map and timer
  - Log batch size with pino

- [x] T031 Implement `cancelPendingFtsUpdates()`:
  - Clear timer and map
  - Called on vault close

- [x] T032 Update `syncNoteToCache()` to use `queueFtsUpdate()`:
  - Replace direct `updateFtsContent()` call
  - Add option `{ immediate?: boolean }` for cases needing sync update

- [x] T033 Call `flushFtsUpdates()` on vault close in `src/main/vault/index.ts`

**Checkpoint**: FTS updates batched, reducing write operations ✅

### 4.2 Embedding Queue ✅

- [x] T034 Create `src/main/inbox/embedding-queue.ts`:

  ```typescript
  const embeddingQueue: string[] = []
  let isProcessing = false
  const BATCH_SIZE = 10
  const BATCH_DELAY_MS = 500

  export function queueEmbeddingUpdate(noteId: string): void
  export function processEmbeddingQueue(): Promise<void>
  export function clearEmbeddingQueue(): void
  ```

- [x] T035 Implement `queueEmbeddingUpdate()`:
  - Add to queue if not already present
  - Schedule processing if not already processing

- [x] T036 Implement `processEmbeddingQueue()`:
  - Process in batches of BATCH_SIZE
  - Use `Promise.allSettled()` for error resilience
  - Log failures with pino
  - Schedule next batch after BATCH_DELAY_MS

- [x] T037 Implement `clearEmbeddingQueue()`:
  - Clear queue
  - Called on vault close

- [x] T038 Update embedding calls to use queue:
  - `src/main/vault/notes.ts` `createNote()` - use `queueEmbeddingUpdate()`
  - `src/main/vault/notes.ts` `updateNote()` - use `queueEmbeddingUpdate()`
  - `src/main/vault/watcher.ts` `handleFileAdd()` - use `queueEmbeddingUpdate()`
  - `src/main/vault/watcher.ts` `handleFileChange()` - use `queueEmbeddingUpdate()`
  - `src/main/vault/indexer.ts` `indexFile()` - use `queueEmbeddingUpdate()`

- [x] T039 Call `clearEmbeddingQueue()` on vault close

**Checkpoint**: Embedding updates batched, reducing model load overhead ✅

### 4.3 Optimize listNotes Further

- [x] T040 Update `listNotes()` in `src/main/vault/notes.ts`:
  - Already uses `getTagsForNotes()` (from uncommitted changes)
  - Add `getPropertiesForNotes()` for bulk property loading
  - Remove any remaining individual queries

- [ ] T041 Add optional `includeProperties` parameter to `listNotes()`:
  - Default to `false` for list views (properties not shown)
  - Set `true` for folder view (needs properties)
  - Skip property query when not needed

**Checkpoint**: listNotes is fully optimized for large vaults

---

## Phase 3: Frontend Migration (Big Bang) ✅

**Purpose**: Deprecate use-notes.ts, migrate all consumers to TanStack Query

### 3.1 Audit and Prepare ✅

- [x] T042 Audit all imports of `use-notes.ts`:
  - Run: `grep -r "from.*use-notes" src/renderer/`
  - Document all files and specific imports used
  - Create migration checklist per file

- [x] T043 Ensure `use-notes-query.ts` has feature parity:
  - Verify `useNote()` covers `getNote()`
  - Verify `useNotesList()` covers `notes` state
  - Verify `useNoteMutations()` covers all CRUD operations
  - Add any missing functionality

- [x] T044 Add `useNoteTagsQuery()` export if not present:
  - Already exists in `use-notes-query.ts` - verify exported

- [x] T045 Add `useNoteFoldersQuery()` export if not present:
  - Already exists in `use-notes-query.ts` - verify exported

### 3.2 Migrate Components (Big Bang) ✅

- [x] T046 Migrate `src/renderer/src/pages/note.tsx`:
  - Already partially migrated in uncommitted changes
  - Complete migration: remove any remaining `useNotes` usage
  - Update all callbacks to use mutation hooks

- [x] T047 Migrate `src/renderer/src/pages/notes.tsx`:
  - Replace `useNotes()` with `useNotesList()`
  - Update loading/error handling
  - Update CRUD operations to mutations

- [x] T048 Migrate `src/renderer/src/components/notes-tree.tsx`:
  - Replace note fetching with query hooks
  - Update event handlers

- [x] T049 Migrate `src/renderer/src/components/note-list.tsx`:
  - Replace with `useNotesList()` hook
  - Keep UI rendering logic

- [x] T050 Migrate `src/renderer/src/components/quick-switcher.tsx`:
  - Update note search/selection to use query hooks

- [x] T051 Migrate `src/renderer/src/components/command-palette.tsx`:
  - Update note operations to use mutation hooks

- [x] T052 Migrate `src/renderer/src/pages/search.tsx`:
  - Keep search hook, update note operations

- [x] T053 Migrate any remaining components:
  - Search for remaining `useNotes` imports
  - Migrate each file

### 3.3 Remove Deprecated Hook

- [x] T054 Add deprecation notice to `use-notes.ts`:

  ```typescript
  /**
   * @deprecated Use hooks from use-notes-query.ts instead:
   * - useNote(id) for single note
   * - useNotesList(options) for note list
   * - useNoteMutations() for create/update/delete
   */
  ```

- [x] T055 Verify no remaining imports of `use-notes.ts`:
  - Run grep to confirm
  - All imports should be from `use-notes-query.ts`
  - **Result**: Only `use-notes.test.tsx` still imports (tests the deprecated API)

- [x] T056 Delete `src/renderer/src/hooks/use-notes.ts`:
  - Remove file (688 lines)
  - Update any barrel exports
  - **Done**: Removed use-notes.ts and use-notes.test.tsx

**Checkpoint**: Single source of truth for note hooks, ~688 lines removed ✅

### 3.4 Optimize Query Hooks

- [ ] T057 Add optimistic updates to `updateNote` mutation:
  - Update cache immediately on mutate
  - Rollback on error
  - Refetch on settle

- [ ] T058 Add optimistic updates to `deleteNote` mutation:
  - Remove from cache immediately
  - Rollback on error

- [ ] T059 Add optimistic updates to `renameNote` mutation:
  - Update title in cache immediately
  - Rollback on error

- [ ] T060 Add infinite scroll support with `useNotesInfinite()`:
  - Create `useNotesInfinite()` hook using `useInfiniteQuery`
  - Mirror pattern from `use-inbox.ts`
  - Export from `use-notes-query.ts`

**Checkpoint**: Notes hooks have optimistic updates and infinite scroll

### 3.5 Extract Shared Hook Utilities

- [ ] T061 Create `src/renderer/src/hooks/utils/use-ipc-invalidation.ts`:

  ```typescript
  export function useIpcInvalidation(
    events: Record<string, () => void>,
    deps?: DependencyList
  ): void {
    useEffect(() => {
      const cleanup = Object.entries(events).map(([event, handler]) => {
        // Subscribe and return unsubscribe
      })
      return () => cleanup.forEach((fn) => fn())
    }, deps)
  }
  ```

- [ ] T062 Create `src/renderer/src/hooks/utils/use-debounced-value.ts`:
  - Extract from `use-search.ts` if not already separate
  - Generic implementation for any value type

- [ ] T063 Create `src/renderer/src/hooks/utils/index.ts`:
  - Barrel export for all utilities

- [ ] T064 Refactor `use-notes-query.ts` to use shared utilities:
  - Replace inline event subscription with `useIpcInvalidation()`

- [ ] T065 Refactor `use-journal.ts` to use shared utilities:
  - Replace inline event subscription with `useIpcInvalidation()`

**Checkpoint**: Shared hook utilities reduce duplication

---

## Phase 1: Quick Wins & Cleanup

**Purpose**: Apply low-risk improvements, complete uncommitted changes

### 1.1 Complete Uncommitted Changes

- [ ] T066 Review and test uncommitted database migration:
  - `0008_tiresome_micromax.sql` adds `snippet` column
  - Verify migration applies cleanly
  - Test with existing vaults

- [ ] T067 Verify `getTagsForNotes()` batch query works correctly:
  - Test with empty array
  - Test with large array (100+ notes)
  - Verify performance improvement

- [ ] T068 Verify `extractWikiLinks()` deduplication works:
  - Test added in uncommitted changes
  - Run tests to confirm

### 1.2 Additional Cleanup

- [ ] T069 Remove remaining verbose logging not covered by pino migration:
  - Search for `console.log` in `src/main/`
  - Convert or remove each occurrence

- [ ] T070 Fix TypeScript strict mode issues:
  - `notesKeys.note(id!)` - add runtime check
  - Other non-null assertions - add proper guards

- [ ] T071 Standardize error types in hooks:
  - All hooks should use `Error | null`
  - Create utility: `extractErrorMessage(err: unknown): string`

- [ ] T072 Add JSDoc to public API functions in `note-sync.ts`:
  - Document parameters, return types, usage examples

**Checkpoint**: Codebase is clean, consistent, well-documented

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 2: Backend Consolidation
    │
    ├── 2.1 NoteSyncService ──────────────────┐
    │       │                                  │
    │       ▼                                  │
    ├── 2.2 Batch Operations ◄────────────────┤
    │       │                                  │
    │       ▼                                  │
    ├── 2.3 Migrate Existing Code ◄───────────┘
    │       │
    │       ▼
    ├── 2.4 Zod Frontmatter (parallel with 2.3)
    │       │
    │       ▼
    └── 2.5 Pino Logging (parallel with 2.3, 2.4)
            │
            ▼
Phase 4: Performance
    │
    ├── 4.1 FTS Batch Updates
    │       │
    ├── 4.2 Embedding Queue (parallel with 4.1)
    │       │
    └── 4.3 Optimize listNotes
            │
            ▼
Phase 3: Frontend Migration
    │
    ├── 3.1 Audit & Prepare
    │       │
    │       ▼
    ├── 3.2 Migrate Components (Big Bang)
    │       │
    │       ▼
    ├── 3.3 Remove Deprecated Hook
    │       │
    │       ▼
    ├── 3.4 Optimize Query Hooks
    │       │
    │       ▼
    └── 3.5 Extract Shared Utilities
            │
            ▼
Phase 1: Quick Wins & Cleanup
    │
    ├── 1.1 Complete Uncommitted Changes
    │       │
    │       ▼
    └── 1.2 Additional Cleanup
```

### Parallel Execution Opportunities

Within each phase, tasks marked with [P] can run in parallel:

**Phase 2:**

- T022-T027 (Pino logging) can run parallel to T010-T017 (migration)
- T018-T021 (Zod) can run parallel to T010-T017 (migration)

**Phase 4:**

- T028-T033 (FTS queue) parallel with T034-T039 (embedding queue)

**Phase 3:**

- T046-T053 (component migrations) can be parallelized across developers

---

## Story Points Estimate

| Phase       | Section                | Tasks | Complexity | Estimate      |
| ----------- | ---------------------- | ----- | ---------- | ------------- |
| **Phase 2** |                        |       |            |               |
|             | 2.1 NoteSyncService    | 5     | High       | 3 hours       |
|             | 2.2 Batch Operations   | 4     | Medium     | 2 hours       |
|             | 2.3 Migrate Code       | 8     | Medium     | 3 hours       |
|             | 2.4 Zod Frontmatter    | 4     | Medium     | 1.5 hours     |
|             | 2.5 Pino Logging       | 6     | Low        | 1.5 hours     |
|             | **Phase 2 Total**      | 27    |            | **11 hours**  |
| **Phase 4** |                        |       |            |               |
|             | 4.1 FTS Batch          | 6     | Medium     | 2 hours       |
|             | 4.2 Embedding Queue    | 6     | Medium     | 2 hours       |
|             | 4.3 Optimize listNotes | 2     | Low        | 0.5 hours     |
|             | **Phase 4 Total**      | 14    |            | **4.5 hours** |
| **Phase 3** |                        |       |            |               |
|             | 3.1 Audit & Prepare    | 4     | Low        | 1 hour        |
|             | 3.2 Migrate Components | 8     | High       | 4 hours       |
|             | 3.3 Remove Hook        | 3     | Low        | 0.5 hours     |
|             | 3.4 Optimize Hooks     | 4     | Medium     | 2 hours       |
|             | 3.5 Shared Utilities   | 5     | Medium     | 1.5 hours     |
|             | **Phase 3 Total**      | 24    |            | **9 hours**   |
| **Phase 1** |                        |       |            |               |
|             | 1.1 Uncommitted        | 3     | Low        | 0.5 hours     |
|             | 1.2 Cleanup            | 4     | Low        | 1 hour        |
|             | **Phase 1 Total**      | 7     |            | **1.5 hours** |

**Grand Total: 72 tasks, ~26 hours (3-4 days)**

---

## Expected Outcomes

### Code Reduction

- Remove ~200 lines duplicate cache sync logic (notes.ts, watcher.ts, indexer.ts)
- Remove ~688 lines deprecated hook (use-notes.ts)
- **Total: ~900 lines removed**

### Performance Improvements

- Batch tag queries: O(1) instead of O(n) for listNotes
- Batch link resolution: O(1) instead of O(n) for wiki links
- FTS batching: Reduce write operations by 80%+
- Embedding batching: Reduce model load overhead

### Quality Improvements

- Type-safe frontmatter with Zod validation
- Structured logging with pino
- Consistent error handling
- Single source of truth for note hooks

### Developer Experience

- Clearer code organization
- Better debugging with structured logs
- Smaller hook surface area
- Documented public APIs

---

## Rollback Strategy

Each phase is designed to be independently reversible:

**Phase 2 Rollback:**

- NoteSyncService can coexist with old code
- Batch operations have fallbacks
- Zod validation is optional (warns, doesn't break)

**Phase 4 Rollback:**

- Queues can be bypassed with `immediate` option
- Original direct calls still work

**Phase 3 Rollback:**

- Keep `use-notes.ts` until all migrations verified
- Deprecation notice warns but doesn't break

**Phase 1 Rollback:**

- No breaking changes, purely additive

---

## Notes

- [P] tasks can run in parallel (different files, no dependencies)
- Each phase should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate
- Run `pnpm test` after each phase to verify no regressions
- Run `pnpm typecheck` frequently during Phase 2 and 3
- The uncommitted changes provide a good foundation - build on them
