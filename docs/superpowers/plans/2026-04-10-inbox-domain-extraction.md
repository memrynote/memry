# Inbox Domain Extraction Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reintroduce `packages/domain-inbox` and move inbox orchestration out of IPC handlers without moving desktop runtime concerns into the package.

**Architecture:** Restore a small pure inbox package, add a desktop composition module under `apps/desktop/src/main/inbox/`, and keep IPC files focused on validation and registration. Cross-domain actions remain adapter-driven in desktop code.

**Tech Stack:** Electron, TypeScript, Zod, Drizzle ORM, Vitest

---

## Task 1: Restore Package Boundary

**Files:**
- Create: `packages/domain-inbox/package.json`
- Create: `packages/domain-inbox/tsconfig.json`
- Create: `packages/domain-inbox/src/index.ts`
- Create: `packages/domain-inbox/src/types.ts`
- Create: `packages/domain-inbox/src/commands.ts`
- Create: `packages/domain-inbox/src/queries.ts`
- Create: `packages/domain-inbox/src/commands.test.ts`
- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/electron.vite.config.ts`
- Modify: `apps/desktop/tsconfig.json`
- Modify: `apps/desktop/tsconfig.node.json`
- Modify: `apps/desktop/tsconfig.web.json`

- [x] Restore the workspace package and desktop wiring.
- [x] Re-add the pure command/query wrappers and focused package tests.
- [x] Re-add desktop resolver aliases so Electron/Vite/TS can import `@memry/domain-inbox`.

## Task 2: Add Desktop Inbox Composition

**Files:**
- Create: `apps/desktop/src/main/inbox/domain.ts`

- [x] Move capture orchestration into the desktop composition module.
- [x] Keep duplicate lookup, metadata queueing, transcription queueing, and filing adapters there.
- [x] Keep runtime-only concerns out of `packages/domain-inbox`.

## Task 3: Thin Main Inbox IPC Handlers

**Files:**
- Modify: `apps/desktop/src/main/ipc/inbox-handlers.ts`

- [x] Keep schema validation at the IPC boundary.
- [x] Delegate capture, filing, retry, suggestions, and snooze flows to the desktop inbox domain surface.
- [x] Preserve existing channel names and return shapes.

## Task 4: Finish Handler Extraction

**Files:**
- Modify: `apps/desktop/src/main/ipc/inbox-crud-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-batch-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/inbox-query-handlers.ts`

- [x] Move CRUD orchestration out of IPC modules.
- [x] Move batch orchestration out of IPC modules.
- [x] Keep query modules as repository adapters or delegated domain/query wrappers.

## Task 5: Verify

**Commands:**

```bash
pnpm ipc:check
pnpm --filter @memry/desktop test -- --run apps/desktop/src/main/ipc/inbox-handlers.test.ts
pnpm --filter @memry/desktop test -- --run apps/desktop/src/main/ipc/inbox-query-handlers.test.ts
```

- [x] Confirm imports/generation stay green.
- [x] Confirm inbox handler tests still pass.
- [x] Document any remaining extraction gaps before updating the architecture checklist.

Verification note (2026-04-10):
- `pnpm ipc:check` passes.
- `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/ipc/inbox-handlers.test.ts` passes.
- `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/ipc/inbox-query-handlers.test.ts` passes.
- `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts ../../packages/domain-inbox/src/commands.test.ts` passes.
- The broader `pnpm --filter @memry/desktop test -- --run ...` command still fans out to the full suite and reports unrelated attachment-test failures already present outside this inbox extraction.
