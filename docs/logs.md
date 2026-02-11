# Logging, Metrics & Crash Reporting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add production-grade observability to Memry — structured logging, crash reporting, and IPC performance instrumentation — so we can diagnose issues, track errors, and understand performance in production.

**Architecture:** Three-layer approach: (1) `electron-log` as the centralized logger across main+renderer processes with file rotation, (2) Sentry for crash reporting + error tracking with PII scrubbing for privacy, (3) lightweight IPC instrumentation layer wrapping existing `createValidatedHandler` / `createHandler` / `withErrorHandling` to capture timing + error rates without touching every handler file.

**Tech Stack:** electron-log v5, @sentry/electron, existing Zod-validated IPC handlers

---

## Current State

- **256 console.* calls** across 34 files in `src/main/`
- **182 console.* calls** across 55 files in `src/renderer/`
- Manual `[Prefix]` namespacing (e.g. `[Indexer]`, `[IPC]`, `[Vault]`)
- Custom error classes: `VaultError`, `NoteError`, `DatabaseError`, `WatcherError` + sync errors
- 3 ErrorBoundary components (tab, editor, journal)
- IPC centralized through `createValidatedHandler`, `createHandler`, `createStringHandler`, `withErrorHandling` in `src/main/ipc/validate.ts`
- 16 handler modules registered via `src/main/ipc/index.ts`
- Zero logging libraries, zero crash reporting, zero metrics
- Pino was planned in spec 007 (T022-T027) but never started

## Decision: electron-log over Pino

The 007 spec proposed Pino, but `electron-log` is better for this use case:
- Native Electron support (main + renderer in one config)
- Auto file rotation + OS-appropriate log paths (`~/Library/Logs/Memry/`)
- Built-in console transport (dev) + file transport (prod)
- No custom transport wiring needed
- v5 has structured JSON support

We'll use Pino for the sync server (Cloudflare Workers) later — that's out of scope.

---

## Phase 1: Structured Logging (electron-log)

### Task 1: Install electron-log and create logger module

**Files:**
- Create: `src/main/lib/logger.ts`
- Create: `src/main/lib/logger.test.ts`
- Modify: `package.json` (add dependency)

**Step 1: Install electron-log**

```bash
pnpm add electron-log
```

**Step 2: Write the logger test**

```typescript
// src/main/lib/logger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron-log', () => {
  const createScope = vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
  return {
    default: {
      initialize: vi.fn(),
      transports: {
        file: { level: 'info', maxSize: 0, format: '' },
        console: { level: 'debug', format: '' }
      },
      errorHandler: { startCatching: vi.fn() },
      scope: createScope
    }
  }
})

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('should export createLogger that returns a scoped logger', async () => {
    const { createLogger } = await import('./logger')
    const log = createLogger('Vault')
    expect(log).toBeDefined()
    expect(typeof log.info).toBe('function')
    expect(typeof log.error).toBe('function')
    expect(typeof log.warn).toBe('function')
    expect(typeof log.debug).toBe('function')
  })

  it('should export a default log instance', async () => {
    const { log } = await import('./logger')
    expect(log).toBeDefined()
    expect(typeof log.info).toBe('function')
  })
})
```

**Step 3: Run the test — confirm it fails**

```bash
pnpm vitest src/main/lib/logger.test.ts
```

Expected: FAIL (module doesn't exist yet)

**Step 4: Create the logger module**

```typescript
// src/main/lib/logger.ts
import log from 'electron-log'

const isDev = process.env.NODE_ENV !== 'production'

log.transports.file.level = isDev ? 'debug' : 'info'
log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB per file
log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] [{scope}] {text}'

log.transports.console.level = isDev ? 'debug' : 'warn'
log.transports.console.format = '[{level}] [{scope}] {text}'

log.errorHandler.startCatching()

function createLogger(scope: string) {
  return log.scope(scope)
}

export { log, createLogger }
```

**Step 5: Run the test — confirm it passes**

```bash
pnpm vitest src/main/lib/logger.test.ts
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/main/lib/logger.ts src/main/lib/logger.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add electron-log logger module with scoped loggers"
```

---

### Task 2: Initialize logger in main process entry

**Files:**
- Modify: `src/main/index.ts` (~line 1-10 for import, ~line 105 for `createWindow`)

**Step 1: Add logger initialization at top of main entry**

At the top of `src/main/index.ts`, add the import and call `log.initialize()` which sets up renderer-side transport:

```typescript
import { log, createLogger } from './lib/logger'
log.initialize()
const mainLog = createLogger('Main')
```

**Step 2: Replace `console.log` / `console.error` calls in `src/main/index.ts`**

Replace the ~22 console.* calls with `mainLog.info()`, `mainLog.error()`, `mainLog.warn()` etc. Keep the same messages, just swap the call.

For example:
- `console.log('[IPC] ...', x)` → `mainLog.info('...', x)` (scope already provides namespace)
- `console.error('...')` → `mainLog.error('...')`

**Step 3: Verify the app still runs**

```bash
pnpm dev
```

Confirm: app starts, logs appear in console AND in `~/Library/Logs/memry/main.log`

**Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "refactor: replace console.* with scoped logger in main entry"
```

---

### Task 3: Replace console.* in IPC layer

**Files:**
- Modify: `src/main/ipc/validate.ts` (1 console.error)
- Modify: `src/main/ipc/index.ts` (3 console calls)

**Step 1: Update validate.ts**

Add `import { createLogger } from '../lib/logger'` and `const ipcLog = createLogger('IPC')`.
Replace `console.error('[IPC Handler]', error)` on line 43 with `ipcLog.error('Handler error:', error)`.

**Step 2: Update ipc/index.ts**

Add import, replace:
- `console.warn('IPC handlers already registered...')` → `ipcLog.warn('handlers already registered, skipping')`
- `console.log('[IPC] All handlers registered')` → `ipcLog.info('all handlers registered')`
- `console.log('All IPC handlers unregistered')` → `ipcLog.info('all handlers unregistered')`

**Step 3: Run existing IPC tests**

```bash
pnpm vitest src/main/ipc/validate.test.ts
pnpm vitest src/main/ipc/index.test.ts
```

Expected: PASS (mock electron-log if needed, or add to vi.mock setup)

**Step 4: Commit**

```bash
git add src/main/ipc/validate.ts src/main/ipc/index.ts
git commit -m "refactor: replace console.* with scoped logger in IPC layer"
```

---

### Task 4: Replace console.* in vault modules

**Files (11 console calls in `src/main/vault/index.ts`, plus others):**
- Modify: `src/main/vault/index.ts`
- Modify: `src/main/vault/indexer.ts` (26 calls — heaviest file)
- Modify: `src/main/vault/watcher.ts` (3 calls)
- Modify: `src/main/vault/notes.ts` (1 call)
- Modify: `src/main/vault/rename-tracker.ts` (8 calls)
- Modify: `src/main/vault/templates.ts` (2 calls)

**Approach:** Add `const vaultLog = createLogger('Vault')` (or more specific scopes like `Indexer`, `Watcher`) at top of each file. Do mechanical replacement of `console.*` → `vaultLog.*`. Remove `[Prefix]` text since scope handles it.

**Step 1:** Replace all console.* in each file with scoped logger calls

**Step 2:** Run vault tests

```bash
pnpm vitest src/main/vault/
```

Expected: PASS

**Step 3: Commit**

```bash
git add src/main/vault/
git commit -m "refactor: replace console.* with scoped logger in vault modules"
```

---

### Task 5: Replace console.* in inbox modules

**Files (~112 console calls across 8 files):**
- Modify: `src/main/inbox/filing.ts` (12 calls)
- Modify: `src/main/inbox/social.ts` (12 calls)
- Modify: `src/main/inbox/suggestions.ts` (19 calls)
- Modify: `src/main/inbox/snooze.ts` (11 calls)
- Modify: `src/main/inbox/stats.ts` (8 calls)
- Modify: `src/main/inbox/transcription.ts` (7 calls)
- Modify: `src/main/inbox/metadata.ts` (5 calls)
- Modify: `src/main/inbox/capture.ts` (3 calls)
- Modify: `src/main/inbox/embedding-queue.ts` (2 calls)

**Approach:** Same as Task 4. Use `createLogger('Inbox')` or more granular scopes.

**Step 1-3:** Same pattern as Task 4

**Commit:**
```bash
git add src/main/inbox/
git commit -m "refactor: replace console.* with scoped logger in inbox modules"
```

---

### Task 6: Replace console.* in remaining IPC handler files

**Files (~57 console calls across 10 handler files):**
- `src/main/ipc/inbox-handlers.ts` (35 calls — heaviest)
- `src/main/ipc/search-handlers.ts` (7)
- `src/main/ipc/settings-handlers.ts` (3)
- `src/main/ipc/tasks-handlers.ts` (2)
- `src/main/ipc/properties-handlers.ts` (2)
- `src/main/ipc/folder-view-handlers.ts` (2)
- `src/main/ipc/crypto-handlers.ts` (2)
- `src/main/ipc/sync-handlers.ts` (2)
- `src/main/ipc/reminder-handlers.ts` (2)
- `src/main/ipc/journal-handlers.ts` (1)

**Approach:** Each handler file gets `createLogger('IPC:<Domain>')`, e.g. `createLogger('IPC:Inbox')`.

**Step 1-3:** Same pattern

**Commit:**
```bash
git add src/main/ipc/
git commit -m "refactor: replace console.* with scoped logger in IPC handlers"
```

---

### Task 7: Replace console.* in remaining main process files

**Files:**
- `src/main/lib/embeddings.ts` (9 calls)
- `src/main/lib/reminders.ts` (19 calls)
- `src/main/database/seed.ts` (5 calls)
- `src/main/database/seed-inbox.ts` (6 calls)
- `src/main/database/fts-queue.ts` (1 call)
- `src/main/store.ts` (2 calls)
- `src/main/sync/http-client.ts` (check for console calls)

**Commit:**
```bash
git add src/main/lib/ src/main/database/ src/main/store.ts src/main/sync/
git commit -m "refactor: replace console.* with scoped logger in lib/db/sync modules"
```

---

### Task 8: Add renderer-side logger wrapper

**Files:**
- Create: `src/renderer/src/lib/logger.ts`

In Electron with `electron-log`, the renderer can use `electron-log/renderer` which proxies logs to main process for file writing.

```typescript
// src/renderer/src/lib/logger.ts
// electron-log/renderer sends logs through IPC to main process logger
import log from 'electron-log/renderer'

function createLogger(scope: string) {
  return log.scope(scope)
}

export { log, createLogger }
```

**Note:** Renderer console.* replacement is lower priority — the critical 256 main process calls come first. Renderer logs are mostly user-facing error catch blocks. We'll replace them incrementally alongside future feature work, NOT as a big-bang migration. The infrastructure is in place.

**Commit:**
```bash
git add src/renderer/src/lib/logger.ts
git commit -m "feat: add renderer-side logger wrapper for electron-log"
```

---

## Phase 2: Crash Reporting (Sentry)

### Task 9: Install and configure Sentry for Electron

**Files:**
- Modify: `package.json`
- Create: `src/main/lib/sentry.ts`
- Modify: `src/main/index.ts`

**Step 1: Install Sentry**

```bash
pnpm add @sentry/electron
```

**Step 2: Create Sentry config module**

```typescript
// src/main/lib/sentry.ts
import * as Sentry from '@sentry/electron/main'

const SENTRY_DSN = process.env.SENTRY_DSN || ''

function initSentry(): void {
  if (!SENTRY_DSN) return

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    enabled: process.env.NODE_ENV === 'production',

    beforeSend(event) {
      // Strip PII: vault paths, note content, user data
      if (event.exception?.values) {
        for (const exc of event.exception.values) {
          if (exc.value) {
            exc.value = exc.value.replace(/\/Users\/[^/\s]+/g, '/Users/[REDACTED]')
          }
        }
      }
      // Strip breadcrumb data that might contain note content
      if (event.breadcrumbs) {
        for (const crumb of event.breadcrumbs) {
          if (crumb.data) {
            delete crumb.data['content']
            delete crumb.data['body']
            delete crumb.data['title']
          }
        }
      }
      return event
    },

    // Don't send events in dev
    sampleRate: process.env.NODE_ENV === 'production' ? 1.0 : 0,
  })
}

export { initSentry, Sentry }
```

**Step 3: Initialize in main process entry (before anything else)**

At the very top of `src/main/index.ts`, before any other imports that could throw:

```typescript
import { initSentry } from './lib/sentry'
initSentry()
```

**Step 4: Add SENTRY_DSN to .env.example**

```
SENTRY_DSN=
```

**Step 5: Commit**

```bash
git add src/main/lib/sentry.ts src/main/index.ts .env.example package.json pnpm-lock.yaml
git commit -m "feat: add Sentry crash reporting for main process"
```

---

### Task 10: Add Sentry to renderer process

**Files:**
- Create: `src/renderer/src/lib/sentry.ts`
- Modify: `src/renderer/src/main.tsx`

**Step 1: Create renderer Sentry config**

```typescript
// src/renderer/src/lib/sentry.ts
import * as Sentry from '@sentry/electron/renderer'

function initSentry(): void {
  Sentry.init({
    // Renderer Sentry auto-connects to main process config
    // Add renderer-specific integrations here
  })
}

export { initSentry, Sentry }
```

**Step 2: Initialize at top of renderer entry**

Add `initSentry()` call at the top of `src/renderer/src/main.tsx`.

**Step 3: Wire ErrorBoundaries to Sentry**

Update the 3 ErrorBoundary components to report to Sentry:

- `src/renderer/src/components/tabs/tab-error-boundary.tsx`
- `src/renderer/src/components/note/editor-error-boundary.tsx`
- `src/renderer/src/components/journal/journal-error-boundary.tsx`

In each `componentDidCatch`:
```typescript
componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
  const { createLogger } = await import('@/lib/logger')
  createLogger('ErrorBoundary').error('Component crash:', error)
  Sentry.captureException(error, { extra: { componentStack: errorInfo.componentStack } })
}
```

**Step 4: Commit**

```bash
git add src/renderer/src/lib/sentry.ts src/renderer/src/main.tsx src/renderer/src/components/tabs/tab-error-boundary.tsx src/renderer/src/components/note/editor-error-boundary.tsx src/renderer/src/components/journal/journal-error-boundary.tsx
git commit -m "feat: add Sentry to renderer process and wire ErrorBoundaries"
```

---

### Task 11: Source map upload for Sentry

**Files:**
- Modify: `electron-builder.yml` or build script
- Modify: `electron.vite.config.ts` (if it exists) or `vite.config.ts`

**Step 1: Configure Vite to generate source maps for production builds**

Add `sourcemap: true` to Vite build config for renderer.

**Step 2: Add Sentry Vite plugin for automatic upload**

```bash
pnpm add -D @sentry/vite-plugin
```

Configure the plugin in the Vite config to upload source maps during build. Source maps should NOT be shipped in the final app bundle — only uploaded to Sentry.

**Step 3: Commit**

```bash
git add electron.vite.config.* package.json pnpm-lock.yaml
git commit -m "build: add Sentry source map upload to build pipeline"
```

---

## Phase 3: IPC Performance Instrumentation

### Task 12: Add timing + error tracking wrapper to IPC handlers

**Files:**
- Modify: `src/main/ipc/validate.ts`
- Modify: `src/main/ipc/validate.test.ts`

This is the highest leverage task — by wrapping the 3 handler factories (`createValidatedHandler`, `createHandler`, `createStringHandler`), we automatically instrument ALL 16 handler modules without touching them.

**Step 1: Write tests for instrumented handlers**

```typescript
// Add to validate.test.ts
describe('IPC instrumentation', () => {
  it('should log handler duration on success', async () => {
    const schema = z.object({ name: z.string() })
    const handler = createValidatedHandler(schema, async (input) => input.name)
    const event = {} as IpcMainInvokeEvent
    const result = await handler(event, { name: 'test' })
    expect(result).toBe('test')
    // Logger should have been called with timing info
  })

  it('should log handler duration and error on failure', async () => {
    const schema = z.object({ name: z.string() })
    const handler = createValidatedHandler(schema, async () => {
      throw new Error('boom')
    })
    const event = {} as IpcMainInvokeEvent
    await expect(handler(event, { name: 'test' })).rejects.toThrow('boom')
  })
})
```

**Step 2: Add timing instrumentation inside the existing handler wrappers**

Modify `createValidatedHandler` to capture `performance.now()` before/after handler execution and log via the IPC logger:

```typescript
export function createValidatedHandler<TSchema extends z.ZodSchema, TResult>(
  schema: TSchema,
  handler: (input: z.infer<TSchema>) => TResult | Promise<TResult>
): (event: IpcMainInvokeEvent, rawInput: unknown) => Promise<TResult> {
  return async (_event: IpcMainInvokeEvent, rawInput: unknown): Promise<TResult> => {
    const start = performance.now()
    try {
      const validated = schema.parse(rawInput)
      const result = await handler(validated)
      const duration = performance.now() - start
      if (duration > 100) {
        ipcLog.warn(`slow handler: ${duration.toFixed(1)}ms`)
      }
      return result
    } catch (error) {
      const duration = performance.now() - start
      if (error instanceof ZodError) {
        // ... existing validation error handling
      }
      ipcLog.error(`handler failed after ${duration.toFixed(1)}ms:`, error)
      throw error instanceof Error ? new Error(error.message) : new Error('Something went wrong')
    }
  }
}
```

Apply similar pattern to `createHandler` and `withErrorHandling`.

**Step 3: Run tests**

```bash
pnpm vitest src/main/ipc/validate.test.ts
```

**Step 4: Commit**

```bash
git add src/main/ipc/validate.ts src/main/ipc/validate.test.ts
git commit -m "feat: add performance instrumentation to IPC handler wrappers"
```

---

### Task 13: Add Sentry breadcrumbs to IPC handlers

**Files:**
- Modify: `src/main/ipc/validate.ts`

Add Sentry breadcrumbs in the handler wrappers so crash reports include recent IPC call history:

```typescript
import { Sentry } from '../lib/sentry'

// Inside handler wrapper, before calling the actual handler:
Sentry.addBreadcrumb({
  category: 'ipc',
  message: 'IPC handler invoked',
  level: 'info'
})
```

This gives Sentry crash reports a timeline of what IPC calls happened before the crash.

**Commit:**
```bash
git add src/main/ipc/validate.ts
git commit -m "feat: add Sentry breadcrumbs to IPC handler wrappers"
```

---

## Phase 4: Privacy & User Control

### Task 14: Add telemetry opt-in/out setting

**Files:**
- Modify: `src/shared/contracts/settings-api.ts` (or equivalent settings schema)
- Modify: `src/main/lib/sentry.ts`
- Modify: settings UI component

**Step 1: Add `telemetryEnabled` to settings schema**

Default: `false` (opt-in model — privacy first for a notes app)

**Step 2: Check setting before Sentry.init**

Only initialize Sentry if user has opted in. If they opt out after init, call `Sentry.close()`.

**Step 3: Add toggle in Settings UI**

Simple switch with explanation: "Help improve Memry by sharing anonymous crash reports. No note content is ever sent."

**Step 4: Commit**

```bash
git commit -m "feat: add telemetry opt-in setting with Sentry toggle"
```

---

## Verification Checklist

After all tasks, verify:

- [ ] `pnpm dev` starts clean — logs appear in console with `[scope]` prefixes
- [ ] Log file created at `~/Library/Logs/memry/main.log`
- [ ] `pnpm build:mac` succeeds — no import issues with electron-log
- [ ] `grep -r "console\." src/main/ --include="*.ts" | grep -v test | grep -v node_modules` returns zero non-test hits
- [ ] Sentry test event sends successfully (when DSN configured)
- [ ] ErrorBoundary triggers send Sentry events
- [ ] IPC handlers log slow operations (>100ms)
- [ ] `pnpm test` passes — no regressions
- [ ] `pnpm typecheck` passes (excluding known test file failures)

---

## Out of Scope (Future Work)

These are deferred to later phases:

1. **Renderer console.* migration** — Do incrementally, not big-bang. Infrastructure is in place (Task 8).
2. **Usage analytics (PostHog/Aptabase)** — Needs product decision on what to track. Do after launch.
3. **Sync server observability** — Separate codebase (Cloudflare Workers). Use Workers Analytics Engine + Sentry Workers SDK.
4. **Log aggregation / remote shipping** — Only needed at scale when you have support volume.
5. **Performance dashboard** — Build internal metrics view when you have enough data.
6. **Alerting** — Set up Sentry alerts after you have baseline error rates.

---

## Task Summary

| # | Task | Scope | LOE |
|---|------|-------|-----|
| 1 | Install electron-log + create logger module | Foundation | Small |
| 2 | Initialize logger in main entry | Integration | Small |
| 3 | Replace console.* in IPC core (validate.ts, index.ts) | Migration | Small |
| 4 | Replace console.* in vault modules (~51 calls) | Migration | Medium |
| 5 | Replace console.* in inbox modules (~79 calls) | Migration | Medium |
| 6 | Replace console.* in IPC handler files (~57 calls) | Migration | Medium |
| 7 | Replace console.* in remaining main files (~42 calls) | Migration | Medium |
| 8 | Renderer logger wrapper | Foundation | Small |
| 9 | Install + configure Sentry main process | Crash reporting | Small |
| 10 | Sentry renderer + ErrorBoundary wiring | Crash reporting | Small |
| 11 | Source map upload for Sentry | Build pipeline | Small |
| 12 | IPC timing + error instrumentation | Metrics | Small |
| 13 | Sentry breadcrumbs in IPC | Observability | Small |
| 14 | Telemetry opt-in setting | Privacy | Medium |

**Critical path:** Tasks 1 → 2 → 3 (foundation) → then 4-8 can parallelize → 9-13 can parallelize → 14 last.
