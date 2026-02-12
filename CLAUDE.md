# CLAUDE.md

Guidelines for AI coding agents working in the Memry codebase.

## Memry is still in maintenance and not in production. When making code changes, avoid writing code for backward compatibility.

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
pnpm db:push              # Push schema to DBs (dev only)
pnpm db:studio:data       # Open Drizzle Studio for data.db

# Build
pnpm build:mac            # Build for macOS
pnpm rebuild              # Rebuild native modules (better-sqlite3)
```

## Architecture Overview

Electron app with 3 process layers:

- **Main** (`src/main/`): Node.js - file system, SQLite, IPC handlers
- **Preload** (`src/preload/`): Secure bridge exposing `window.api`
- **Renderer** (`src/renderer/`): React 19 app, no Node.js access

Two SQLite databases:

- `data.db`: Source of truth (tasks, projects, settings)
- `index.db`: Rebuildable cache (note search, FTS)

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
// Standard pattern: explicit props interface + function component
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

## Error Handling

### Main Process

Use custom error classes with error codes:

```typescript
import { NoteError, NoteErrorCode } from '../lib/errors'
throw new NoteError('Note not found', NoteErrorCode.NOT_FOUND, noteId)
```

### IPC Boundary

All handlers use Zod validation:

```typescript
ipcMain.handle(
  'notes:create',
  createValidatedHandler(NoteCreateSchema, async (input) => {
    return notesService.create(input)
  })
)
```

### Renderer

- Use ErrorBoundary for major UI sections
- Services return `{ success, error }` pattern

## Testing

### Structure

Tests are **co-located** with source files:

```
src/main/vault/notes.ts
src/main/vault/notes.test.ts  # Co-located test
```

### Running Single Tests

```bash
pnpm vitest src/main/vault/notes.test.ts        # Single file
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
// Mock Electron APIs
vi.mock('electron')

// Mock window.api for renderer tests
window.api = { notes: { list: vi.fn().mockResolvedValue([]) } }

// Spy on internal services
vi.spyOn(notesService, 'create').mockResolvedValue({ success: true })
```

## IPC Communication Pattern

1. **Define contract** in `src/shared/contracts/<domain>-api.ts`:

   ```typescript
   export const NoteCreateSchema = z.object({
     title: z.string().min(1),
     content: z.string().optional()
   })
   ```

2. **Register handler** in `src/main/ipc/<domain>-handlers.ts`:

   ```typescript
   ipcMain.handle(
     'notes:create',
     createValidatedHandler(NoteCreateSchema, async (input) => {
       return createNote(input)
     })
   )
   ```

3. **Expose in preload** (`src/preload/index.ts`)

4. **Create service** in `src/renderer/src/services/<domain>-service.ts`

5. **Create hook** in `src/renderer/src/hooks/use-<domain>.ts`

## Key Patterns to Follow

### Tab System

VS Code-style tabs with split view. Singleton tabs (inbox, journal) only allow one instance.

### Drag & Drop

Uses @dnd-kit. Global `DragProvider` context handles all drag operations.

### State Management

React Context for global state:

- `TabProvider` - tab/split view state
- `TasksProvider` - tasks and projects
- `DragProvider` - drag-drop context

### File Operations

Always use atomic writes via `src/main/vault/file-ops.ts`.

## Don'ts

- **Never** suppress TypeScript errors with `as any` or `@ts-ignore`
- **Never** use empty catch blocks `catch(e) {}`
- **Never** commit without explicit user request
- **Never** delete failing tests to make builds pass
- **Never** hardcode file paths - use path utilities
- **Never** access Node.js APIs from renderer process
