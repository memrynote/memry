# Implementation Plan: Journal System

**Branch**: `004-journal-system` | **Date**: 2025-12-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-journal-system/spec.md`
**Backend Plan Input**: User-provided technology decisions and architecture

## Summary

Implement a journaling system with date-based daily entries, calendar heatmap navigation, auto-save, focus mode, and day context sidebar. The system builds on existing infrastructure from 003-notes (BlockNote editor, file watcher, SQLite cache) while adding journal-specific features like date-based file naming (`YYYY-MM-DD.md`), heatmap activity tracking, and task integration.

**Key Technical Approach**: Reuse BlockNote editor from notes, store entries as markdown files in `vault/journal/`, cache metadata in SQLite `index.db` for fast heatmap queries, and integrate with existing task system for day context.

## Technical Context

**Language/Version**: TypeScript 5.9+ (strict mode), Node.js 20+, React 19
**Primary Dependencies**:

- Electron 28+ with electron-vite
- BlockNote (rich text editor - reuse from notes)
- Drizzle ORM with better-sqlite3
- chokidar (file watching - already monitoring journal folder)
- gray-matter (frontmatter parsing)
- Zod (runtime validation)
- date-fns (date utilities)

**Storage**:

- **Files**: Markdown with YAML frontmatter in `vault/journal/YYYY-MM-DD.md` (source of truth)
- **index.db**: SQLite cache for metadata, heatmap data, FTS5 search (rebuildable)
- **data.db**: SQLite for tasks/projects (existing, for day context queries)

**Testing**: Vitest for unit/integration, Playwright for E2E
**Target Platform**: macOS, Windows, Linux (Electron desktop)
**Project Type**: Electron (main + renderer processes with IPC bridge)

**Performance Goals**:

- Day navigation: <100ms perceived response
- Heatmap render (365 days): <50ms
- Auto-save: No UI stutter during typing
- Focus mode toggle: Instant
- Index rebuild (2000 entries): <2s

**Constraints**:

- Offline-first (no network dependency)
- File system as source of truth for entries
- Zero data loss on crash (atomic writes)
- External edit detection via existing file watcher

**Scale/Scope**: Years of daily entries (~3650 entries for 10 years), 10,000+ words per entry supported

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                              | Status                | Evidence                                                                                                         |
| -------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **I. Local-First Architecture**        | PASS                  | Journal entries stored as plain markdown files in vault folder; works fully offline; editable in any text editor |
| **II. End-to-End Encryption**          | N/A                   | Phase 004 is local-only; encryption applies to future sync phase                                                 |
| **III. No Vendor Lock-In**             | PASS                  | Standard markdown format; YAML frontmatter is universal; date-based naming is portable                           |
| **IV. Privacy by Design**              | PASS                  | No telemetry; all data local; no network calls                                                                   |
| **V. Offline-First**                   | PASS                  | All journal operations work without internet                                                                     |
| **VI. File System as Source of Truth** | PASS                  | Markdown files authoritative; SQLite journalCache is rebuildable                                                 |
| **VII. Database for Structured Data**  | PASS                  | Tasks/projects in SQLite data.db; journal entries in files                                                       |
| **VIII. External Edit Detection**      | PASS                  | chokidar file watcher already monitors journal folder                                                            |
| **IX. Rename Tracking**                | N/A                   | Journal files use date-based naming (not renamed)                                                                |
| **X. Single Source of Truth**          | PASS                  | Files = authoritative; cache = derived; heatmap = derived                                                        |
| **Type Safety**                        | PASS                  | Strict TypeScript; Zod validation at IPC boundaries                                                              |
| **Performance**                        | REQUIRES VERIFICATION | Targets set; implementation must meet                                                                            |
| **Accessibility**                      | REQUIRES VERIFICATION | Focus mode keyboard shortcuts; ARIA labels needed                                                                |
| **Error Handling**                     | PASS                  | Atomic writes; graceful degradation; auto-save recovery                                                          |
| **Defensive Coding**                   | PASS                  | Zod validation; date format validation; path sanitization                                                        |

**Gate Result**: PASS (no violations; 2 items require implementation attention)

## Project Structure

### Documentation (this feature)

```text
specs/004-journal-system/
├── plan.md              # This file
├── research.md          # Phase 0 output - tech decisions
├── data-model.md        # Phase 1 output - entity schemas
├── quickstart.md        # Phase 1 output - developer guide
├── contracts/           # Phase 1 output - API contracts
│   └── journal-api.ts   # Journal IPC API definitions
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
# Electron application structure
src/
├── main/                       # Main process (Node.js)
│   ├── index.ts                # App entry, handler registration
│   ├── vault/
│   │   ├── journal.ts          # Journal file operations (NEW)
│   │   ├── watcher.ts          # File watching (already monitors journal/)
│   │   ├── file-ops.ts         # Atomic writes (reuse)
│   │   └── frontmatter.ts      # YAML parsing (reuse)
│   ├── ipc/
│   │   ├── index.ts            # Handler registration
│   │   ├── journal-handlers.ts # Journal IPC handlers (NEW)
│   │   └── validate.ts         # Zod validation middleware
│   └── database/
│       ├── client.ts           # Drizzle client instances
│       └── drizzle-index/      # index.db migrations
│
├── shared/                     # Shared between processes
│   ├── contracts/
│   │   └── journal-api.ts      # Journal types (NEW - in specs/004 for now)
│   └── db/
│       ├── schema/
│       │   ├── journal-cache.ts # Journal cache schema (NEW)
│       │   └── index.ts         # Schema exports
│       └── queries/
│           └── journal.ts       # Journal query functions (NEW)
│
├── renderer/src/               # Renderer process (React)
│   ├── components/journal/     # Journal UI components (EXISTING - 100% complete)
│   │   ├── calendar-heatmap.tsx
│   │   ├── date-breadcrumb.tsx
│   │   ├── journal-month-view.tsx
│   │   ├── journal-year-view.tsx
│   │   ├── day-context-sidebar.tsx
│   │   ├── ai-connections-panel.tsx
│   │   └── ...
│   ├── services/
│   │   └── journal-service.ts  # Journal IPC client (NEW)
│   ├── hooks/
│   │   └── use-journal.ts      # Journal state hook (NEW)
│   └── pages/
│       └── journal.tsx         # Journal page (EXISTING - uses demo data)
│
└── preload/
    ├── index.ts                # Bridge API (add journal methods)
    └── index.d.ts              # Type declarations (add journal types)
```

**Structure Decision**: Electron application with main/renderer/shared/preload structure. UI components are 100% complete with demo data. Backend infrastructure (file ops, cache, IPC) needs implementation. Reuse patterns from 003-notes for consistency.

## Complexity Tracking

> No violations requiring justification. The architecture follows constitution principles.

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| _None_    | _N/A_      | _N/A_                                |

## Implementation Phases

### Phase 0: Research (Complete)

- Technology decisions documented in research.md
- Existing codebase patterns analyzed
- No NEEDS CLARIFICATION items

### Phase 1: Design (Complete)

- Data model documented in data-model.md
- API contracts in contracts/journal-api.ts
- Developer quickstart in quickstart.md

### Phase 2: Tasks

- Generated by `/speckit.tasks` command
- Ordered by priority and dependencies
- Estimated 15-20 tasks across P1/P2/P3 features

## Dependencies

All dependencies are already installed from previous phases:

```json
{
  "dependencies": {
    "@blocknote/core": "^0.44.2",
    "@blocknote/react": "^0.44.2",
    "@blocknote/shadcn": "^0.44.2",
    "drizzle-orm": "^0.38.3",
    "better-sqlite3": "^11.7.0",
    "chokidar": "^4.0.3",
    "gray-matter": "^4.0.3",
    "date-fns": "^4.x",
    "zod": "^3.24.0",
    "use-debounce": "^10.0.0"
  }
}
```

## Risk Assessment

| Risk                                    | Likelihood | Impact | Mitigation                                         |
| --------------------------------------- | ---------- | ------ | -------------------------------------------------- |
| Heatmap performance with years of data  | Low        | Medium | Pre-compute activity levels; batch queries         |
| Auto-save during rapid navigation       | Medium     | Low    | Cancel pending saves on date change                |
| Focus mode sidebar state sync           | Low        | Low    | Store sidebar state before hiding; restore on exit |
| Large entry performance                 | Low        | Medium | BlockNote handles large docs; lazy load backlinks  |
| Date edge cases (leap years, timezones) | Low        | Medium | Use date-fns for parsing; store as ISO strings     |

## Implementation Timeline

Based on the user's backend implementation plan:

| Phase                          | Duration | Tasks                                              |
| ------------------------------ | -------- | -------------------------------------------------- |
| **Journal Backend (Week 5-6)** | 2 weeks  | Entry CRUD, calendar queries, heatmap, day context |
| **Journal Integration**        | 1 week   | Connect UI to real data, remove demo data          |
| **Polish & Edge Cases**        | 1 week   | Error handling, performance tuning, accessibility  |

Total: ~4 weeks for P1 features, +2 weeks for P2 features.

## Related Specifications

- **001-core-data-layer**: Provides vault management, database client, file watching
- **003-notes**: Provides BlockNote editor, frontmatter parsing, backlinks pattern
- **006-ai** (future): Will provide semantic search for AI connections panel
