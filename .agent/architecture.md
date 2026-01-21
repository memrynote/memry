# Architecture

## Electron Process Model

```
┌─────────────────────────────────────────────────────────────┐
│ Main Process (src/main/)                                    │
│ - Node.js environment                                       │
│ - App lifecycle, window creation, native APIs               │
│ - SQLite databases (Drizzle ORM)                           │
│ - File system operations                                    │
└─────────────────────────────────────────────────────────────┘
                          │ IPC
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Preload (src/preload/)                                      │
│ - Secure bridge: exposes window.api and window.electron     │
│ - Types: src/preload/index.d.ts                            │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Renderer (src/renderer/)                                    │
│ - React 19 app                                              │
│ - NO direct Node.js access                                  │
│ - Uses window.api for all IPC                              │
└─────────────────────────────────────────────────────────────┘
```

## State Management

React Context for global state:

| Provider | Location | Purpose |
|----------|----------|---------|
| TabProvider | `contexts/tabs/` | VS Code-style tabs, split view, persistence |
| TasksProvider | `contexts/tasks/` | Tasks and projects |
| DragProvider | `contexts/drag-context.tsx` | @dnd-kit drag-drop handling |

## Vault System

User-selected folder containing all data:

```
MyVault/
├── notes/
├── journal/
├── attachments/
└── .memry/
    ├── data.db      # Source of truth (tasks, projects)
    ├── index.db     # Rebuildable cache (note search, FTS)
    └── config.json
```

See `docs/vault-architecture.md` for full details.

## Key Patterns

**Singleton Tabs**: inbox, journal, tasks views only allow one instance.

**File Operations**: Always use atomic writes via `src/main/vault/file-ops.ts`.

**Notes**: File-first architecture. Markdown files are source of truth; index.db is a rebuildable cache for search.
