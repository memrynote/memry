# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Memry is an Electron desktop application for personal knowledge management (PKM), combining task management, journaling, and note-taking. Built with React 19, TypeScript, and shadcn/ui components, it uses electron-vite for build tooling and features a VS Code-style tab system with split view support.

## Common Commands

```bash
pnpm dev              # Start development server with hot reload
pnpm start            # Preview production build
pnpm typecheck        # Check all TypeScript types (main + renderer)
pnpm typecheck:node   # Check main process types only
pnpm typecheck:web    # Check renderer process types only
pnpm lint             # Run ESLint with cache
pnpm format           # Format all files with Prettier
pnpm build:mac        # Build for macOS
pnpm build:win        # Build for Windows
pnpm build:linux      # Build for Linux
```

## Architecture

### Electron Process Model

- **Main Process** (`src/main/index.ts`): Node.js environment managing app lifecycle, window creation, and native APIs. Window controls (minimize/maximize/close) are handled via IPC.

- **Preload Script** (`src/preload/index.ts`): Secure bridge exposing `window.api` and `window.electron` to renderer. Add new IPC handlers here and update types in `src/preload/index.d.ts`.

- **Renderer Process** (`src/renderer/`): React app with no direct Node.js access. Uses custom traffic lights on macOS (native ones hidden).

### Frontend State Management

The app uses React Context for state management with several key providers:

- **TabProvider** (`contexts/tabs/`): VS Code-style tab system with split view support, tab persistence, pinning, and preview mode. Supports singleton tabs (only one instance allowed) for views like inbox, journal, tasks.

- **TasksProvider** (`contexts/tasks/`): Centralized task and project state management.

- **DragProvider** (`contexts/drag-context.tsx`): Global drag-drop context using @dnd-kit for task reordering, moving tasks between projects, and sidebar project reordering.

- **AIAgentProvider** (`contexts/ai-agent-context.tsx`): AI assistant panel state.

### Tab System Architecture

The tab system (`contexts/tabs/`) mirrors VS Code behavior:
- **Types**: `TabType` defines content types (inbox, tasks, note, journal, project, etc.)
- **Split View**: Horizontal splits with resizable panes, layout stored as recursive tree structure
- **Persistence**: Tab state persisted to localStorage with migrations support
- **Singleton Tabs**: Certain tab types (inbox, journal, tasks) only allow one instance

### Page Structure

Pages in `src/renderer/src/pages/`:
- `inbox.tsx` - Inbox for quick capture
- `tasks.tsx` - Task management with multiple views (all, today, upcoming, completed) and kanban/calendar views
- `journal.tsx` - Daily journaling with date navigation
- `note.tsx` - Individual note editor

### Custom Hooks

Key hooks in `src/renderer/src/hooks/`:
- `use-tab-keyboard-shortcuts.ts` - Tab navigation shortcuts
- `use-chord-shortcuts.ts` - Multi-key shortcut combinations
- `use-drag-handlers.ts` - Unified drag-drop handling
- `use-task-order.ts` - Task ordering persistence
- `use-task-selection.ts` - Multi-select for bulk operations

### Component Organization

```
src/renderer/src/
├── components/
│   ├── ui/           # shadcn/ui components
│   ├── tabs/         # Tab bar, drag overlay, context menus
│   ├── tasks/        # Task components (kanban/, calendar/, filters/, completed/)
│   ├── keyboard/     # Keyboard shortcut components
│   └── split-view/   # Split view container
├── contexts/         # React contexts
├── hooks/            # Custom hooks
├── lib/              # Utilities (task-utils, fuzzy-search, natural-date-parser)
├── data/             # Sample data and type definitions
└── pages/            # Main page components
```

### Path Aliases

Both `@/` and `@renderer/` resolve to `src/renderer/src/`. Use `@/components`, `@/lib`, `@/hooks` for imports.

## Adding shadcn/ui Components

The project uses shadcn/ui with extended registries (configured in `components.json`):
- @alpine, @tailark, @magicui, @shadcn-form, @kokonutui, @diceui, @basecn, @animateui, @fancycomponents, @kibo-ui, @cult-ui

```bash
npx shadcn@latest add <component-name>
npx shadcn@latest add @magicui/<component-name>  # From specific registry
```

## IPC Communication Pattern

1. Define handler in `src/main/index.ts`:
```typescript
ipcMain.on('channel-name', (event, arg) => { /* handler */ })
```

2. Expose API in `src/preload/index.ts`:
```typescript
const api = {
  yourMethod: () => ipcRenderer.send('channel-name')
}
```

3. Update types in `src/preload/index.d.ts`

4. Use in renderer: `window.api.yourMethod()`

## Code Style Guidelines

- Use `const` arrow functions with type definitions
- Event handlers prefixed with `handle` (e.g., `handleClick`, `handleKeyDown`)
- Early returns for readability
- Tailwind classes for styling (no CSS files except for base styles)
- Accessibility attributes on interactive elements (tabindex, aria-label, keyboard handlers)

## Data Layer Architecture

### Vault System

The app uses a "vault" model where users select a folder to store all their data. See `docs/vault-architecture.md` for full details.

**Key concepts:**
- **Vault**: User-selected folder containing notes, journals, and `.memry/` hidden folder
- **data.db**: SQLite database for tasks/projects (source of truth)
- **index.db**: SQLite database for note cache/FTS (rebuildable from files)

**Vault folder structure:**
```
MyVault/
├── notes/
├── journal/
├── attachments/
└── .memry/
    ├── data.db
    ├── index.db
    └── config.json
```

### Database (Drizzle ORM + SQLite)

```bash
pnpm db:generate    # Generate migrations from schema changes
pnpm db:push        # Push schema to database (dev)
pnpm db:studio      # Open Drizzle Studio GUI
pnpm rebuild        # Rebuild native modules (better-sqlite3)
```

**Schema files**: `src/shared/db/schema/`
- `projects.ts`, `statuses.ts`, `tasks.ts`, `task-relations.ts`
- `inbox.ts`, `settings.ts`, `notes-cache.ts`

### IPC Communication (Modern Pattern)

For request/response operations, use `ipcMain.handle` + `ipcRenderer.invoke`:

1. Define handler in `src/main/ipc/<domain>-handlers.ts`:
```typescript
import { ipcMain } from 'electron'
import { createValidatedHandler } from './validate'
import { MySchema } from '@shared/contracts/my-api'

export function registerMyHandlers() {
  ipcMain.handle('my:action', createValidatedHandler(MySchema, async (input) => {
    return myService.doAction(input)
  }))
}
```

2. Register in `src/main/ipc/index.ts`
3. Expose in `src/preload/index.ts`
4. Add types in `src/preload/index.d.ts`
5. Create service in `src/renderer/src/services/`
6. Create hook in `src/renderer/src/hooks/`

### Path Aliases

- `@/` → `src/renderer/src/`
- `@shared/` → `src/shared/`
- `@renderer/` → `src/renderer/src/`

### Main Process Modules

```
src/main/
├── store.ts              # electron-store for vault persistence
├── vault/
│   ├── index.ts          # Vault manager (select, open, close)
│   ├── init.ts           # Folder structure creation
│   ├── watcher.ts        # chokidar file watcher
│   ├── notes.ts          # Note CRUD operations
│   ├── frontmatter.ts    # YAML frontmatter parsing
│   ├── file-ops.ts       # Atomic file operations
│   ├── rename-tracker.ts # UUID-based rename detection
│   └── indexer.ts        # Initial vault indexing
├── ipc/
│   ├── index.ts          # Handler registration
│   ├── validate.ts       # Zod validation middleware
│   ├── vault-handlers.ts # Vault IPC handlers
│   ├── notes-handlers.ts # Notes IPC handlers
│   ├── tasks-handlers.ts # Tasks IPC handlers
│   └── search-handlers.ts # Search IPC handlers
├── database/
│   ├── client.ts         # Drizzle ORM client with SQLite pragmas
│   ├── migrate.ts        # Migration runner
│   ├── fts.ts            # FTS5 full-text search
│   └── seed.ts           # Default data seeding
└── lib/
    ├── errors.ts         # Custom error classes
    ├── paths.ts          # Path utilities
    └── id.ts             # ID generation (nanoid)
```

## Documentation

- `docs/vault-architecture.md` - Full vault system documentation
- `docs/implementation-status.md` - What's implemented vs missing
- `specs/001-core-data-layer/` - Design documents and contracts

## Active Technologies
- TypeScript 5.9+ with strict mode
- Drizzle ORM with better-sqlite3
- electron-store for settings persistence
- Zod for runtime validation
- chokidar for file watching
- gray-matter for YAML frontmatter parsing
- nanoid for unique ID generation

## Database Configuration

### SQLite Pragmas

Both databases are configured with optimized SQLite pragmas in `src/main/database/client.ts`:

**data.db (source of truth for tasks/projects)**:
```typescript
journal_mode = WAL     // Better concurrency and crash recovery
foreign_keys = ON      // Referential integrity
synchronous = NORMAL   // Balance between safety and performance
busy_timeout = 5000    // Wait 5s for locks
cache_size = -64000    // 64MB cache
temp_store = MEMORY    // Temp tables in memory
```

**index.db (rebuildable cache for notes)**:
```typescript
journal_mode = WAL
synchronous = NORMAL
busy_timeout = 5000
cache_size = -128000   // 128MB cache for search
temp_store = MEMORY
// No foreign keys (it's a cache)
```

### Graceful Shutdown

The app performs graceful shutdown on quit (`src/main/index.ts`):
1. Prevents default quit behavior
2. Sets 5-second timeout for forced exit
3. Closes vault (stops file watcher, closes databases)
4. Exits cleanly

## Recent Changes
- 001-core-data-layer: Phase 10 complete (T088-T093)
  - Graceful shutdown with timeout mechanism
  - Full Zod validation at all IPC boundaries
  - SQLite pragma optimization for reliability and performance
  - Database operation timeout utility
  - Updated documentation
