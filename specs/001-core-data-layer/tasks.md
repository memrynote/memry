# Tasks: Core Data Layer

**Input**: Design documents from `/specs/001-core-data-layer/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Not explicitly requested - implementation tasks only.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Shared code**: `src/shared/db/` (schemas, queries, types - reusable for React Native)
- **Main process**: `src/main/` (database, vault, ipc, lib)
- **Preload**: `src/preload/`
- **Renderer**: `src/renderer/src/` (services, hooks)

---

## Phase 1: Setup (Project Initialization)

**Purpose**: Install dependencies, configure build tools, create project structure

- [x] T001 Install production dependencies: drizzle-orm, better-sqlite3, chokidar, gray-matter, nanoid, electron-store, zod
- [x] T002 Install dev dependencies: drizzle-kit, @electron/rebuild, @types/better-sqlite3, vitest
- [x] T003 [P] Add npm scripts to package.json (postinstall, rebuild, db:generate, db:push, db:studio)
- [x] T004 [P] Update electron.vite.config.ts to externalize better-sqlite3 and add @shared path alias
- [x] T005 [P] Update tsconfig.json with @shared/* path alias
- [x] T006 Create drizzle.config.ts in project root
- [x] T007 Create directory structure per plan.md (src/shared/db/, src/main/database/, src/main/vault/, src/main/ipc/, src/main/lib/)
- [x] T008 Run electron-rebuild to compile better-sqlite3 for Electron

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**CRITICAL**: No user story work can begin until this phase is complete

### Database Schemas (src/shared/db/schema/)

- [x] T009 [P] Create projects schema in src/shared/db/schema/projects.ts
- [x] T010 [P] Create statuses schema in src/shared/db/schema/statuses.ts
- [x] T011 [P] Create tasks schema in src/shared/db/schema/tasks.ts
- [x] T012 [P] Create task-relations schema (taskNotes, taskTags) in src/shared/db/schema/task-relations.ts
- [x] T013 [P] Create inbox schema in src/shared/db/schema/inbox.ts
- [x] T014 [P] Create settings schema (settings, savedFilters) in src/shared/db/schema/settings.ts
- [x] T015 [P] Create notes-cache schema (noteCache, noteTags, noteLinks) in src/shared/db/schema/notes-cache.ts
- [x] T016 Create schema index with re-exports in src/shared/db/schema/index.ts
- [x] T017 Run drizzle-kit generate to create initial migrations

### Database Module (src/main/database/)

- [x] T018 Create Drizzle client with better-sqlite3 driver in src/main/database/client.ts
- [x] T019 Create migration runner in src/main/database/migrate.ts
- [x] T020 Create database module exports in src/main/database/index.ts
- [x] T021 Create FTS5 virtual table setup for search in src/main/database/fts.ts

### Utility Modules (src/main/lib/)

- [x] T022 [P] Create path utilities and sanitization in src/main/lib/paths.ts
- [x] T023 [P] Create nanoid wrapper for UUID generation in src/main/lib/id.ts
- [x] T024 [P] Create custom error types in src/main/lib/errors.ts

### Vault Foundation (US5 + US6 - Required for all operations)

**Goal**: Enable vault folder selection and persistence - prerequisite for all file operations

- [x] T025 Install and configure electron-store for vault path persistence
- [x] T026 Create vault index module with folder selection dialog in src/main/vault/index.ts
- [x] T027 Create vault initialization (create .memry folder structure) in src/main/vault/init.ts
- [x] T028 Create vault-handlers.ts with SELECT, GET_STATUS, GET_CONFIG channels in src/main/ipc/vault-handlers.ts
- [x] T029 Update preload script with vault API in src/preload/index.ts
- [x] T030 Update preload types in src/preload/index.d.ts with vault API
- [x] T031 Create vault-service.ts client in src/renderer/src/services/vault-service.ts
- [x] T032 Create use-vault.ts hook in src/renderer/src/hooks/use-vault.ts
- [x] T033 Register vault handlers in main process in src/main/ipc/index.ts
- [x] T034 Initialize database and run migrations on vault open in src/main/index.ts

### IPC Infrastructure

- [x] T035 Create IPC handler registration pattern in src/main/ipc/index.ts
- [x] T036 Create Zod validation middleware for IPC handlers in src/main/ipc/validate.ts

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Store Notes as Portable Markdown Files (Priority: P1)

**Goal**: Enable creating, reading, updating, and deleting notes as plain markdown files with YAML frontmatter

**Independent Test**: Create a note in Memry, open the vault folder in Finder, verify the .md file exists with readable frontmatter and content. Edit the file in VS Code to confirm it's standard markdown.

### Implementation for User Story 1

- [x] T037 [US1] Create frontmatter parsing/serialization module using gray-matter in src/main/vault/frontmatter.ts
- [x] T038 [US1] Create atomic file write operations (write-temp-then-rename) in src/main/vault/file-ops.ts
- [x] T039 [US1] Implement note CRUD operations (create, read, update, delete) in src/main/vault/notes.ts
- [x] T040 [US1] Create notes query functions in src/shared/db/queries/notes.ts
- [x] T041 [US1] Implement notes IPC handlers (CREATE, GET, UPDATE, DELETE, LIST) in src/main/ipc/notes-handlers.ts
- [x] T042 [US1] Update preload script with notes API in src/preload/index.ts
- [x] T043 [US1] Create notes-service.ts client in src/renderer/src/services/notes-service.ts
- [x] T044 [US1] Create use-notes.ts hook in src/renderer/src/hooks/use-notes.ts
- [x] T045 [US1] Handle missing frontmatter: auto-add UUID and timestamps on first edit in src/main/vault/frontmatter.ts
- [x] T046 [US1] Handle duplicate UUIDs: generate new UUID when copy-paste detected in src/main/vault/notes.ts
- [x] T047 [US1] Add note caching in index.db on create/update in src/main/vault/notes.ts
- [x] T048 [US1] Register notes handlers in main process in src/main/ipc/index.ts

**Checkpoint**: US1 complete - notes can be created and edited as portable markdown files

---

## Phase 4: User Story 2 - Detect External File Changes (Priority: P1)

**Goal**: Automatically detect when files are created, modified, or deleted outside Memry and update the UI within 500ms

**Independent Test**: Open a note in VS Code while Memry is running, edit and save the file. Verify Memry shows updated content within 500ms without manual refresh.

### Implementation for User Story 2

- [ ] T049 [US2] Create chokidar file watcher setup in src/main/vault/watcher.ts
- [ ] T050 [US2] Implement debounced event handling with 100ms stabilization in src/main/vault/watcher.ts
- [ ] T051 [US2] Create IPC events for file change notifications (CREATED, UPDATED, DELETED) in src/main/ipc/notes-handlers.ts
- [ ] T052 [US2] Update index.db cache on external file changes in src/main/vault/watcher.ts
- [ ] T053 [US2] Subscribe to file change events in use-notes.ts hook in src/renderer/src/hooks/use-notes.ts
- [ ] T054 [US2] Start watcher when vault opens, stop when vault closes in src/main/vault/index.ts

**Checkpoint**: US2 complete - external file changes are detected and reflected in UI within 500ms

---

## Phase 5: User Story 3 - Track File Renames Without Breaking Links (Priority: P1)

**Goal**: Use UUID-based identity tracking so renames don't break internal links

**Independent Test**: Create NoteA linking to NoteB using [[NoteB]]. Rename NoteB.md in Finder to NewName.md. Verify the link in NoteA still works.

### Implementation for User Story 3

- [ ] T055 [US3] Create rename detection using UUID matching within 500ms window in src/main/vault/rename-tracker.ts
- [ ] T056 [US3] Update note links cache (note_links table) when files are renamed in src/main/vault/rename-tracker.ts
- [ ] T057 [US3] Add RENAMED event to file watcher notifications in src/main/vault/watcher.ts
- [ ] T058 [US3] Implement get-links IPC handler for backlinks in src/main/ipc/notes-handlers.ts
- [ ] T059 [US3] Update paths in noteCache when files are renamed in src/main/vault/rename-tracker.ts

**Checkpoint**: US3 complete - file renames are tracked by UUID, internal links remain valid

---

## Phase 6: User Story 4 - Fast Search Across All Notes (Priority: P1)

**Goal**: Provide full-text search returning results in under 50ms for 10,000 notes

**Independent Test**: With 1,000+ notes in vault, search for a term and measure response time. Results should appear in under 50ms.

### Implementation for User Story 4

- [ ] T060 [US4] Create FTS5 triggers to sync fts_notes with note_cache in src/main/database/fts.ts
- [ ] T061 [US4] Implement search query functions with BM25 ranking in src/shared/db/queries/search.ts
- [ ] T062 [US4] Create search IPC handlers (SEARCH, QUICK_SEARCH, SUGGESTIONS) in src/main/ipc/search-handlers.ts
- [ ] T063 [US4] Update preload script with search API in src/preload/index.ts
- [ ] T064 [US4] Create search-service.ts client in src/renderer/src/services/search-service.ts
- [ ] T065 [US4] Create use-search.ts hook in src/renderer/src/hooks/use-search.ts
- [ ] T066 [US4] Register search handlers in main process in src/main/ipc/index.ts
- [ ] T067 [US4] Implement search result highlighting with snippet extraction in src/shared/db/queries/search.ts

**Checkpoint**: US4 complete - full-text search works across all notes with <50ms response time

---

## Phase 7: User Story 7 + User Story 8 - Progress Indication & Auto Recovery (Priority: P2)

**Goal (US7)**: Show indexing progress when opening vault with many files
**Goal (US8)**: Automatically rebuild index if corrupted, without data loss

**Independent Test (US7)**: Open a vault with 1,000 files for the first time. Verify progress indicator shows indexing status.
**Independent Test (US8)**: Manually corrupt index.db, reopen app. Verify automatic rebuild occurs and all notes are accessible.

### Implementation for User Story 7 + 8

- [ ] T068 [US7] Create initial vault indexer with progress reporting in src/main/vault/indexer.ts
- [ ] T069 [US7] Add INDEX_PROGRESS event to vault IPC channels in src/main/ipc/vault-handlers.ts
- [ ] T070 [US7] Display indexing progress in UI via use-vault.ts hook in src/renderer/src/hooks/use-vault.ts
- [ ] T071 [US8] Implement index corruption detection (check schema version, table existence) in src/main/database/index.ts
- [ ] T072 [US8] Implement automatic index rebuild from source files in src/main/vault/indexer.ts
- [ ] T073 [US8] Add notification for auto-recovery completion in src/main/ipc/vault-handlers.ts

**Checkpoint**: US7+US8 complete - indexing progress is visible, and index corruption triggers automatic recovery

---

## Phase 8: User Story 9 + User Story 10 - Multiple Vaults & Exclusions (Priority: P3)

**Goal (US9)**: Support switching between multiple vault folders
**Goal (US10)**: Allow excluding folders (like .git, node_modules) from indexing

**Independent Test (US9)**: Create two vaults, switch between them. Verify each vault shows only its own notes.
**Independent Test (US10)**: Add a .git folder to vault. Verify files inside are not indexed or shown in search.

### Implementation for User Story 9 + 10

- [ ] T074 [US9] Store multiple vault paths in electron-store in src/main/vault/index.ts
- [ ] T075 [US9] Implement SWITCH and GET_ALL vault IPC handlers in src/main/ipc/vault-handlers.ts
- [ ] T076 [US9] Update use-vault.ts with multi-vault support in src/renderer/src/hooks/use-vault.ts
- [ ] T077 [US10] Add exclude patterns to VaultConfig and watcher configuration in src/main/vault/watcher.ts
- [ ] T078 [US10] Implement UPDATE_CONFIG IPC handler for exclusion patterns in src/main/ipc/vault-handlers.ts
- [ ] T079 [US10] Skip excluded files during initial indexing in src/main/vault/indexer.ts

**Checkpoint**: US9+US10 complete - multiple vaults can be managed, and folders can be excluded from indexing

---

## Phase 9: Tasks Database Integration

**Goal**: Connect existing tasks UI to real SQLite database via Drizzle ORM

**Purpose**: Enable persistence of tasks, projects, and statuses that currently exist only in React Context

### Implementation for Tasks Database

- [ ] T080 [P] Create task query functions in src/shared/db/queries/tasks.ts
- [ ] T081 [P] Create project query functions in src/shared/db/queries/projects.ts
- [ ] T082 Implement tasks IPC handlers (full CRUD per tasks-api.ts) in src/main/ipc/tasks-handlers.ts
- [ ] T083 Update preload script with tasks API in src/preload/index.ts
- [ ] T084 Create tasks-service.ts client in src/renderer/src/services/tasks-service.ts
- [ ] T085 Update TasksProvider to use tasks-service instead of local state in src/renderer/src/contexts/tasks/
- [ ] T086 Seed default inbox project on first vault open in src/main/database/seed.ts
- [ ] T087 Register tasks handlers in main process in src/main/ipc/index.ts

**Checkpoint**: Tasks UI is connected to real database, data persists between sessions

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Final improvements and cleanup

- [ ] T088 Add graceful shutdown: close database and watcher on app quit in src/main/index.ts
- [ ] T089 Add input validation with Zod at all IPC boundaries in src/main/ipc/validate.ts
- [ ] T090 Configure WAL mode and foreign keys for both databases in src/main/database/client.ts
- [ ] T091 Add timeout handling for long-running database operations in src/main/database/client.ts
- [ ] T092 Run quickstart.md validation steps to verify setup
- [ ] T093 Update CLAUDE.md with new database commands and architecture notes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-8)**: All depend on Foundational phase completion
  - User stories can proceed in priority order (P1 → P2 → P3)
  - Within P1: US1 → US2/US3 (parallel) → US4
- **Tasks Integration (Phase 9)**: Can proceed after Foundational (independent of notes stories)
- **Polish (Phase 10)**: Depends on all desired user stories being complete

### User Story Dependencies

```
Foundational (Phase 2)
├── US1 (Store Notes) ──────────┬── US2 (External Changes)
│                               └── US3 (Rename Tracking)
│                                          │
└── US4 (Fast Search) ◄────────────────────┘
         │
         ├── US7+US8 (Progress/Recovery)
         │
         └── US9+US10 (Multi-Vault/Exclusions)
```

- **US1**: Can start after Foundational - No dependencies on other stories
- **US2**: Depends on US1 (file operations module)
- **US3**: Depends on US1 (frontmatter with UUID)
- **US4**: Depends on US1 (note cache for FTS), can start after US1
- **US7+US8**: Can start after US4 (indexer infrastructure)
- **US9+US10**: Can start after Foundational, mostly independent

### Parallel Opportunities

**Within Phase 1 (Setup)**:
- T003, T004, T005 can run in parallel (different config files)

**Within Phase 2 (Foundational)**:
- T009-T015 (7 schema files) can ALL run in parallel
- T022-T024 (3 utility files) can ALL run in parallel

**Within Phase 3 (US1)**:
- After T037-T038 complete, remaining tasks are sequential

**Within Phase 4-6 (US2-US4)**:
- These phases are mostly sequential within themselves

**Across Stories (with team)**:
- Tasks Integration (Phase 9) is independent of notes user stories
- Can work on Phase 9 in parallel with Phase 3-8 if needed

---

## Parallel Example: Foundational Schemas

```bash
# Launch all 7 schema files in parallel:
Task: "[P] Create projects schema in src/shared/db/schema/projects.ts"
Task: "[P] Create statuses schema in src/shared/db/schema/statuses.ts"
Task: "[P] Create tasks schema in src/shared/db/schema/tasks.ts"
Task: "[P] Create task-relations schema in src/shared/db/schema/task-relations.ts"
Task: "[P] Create inbox schema in src/shared/db/schema/inbox.ts"
Task: "[P] Create settings schema in src/shared/db/schema/settings.ts"
Task: "[P] Create notes-cache schema in src/shared/db/schema/notes-cache.ts"
```

---

## Implementation Strategy

### MVP First (Setup + Foundational + US1)

1. Complete Phase 1: Setup (dependencies, config)
2. Complete Phase 2: Foundational (schemas, database, vault selection)
3. Complete Phase 3: User Story 1 (note CRUD as markdown)
4. **STOP and VALIDATE**: Create a note, check it's readable in external editor
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Vault opens, database ready
2. Add US1 → Notes work as portable markdown (MVP!)
3. Add US2 → External changes detected
4. Add US3 → Renames tracked by UUID
5. Add US4 → Fast search works
6. Add US7+US8 → Progress indicators, auto-recovery
7. Add US9+US10 → Multiple vaults, exclusions
8. Add Tasks Integration → Tasks persist to database
9. Each story adds value without breaking previous stories

### Recommended MVP Scope

**Minimum Viable Product**: Setup + Foundational + US1

This delivers:
- Users can select a vault folder
- Users can create, edit, delete notes
- Notes are plain markdown files with YAML frontmatter
- Notes are readable/editable in any text editor
- Vault location is remembered between sessions

**Enhanced MVP**: Add US2 + US4 (external changes + search)

This adds:
- Real-time detection of external edits
- Fast full-text search across notes

---

## Summary

| Phase | Task Count | Parallel Tasks |
|-------|------------|----------------|
| Setup | 8 | 3 |
| Foundational | 28 | 10 |
| US1 (Markdown) | 12 | 0 |
| US2 (External) | 6 | 0 |
| US3 (Renames) | 5 | 0 |
| US4 (Search) | 8 | 0 |
| US7+US8 (Progress/Recovery) | 6 | 0 |
| US9+US10 (Multi-Vault) | 6 | 0 |
| Tasks Integration | 8 | 2 |
| Polish | 6 | 0 |
| **Total** | **93** | **15** |

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
- All schemas use Drizzle ORM patterns from research.md
- File operations use atomic write pattern from research.md
- File watching uses chokidar v4 patterns from research.md
