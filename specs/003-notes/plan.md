# Implementation Plan: Notes System

**Branch**: `003-notes` | **Date**: 2025-12-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-notes/spec.md`

## Summary

Implement a rich-text notes system with wiki-style linking, backlinks, tags, custom properties, and auto-save. The system builds on existing 90% complete backend infrastructure (vault operations, IPC handlers, database schemas, file watcher) and requires primarily UI integration and content format finalization.

**Key Technical Approach**: Leverage existing Tiptap editor with wiki-link/tag extensions, store content as markdown files with YAML frontmatter (source of truth), cache metadata in SQLite index.db for fast queries, and use FTS5 for full-text search.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode), Node.js 20+, React 19
**Primary Dependencies**:
- Electron 28+ with electron-vite
- Tiptap (rich text editor with extensions)
- Drizzle ORM with better-sqlite3
- chokidar (file watching)
- gray-matter (frontmatter parsing)
- Zod (runtime validation)

**Storage**:
- **Files**: Markdown with YAML frontmatter in `vault/notes/` (source of truth)
- **index.db**: SQLite cache for metadata, tags, links, FTS5 (rebuildable)
- **data.db**: SQLite for tasks/projects (already exists, separate concern)

**Testing**: Vitest for unit/integration, Playwright for E2E
**Target Platform**: macOS, Windows, Linux (Electron desktop)
**Project Type**: Electron (main + renderer processes with IPC bridge)

**Performance Goals**:
- Note open to editable: <100ms
- Auto-save without UI stutter
- Search 10,000 notes: <50ms
- Wiki-link autocomplete: <100ms
- 50+ backlinks without blocking

**Constraints**:
- Offline-first (no network dependency)
- File system as source of truth for notes
- Zero data loss on crash
- External edit detection and sync

**Scale/Scope**: 10,000+ notes, 100KB+ individual notes, 50+ backlinks per note

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| **I. Local-First Architecture** | PASS | Notes stored as plain markdown files in vault folder; works fully offline; editable in any text editor |
| **II. End-to-End Encryption** | N/A | Phase 003 is local-only; encryption applies to future sync phase |
| **III. No Vendor Lock-In** | PASS | Standard markdown format; YAML frontmatter is universal; trivial export |
| **IV. Privacy by Design** | PASS | No telemetry; all data local; no network calls |
| **V. Offline-First** | PASS | All note operations work without internet |
| **VI. File System as Source of Truth** | PASS | Markdown files authoritative; SQLite is rebuildable cache only |
| **VII. Database for Structured Data** | PASS | Tasks/projects in SQLite; notes in files |
| **VIII. External Edit Detection** | PASS | chokidar file watcher already implemented; debounced 100ms |
| **IX. Rename Tracking** | PASS | UUID in frontmatter; rename-tracker.ts preserves identity |
| **X. Single Source of Truth** | PASS | Files = authoritative; cache = derived; FTS = derived |
| **Type Safety** | PASS | Strict TypeScript; Zod validation at IPC boundaries |
| **Performance** | REQUIRES VERIFICATION | Targets set; implementation must meet |
| **Accessibility** | REQUIRES IMPLEMENTATION | Editor needs keyboard nav, ARIA labels |
| **Error Handling** | PASS | NoteError classes; atomic writes; graceful degradation |
| **Defensive Coding** | PASS | Zod validation; path sanitization; timeouts |

**Gate Result**: PASS (no violations; 2 items require implementation attention)

## Project Structure

### Documentation (this feature)

```text
specs/003-notes/
├── plan.md              # This file
├── research.md          # Phase 0 output - tech decisions
├── data-model.md        # Phase 1 output - entity schemas
├── quickstart.md        # Phase 1 output - developer guide
├── contracts/           # Phase 1 output - API contracts
│   └── notes-api.yaml   # OpenAPI spec for notes operations
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
# Electron application structure (existing)
src/
├── main/                       # Main process (Node.js)
│   ├── index.ts                # App entry, handler registration
│   ├── vault/                  # Vault & file operations
│   │   ├── notes.ts            # Note CRUD (EXISTING - enhance)
│   │   ├── frontmatter.ts      # YAML parsing (EXISTING)
│   │   ├── file-ops.ts         # Atomic writes (EXISTING)
│   │   ├── watcher.ts          # File watching (EXISTING)
│   │   └── indexer.ts          # Initial indexing (EXISTING)
│   ├── ipc/                    # IPC handlers
│   │   ├── notes-handlers.ts   # Notes API (EXISTING - enhance)
│   │   └── search-handlers.ts  # FTS5 search (EXISTING)
│   └── database/               # Drizzle ORM
│       ├── client.ts           # DB initialization (EXISTING)
│       └── fts.ts              # FTS5 setup (EXISTING)
│
├── renderer/src/               # Renderer process (React)
│   ├── components/
│   │   ├── note/               # Note UI components (NEW/ENHANCE)
│   │   │   ├── note-editor.tsx         # Rich text editor
│   │   │   ├── note-properties.tsx     # Properties panel
│   │   │   ├── note-backlinks.tsx      # Backlinks panel
│   │   │   ├── note-outline.tsx        # Heading outline
│   │   │   └── note-header.tsx         # Title + emoji
│   │   ├── journal/
│   │   │   └── extensions/             # Tiptap extensions (EXISTING)
│   │   │       ├── wiki-link/          # [[Link]] syntax
│   │   │       └── tag/                # #tag syntax
│   │   └── notes-tree.tsx              # Folder tree (EXISTING)
│   ├── hooks/
│   │   ├── use-notes.ts                # Notes state (EXISTING - enhance)
│   │   └── use-note-editor.ts          # Editor state (NEW)
│   ├── services/
│   │   └── notes-service.ts            # IPC wrapper (EXISTING)
│   └── pages/
│       └── note.tsx                    # Note page (EXISTING - enhance)
│
├── shared/                     # Shared between processes
│   ├── contracts/              # Zod schemas
│   │   └── notes-api.ts        # Note types (EXISTING - enhance)
│   ├── db/
│   │   ├── schema/
│   │   │   └── notes-cache.ts  # Cache schema (EXISTING)
│   │   └── queries/
│   │       └── notes.ts        # Query functions (EXISTING)
│   └── ipc-channels.ts         # Channel names (EXISTING)
│
└── preload/
    ├── index.ts                # Bridge API (EXISTING)
    └── index.d.ts              # Type declarations (EXISTING)
```

**Structure Decision**: Electron application with main/renderer/shared/preload structure. Most infrastructure exists from Phase 001-002. This phase primarily adds UI components and enhances existing handlers.

## Complexity Tracking

> No violations requiring justification. The architecture follows constitution principles.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *None* | *N/A* | *N/A* |

## Implementation Phases

### Phase 0: Research (Complete)
- Technology decisions documented in research.md
- Existing codebase patterns analyzed
- No NEEDS CLARIFICATION items

### Phase 1: Design
- Data model documented in data-model.md
- API contracts in contracts/
- Developer quickstart in quickstart.md

### Phase 2: Tasks
- Generated by `/speckit.tasks` command
- Ordered by priority and dependencies
