# Testing

Vitest for unit / integration, Playwright for E2E (Electron).

## Unit + Integration (Vitest)

```bash
pnpm test                 # all packages via Turborepo
pnpm --filter @memry/desktop test
```

## E2E (Playwright)

```bash
pnpm test:e2e
```

E2E tests run against the **built bundle** (`out/main/index.js`), not source. Rebuild after edits:

```bash
npx electron-vite build
pnpm test:e2e
```

## IPC Contract Check

After editing renderer / main contracts:

```bash
pnpm ipc:check
pnpm ipc:generate    # regenerate invoke map
```

## Focused Typecheck

```bash
pnpm typecheck:node     # main process
pnpm typecheck:web      # renderer
```

These skip the flaky `ipc:check` pre-hook and known pre-existing errors.

## Coverage Targets

- Pre-production: pragmatic coverage, with strong tests around sync, CRDT, and crypto.
- Test files with known type errors (e.g. `websocket.test.ts`, `folders.test.ts`) are tracked and excluded from gating.
