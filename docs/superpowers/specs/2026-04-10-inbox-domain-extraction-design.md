# Inbox Domain Extraction Design

**Goal:** Reintroduce `packages/domain-inbox` as a real inbox boundary without repeating the earlier failed extraction that bundled Electron, filesystem, and background-job concerns into the package.

**Why now:** Current `main` still keeps inbox orchestration in IPC handlers. That makes the architecture checklist inaccurate, increases worktree merge risk, and keeps inbox unlike the task-domain shape that already exists.

## Constraints

- Preserve the current renderer-facing IPC/API surface.
- Keep the first pass compatible with the current inbox database schema and helper modules.
- Do not move Electron, timers, filesystem, metadata scraping, transcription execution, sync dispatch, or projection publishing into the package.
- Cross-domain actions such as convert-to-note, convert-to-task, and link-to-note stay adapter-driven in desktop code.

## Boundary

### `packages/domain-inbox`

Owns:

- Canonical inbox types
- Command/query interfaces
- Capture decision rules
- Duplicate handling rules
- Filing validation rules
- Retry validation rules
- Snooze/archive/update validation

Does not own:

- `ipcMain`
- `BrowserWindow`
- `sharp`
- attachment storage
- metadata fetches
- transcription execution
- timers/schedulers
- sync enqueueing
- projection publishing
- Drizzle queries directly

### `apps/desktop/src/main/inbox/*`

Owns:

- repository and persistence wiring
- Electron event emission
- attachment and file operations
- metadata and transcription execution
- background job scheduling
- sync/projection side effects
- composition of domain services with desktop adapters

### `apps/desktop/src/main/ipc/*`

Owns only:

- input validation
- IPC registration/unregistration
- dispatch to the inbox domain surface

## Cross-Domain Actions

The domain decides whether an inbox action is valid and what action should happen. Desktop adapters execute the action.

Examples:

- `file -> folder`
- `convert -> note`
- `convert -> task`
- `link -> note(s)`

The domain package should not import notes/tasks modules directly.

## Incremental Landing Plan

1. Restore `packages/domain-inbox` with the pure command/query surface and tests.
2. Restore `apps/desktop/src/main/inbox/domain.ts` as the desktop composition layer.
3. Move capture, filing, retry, snooze, and suggestion orchestration out of `ipc/inbox-handlers.ts`.
4. Move CRUD and batch orchestration behind the same desktop composition layer.
5. Move query composition behind the same domain surface without changing renderer contracts.
6. Update the architecture checklist only after the code actually matches the target boundary.

## Non-Goals For This Pass

- Event-sourcing inbox
- changing renderer query keys or hooks
- redesigning inbox jobs
- changing the current DB schema

## Success Criteria

- `packages/domain-inbox` exists and is imported by desktop code
- `apps/desktop/src/main/ipc/inbox-handlers.ts` becomes transport/validation only
- inbox capture/retry/filing flows no longer keep business orchestration inline in IPC
- the package boundary is small enough that a future revert is not necessary
