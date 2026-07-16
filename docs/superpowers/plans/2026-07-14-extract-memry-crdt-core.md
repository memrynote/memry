# Extract @memry/crdt-core Implementation Plan

> Agentic workers: use the `superpowers:subagent-driven-development` sub-skill to execute this plan. Every step below uses `- [ ]` checkbox syntax; check a box only when its exact verification evidence is green. Do NOT commit anything the orchestrator has not told you to; the per-task "Commit" steps are the message/command the future executor runs, not you.

**Goal:** Move the portable Yjs doc-lifecycle kernel and its helpers (`crdt-compact-utils`, `crdt-queue`, `crdt-feed`, `crdt-encrypt`, `microtask-batch-broadcaster`) into a new `@memry/crdt-core` workspace package, and SPLIT `crdt-provider.ts` behind three injected seams (`YDocPersistence`, `NoteContentSource`, `EmitEvents`) plus a `Logger` seam, keeping desktop green and CRDT update bytes byte-identical.

**Architecture:** `crdt-provider.ts`'s 968-line `CrdtProvider` class is decomposed into a host-agnostic `CrdtDocManager` (docs Map / open-locks / compaction / eviction / network-batching / broadcast routing) that owns only Yjs + injected seams, and a thin desktop wiring file that adapts `y-leveldb` persistence + vault hydration + `BrowserWindow` broadcast onto that core and keeps every existing export (`getCrdtProvider`/`resetCrdtProvider`/`ORIGIN_LOCAL`/…) so all 22 desktop importers compile untouched. Tests move with the code; the desktop suite is the red→green gate at every step; no Yjs call order, encryption header layout, or sync wire byte changes.

**Tech Stack:** TypeScript (ESM, `moduleResolution: bundler`), `yjs ~13.6.29`, Vitest, pnpm workspace + Turbo, Drizzle-free (this package has no DB). New package `@memry/crdt-core` depends on `@memry/contracts`, `@memry/shared`, and later `@memry/crypto` + `@memry/sync-engine` (only when `crdt-encrypt` moves). NO `electron`, NO `y-leveldb`, NO `fs` inside the package.

## Global Constraints

Copy these project-wide constraints VERBATIM; they bind every task in this plan.

- Backward compatibility is MANDATORY for production installs: every change must work for existing installs, no DB resets, sync protocol / IPC contracts / vault file formats / settings shapes must tolerate data written by older app versions.
- DB schema changes go through additive, hand-written D1/data-DB migrations that preserve existing rows (Drizzle snapshots broken past 0021; data-DB migrations are hand-written).
- Sync-server deploys BEFORE desktop/mobile clients for every additive change (D6 sync item types, D8 settings-push, entitlement_grants).
- Crypto parameters are IMMUTABLE and byte-identical across clients: Argon2id v1.3 ops=3, mem=64 MiB, parallelism=1; BLAKE2b crypto_kdf_derive_from_key with exact 8-char contexts (memryvlt/memrysgn/memryvrf/memrykve/memrylnk/memrymac/memrysas); base64 = sodium.base64_variants.ORIGINAL (standard alphabet, padded); cryptoVersion=1; canonical CBOR in CBOR_FIELD_ORDER.
- E2E-encrypted: server never sees plaintext; it verifies Ed25519 via WebCrypto and validates envelope lengths only.
- Offline-first: SQLite local storage is canonical on mobile; CRDT (Yjs) for note/journal bodies, field-level vector clocks for tasks/projects/calendar; correctness never depends on background execution.
- `@blocknote/*`, `yjs`, and `zod` pinned IDENTICALLY to desktop across clients; a CI check fails the mobile build on drift; BlockNote bumps gated on the markdown round-trip / byte-preservation golden suite.
- `@memry/contracts` is the single wire-format source of truth; mobile MUST import, never copy (copying breaks cross-device crypto/signature interop).
- No Co-Authored-By trailer on commit messages.
- Prettier: single quotes, no semicolons, 100-char width, no trailing commas.
- RTL safety: new code uses logical Tailwind/RN props (ms-/me-, ps-/pe-, start-/end-) that flip automatically in RTL; RN uses I18nManager.forceRTL instead of document.dir.
- Extraction principle: move files, re-export from old paths, tests move with the code, desktop consumes the new package first — each extraction keeps desktop green, verified by the existing suite before mobile exists.
- Logging via createLogger('Scope') seam (never raw console.\*); user-facing errors via extractErrorMessage(err, fallback).
- WCAG AA + reduced-motion + RTL accessibility per PRODUCT.md; personality calm, private, crafted.

**Version pins (this package):** `yjs = ~13.6.29` (desktop `^13.6.29`), `zod = ^4.3.4`, `@blocknote/* = 0.47.x` (only reached indirectly through injected converters — crdt-core itself never imports `@blocknote/*`).

**Byte-identity invariant (workstream-specific, non-negotiable):** No reordering of `Y.encodeStateAsUpdate` / `Y.applyUpdate` / `Y.mergeUpdates` calls; no gc-flag change in `compactYDoc` (`new Y.Doc({ gc: true })`); the `crdt-encrypt` header layout stays `NONCE24 | NONCE24 | WRAPPED48 | SIG64` (HEADER_LEN=160) with `buildSignedPayload = noteIdBytes || beforeSig || afterSig`. Every move is behavior-preserving; the moved tests are the proof.

**Cross-workstream sequencing (read before starting):**

- Tasks 1–8 have NO dependency on any not-yet-extracted package. They land now and keep desktop green on their own.
- Task 9 (move `crdt-encrypt`) is GATED: it MUST run only after `@memry/crypto` (workstream `extract-crypto`) and `@memry/sync-engine` (workstream `extract-sync-engine`) are landed, because `crdt-encrypt` consumes `encrypt/decrypt/wrapFileKey/unwrapFileKey/generateFileKey/secureCleanup` + a `SodiumProvider` from `@memry/crypto` and `compressPayload/decompressPayload` + `SignatureVerificationError` from `@memry/sync-engine`. Until then `crdt-encrypt.ts` stays at its desktop path unchanged; desktop stays green because nothing about it moves.

---

## File Structure

### New files — `packages/crdt-core/`

| Path                                 | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                       | Workspace pkg `@memry/crdt-core`. Deps: `yjs`, `@memry/contracts`, `@memry/shared` (Task 9 adds `@memry/crypto`, `@memry/sync-engine`). No electron / y-leveldb / fs.                                                                                                                                                                                                                                             |
| `tsconfig.json`                      | Extends `@memry/typescript-config/node.json`; excludes tests.                                                                                                                                                                                                                                                                                                                                                     |
| `vitest.config.ts`                   | Node-env Vitest so moved `*.test.ts` run in-package.                                                                                                                                                                                                                                                                                                                                                              |
| `src/index.ts`                       | Barrel: `CrdtDocManager` + option types, `YDocPersistence`, `NoteContentSource`, `EmitEvents`, `Logger`, `ORIGIN_LOCAL`/`ORIGIN_NETWORK`, `SnapshotPushFn`, `CrdtDocSizeMetric`/`CrdtOpenDocMetrics`, `compactYDoc`/`copyXmlFragment`/`copyYMap`/`copyYArray`, `CrdtUpdateQueue`, `MicrotaskBatchBroadcaster`, `replaceNoteBodyInCrdt`/`replaceNoteTagsInCrdt`, `encryptCrdtUpdate`/`decryptCrdtUpdate` (Task 9). |
| `src/logger.ts`                      | `Logger` seam interface + `noopLogger`. Replaces `createLogger('…')` imports in moved files.                                                                                                                                                                                                                                                                                                                      |
| `src/microtask-batch-broadcaster.ts` | Moved verbatim. `MicrotaskBatchBroadcaster` + `BroadcastFn`. Pure Yjs.                                                                                                                                                                                                                                                                                                                                            |
| `src/crdt-compact-utils.ts`          | Moved. `compactYDoc(doc, fragmentName, logger?)` + `copyXmlFragment`/`copyYMap`/`copyYArray`. Logger injected.                                                                                                                                                                                                                                                                                                    |
| `src/crdt-queue.ts`                  | Moved. `CrdtUpdateQueue` batcher; retryable check duck-typed on `{ statusCode }` (no `SyncServerError` import); logger injected.                                                                                                                                                                                                                                                                                  |
| `src/persistence.ts`                 | `YDocPersistence` — the exact 5-method `CrdtPersistence` contract lifted from `crdt-provider.ts:72-78`.                                                                                                                                                                                                                                                                                                           |
| `src/note-content-source.ts`         | `NoteContentSource` seam: `getNoteContent(noteId): Promise<string \| null>`.                                                                                                                                                                                                                                                                                                                                      |
| `src/emit-events.ts`                 | `EmitEvents` seam: `broadcast(noteId, update, origin, sourceSubscriberId?)`.                                                                                                                                                                                                                                                                                                                                      |
| `src/crdt-doc-manager.ts`            | THE SPLIT-OUT PORTABLE CORE of `crdt-provider.ts`. `CrdtDocManager` owning docs Map / open-locks / compaction / eviction / network-batch / broadcast routing / seed via `NoteContentSource`.                                                                                                                                                                                                                      |
| `src/crdt-feed.ts`                   | Moved. `replaceNoteBodyInCrdt` / `replaceNoteTagsInCrdt` taking injected `getDoc` + markdown converters.                                                                                                                                                                                                                                                                                                          |
| `src/crdt-encrypt.ts`                | Moved (Task 9). `encryptCrdtUpdate` / `decryptCrdtUpdate`; header layout unchanged.                                                                                                                                                                                                                                                                                                                               |
| `src/*.test.ts`                      | Moved tests (see each task).                                                                                                                                                                                                                                                                                                                                                                                      |

### Desktop files — `apps/desktop/`

| Path                                           | Change                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/sync/crdt-leveldb-persistence.ts`    | **New.** Desktop `YDocPersistence` impl wrapping `y-leveldb` `LeveldbPersistence` + the full `doInitPersistence` hardening (preflight quarantine/restore, `probePersistence` uncaught+timeout guard, in-memory degrade).                          |
| `src/main/sync/crdt-provider.ts`               | **Rewrite** from 968-line class to thin wiring: instantiate `CrdtDocManager` with the leveldb persistence, a `VaultNoteContentSource`, a `BrowserWindowEmitEvents`, and an electron-log `Logger`; delegate every public method; keep ALL exports. |
| `src/main/sync/microtask-batch-broadcaster.ts` | **Re-export shim** → `@memry/crdt-core`.                                                                                                                                                                                                          |
| `src/main/sync/crdt-compact-utils.ts`          | **Re-export shim** → `@memry/crdt-core`.                                                                                                                                                                                                          |
| `src/main/sync/crdt-queue.ts`                  | **Re-export shim** → `@memry/crdt-core`.                                                                                                                                                                                                          |
| `src/main/sync/crdt-feed.ts`                   | **Re-export shim** binding `getCrdtProvider().getDoc` + `blocknote-converter` converters to the moved core function.                                                                                                                              |
| `src/main/sync/crdt-encrypt.ts`                | **Re-export shim** (Task 9) → `@memry/crdt-core`.                                                                                                                                                                                                 |
| `package.json`                                 | Add `"@memry/crdt-core": "workspace:*"` to dependencies.                                                                                                                                                                                          |

---

## Task 1: Scaffold the `@memry/crdt-core` package

**Files:**

- Create `packages/crdt-core/package.json`
- Create `packages/crdt-core/tsconfig.json`
- Create `packages/crdt-core/vitest.config.ts`
- Create `packages/crdt-core/src/index.ts`
- Modify `apps/desktop/package.json` (add dependency)

**Interfaces:**

- Produces: workspace package `@memry/crdt-core` with `exports["."] = "./src/index.ts"`; empty barrel `src/index.ts`.
- Consumes: `@memry/contracts` (`workspace:*`), `@memry/shared` (`workspace:*`), `yjs`.

**Steps:**

- [ ] **Step 1: Write the package manifest.** Create `packages/crdt-core/package.json`:

```json
{
  "name": "@memry/crdt-core",
  "version": "0.1.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@memry/contracts": "workspace:*",
    "@memry/shared": "workspace:*",
    "yjs": "~13.6.29"
  },
  "devDependencies": {
    "@memry/typescript-config": "workspace:*",
    "@types/node": "^25.0.3",
    "vitest": "^3.2.4"
  }
}
```

(Match the installed vitest major: run `pnpm ls vitest -r --depth -1` and pin the same `^x.y.z` the desktop uses.)

- [ ] **Step 2: Write tsconfig + vitest config.** Create `packages/crdt-core/tsconfig.json` (mirror `packages/shared/tsconfig.json`):

```json
{
  "extends": "@memry/typescript-config/node.json",
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"]
}
```

Create `packages/crdt-core/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
```

- [ ] **Step 3: Write the empty barrel.** Create `packages/crdt-core/src/index.ts`:

```ts
export {}
```

- [ ] **Step 4: Register the dependency + install.** In `apps/desktop/package.json`, add under `"dependencies"` (alphabetical, after `"@memry/contracts"`):

```json
    "@memry/crdt-core": "workspace:*",
```

Then run `pnpm install` from the repo root. Expect: lockfile updates, `@memry/crdt-core` linked into `apps/desktop/node_modules/@memry/`.

- [ ] **Step 5: Verify the empty package typechecks.** Run:

```bash
pnpm --filter @memry/crdt-core typecheck
```

Expect: exit 0, no output (empty `export {}` compiles clean).

- [ ] **Step 6: Commit.**

```bash
git add packages/crdt-core apps/desktop/package.json pnpm-lock.yaml
git commit -m "chore(crdt-core): scaffold @memry/crdt-core workspace package"
```

---

## Task 2: Move `microtask-batch-broadcaster` (cleanest move)

**Files:**

- Create `packages/crdt-core/src/microtask-batch-broadcaster.ts` (moved verbatim)
- Create `packages/crdt-core/src/microtask-batch-broadcaster.test.ts` (moved verbatim)
- Modify `apps/desktop/src/main/sync/microtask-batch-broadcaster.ts` → re-export shim
- Modify `packages/crdt-core/src/index.ts` (barrel)
- Delete `apps/desktop/src/main/sync/microtask-batch-broadcaster.test.ts`

**Interfaces:**

- Produces: `class MicrotaskBatchBroadcaster { enqueue(noteId, update); flush(noteId); flushAll(); hasPending(noteId) }`, `type BroadcastFn = (noteId: string, mergedUpdate: Uint8Array) => void`.
- Consumes: `yjs` (`Y.mergeUpdates`).

**Steps:**

- [ ] **Step 1: Move the source + test (they ARE the failing→passing gate).** Copy `apps/desktop/src/main/sync/microtask-batch-broadcaster.ts` verbatim to `packages/crdt-core/src/microtask-batch-broadcaster.ts` (its only import is `import * as Y from 'yjs'` — zero platform deps, moves clean). Copy `apps/desktop/src/main/sync/microtask-batch-broadcaster.test.ts` verbatim to `packages/crdt-core/src/microtask-batch-broadcaster.test.ts` (its import `from './microtask-batch-broadcaster'` resolves unchanged in the new dir).

- [ ] **Step 2: Run the moved test in-package, expect PASS.**

```bash
pnpm --filter @memry/crdt-core test
```

Expect: `microtask-batch-broadcaster.test.ts` runs green (227 lines of assertions), e.g. `Test Files 1 passed`.

- [ ] **Step 3: Replace the desktop file with a re-export shim + export from barrel.** Overwrite `apps/desktop/src/main/sync/microtask-batch-broadcaster.ts` with:

```ts
export { MicrotaskBatchBroadcaster } from '@memry/crdt-core'
export type { BroadcastFn } from '@memry/crdt-core'
```

Add to `packages/crdt-core/src/index.ts`:

```ts
export { MicrotaskBatchBroadcaster } from './microtask-batch-broadcaster'
export type { BroadcastFn } from './microtask-batch-broadcaster'
```

Delete `apps/desktop/src/main/sync/microtask-batch-broadcaster.test.ts` (it moved).

- [ ] **Step 4: Verify desktop still green through the shim.** `crdt-provider.ts` imports `MicrotaskBatchBroadcaster` from `./microtask-batch-broadcaster` — the shim keeps that path valid. Run:

```bash
pnpm --filter @memry/crdt-core test
pnpm --filter @memry/desktop test:main -- microtask
pnpm typecheck
```

Expect: crdt-core green; desktop main suite green for any spec touching the broadcaster; typecheck exit 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/crdt-core apps/desktop/src/main/sync/microtask-batch-broadcaster.ts
git rm apps/desktop/src/main/sync/microtask-batch-broadcaster.test.ts
git commit -m "refactor(crdt-core): move microtask-batch-broadcaster into @memry/crdt-core"
```

---

## Task 3: Move `crdt-compact-utils` behind the `Logger` seam

**Files:**

- Create `packages/crdt-core/src/logger.ts`
- Create `packages/crdt-core/src/crdt-compact-utils.ts` (moved, logger injected)
- Create `packages/crdt-core/src/crdt-compaction.test.ts` (moved)
- Modify `apps/desktop/src/main/sync/crdt-compact-utils.ts` → re-export shim
- Modify `packages/crdt-core/src/index.ts`
- Delete `apps/desktop/src/main/sync/crdt-compaction.test.ts`

**Interfaces:**

- Produces: `interface Logger { debug(msg: string, ...args: unknown[]): void; info(...): void; warn(...): void; error(...): void }`; `const noopLogger: Logger`; `compactYDoc(doc: Y.Doc, fragmentName: string, logger?: Logger): { compacted: Uint8Array; savedBytes: number } | null`; `copyXmlFragment`/`copyYMap`/`copyYArray`.
- Consumes: `yjs`.

**Steps:**

- [ ] **Step 1: Write the `Logger` seam.** Create `packages/crdt-core/src/logger.ts`:

```ts
export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
}
```

- [ ] **Step 2: Move `crdt-compact-utils.ts`, swap `createLogger` for the seam.** Create `packages/crdt-core/src/crdt-compact-utils.ts` as the verbatim source EXCEPT the top two lines (`import * as Y from 'yjs'` stays; drop `import { createLogger } from '../lib/logger'` and `const log = createLogger('CrdtCompaction')`), and give `compactYDoc` an injected logger — behaviour-preserving because logging is not on-wire:

```ts
import * as Y from 'yjs'
import { noopLogger, type Logger } from './logger'

export function compactYDoc(
  doc: Y.Doc,
  _fragmentName: string,
  log: Logger = noopLogger
): { compacted: Uint8Array; savedBytes: number } | null {
  const originalSize = Y.encodeStateAsUpdate(doc).byteLength

  const fresh = new Y.Doc({ gc: true })
  fresh.transact(() => {
    for (const [name, type] of doc.share) {
      if (type instanceof Y.XmlFragment) {
        copyXmlFragment(type, fresh.getXmlFragment(name))
      } else if (type instanceof Y.Map) {
        copyYMap(type as Y.Map<unknown>, fresh.getMap(name))
      } else if (type instanceof Y.Array) {
        copyYArray(type as Y.Array<unknown>, fresh.getArray(name))
      } else if (type instanceof Y.Text) {
        const dst = fresh.getText(name)
        dst.applyDelta(type.toDelta())
      } else {
        log.warn('Unknown shared type during compaction, skipping', {
          name,
          type: type.constructor.name
        })
      }
    }
  })

  const compacted = Y.encodeStateAsUpdate(fresh)
  fresh.destroy()

  const savedBytes = originalSize - compacted.byteLength
  if (savedBytes <= 0) {
    log.debug('Compaction would not reduce size', {
      originalSize,
      compactedSize: compacted.byteLength
    })
    return null
  }

  return { compacted, savedBytes }
}
```

Keep `copyXmlFragment`, `copyYMap`, `copyYArray` verbatim below (unchanged from the source — they have no logger use). The `new Y.Doc({ gc: true })` gc flag MUST stay identical (byte-identity invariant).

- [ ] **Step 3: Move the test.** Copy `apps/desktop/src/main/sync/crdt-compaction.test.ts` verbatim to `packages/crdt-core/src/crdt-compaction.test.ts` — its import `from './crdt-compact-utils'` resolves unchanged, and it only imports `compactYDoc, copyXmlFragment, copyYMap` (never the logger), so the new default-logger signature is source-compatible.

- [ ] **Step 4: Run it, expect PASS.**

```bash
pnpm --filter @memry/crdt-core test -- crdt-compaction
```

Expect: `crdt-compaction.test.ts` green (175 lines; compaction / xml / map copy assertions).

- [ ] **Step 5: Shim the desktop path + barrel export.** Overwrite `apps/desktop/src/main/sync/crdt-compact-utils.ts`:

```ts
export { compactYDoc, copyXmlFragment, copyYMap, copyYArray } from '@memry/crdt-core'
```

Add to `packages/crdt-core/src/index.ts`:

```ts
export { compactYDoc, copyXmlFragment, copyYMap, copyYArray } from './crdt-compact-utils'
export { noopLogger, type Logger } from './logger'
```

Delete `apps/desktop/src/main/sync/crdt-compaction.test.ts`.

- [ ] **Step 6: Verify desktop green.** `crdt-provider.ts:809` calls `compactYDoc(entry.doc, CRDT_FRAGMENT_NAME)` (two args) — the optional third `logger` keeps that call valid. Run:

```bash
pnpm --filter @memry/crdt-core test
pnpm typecheck
```

Expect: crdt-core green; typecheck exit 0 (the two-arg desktop call still compiles).

- [ ] **Step 7: Commit.**

```bash
git add packages/crdt-core apps/desktop/src/main/sync/crdt-compact-utils.ts
git rm apps/desktop/src/main/sync/crdt-compaction.test.ts
git commit -m "refactor(crdt-core): move crdt-compact-utils behind Logger seam"
```

---

## Task 4: Move `crdt-queue` (duck-typed retryable, injected logger)

**Files:**

- Create `packages/crdt-core/src/crdt-queue.ts` (moved; no `SyncServerError` import)
- Create `packages/crdt-core/src/crdt-queue.test.ts` (moved; local fake error)
- Modify `apps/desktop/src/main/sync/crdt-queue.ts` → re-export shim
- Modify `packages/crdt-core/src/index.ts`
- Delete `apps/desktop/src/main/sync/crdt-queue.test.ts`

**Interfaces:**

- Produces: `class CrdtUpdateQueue { constructor(logger?: Logger); start(pushFn); stop(); pause(); resume(); enqueue(noteId, rawUpdate); getPendingCount(); getOutstandingCount() }`. Retryable classification is duck-typed: any thrown error carrying a numeric `statusCode` is treated with the exact same rule as before (`400 ≤ code < 500 && code !== 429 && code !== 401` ⇒ non-retryable/drop; everything else re-buffers).
- Consumes: `Logger` seam. NO import of `SyncServerError` (decouples crdt-core from `@memry/sync-engine` for this task).

**Steps:**

- [ ] **Step 1: Move `crdt-queue.ts`, drop the `SyncServerError` import, inject logger.** Create `packages/crdt-core/src/crdt-queue.ts` verbatim from the source EXCEPT: (a) delete `import { createLogger } from '../lib/logger'`, `import { SyncServerError } from './http-client'`, and `const log = createLogger('CrdtUpdateQueue')`; (b) add `import { noopLogger, type Logger } from './logger'` and a ctor logger field; (c) replace the `SyncServerError instanceof` check with a `statusCode` duck-type helper. Header and `flushNote` become:

```ts
import { noopLogger, type Logger } from './logger'

const FLUSH_INTERVAL_MS = 1000
const MAX_BATCH_SIZE = 50

interface BufferedUpdate {
  noteId: string
  rawUpdate: Uint8Array
  timestamp: number
}

function hasStatusCode(err: unknown): err is { statusCode: number } {
  return typeof err === 'object' && err !== null && typeof (err as { statusCode?: unknown }).statusCode === 'number'
}

export class CrdtUpdateQueue {
  private buffers = new Map<string, BufferedUpdate[]>()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushingNotes = new Set<string>()
  private pushFn: ((noteId: string, updates: Uint8Array[]) => Promise<void>) | null = null
  private paused = false
  private readonly log: Logger

  constructor(logger: Logger = noopLogger) {
    this.log = logger
  }
```

The `flushNote` catch block's classification becomes (identical rule, now duck-typed on `statusCode`):

```ts
      .catch((err) => {
        if (!this.paused) {
          this.log.error('Failed to push CRDT updates', { noteId, error: err })
        }
        // 401 stays buffered: the push fn pauses the queue and a successful
        // token refresh resumes it, so the batch retries instead of dropping.
        const nonRetryable =
          hasStatusCode(err) &&
          err.statusCode >= 400 &&
          err.statusCode < 500 &&
          err.statusCode !== 429 &&
          err.statusCode !== 401
        if (nonRetryable) return

        let existing = this.buffers.get(noteId)
        if (!existing) {
          existing = []
          this.buffers.set(noteId, existing)
        }
        existing.unshift(...updates)
      })
```

Everything else (`start`/`stop`/`pause`/`resume`/`enqueue`/`getPendingCount`/`getOutstandingCount`/`flushAll`, the `log.info`/`log.warn` calls now on `this.log`) moves verbatim with `log.` → `this.log.`.

- [ ] **Step 2: Move the test, decouple it from `http-client`.** Copy `apps/desktop/src/main/sync/crdt-queue.test.ts` to `packages/crdt-core/src/crdt-queue.test.ts`. Delete its `import { SyncServerError } from './http-client'` and its `vi.mock('../lib/logger', …)` block; replace the error construction with a local fake that mirrors `SyncServerError`'s duck-typed shape:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CrdtUpdateQueue } from './crdt-queue'

class FakeSyncServerError extends Error {
  constructor(public statusCode: number) {
    super(`status ${statusCode}`)
    this.name = 'FakeSyncServerError'
  }
}
```

Rewrite every `new SyncServerError(msg, code)` in the test body as `new FakeSyncServerError(code)`. The non-retryable/retryable assertions are unchanged (403 drops, 429/401/500 re-buffer).

- [ ] **Step 3: Run it, expect PASS.**

```bash
pnpm --filter @memry/crdt-core test -- crdt-queue
```

Expect: `crdt-queue.test.ts` green (batch size, flush interval, pause/resume, retryable classification).

- [ ] **Step 4: Shim the desktop path + barrel export.** Overwrite `apps/desktop/src/main/sync/crdt-queue.ts`:

```ts
export { CrdtUpdateQueue } from '@memry/crdt-core'
```

Add to `packages/crdt-core/src/index.ts`:

```ts
export { CrdtUpdateQueue } from './crdt-queue'
```

Delete `apps/desktop/src/main/sync/crdt-queue.test.ts`.

- [ ] **Step 5: Verify desktop green.** `runtime.ts:360` constructs `new CrdtUpdateQueue()` (zero args) — the optional-logger ctor keeps that valid; the desktop wiring may later pass `new CrdtUpdateQueue(createLogger('CrdtUpdateQueue'))` but is not required to for green. Run:

```bash
pnpm --filter @memry/crdt-core test
pnpm --filter @memry/desktop test:main -- crdt
pnpm typecheck
```

Expect: crdt-core green; desktop CRDT specs green; typecheck exit 0.

- [ ] **Step 6: Commit.**

```bash
git add packages/crdt-core apps/desktop/src/main/sync/crdt-queue.ts
git rm apps/desktop/src/main/sync/crdt-queue.test.ts
git commit -m "refactor(crdt-core): move crdt-queue with duck-typed retryable status"
```

---

## Task 5: Define the three seams (`YDocPersistence`, `NoteContentSource`, `EmitEvents`)

**Files:**

- Create `packages/crdt-core/src/persistence.ts`
- Create `packages/crdt-core/src/note-content-source.ts`
- Create `packages/crdt-core/src/emit-events.ts`
- Create `packages/crdt-core/src/seams.test.ts`
- Modify `packages/crdt-core/src/index.ts`

**Interfaces:**

- Produces:
  - `interface YDocPersistence { getYDoc(noteId: string): Promise<Y.Doc>; clearDocument(noteId: string): Promise<void>; destroy(): Promise<void> | void; storeUpdate(noteId: string, update: Uint8Array): Promise<void>; flushDocument(noteId: string): Promise<void> }` (the exact 5-method `CrdtPersistence` contract from `crdt-provider.ts:72-78`; structurally identical to `y-leveldb`'s `LeveldbPersistence`).
  - `interface NoteContentSource { getNoteContent(noteId: string): Promise<string | null> }` (spine seam name).
  - `interface EmitEvents { broadcast(noteId: string, update: Uint8Array, origin: string, sourceSubscriberId?: number): void }`.
- Consumes: `yjs` (`Y.Doc` type only).

**Steps:**

- [ ] **Step 1: Write the failing test.** Create `packages/crdt-core/src/seams.test.ts` — a compile-and-shape test proving each interface is implementable with the documented signatures:

```ts
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import type { YDocPersistence } from './persistence'
import type { NoteContentSource } from './note-content-source'
import type { EmitEvents } from './emit-events'

describe('crdt-core seams', () => {
  it('YDocPersistence is implementable with the 5-method contract', async () => {
    const store = new Map<string, Uint8Array>()
    const impl: YDocPersistence = {
      async getYDoc(id) {
        const doc = new Y.Doc()
        const u = store.get(id)
        if (u) Y.applyUpdate(doc, u)
        return doc
      },
      async storeUpdate(id, update) {
        store.set(id, update)
      },
      async flushDocument() {},
      async clearDocument(id) {
        store.delete(id)
      },
      destroy() {}
    }
    const d = new Y.Doc()
    d.getText('t').insert(0, 'hi')
    await impl.storeUpdate('n1', Y.encodeStateAsUpdate(d))
    const loaded = await impl.getYDoc('n1')
    expect(loaded.getText('t').toString()).toBe('hi')
  })

  it('NoteContentSource + EmitEvents are implementable', () => {
    const source: NoteContentSource = {
      async getNoteContent() {
        return '# hi'
      }
    }
    const emitted: string[] = []
    const emit: EmitEvents = {
      broadcast(noteId, _update, origin) {
        emitted.push(`${noteId}:${origin}`)
      }
    }
    emit.broadcast('n1', new Uint8Array([1]), 'local', 42)
    expect(emitted).toEqual(['n1:local'])
    expect(typeof source.getNoteContent).toBe('function')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
pnpm --filter @memry/crdt-core test -- seams
```

Expect: FAIL — `Cannot find module './persistence'` (and `./note-content-source`, `./emit-events`).

- [ ] **Step 3: Write the seam interfaces.** Create `packages/crdt-core/src/persistence.ts`:

```ts
import type * as Y from 'yjs'

// The exact 5-method CrdtPersistence contract lifted from crdt-provider.ts:72-78.
// Structurally identical to y-leveldb's LeveldbPersistence so the desktop
// adapter is a structural fit; mobile implements it over a SQLite update-log.
export interface YDocPersistence {
  getYDoc(noteId: string): Promise<Y.Doc>
  clearDocument(noteId: string): Promise<void>
  destroy(): Promise<void> | void
  storeUpdate(noteId: string, update: Uint8Array): Promise<void>
  flushDocument(noteId: string): Promise<void>
}
```

Create `packages/crdt-core/src/note-content-source.ts`:

```ts
// Hydrates the markdown body used to seed a CRDT doc on first open.
// Desktop reads the vault file (returns null for missing/binary/empty notes);
// mobile has no note-file vault, so its impl returns null (SQLite/Y.Doc is canonical).
export interface NoteContentSource {
  getNoteContent(noteId: string): Promise<string | null>
}
```

Create `packages/crdt-core/src/emit-events.ts`:

```ts
// Fans a CRDT update out to subscribers, skipping the origin subscriber to
// prevent echo loops. Desktop = BrowserWindow.webContents.send; mobile =
// in-process EventEmitter. sourceSubscriberId replaces desktop's sourceWindowId.
export interface EmitEvents {
  broadcast(noteId: string, update: Uint8Array, origin: string, sourceSubscriberId?: number): void
}
```

- [ ] **Step 4: Run tests, expect PASS + export from barrel.**

```bash
pnpm --filter @memry/crdt-core test -- seams
```

Expect: `seams.test.ts` green. Add to `packages/crdt-core/src/index.ts`:

```ts
export type { YDocPersistence } from './persistence'
export type { NoteContentSource } from './note-content-source'
export type { EmitEvents } from './emit-events'
```

- [ ] **Step 5: Commit.**

```bash
git add packages/crdt-core
git commit -m "feat(crdt-core): define YDocPersistence, NoteContentSource, EmitEvents seams"
```

---

## Task 6: Extract the portable `CrdtDocManager` (the crux)

This is the hardest task; it is broken into guarded sub-cycles. The manager is the verbatim lifecycle logic of `CrdtProvider` with three substitutions: `this.persistence` becomes an injected `YDocPersistence | null`; the vault-seed path becomes `NoteContentSource.getNoteContent` + an injected `seedFragmentFromMarkdown`; `broadcastToWindows` becomes `this.emit.broadcast`. `windowId` is generalized to `subscriberId` but stays `number` so desktop `BrowserWindow` ids and the `sourceWindowId === -1` sync-step2 sentinel keep working unchanged.

**Files:**

- Create `packages/crdt-core/src/crdt-doc-manager.ts`
- Create `packages/crdt-core/src/crdt-doc-manager.test.ts` (portable lifecycle assertions, against fakes)
- Modify `packages/crdt-core/src/index.ts`

**Interfaces:**

- Consumes: `YDocPersistence`, `NoteContentSource`, `EmitEvents`, `Logger`, `MicrotaskBatchBroadcaster`, `compactYDoc`, `CrdtUpdateQueue`; `@memry/contracts/ipc-crdt` (`CRDT_FRAGMENT_NAME`), `@memry/shared` (`CRITIC_MARKUP_MARKS_ARRAY`).
- Produces:
  - `interface CrdtDocManagerOptions { persistence: YDocPersistence | null; contentSource: NoteContentSource; emit: EmitEvents; logger?: Logger; now?: () => number; inactiveDocLimit?: number; seedFragmentFromMarkdown: (markdown: string, fragment: Y.XmlFragment) => Promise<boolean>; repairFragment?: (fragment: Y.XmlFragment) => number }`
  - `type SnapshotPushFn = (noteId: string, state: Uint8Array) => Promise<void>`
  - `interface CrdtDocSizeMetric { noteId: string; encodedSizeBytes: number; accumulatedBytes: number; pendingSnapshotBytes: number; subscriberCount: number; lastTouchedAt: number }`
  - `interface CrdtOpenDocMetrics { count: number; totalEncodedSizeBytes: number; totalAccumulatedBytes: number; docs: CrdtDocSizeMetric[] }`
  - `class CrdtDocManager` with: `init(queue?, snapshotPush?)`, `open(noteId, subscriberId?, { skipSeed? })`, `close(noteId, subscriberId?)`, `closeIfInactive(noteId)`, `purge(noteId)`, `getDoc(noteId)`, `applyRemoteUpdate(noteId, update)`, `getStateVector(noteId)`, `getDiff(noteId, remoteSV)`, `applyIpcUpdate(noteId, arr, sourceSubscriberId)`, `applyIpcSyncStep2(noteId, arr)`, `initForNote(noteId, meta, tags?)`, `updateMeta(noteId, meta)`, `seedExistingDocs(entries, onProgress?, signal?)`, `seedNote(noteId)`, `pushAllSnapshots()`, `pushSnapshotForNote(noteId)`, `compactDoc(noteId)`, `getOpenNoteIds()`, `getDocSizeMetrics()`, `getOpenDocMetrics()`, `getSubscriberIds(noteId): number[]`, `destroy()`.
  - Constants `ORIGIN_LOCAL = 'local'`, `ORIGIN_NETWORK = 'network'`, `DEFAULT_INACTIVE_DOC_LIMIT = 32`, `ENCODED_SIZE_COMPACTION_THRESHOLD = 1024*1024`, `ACCUMULATED_BYTES_RECHECK_THRESHOLD = 512*1024`, `SIZE_CHECK_INTERVAL_MS = 60_000`.

Note: `pushSnapshotForNote` here is the binary-agnostic core (open→encode→push→close, skips only when encoded `state.length <= 4`); the desktop wrapper applies the binary-file guard before delegating. `initPersistence`/`isInitialized`/`wipeStorage`/`validateNoteForCrdt` do NOT live on the manager — they stay on the desktop wiring (Task 7).

**Steps:**

- [ ] **Step 1: Write the failing lifecycle test against fakes.** Create `packages/crdt-core/src/crdt-doc-manager.test.ts`. Port the portable assertions out of `crdt-provider.test.ts` (open/close/evict/compact/broadcast/state-vector/diff) but drive them through fake seams instead of the desktop `vi.mock('electron' | 'y-leveldb' | '../database/client' | …)` graph:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { CrdtDocManager } from './crdt-doc-manager'
import type { YDocPersistence } from './persistence'
import type { NoteContentSource } from './note-content-source'
import type { EmitEvents } from './emit-events'

function makeFakePersistence(): YDocPersistence {
  const store = new Map<string, Uint8Array>()
  return {
    async getYDoc(id) {
      const doc = new Y.Doc()
      const u = store.get(id)
      if (u) Y.applyUpdate(doc, u)
      return doc
    },
    async storeUpdate(id, update) {
      const doc = new Y.Doc()
      const prev = store.get(id)
      if (prev) Y.applyUpdate(doc, prev)
      Y.applyUpdate(doc, update)
      store.set(id, Y.encodeStateAsUpdate(doc))
    },
    async flushDocument() {},
    async clearDocument(id) {
      store.delete(id)
    },
    destroy() {}
  }
}

function makeManager(
  overrides: Partial<Parameters<typeof CrdtDocManager.prototype.constructor>[0]> = {}
) {
  const broadcasts: Array<{ noteId: string; origin: string; src?: number }> = []
  const emit: EmitEvents = {
    broadcast(noteId, _u, origin, src) {
      broadcasts.push({ noteId, origin, src })
    }
  }
  const contentSource: NoteContentSource = {
    async getNoteContent() {
      return null
    }
  }
  const manager = new CrdtDocManager({
    persistence: makeFakePersistence(),
    contentSource,
    emit,
    seedFragmentFromMarkdown: async () => false,
    now: () => 1000,
    ...overrides
  })
  return { manager, broadcasts }
}

describe('CrdtDocManager lifecycle', () => {
  it('opens a doc with the standard shared structure', async () => {
    const { manager } = makeManager()
    const doc = await manager.open('n1', 1)
    expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME)).toBeDefined()
    expect(doc.getMap('meta')).toBeDefined()
    expect(doc.getArray('tags')).toBeDefined()
    await manager.destroy()
  })

  it('reference-counts subscribers and closes on the last release', async () => {
    const { manager } = makeManager()
    await manager.open('n1', 1)
    await manager.open('n1', 2)
    await manager.close('n1', 1)
    expect(manager.getOpenNoteIds()).toContain('n1')
    await manager.close('n1', 2)
    expect(manager.getOpenNoteIds()).not.toContain('n1')
    await manager.destroy()
  })

  it('broadcasts local edits with ORIGIN_LOCAL and skips the source subscriber', async () => {
    const { manager, broadcasts } = makeManager()
    const doc = await manager.open('n1', 1)
    doc.getMap('meta').set('title', 'hello')
    await Promise.resolve()
    expect(broadcasts.some((b) => b.noteId === 'n1' && b.origin === 'local')).toBe(true)
    await manager.destroy()
  })

  it('returns a state vector and a diff for an open doc', async () => {
    const { manager } = makeManager()
    const doc = await manager.open('n1', 1)
    doc.getText('body').insert(0, 'x')
    const sv = manager.getStateVector('n1')
    expect(sv).toBeInstanceOf(Uint8Array)
    const diff = manager.getDiff('n1', new Uint8Array())
    expect(diff && diff.byteLength).toBeGreaterThan(0)
    await manager.destroy()
  })

  it('evicts the least-recently-touched inactive doc past the limit', async () => {
    const { manager } = makeManager({ inactiveDocLimit: 1, now: () => Date.now() })
    await manager.open('a')
    await new Promise((r) => setTimeout(r, 2))
    await manager.open('b')
    await new Promise((r) => setTimeout(r, 2))
    await manager.open('c')
    const open = manager.getOpenNoteIds()
    expect(open.length).toBeLessThanOrEqual(1)
    await manager.destroy()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
pnpm --filter @memry/crdt-core test -- crdt-doc-manager
```

Expect: FAIL — `Cannot find module './crdt-doc-manager'`.

- [ ] **Step 3: Write the manager — header, options, constructor.** Create `packages/crdt-core/src/crdt-doc-manager.ts`. Lift the body of `CrdtProvider` from `crdt-provider.ts` with the three seam substitutions. Header:

```ts
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { CRITIC_MARKUP_MARKS_ARRAY } from '@memry/shared'
import { noopLogger, type Logger } from './logger'
import type { YDocPersistence } from './persistence'
import type { NoteContentSource } from './note-content-source'
import type { EmitEvents } from './emit-events'
import { MicrotaskBatchBroadcaster } from './microtask-batch-broadcaster'
import { compactYDoc } from './crdt-compact-utils'
import type { CrdtUpdateQueue } from './crdt-queue'

interface IpcOrigin {
  source: 'ipc'
  subscriberId: number
}

export const ORIGIN_NETWORK = 'network'
export const ORIGIN_LOCAL = 'local'
const SIZE_CHECK_INTERVAL_MS = 60_000
const ENCODED_SIZE_COMPACTION_THRESHOLD = 1024 * 1024
const ACCUMULATED_BYTES_RECHECK_THRESHOLD = 512 * 1024
export const DEFAULT_INACTIVE_DOC_LIMIT = 32

export type SnapshotPushFn = (noteId: string, state: Uint8Array) => Promise<void>

export interface CrdtDocManagerOptions {
  persistence: YDocPersistence | null
  contentSource: NoteContentSource
  emit: EmitEvents
  logger?: Logger
  now?: () => number
  inactiveDocLimit?: number
  seedFragmentFromMarkdown: (markdown: string, fragment: Y.XmlFragment) => Promise<boolean>
  repairFragment?: (fragment: Y.XmlFragment) => number
}

export interface CrdtDocSizeMetric {
  noteId: string
  encodedSizeBytes: number
  accumulatedBytes: number
  pendingSnapshotBytes: number
  subscriberCount: number
  lastTouchedAt: number
}

export interface CrdtOpenDocMetrics {
  count: number
  totalEncodedSizeBytes: number
  totalAccumulatedBytes: number
  docs: CrdtDocSizeMetric[]
}

interface ActiveDoc {
  doc: Y.Doc
  subscriberIds: Set<number>
  accumulatedBytes: number
  pendingSnapshotBytes: number
  lastEncodedSize: number
  lastSizeCheckAt: number
  lastTouchedAt: number
  closing?: boolean
}

export class CrdtDocManager {
  private docs = new Map<string, ActiveDoc>()
  private openLocks = new Map<string, Promise<Y.Doc>>()
  private readonly persistence: YDocPersistence | null
  private readonly contentSource: NoteContentSource
  private readonly emit: EmitEvents
  private readonly log: Logger
  private readonly now: () => number
  private readonly inactiveDocLimit: number
  private readonly seedFragmentFromMarkdown: (m: string, f: Y.XmlFragment) => Promise<boolean>
  private readonly repairFragment: (f: Y.XmlFragment) => number
  private updateQueue: CrdtUpdateQueue | null = null
  private snapshotPushFn: SnapshotPushFn | null = null
  private compactingDocs = new Set<string>()
  private compactionBuffers = new Map<string, Uint8Array[]>()
  private networkBatcher = new MicrotaskBatchBroadcaster((noteId, merged) => {
    this.emit.broadcast(noteId, merged, ORIGIN_NETWORK, undefined)
  })

  constructor(options: CrdtDocManagerOptions) {
    this.persistence = options.persistence
    this.contentSource = options.contentSource
    this.emit = options.emit
    this.log = options.logger ?? noopLogger
    this.now = options.now ?? Date.now
    this.inactiveDocLimit = Math.max(1, options.inactiveDocLimit ?? DEFAULT_INACTIVE_DOC_LIMIT)
    this.seedFragmentFromMarkdown = options.seedFragmentFromMarkdown
    this.repairFragment = options.repairFragment ?? (() => 0)
  }

  async init(queue?: CrdtUpdateQueue, snapshotPush?: SnapshotPushFn): Promise<void> {
    this.updateQueue = queue ?? null
    this.snapshotPushFn = snapshotPush ?? null
    this.log.debug('CrdtDocManager sync callbacks updated')
  }

  getSubscriberIds(noteId: string): number[] {
    const entry = this.docs.get(noteId)
    return entry ? Array.from(entry.subscriberIds) : []
  }
```

- [ ] **Step 4: Write the manager — lifecycle methods (verbatim moves with the 3 substitutions).** Port `open`/`doOpen`/`close`/`closeIfInactive`/`purge`/`getDoc`/`applyRemoteUpdate`/`getStateVector`/`getDiff`/`destroy`/`getOpenNoteIds`/`getDocSizeMetrics`/`getOpenDocMetrics`/`initForNote`/`updateMeta`/`seedExistingDocs`/`onDocUpdate`/`queueNetworkBroadcast`/`flushNetworkBroadcast`/`persistUpdate`/`maybeCompact`/`checkAndCompact`/`flushDoc`/`touchDoc`/`measureDocSize`/`evictInactiveDocsIfNeeded`/`compactDoc`/`applyIpcUpdate`/`applyIpcSyncStep2` from `crdt-provider.ts:190-897` unchanged EXCEPT the mechanical substitutions below. The rename `windowId → subscriberId`/`windowIds → subscriberIds` keeps type `number`. `doOpen`'s persisted-load branch and `onDocUpdate`'s routing are the byte-sensitive parts and MUST keep call order; here they are with substitutions applied:

```ts
  private async doOpen(
    noteId: string,
    subscriberId?: number,
    options?: { skipSeed?: boolean }
  ): Promise<Y.Doc> {
    const doc = new Y.Doc({ guid: noteId })
    this.initDocStructure(doc)

    if (this.persistence) {
      try {
        const persisted = await this.persistence.getYDoc(noteId)
        if (persisted) {
          const update = Y.encodeStateAsUpdate(persisted)
          Y.applyUpdate(doc, update)
          persisted.destroy()
          let repaired = 0
          doc.transact(() => {
            repaired = this.repairFragment(doc.getXmlFragment(CRDT_FRAGMENT_NAME))
          }, ORIGIN_LOCAL)
          if (repaired > 0) {
            this.log.info('Repaired empty block ids in persisted note', { noteId, count: repaired })
            await this.persistence.storeUpdate(noteId, Y.encodeStateAsUpdate(doc))
          }
        } else {
          this.log.warn('CRDT persistence returned empty doc; continuing in-memory', { noteId })
        }
      } catch (err) {
        this.log.error('Failed to load persisted CRDT doc; seeding from content source', {
          noteId,
          error: err
        })
      }
    }

    if (!options?.skipSeed) {
      await this.seedNote(noteId, doc)
    }

    const entry: ActiveDoc = {
      doc,
      subscriberIds: new Set(subscriberId ? [subscriberId] : []),
      accumulatedBytes: 0,
      pendingSnapshotBytes: 0,
      lastEncodedSize: 0,
      lastSizeCheckAt: 0,
      lastTouchedAt: this.now()
    }
    this.docs.set(noteId, entry)

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.onDocUpdate(noteId, update, origin)
    })

    await this.evictInactiveDocsIfNeeded()

    return doc
  }

  private onDocUpdate(noteId: string, update: Uint8Array, origin: unknown): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    this.touchDoc(entry)
    entry.accumulatedBytes += update.byteLength
    if (origin !== ORIGIN_NETWORK) {
      entry.pendingSnapshotBytes += update.byteLength
    }

    if (isIpcOrigin(origin)) {
      this.emit.broadcast(noteId, update, 'ipc', origin.subscriberId)
    } else if (origin === ORIGIN_NETWORK) {
      this.networkBatcher.enqueue(noteId, update)
    } else {
      this.emit.broadcast(noteId, update, ORIGIN_LOCAL, undefined)
    }

    this.persistUpdate(noteId, update)
    this.maybeCompact(noteId)

    if (origin !== ORIGIN_NETWORK && this.updateQueue) {
      this.updateQueue.enqueue(noteId, update)
    }
  }
```

Note the desktop-only side effects that were inline in `onDocUpdate` (`recordNetworkUpdate`, `scheduleWriteback`) are NOT in the portable core — they move to a post-update hook wired by the desktop (Task 7) via a `doc.on('update')` listener the desktop attaches to `getDoc(noteId)` after open. `broadcastToWindows` is fully replaced by `this.emit.broadcast`; `getSubscriberIds` gives the desktop `EmitEvents` the per-note subscriber set.

- [ ] **Step 5: Write the manager — seed + structure helpers.** `initDocStructure` moves verbatim; `seedFromMarkdown` becomes `seedNote` using the injected seam:

```ts
  private initDocStructure(doc: Y.Doc): void {
    doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    doc.getMap('meta')
    doc.getArray('tags')
    doc.getArray(CRITIC_MARKUP_MARKS_ARRAY)
  }

  async seedNote(noteId: string, doc?: Y.Doc): Promise<void> {
    const target = doc ?? this.docs.get(noteId)?.doc
    if (!target) return
    const fragment = target.getXmlFragment(CRDT_FRAGMENT_NAME)
    if (fragment.length > 0) return

    const markdown = await this.contentSource.getNoteContent(noteId)
    if (!markdown || !markdown.trim()) return

    const ok = await this.seedFragmentFromMarkdown(markdown, fragment)
    if (ok && this.persistence) {
      await this.persistence.storeUpdate(noteId, Y.encodeStateAsUpdate(target)).catch((err) => {
        this.log.error('Failed to persist markdown-seeded CRDT doc', { noteId, error: err })
      })
    }
  }
```

`pushAllSnapshots` and `pushSnapshotForNote` move verbatim except the binary guard is dropped from the core `pushSnapshotForNote` (it stays open→encode→`state.length <= 4` skip→push→close; the desktop wrapper does the binary check first). `destroy` drops `flushPendingWritebacks()` (desktop-only; moves to the desktop wrapper) but keeps `this.networkBatcher.flushAll()` and the doc flush/destroy loop.

- [ ] **Step 6: Run tests, expect PASS + barrel export.**

```bash
pnpm --filter @memry/crdt-core test -- crdt-doc-manager
```

Expect: all `CrdtDocManager lifecycle` cases green. Add to `packages/crdt-core/src/index.ts`:

```ts
export {
  CrdtDocManager,
  ORIGIN_LOCAL,
  ORIGIN_NETWORK,
  DEFAULT_INACTIVE_DOC_LIMIT
} from './crdt-doc-manager'
export type {
  CrdtDocManagerOptions,
  SnapshotPushFn,
  CrdtDocSizeMetric,
  CrdtOpenDocMetrics
} from './crdt-doc-manager'
```

- [ ] **Step 7: Add the byte-order golden test.** Append to `crdt-doc-manager.test.ts` a test proving the merged/encoded bytes are stable, guarding the byte-identity invariant:

```ts
it('encodeStateAsUpdate output is byte-stable for a known edit sequence', async () => {
  const build = () => {
    const doc = new Y.Doc({ guid: 'g' })
    doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    doc.getMap('meta').set('title', 'T')
    doc.getArray('tags').push(['a', 'b'])
    return Y.encodeStateAsUpdate(doc)
  }
  expect(Array.from(build())).toEqual(Array.from(build()))
})
```

Run `pnpm --filter @memry/crdt-core test -- crdt-doc-manager`; expect green.

- [ ] **Step 8: Commit.**

```bash
git add packages/crdt-core
git commit -m "feat(crdt-core): extract portable CrdtDocManager behind persistence/content/emit seams"
```

---

## Task 7: Rewrite desktop `crdt-provider.ts` as thin wiring + leveldb adapter

**Files:**

- Create `apps/desktop/src/main/sync/crdt-leveldb-persistence.ts`
- Modify `apps/desktop/src/main/sync/crdt-provider.ts` (968 lines → thin wiring)
- Keep `apps/desktop/src/main/sync/crdt-provider.test.ts` (desktop-wiring assertions only; portable ones already moved in Task 6)
- Modify `apps/desktop/src/main/sync/crdt-writeback.ts` (no logic change — confirm import resolves)

**Interfaces:**

- Consumes: `CrdtDocManager`, `ORIGIN_LOCAL`, `SnapshotPushFn`, `CrdtDocSizeMetric`, `CrdtOpenDocMetrics`, `YDocPersistence`, `NoteContentSource`, `EmitEvents` from `@memry/crdt-core`; `LeveldbPersistence` from `y-leveldb`; existing desktop helpers (`getIndexDatabase`, `getNoteCacheById`, `safeRead`, `toAbsolutePath`, `parseNote`, `isBinaryFileType`, `markdownToYFragment`, `repairEmptyBlockIds`, `runCrdtPreflight`, `scheduleWriteback`, `recordNetworkUpdate`, `flushPendingWritebacks`, `createLogger`).
- Produces (UNCHANGED public surface — 22 importers depend on it): `class CrdtProvider`; `getCrdtProvider(): CrdtProvider`; `resetCrdtProvider(): void`; `const ORIGIN_LOCAL`; `type SnapshotPushFn`; `interface CrdtProviderOptions`; `interface CrdtDocSizeMetric`; `interface CrdtOpenDocMetrics`. All methods enumerated by desktop callers (`init`, `initPersistence`, `isInitialized`, `open`, `close`, `closeIfInactive`, `purge`, `getDoc`, `applyRemoteUpdate`, `getStateVector`, `getDiff`, `destroy`, `getOpenNoteIds`, `getDocSizeMetrics`, `getOpenDocMetrics`, `wipeStorage`, `pushAllSnapshots`, `pushSnapshotForNote`, `initForNote`, `updateMeta`, `seedExistingDocs`, `seedFromMarkdownPublic`, `validateNoteForCrdt`, `applyIpcUpdate`, `applyIpcSyncStep2`, `compactDoc`) remain callable with identical signatures.

**Steps:**

- [ ] **Step 1: Move the leveldb hardening into an adapter (the failing gate is the existing preflight/persistence assertions in `crdt-provider.test.ts`).** Create `apps/desktop/src/main/sync/crdt-leveldb-persistence.ts` implementing `YDocPersistence`, lifting `doInitPersistence` + `probePersistence` verbatim from `crdt-provider.ts:109-184, 900-946`:

```ts
import * as Y from 'yjs'
import path from 'path'
import { existsSync, renameSync } from 'fs'
import { app } from 'electron'
import { LeveldbPersistence } from 'y-leveldb'
import type { YDocPersistence } from '@memry/crdt-core'
import { createLogger } from '../lib/logger'
import { runCrdtPreflight } from './crdt-preflight'

const log = createLogger('CrdtLeveldbPersistence')
const PERSISTENCE_PROBE_KEY = '__memry_crdt_probe__'
const PERSISTENCE_PROBE_TIMEOUT_MS = 15_000

export function crdtStoragePath(): string {
  return path.join(app.getPath('userData'), 'crdt-store')
}

// Returns a hardened YDocPersistence, or null when the native binding is
// broken (degrade to in-memory: notes still load from vault files).
export async function createLeveldbPersistence(): Promise<YDocPersistence | null> {
  const storagePath = crdtStoragePath()
  try {
    let preflight = await runCrdtPreflight(storagePath)
    if (!preflight.ok && existsSync(storagePath)) {
      const quarantinePath = `${storagePath}.broken-${Date.now()}`
      renameSync(storagePath, quarantinePath)
      preflight = await runCrdtPreflight(storagePath)
      if (preflight.ok) {
        log.warn('CRDT store quarantined after failed preflight — continuing with a fresh store', {
          storagePath,
          quarantinePath
        })
      } else {
        try {
          renameSync(quarantinePath, storagePath)
        } catch (restoreErr) {
          log.warn('Failed to restore quarantined CRDT store', {
            quarantinePath,
            error: restoreErr
          })
        }
      }
    }
    if (!preflight.ok) {
      throw new Error(`CRDT store preflight failed: ${preflight.reason ?? 'unknown'}`)
    }
    const persistence = new LeveldbPersistence(storagePath) as YDocPersistence
    await probePersistence(persistence)
    log.debug('CRDT persistence initialized', { storagePath })
    return persistence
  } catch (err) {
    log.error(
      'CRDT persistence unavailable — continuing in-memory (notes still load from vault files)',
      { storagePath, error: err }
    )
    return null
  }
}

async function probePersistence(persistence: YDocPersistence): Promise<void> {
  const probeDoc = new Y.Doc()
  probeDoc.getMap('probe').set('ok', true)
  const update = Y.encodeStateAsUpdate(probeDoc)
  probeDoc.destroy()

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener('uncaughtException', onUncaught)
      fn()
    }
    const onUncaught = (err: Error): void => settle(() => reject(err))
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new Error(`CRDT persistence probe timed out after ${PERSISTENCE_PROBE_TIMEOUT_MS}ms`)
          )
        ),
      PERSISTENCE_PROBE_TIMEOUT_MS
    )
    process.prependListener('uncaughtException', onUncaught)

    Promise.resolve()
      .then(async () => {
        await persistence.storeUpdate(PERSISTENCE_PROBE_KEY, update)
        const loaded = await persistence.getYDoc(PERSISTENCE_PROBE_KEY)
        loaded.destroy()
        await persistence.clearDocument(PERSISTENCE_PROBE_KEY)
      })
      .then(
        () => settle(resolve),
        (err) => settle(() => reject(err instanceof Error ? err : new Error(String(err))))
      )
  })
}
```

- [ ] **Step 2: Rewrite `crdt-provider.ts` as thin wiring.** Overwrite `apps/desktop/src/main/sync/crdt-provider.ts` so `CrdtProvider` composes a `CrdtDocManager` from the desktop adapters and delegates every method. Key wiring (persistence lazy-init preserved for `initPersistence`/`isInitialized`; forward-reference closure so `BrowserWindowEmitEvents` can read the manager's subscriber set):

```ts
import * as Y from 'yjs'
import { BrowserWindow } from 'electron'
import { CRDT_EVENTS, CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  CrdtDocManager,
  ORIGIN_LOCAL,
  type SnapshotPushFn,
  type CrdtDocSizeMetric,
  type CrdtOpenDocMetrics,
  type YDocPersistence,
  type NoteContentSource,
  type EmitEvents,
  type CrdtUpdateQueue
} from '@memry/crdt-core'
import { createLogger } from '../lib/logger'
import { getIndexDatabase } from '../database/client'
import { getNoteCacheById } from '@main/database/queries/notes'
import { scheduleWriteback, flushPendingWritebacks, recordNetworkUpdate } from './crdt-writeback'
import { toAbsolutePath } from '../vault/notes'
import { safeRead } from '../vault/file-ops'
import { parseNote } from '../vault/frontmatter'
import { markdownToYFragment, repairEmptyBlockIds } from './blocknote-converter'
import { isBinaryFileType } from '@memry/shared/file-types'
import { createLeveldbPersistence, crdtStoragePath } from './crdt-leveldb-persistence'

const log = createLogger('CrdtProvider')

export { ORIGIN_LOCAL }
export type { SnapshotPushFn, CrdtDocSizeMetric, CrdtOpenDocMetrics }

export interface CrdtProviderOptions {
  inactiveDocLimit?: number
  now?: () => number
}

// Desktop NoteContentSource: vault index-DB hydration; null for binary/missing/empty.
class VaultNoteContentSource implements NoteContentSource {
  async getNoteContent(noteId: string): Promise<string | null> {
    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, noteId)
    if (!cached) return null
    if (cached.fileType && isBinaryFileType(cached.fileType)) return null
    const raw = await safeRead(toAbsolutePath(cached.path))
    if (!raw) return null
    const parsed = parseNote(raw, cached.path)
    return parsed.content?.trim() ? parsed.content : null
  }
}

// Desktop EmitEvents: fan out to the note's subscriber windows, skip source.
class BrowserWindowEmitEvents implements EmitEvents {
  constructor(private getSubscriberIds: (noteId: string) => number[]) {}
  broadcast(noteId: string, update: Uint8Array, origin: string, sourceSubscriberId?: number): void {
    const ids = this.getSubscriberIds(noteId)
    for (const windowId of ids) {
      if (windowId === sourceSubscriberId) continue
      const win = BrowserWindow.fromId(windowId)
      if (win && !win.isDestroyed()) {
        win.webContents.send(CRDT_EVENTS.STATE_CHANGED, {
          noteId,
          update: Array.from(update),
          origin
        })
      }
    }
  }
}

export class CrdtProvider {
  private manager: CrdtDocManager
  private persistenceReady = false
  private persistenceInitPromise: Promise<void> | null = null
  private writebackHooked = new Set<string>()

  constructor(options: CrdtProviderOptions = {}) {
    let manager!: CrdtDocManager
    const emit = new BrowserWindowEmitEvents((noteId) => manager.getSubscriberIds(noteId))
    manager = new CrdtDocManager({
      persistence: null,
      contentSource: new VaultNoteContentSource(),
      emit,
      logger: log,
      now: options.now,
      inactiveDocLimit: options.inactiveDocLimit,
      seedFragmentFromMarkdown: (markdown, fragment) => markdownToYFragment(markdown, fragment),
      repairFragment: (fragment) => repairEmptyBlockIds(fragment)
    })
    this.manager = manager
  }

  async init(queue?: CrdtUpdateQueue, snapshotPush?: SnapshotPushFn): Promise<void> {
    await this.initPersistence()
    await this.manager.init(queue, snapshotPush)
  }

  async initPersistence(): Promise<void> {
    if (this.persistenceReady) return
    if (!this.persistenceInitPromise) {
      this.persistenceInitPromise = createLeveldbPersistence()
        .then((persistence) => {
          ;(this.manager as unknown as { persistence: YDocPersistence | null }).persistence =
            persistence
          this.persistenceReady = true
        })
        .finally(() => {
          this.persistenceInitPromise = null
        })
    }
    return this.persistenceInitPromise
  }

  isInitialized(): boolean {
    return this.persistenceReady
  }

  async open(noteId: string, windowId?: number, options?: { skipSeed?: boolean }): Promise<Y.Doc> {
    const doc = await this.manager.open(noteId, windowId, options)
    this.hookWriteback(noteId, doc)
    return doc
  }

  // Desktop-only side effects removed from the portable core: attach a writeback
  // listener the first time a doc is opened so network/ipc updates trigger vault
  // writeback + network-update recording (previously inline in onDocUpdate).
  private hookWriteback(noteId: string, doc: Y.Doc): void {
    if (this.writebackHooked.has(noteId)) return
    this.writebackHooked.add(noteId)
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      const isIpc =
        typeof origin === 'object' &&
        origin !== null &&
        (origin as { source?: string }).source === 'ipc'
      if (origin === 'network') recordNetworkUpdate(noteId)
      if (origin === 'network' || isIpc) scheduleWriteback(noteId, doc)
    })
  }

  validateNoteForCrdt(noteId: string): { ok: true } | { ok: false; error: string } {
    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, noteId)
    if (!cached) return { ok: false, error: `Note not found: ${noteId}` }
    if (cached.fileType && isBinaryFileType(cached.fileType)) {
      return { ok: false, error: `Binary notes do not use CRDT: ${noteId}` }
    }
    return { ok: true }
  }

  async pushSnapshotForNote(noteId: string): Promise<boolean> {
    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, noteId)
    if (cached?.fileType && isBinaryFileType(cached.fileType)) {
      log.debug('Skipping CRDT snapshot push for binary note', {
        noteId,
        fileType: cached.fileType
      })
      return false
    }
    return this.manager.pushSnapshotForNote(noteId)
  }

  async destroy(): Promise<void> {
    await flushPendingWritebacks()
    this.writebackHooked.clear()
    await this.manager.destroy()
    this.persistenceReady = false
  }

  async wipeStorage(): Promise<void> {
    await this.destroy()
    const storagePath = crdtStoragePath()
    try {
      const { rmSync } = await import('fs')
      rmSync(storagePath, { recursive: true, force: true })
      log.info('CRDT storage wiped', { storagePath })
    } catch (err) {
      log.warn('Failed to wipe CRDT storage', { storagePath, error: err })
    }
  }

  // Straight delegations (identical signatures the 22 importers call):
  close(noteId: string, windowId?: number) {
    return this.manager.close(noteId, windowId)
  }
  closeIfInactive(noteId: string) {
    return this.manager.closeIfInactive(noteId)
  }
  purge(noteId: string) {
    return this.manager.purge(noteId)
  }
  getDoc(noteId: string) {
    return this.manager.getDoc(noteId)
  }
  applyRemoteUpdate(noteId: string, update: Uint8Array) {
    this.manager.applyRemoteUpdate(noteId, update)
  }
  getStateVector(noteId: string) {
    return this.manager.getStateVector(noteId)
  }
  getDiff(noteId: string, remoteSV: Uint8Array) {
    return this.manager.getDiff(noteId, remoteSV)
  }
  getOpenNoteIds() {
    return this.manager.getOpenNoteIds()
  }
  getDocSizeMetrics() {
    return this.manager.getDocSizeMetrics()
  }
  getOpenDocMetrics() {
    return this.manager.getOpenDocMetrics()
  }
  pushAllSnapshots() {
    return this.manager.pushAllSnapshots()
  }
  initForNote(noteId: string, meta: { title?: string; date?: string }, tags?: string[]) {
    return this.manager.initForNote(noteId, meta, tags)
  }
  updateMeta(noteId: string, meta: { title?: string; date?: string }) {
    this.manager.updateMeta(noteId, meta)
  }
  seedExistingDocs(
    entries: Array<{ id: string; title?: string; date?: string; tags?: string[] }>,
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal
  ) {
    return this.manager.seedExistingDocs(entries, onProgress, signal)
  }
  async seedFromMarkdownPublic(noteId: string) {
    await this.manager.seedNote(noteId)
  }
  compactDoc(noteId: string) {
    return this.manager.compactDoc(noteId)
  }
  applyIpcUpdate(noteId: string, updateArr: number[], sourceWindowId: number) {
    this.manager.applyIpcUpdate(noteId, updateArr, sourceWindowId)
  }
  applyIpcSyncStep2(noteId: string, diffArr: number[]) {
    this.manager.applyIpcSyncStep2(noteId, diffArr)
  }
}

let instance: CrdtProvider | null = null

export function getCrdtProvider(): CrdtProvider {
  if (!instance) instance = new CrdtProvider()
  return instance
}

export function resetCrdtProvider(): void {
  instance = null
}
```

(If injecting persistence via a cast reads poorly, add a `setPersistence(p: YDocPersistence | null): void` method to `CrdtDocManager` in Task 6 and call `this.manager.setPersistence(persistence)` instead of the cast. Prefer the explicit setter.)

- [ ] **Step 3: Repartition `crdt-provider.test.ts` — keep only desktop-wiring assertions.** In `apps/desktop/src/main/sync/crdt-provider.test.ts`, delete the portable lifecycle cases already covered by `crdt-doc-manager.test.ts` (open/close/evict/compact/broadcast/state-vector/diff pure paths). KEEP the desktop-specific cases: leveldb preflight quarantine/restore, in-memory degrade, vault seeding through `VaultNoteContentSource`, binary-note snapshot skip, writeback scheduling on network/ipc updates, and the `getCrdtProvider`/`resetCrdtProvider` singleton. These still `vi.mock('electron' | 'y-leveldb' | '../database/client' | '@main/database/queries/notes' | '../vault/*' | './blocknote-converter' | './crdt-writeback' | './crdt-preflight')` as before.

- [ ] **Step 4: Run the desktop main suite, expect PASS.**

```bash
pnpm --filter @memry/desktop test:main -- crdt-provider crdt-ipc-handlers crdt-writeback session-teardown runtime watcher
pnpm --filter @memry/desktop typecheck:node
pnpm typecheck
```

Expect: all listed specs green; `typecheck:node` exit 0 (proves all 22 importers of `getCrdtProvider`/`ORIGIN_LOCAL`/`CrdtProvider` still resolve). If a native load error (`ERR_DLOPEN_FAILED`) appears, run `pnpm --filter @memry/desktop rebuild:node` and re-run.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/main/sync/crdt-leveldb-persistence.ts apps/desktop/src/main/sync/crdt-provider.ts apps/desktop/src/main/sync/crdt-provider.test.ts
git commit -m "refactor(crdt): split crdt-provider into CrdtDocManager wiring + leveldb adapter"
```

---

## Task 8: Move `crdt-feed` behind an injected getDoc + converters

**Files:**

- Create `packages/crdt-core/src/crdt-feed.ts` (moved; injected deps)
- Create `packages/crdt-core/src/crdt-feed.test.ts` (moved; fakes)
- Modify `apps/desktop/src/main/sync/crdt-feed.ts` → thin shim binding the singleton + converters
- Modify `packages/crdt-core/src/index.ts`
- Delete `apps/desktop/src/main/sync/crdt-feed.test.ts`

**Interfaces:**

- Produces:
  - `interface CrdtFeedDeps { getDoc(noteId: string): Y.Doc | undefined; markdownToBlocks(markdown: string): Promise<unknown[] | null>; blocksToYFragment(blocks: unknown[], fragment: Y.XmlFragment): void }`
  - `replaceNoteBodyInCrdt(noteId: string, markdown: string, deps: CrdtFeedDeps): Promise<boolean>`
  - `replaceNoteTagsInCrdt(noteId: string, tags: string[], getDoc: (noteId: string) => Y.Doc | undefined): boolean`
- Consumes: `yjs`, `ORIGIN_LOCAL` from `./crdt-doc-manager`.

**Steps:**

- [ ] **Step 1: Write the failing test against fakes.** Create `packages/crdt-core/src/crdt-feed.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { replaceNoteBodyInCrdt, replaceNoteTagsInCrdt } from './crdt-feed'

function fakeDeps(doc: Y.Doc) {
  return {
    getDoc: () => doc,
    markdownToBlocks: async (md: string) => (md ? [{ text: md }] : null),
    blocksToYFragment: (blocks: unknown[], fragment: Y.XmlFragment) => {
      const el = new Y.XmlElement('paragraph')
      const t = new Y.XmlText()
      t.insert(0, JSON.stringify(blocks))
      el.insert(0, [t])
      fragment.insert(fragment.length, [el])
    }
  }
}

describe('crdt-feed', () => {
  it('replaces the note body fragment', async () => {
    const doc = new Y.Doc()
    doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlElement('paragraph')])
    const ok = await replaceNoteBodyInCrdt('n1', 'hello', fakeDeps(doc))
    expect(ok).toBe(true)
    expect(doc.getXmlFragment('prosemirror').length).toBe(1)
  })

  it('returns false when the doc is not open', async () => {
    const ok = await replaceNoteBodyInCrdt('n1', 'hi', {
      ...fakeDeps(new Y.Doc()),
      getDoc: () => undefined
    })
    expect(ok).toBe(false)
  })

  it('replaces the tag array', () => {
    const doc = new Y.Doc()
    const ok = replaceNoteTagsInCrdt('n1', ['a', 'b'], () => doc)
    expect(ok).toBe(true)
    expect(doc.getArray('tags').toJSON()).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
pnpm --filter @memry/crdt-core test -- crdt-feed
```

Expect: FAIL — `Cannot find module './crdt-feed'`.

- [ ] **Step 3: Write the moved `crdt-feed.ts` with injected deps.** Create `packages/crdt-core/src/crdt-feed.ts` — same body/transaction order as the source (byte-preserving), converters + getDoc injected:

```ts
import type * as Y from 'yjs'
import { ORIGIN_LOCAL } from './crdt-doc-manager'

export interface CrdtFeedDeps {
  getDoc(noteId: string): Y.Doc | undefined
  markdownToBlocks(markdown: string): Promise<unknown[] | null>
  blocksToYFragment(blocks: unknown[], fragment: Y.XmlFragment): void
}

export async function replaceNoteBodyInCrdt(
  noteId: string,
  markdown: string,
  deps: CrdtFeedDeps
): Promise<boolean> {
  const doc = deps.getDoc(noteId)
  if (!doc) return false

  const blocks = await deps.markdownToBlocks(markdown)
  if (!blocks) return false

  const fragment = doc.getXmlFragment('prosemirror')
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    deps.blocksToYFragment(blocks, fragment)
  }, ORIGIN_LOCAL)

  return true
}

export function replaceNoteTagsInCrdt(
  noteId: string,
  tags: string[],
  getDoc: (noteId: string) => Y.Doc | undefined
): boolean {
  const doc = getDoc(noteId)
  if (!doc) return false

  const tagArray = doc.getArray('tags')
  doc.transact(() => {
    tagArray.delete(0, tagArray.length)
    if (tags.length > 0) tagArray.push(tags)
  }, ORIGIN_LOCAL)

  return true
}
```

- [ ] **Step 4: Run tests, expect PASS + barrel export.**

```bash
pnpm --filter @memry/crdt-core test -- crdt-feed
```

Expect: green. Add to `packages/crdt-core/src/index.ts`:

```ts
export { replaceNoteBodyInCrdt, replaceNoteTagsInCrdt } from './crdt-feed'
export type { CrdtFeedDeps } from './crdt-feed'
```

- [ ] **Step 5: Replace the desktop `crdt-feed.ts` with a binding shim.** Overwrite `apps/desktop/src/main/sync/crdt-feed.ts` so the two exported functions keep their EXACT desktop signatures (`apply-template.ts` and `watcher.ts` call `replaceNoteBodyInCrdt(noteId, markdown)` / `replaceNoteTagsInCrdt(noteId, tags)` with two args):

```ts
import {
  replaceNoteBodyInCrdt as coreReplaceBody,
  replaceNoteTagsInCrdt as coreReplaceTags
} from '@memry/crdt-core'
import { getCrdtProvider } from './crdt-provider'
import { markdownToBlocks, blocksToYFragment } from './blocknote-converter'

export function replaceNoteBodyInCrdt(noteId: string, markdown: string): Promise<boolean> {
  const provider = getCrdtProvider()
  return coreReplaceBody(noteId, markdown, {
    getDoc: (id) => provider.getDoc(id),
    markdownToBlocks,
    blocksToYFragment
  })
}

export function replaceNoteTagsInCrdt(noteId: string, tags: string[]): boolean {
  const provider = getCrdtProvider()
  return coreReplaceTags(noteId, tags, (id) => provider.getDoc(id))
}
```

Delete `apps/desktop/src/main/sync/crdt-feed.test.ts` (moved).

- [ ] **Step 6: Verify desktop green.**

```bash
pnpm --filter @memry/crdt-core test
pnpm --filter @memry/desktop test:main -- apply-template watcher
pnpm typecheck
```

Expect: crdt-core green; `apply-template`/`watcher` specs green; typecheck exit 0.

- [ ] **Step 7: Commit.**

```bash
git add packages/crdt-core apps/desktop/src/main/sync/crdt-feed.ts
git rm apps/desktop/src/main/sync/crdt-feed.test.ts
git commit -m "refactor(crdt-core): move crdt-feed behind injected getDoc + markdown converters"
```

---

## Task 9: Move `crdt-encrypt` (GATED on @memry/crypto + @memry/sync-engine)

**PREREQUISITE — do NOT start until both are true:** `@memry/crypto` exports `encrypt`, `decrypt`, `wrapFileKey`, `unwrapFileKey`, `generateFileKey`, `secureCleanup`, and a ready `SodiumProvider` (with `crypto_sign_detached` / `crypto_sign_verify_detached`); `@memry/sync-engine` exports `compressPayload`, `decompressPayload`, `SignatureVerificationError`. Verify with `ls packages/crypto packages/sync-engine`. If either is missing, STOP — leave `crdt-encrypt.ts` at its desktop path; desktop stays green because nothing moves.

**Files:**

- Create `packages/crdt-core/src/crdt-encrypt.ts` (moved; imports from the two new packages)
- Create `packages/crdt-core/src/crdt-encrypt.test.ts` (moved)
- Modify `apps/desktop/src/main/sync/crdt-encrypt.ts` → re-export shim
- Modify `packages/crdt-core/package.json` (add `@memry/crypto`, `@memry/sync-engine`)
- Modify `packages/crdt-core/src/index.ts`
- Delete `apps/desktop/src/main/sync/crdt-encrypt.test.ts`

**Interfaces:**

- Consumes: `@memry/crypto` (`encrypt`, `decrypt`, `wrapFileKey`, `unwrapFileKey`, `generateFileKey`, `secureCleanup`, `getSodium()`); `@memry/sync-engine` (`compressPayload`, `decompressPayload`, `SignatureVerificationError`).
- Produces (UNCHANGED signatures — `runtime.ts` + `crdt-sync-coordinator.ts` call these): `encryptCrdtUpdate(update: Uint8Array, vaultKey: Uint8Array, noteId: string, signingSecretKey: Uint8Array): Uint8Array`; `decryptCrdtUpdate(packed: Uint8Array, vaultKey: Uint8Array, noteId: string, signerPublicKey: Uint8Array): Uint8Array`. Header layout constants `NONCE_LEN=24`, `WRAPPED_KEY_LEN=48`, `SIGNATURE_LEN=64`, `HEADER_LEN=160` and `buildSignedPayload` MUST be identical (cross-device crypto interop / byte-identity invariant).

**Steps:**

- [ ] **Step 1: Add the two deps + move the test (the moved test is the byte-compat gate).** Add to `packages/crdt-core/package.json` dependencies: `"@memry/crypto": "workspace:*"`, `"@memry/sync-engine": "workspace:*"`; run `pnpm install`. Copy `apps/desktop/src/main/sync/crdt-encrypt.test.ts` to `packages/crdt-core/src/crdt-encrypt.test.ts`, repointing its imports: `initCrypto`/sodium init and `encrypt`/`decrypt` helpers from `@memry/crypto`, `SignatureVerificationError` from `@memry/sync-engine`, and `encryptCrdtUpdate`/`decryptCrdtUpdate` from `./crdt-encrypt`. The existing round-trip + tamper + wrong-signer assertions are the proof of byte compatibility.

- [ ] **Step 2: Run it, expect FAIL.**

```bash
pnpm --filter @memry/crdt-core test -- crdt-encrypt
```

Expect: FAIL — `Cannot find module './crdt-encrypt'`.

- [ ] **Step 3: Write the moved `crdt-encrypt.ts`.** Create `packages/crdt-core/src/crdt-encrypt.ts` — body identical to the source (same offsets, same `buildSignedPayload`, same finally/`secureCleanup`), only the import sources change and raw `sodium` comes from `@memry/crypto`'s `SodiumProvider`:

```ts
import { getSodium } from '@memry/crypto'
import {
  encrypt,
  decrypt,
  wrapFileKey,
  unwrapFileKey,
  generateFileKey,
  secureCleanup
} from '@memry/crypto'
import { compressPayload, decompressPayload } from '@memry/sync-engine'
import { SignatureVerificationError } from '@memry/sync-engine'

const NONCE_LEN = 24
const WRAPPED_KEY_LEN = 48
const SIGNATURE_LEN = 64
const HEADER_LEN = NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN + SIGNATURE_LEN

export function encryptCrdtUpdate(
  update: Uint8Array,
  vaultKey: Uint8Array,
  noteId: string,
  signingSecretKey: Uint8Array
): Uint8Array {
  const sodium = getSodium()
  const fileKey = generateFileKey()
  const noteIdBytes = new TextEncoder().encode(noteId)

  try {
    const compressed = compressPayload(update)
    const { ciphertext, nonce: dataNonce } = encrypt(compressed, fileKey, noteIdBytes)
    const { wrappedKey, nonce: keyNonce } = wrapFileKey(fileKey, vaultKey)

    const packedLen = HEADER_LEN + ciphertext.length
    const packed = new Uint8Array(packedLen)
    packed.set(dataNonce, 0)
    packed.set(keyNonce, NONCE_LEN)
    packed.set(wrappedKey, NONCE_LEN + NONCE_LEN)
    packed.set(ciphertext, HEADER_LEN)

    const bodyToSign = buildSignedPayload(noteIdBytes, packed)
    const signature = sodium.crypto_sign_detached(bodyToSign, signingSecretKey)
    packed.set(signature, NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN)

    return packed
  } finally {
    secureCleanup(fileKey)
  }
}

export function decryptCrdtUpdate(
  packed: Uint8Array,
  vaultKey: Uint8Array,
  noteId: string,
  signerPublicKey: Uint8Array
): Uint8Array {
  const sodium = getSodium()
  if (packed.length < HEADER_LEN + 1) {
    throw new Error(`CRDT update too short: ${packed.length} bytes`)
  }

  const noteIdBytes = new TextEncoder().encode(noteId)
  const signature = packed.subarray(
    NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN,
    NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN + SIGNATURE_LEN
  )

  const bodyToVerify = buildSignedPayload(noteIdBytes, packed)
  const valid = sodium.crypto_sign_verify_detached(signature, bodyToVerify, signerPublicKey)
  if (!valid) {
    const keyHex = bytesToHex(signerPublicKey).slice(0, 16)
    throw new SignatureVerificationError(noteId, `pubkey:${keyHex}`)
  }

  const dataNonce = packed.subarray(0, NONCE_LEN)
  const keyNonce = packed.subarray(NONCE_LEN, NONCE_LEN + NONCE_LEN)
  const wrappedKey = packed.subarray(NONCE_LEN + NONCE_LEN, NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN)
  const ciphertext = packed.subarray(HEADER_LEN)

  const fileKey = unwrapFileKey(wrappedKey, keyNonce, vaultKey)
  try {
    const compressed = decrypt(ciphertext, dataNonce, fileKey, noteIdBytes)
    return decompressPayload(compressed)
  } finally {
    secureCleanup(fileKey)
  }
}

function buildSignedPayload(noteIdBytes: Uint8Array, packed: Uint8Array): Uint8Array {
  const sigOffset = NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN
  const beforeSig = packed.subarray(0, sigOffset)
  const afterSig = packed.subarray(sigOffset + SIGNATURE_LEN)
  const payload = new Uint8Array(noteIdBytes.length + beforeSig.length + afterSig.length)
  payload.set(noteIdBytes, 0)
  payload.set(beforeSig, noteIdBytes.length)
  payload.set(afterSig, noteIdBytes.length + beforeSig.length)
  return payload
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}
```

(If `@memry/crypto` re-exports `to_hex`, use it instead of `bytesToHex`; the error string is not on-wire so either is safe.)

- [ ] **Step 4: Run tests, expect PASS + barrel export.**

```bash
pnpm --filter @memry/crdt-core test -- crdt-encrypt
```

Expect: round-trip / tamper-detection / wrong-signer cases green — proves the 160-byte header and signed-payload layout are byte-identical to desktop peers. Add to `packages/crdt-core/src/index.ts`:

```ts
export { encryptCrdtUpdate, decryptCrdtUpdate } from './crdt-encrypt'
```

- [ ] **Step 5: Shim the desktop path.** Overwrite `apps/desktop/src/main/sync/crdt-encrypt.ts`:

```ts
export { encryptCrdtUpdate, decryptCrdtUpdate } from '@memry/crdt-core'
```

`runtime.ts` (imports `encryptCrdtUpdate`) and `engine/crdt-sync-coordinator.ts` (imports `decryptCrdtUpdate`) keep their relative import path valid through the shim. Delete `apps/desktop/src/main/sync/crdt-encrypt.test.ts`.

- [ ] **Step 6: Verify desktop green (rebuild native first if needed).**

```bash
pnpm --filter @memry/desktop rebuild:node
pnpm --filter @memry/crdt-core test
pnpm --filter @memry/desktop test:main -- crdt-sync-coordinator runtime
pnpm typecheck
```

Expect: crdt-core green; coordinator/runtime specs green; typecheck exit 0. (`crdt-encrypt` touches libsodium native → rebuild guards against `ERR_DLOPEN_FAILED`.)

- [ ] **Step 7: Commit.**

```bash
git add packages/crdt-core apps/desktop/src/main/sync/crdt-encrypt.ts pnpm-lock.yaml
git rm apps/desktop/src/main/sync/crdt-encrypt.test.ts
git commit -m "refactor(crdt-core): move crdt-encrypt onto @memry/crypto + @memry/sync-engine"
```

---

## Final verification (run after Task 8; re-run after Task 9)

- [ ] **Full package suite:** `pnpm --filter @memry/crdt-core test` → all moved + new specs green.
- [ ] **Desktop main suite:** `pnpm --filter @memry/desktop test:main` → green (rebuild:node first on any `ERR_DLOPEN_FAILED`).
- [ ] **Workspace typecheck:** `pnpm typecheck` → exit 0 (confirms all 22 `crdt-provider` importers + `crdt-feed`/`crdt-queue`/`crdt-encrypt`/`crdt-compact-utils`/`microtask-batch-broadcaster` importers resolve through the shims).
- [ ] **Architecture + contract boundaries:** `pnpm check:architecture && pnpm check:contracts` → green (crdt-core imports only `@memry/contracts`/`@memry/shared`/`@memry/crypto`/`@memry/sync-engine`, no electron/y-leveldb/fs).
- [ ] **Lint + formatting:** `pnpm lint && git diff --check` → clean (single quotes, no semicolons, 100 cols, no trailing commas).
- [ ] **Coverage re-baseline:** after the tests move out of the desktop package, if `apps/desktop` coverage floors trip, re-baseline `coverage-thresholds.json` for the desktop project and confirm `@memry/crdt-core` carries the moved coverage (moved specs must not be double-counted). This is a threshold-only adjustment, never a deletion of assertions.
- [ ] **`crdt-cursor-stability.test.ts` disposition:** inspect `apps/desktop/src/main/sync/crdt-cursor-stability.test.ts` — it imports only `yjs` and asserts Y.Doc merge stability, so MOVE it to `packages/crdt-core/src/crdt-cursor-stability.test.ts` (same as the compaction test) and delete the desktop copy; if on inspection it drives the desktop `CrdtProvider`, leave it in `apps/desktop`. Re-run both suites after deciding.
