# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Memry is in **active development / maintenance** — not yet in production. This means:

- **No backward-compatibility burden on DB schema.** Tables, columns, and migrations can be freely added, renamed, or dropped. The app and databases can be recreated from scratch at any time. Don't waste effort writing data-migration shims or preserving deprecated columns.
- **No backward-compatibility burden on code.** Interfaces, services, IPC contracts, and types can change freely. Don't add re-exports, deprecated wrappers, or compatibility layers — just change the code directly and update all call sites.
- **Same applies to sync server schema** (`sync-server/schema/d1.sql`). D1 can be wiped and re-seeded.

## Quick Reference

```bash
# Development
pnpm dev                  # Start dev server (auto-rebuilds native modules)
pnpm lint                 # ESLint with cache
pnpm format               # Prettier format all files
pnpm typecheck            # Check all TypeScript (main + renderer)

# Testing
pnpm test                 # Run all tests once
pnpm vitest <path>        # Run SINGLE test file (e.g., pnpm vitest src/main/vault/notes.test.ts)
pnpm test:watch           # Watch mode
pnpm test:main            # Main process tests only
pnpm test:renderer        # Renderer process tests only
pnpm test:e2e             # Playwright E2E tests

# Database
pnpm db:generate          # Generate migrations (both DBs)
pnpm db:generate:data     # Data.db only
pnpm db:generate:index    # Index.db only
pnpm db:push              # Push schema to DBs (dev only)
pnpm db:studio:data       # Open Drizzle Studio for data.db
pnpm db:studio:index      # Open Drizzle Studio for index.db

# Build
pnpm build:mac            # Build for macOS
pnpm rebuild              # Rebuild native modules (better-sqlite3)
```

## Architecture Overview

Electron app with 3 process layers:

- **Main** (`src/main/`): Node.js — file system, SQLite, IPC handlers
- **Preload** (`src/preload/`): Secure bridge exposing `window.api`
- **Renderer** (`src/renderer/`): React 19 app, no Node.js access

### Two SQLite Databases (Drizzle ORM)

| Database   | Config                    | Purpose                                           | FK enforcement                |
| ---------- | ------------------------- | ------------------------------------------------- | ----------------------------- |
| `data.db`  | `drizzle-data.config.ts`  | Source of truth (tasks, projects, settings, sync) | Yes (CASCADE/SET NULL)        |
| `index.db` | `drizzle-index.config.ts` | Rebuildable cache (note search, FTS, embeddings)  | No (safe to delete & rebuild) |

Schemas live in `src/shared/db/schema/`. Migrations in `src/main/database/drizzle-data/` and `drizzle-index/`. Both run automatically on app startup.

**Schema changes:** Edit schema files → `pnpm db:generate` → `pnpm db:push`. No need for backward-compatible migrations (see Project Status above).

## Code Style

### Formatting (Prettier)

```yaml
singleQuote: true
semi: false
printWidth: 100
trailingComma: none
```

### TypeScript

- Strict mode enabled
- **NEVER** use `as any`, `@ts-ignore`, `@ts-expect-error`
- Define interfaces for props: `interface MyComponentProps { ... }`
- Use Zod schemas for runtime validation at IPC boundaries

### React Components

```tsx
export interface TaskItemProps {
  id: string
  onComplete: (id: string) => void
}

export function TaskItem({ id, onComplete }: TaskItemProps) {
  const handleComplete = useCallback(() => onComplete(id), [id, onComplete])
  return <div onClick={handleComplete}>{id}</div>
}

// Performance-critical: use memo
export const ContentArea = memo(function ContentArea({ ... }: ContentAreaProps) { ... })
```

### Import Order

1. React & hooks: `import { useState } from 'react'`
2. External libs: `import { z } from 'zod'`
3. Path aliases: `@/lib`, `@/components`, `@/hooks`
4. Shared: `@shared/contracts`, `@shared/db`
5. Local: `./types`, `./utils`

### Naming Conventions

| Type         | Convention        | Example                                 |
| ------------ | ----------------- | --------------------------------------- |
| Files        | kebab-case        | `task-section.tsx`, `vault-handlers.ts` |
| Components   | PascalCase        | `TaskItem`, `ContentArea`               |
| Handlers     | `handle` prefix   | `handleClick`, `handleKeyDown`          |
| Props        | `Props` suffix    | `TaskItemProps`                         |
| IPC channels | Namespaced object | `NotesChannels.invoke.CREATE`           |

### Path Aliases

```typescript
'@/'       → 'src/renderer/src/'
'@shared/' → 'src/shared/'
'@tests/'  → 'tests/'
```

## Logging

Use **electron-log** with scoped loggers everywhere. Never use raw `console.*`.

### Main Process

```typescript
import { createLogger } from '../lib/logger' // src/main/lib/logger.ts
const log = createLogger('Notes')

log.info('note created', { id })
log.error('failed to save', error)
```

Config: 5MB file rotation, format `{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] [{scope}] {text}`. Dev=debug, Prod=warn console threshold. Uncaught errors auto-caught via `log.errorHandler.startCatching()`.

### Renderer Process

```typescript
import { createLogger } from '@/lib/logger' // src/renderer/src/lib/logger.ts
const log = createLogger('EditorComponent')
```

Renderer loggers proxy back to the main process via IPC (`electron-log/renderer`), so all logs end up in the same file.

## Error Handling

### Main Process — Custom Error Classes

Domain-specific errors in `src/main/lib/errors.ts`:

```typescript
throw new NoteError('Note not found', NoteErrorCode.NOT_FOUND, noteId)
throw new VaultError('Path invalid', VaultErrorCode.INVALID_PATH)
throw new DatabaseError('Query failed', DatabaseErrorCode.QUERY)
```

Type guards available: `isNoteError()`, `isVaultError()`, `isDatabaseError()`, `isWatcherError()`.

Sync-specific errors in `src/main/sync/http-client.ts`:

```typescript
throw new SyncServerError('Unauthorized', 401)
throw new NetworkError('Unable to connect to sync server...')
throw new RateLimitError(retryAfterSeconds)
```

### IPC Boundary — Validated Handlers

All IPC handlers go through `src/main/ipc/validate.ts`:

```typescript
// createValidatedHandler: Zod-validates input, catches + logs errors, re-throws clean message
ipcMain.handle(
  'notes:create',
  createValidatedHandler(NoteCreateSchema, async (input) => notesService.create(input))
)

// createHandler: no-input wrapper (same error handling)
// withErrorHandling: returns { success, error } instead of throwing
```

The handler catches errors, logs via `ipcLog.error()`, and re-throws with just the message — stripping internal stack details before they cross the IPC bridge.

### Renderer — extractErrorMessage (User-Facing Errors)

**Always use `extractErrorMessage`** when displaying errors to users. Electron wraps IPC errors in nested prefixes like `"Error occurred in handler for 'sync:auth': Error: Invalid OTP"` — this utility strips all that noise:

```typescript
import { extractErrorMessage } from '@/lib/ipc-error'

try {
  await window.api.notes.create(data)
} catch (err) {
  const message = extractErrorMessage(err, 'Failed to create note')
  toast.error(message) // Shows "Invalid OTP" not the full wrapped string
}
```

The `fallback` parameter (2nd arg) is shown when the error is empty or unrecognizable. Always provide a meaningful fallback.

### Renderer — Error Boundaries

Three specialized boundaries exist for crash recovery:

- `TabErrorBoundary` — generic "Something went wrong" + retry
- `EditorErrorBoundary` — warns about unsaved changes, expandable details
- `JournalErrorBoundary` — recovers pending content, copy-to-clipboard

All log crashes via `createLogger` and accept an `onError` callback (for future Sentry wiring).

## Testing

### Structure

Tests are **co-located** with source files:

```
src/main/vault/notes.ts
src/main/vault/notes.test.ts
```

### Running Single Tests

```bash
pnpm vitest src/main/vault/notes.test.ts                     # Single file
pnpm vitest src/main/vault/notes.test.ts -t "should create"  # Single test
```

### Test Utilities

```typescript
// Main process: in-memory database
import { createTestDataDb } from '@tests/utils/test-db'
const db = createTestDataDb()

// Renderer: wrapped rendering with providers
import { renderWithProviders, configureMockApi } from '@tests/utils/render'
configureMockApi({ 'notes.list': mockNotes })
renderWithProviders(<NotesList />)
```

### Mocking Patterns

```typescript
vi.mock('electron')
window.api = { notes: { list: vi.fn().mockResolvedValue([]) } }
vi.spyOn(notesService, 'create').mockResolvedValue({ success: true })
```

## IPC Communication Pattern

Full pipeline for new IPC channels:

1. **Contract** in `src/shared/contracts/<domain>-api.ts` (Zod schema)
2. **Handler** in `src/main/ipc/<domain>-handlers.ts` (via `createValidatedHandler`)
3. **Preload bridge** in `src/preload/index.ts`
4. **Service** in `src/renderer/src/services/<domain>-service.ts`
5. **Hook** in `src/renderer/src/hooks/use-<domain>.ts`

## Key Patterns

### Tab System

VS Code-style tabs with split view. Singleton tabs (inbox, journal) only allow one instance.

### Drag & Drop

Uses @dnd-kit. Global `DragProvider` context handles all drag operations.

### State Management

React Context for global state:

- `TabProvider` — tab/split view state
- `TasksProvider` — tasks and projects
- `DragProvider` — drag-drop context

### File Operations

Always use atomic writes via `src/main/vault/file-ops.ts`.

## Don'ts

- **Never** use `console.*` — use `createLogger('Scope')` from electron-log
- **Never** show raw IPC errors to users — use `extractErrorMessage(err, fallback)`
- **Never** suppress TypeScript errors with `as any` or `@ts-ignore`
- **Never** use empty catch blocks `catch(e) {}`
- **Never** commit without explicit user request
- **Never** delete failing tests to make builds pass
- **Never** hardcode file paths — use path utilities
- **Never** access Node.js APIs from renderer process
- **Never** write backward-compat migration shims or deprecated wrappers (pre-production app)
