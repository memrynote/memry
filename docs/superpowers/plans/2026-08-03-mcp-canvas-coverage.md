# MCP Canvas Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Agent Chat backends and external MCP clients read access to canvases (summarized, never raw geometry) and the ability to put an entity on a canvas or take one off, without ever silently destroying work in an open editor.

**Architecture:** Reads run entirely in main — `main/canvas/scene-refs.ts` already parses scenes without Excalidraw, so a new pure summarizer plus the existing store covers listing and reading. Writes route to a renderer window because `convertToExcalidrawElements` (a free function, not an editor method) is what mints valid element ids/seeds/versions/fractional-index; the renderer applies the change to the **live Excalidraw instance** when it has that canvas open, and otherwise does a headless get→mutate→update guarded by an optimistic `expectedUpdatedAt` compared inside the store's existing transaction.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), Zod v4, Drizzle ORM over better-sqlite3, Vitest, `@modelcontextprotocol/sdk`, `@excalidraw/excalidraw`.

**Spec:** `docs/superpowers/specs/2026-08-03-mcp-canvas-coverage-design.md`
**Issue:** [#916](https://github.com/memrynote/memry/issues/916)

## Global Constraints

- **PRODUCTION — backward compatibility is MANDATORY.** Every contract/schema change here must be **additive and optional**. `CanvasUpdateSchema` gaining `expectedUpdatedAt` must leave every existing caller (the renderer autosave, older app versions writing through sync) behaving exactly as today.
- **No DB schema change.** This plan adds no migration. `canvas_entity_refs` and `canvases` are used as they exist.
- **Logging:** always `createLogger('Scope')`, never raw `console.*`.
- **User-facing errors:** always `extractErrorMessage(err, fallback)` from `@/lib/ipc-error` in the renderer.
- **IPC boundary:** all renderer↔main types live in `packages/contracts`. Run `pnpm ipc:generate` then `pnpm ipc:check` after touching contracts, preload, or main IPC handlers.
- **Architecture boundary:** `main/agent/**` must not import from `main/ipc/**` except the explicitly-exported non-IPC readers (`getCalendarSettings` precedent). Run `pnpm check:architecture`.
- **Tailwind logical properties:** not applicable — this plan touches no new UI markup.
- **Google Workspace Limited Use:** unchanged; no Google-integration operation may enter either allowlist.
- **Zod v4:** `z.record(z.unknown())` throws in safeParse — use `z.record(z.string(), z.unknown())`.
- **Native modules:** node-side test runs hitting `better-sqlite3` `ERR_DLOPEN_FAILED` need `pnpm --filter @memry/desktop rebuild:node`. That is **not** proof for Electron runtime.
- **Verification per task:** `pnpm --filter @memry/desktop test:main` (main), `test:renderer` (renderer), `pnpm --filter @memry/contracts test` (contracts), plus `pnpm typecheck` before any commit that changes types.

---

## File Structure

**Contracts (`packages/contracts/src/`)**
| File | Responsibility |
| --- | --- |
| `canvas-api.ts` (modify) | `expectedUpdatedAt` on the update schema; `CanvasUpdateResponse` carrying `tooLarge` |
| `agent-mcp-channels.ts` (modify) | six canvas operations added to the two allowlists |
| `agent-mcp-channels.test.ts` (modify) | positive assertions + **negative** assertions carrying the exclusion reasons |

**Main (`apps/desktop/src/main/`)**
| File | Responsibility |
| --- | --- |
| `canvas/vault-key.ts` (new) | the single cached vault-key accessor for canvas code |
| `canvas/summary.ts` (new) | pure scene → `{ items, texts, elementCount, textsTruncated }` |
| `canvas/live-registry.ts` (new) | `canvasId → windowId` for windows with a canvas mounted |
| `canvas/store.ts` (modify) | optimistic update guard; `listCanvasesWithCounts` |
| `ipc/canvas-handlers.ts` (modify) | use shared vault key; return `tooLarge`; register live-registry IPC |
| `ipc/settings-handlers.ts` (modify) | export `getFeaturesSettings()` for non-IPC callers |
| `agent/mcp/tools/canvas-write.ts` (new) | route a write to the owning window, else any window |
| `agent/mcp/tools/handles.ts` (modify) | `canvas` handle section types |
| `agent/mcp/tools/handles-adapter.ts` (modify) | canvas handle impl + `canvas.*` flag gate on the escape hatch |
| `agent/mcp/tools/schemas.ts` (modify) | four tool schemas + name lists |
| `agent/mcp/tools/read-tools.ts` / `write-tools.ts` (modify) | registrations |

**Renderer (`apps/desktop/src/renderer/src/`)**
| File | Responsibility |
| --- | --- |
| `pages/canvas/canvas-scene-edit.ts` (new) | pure add/remove element math, Excalidraw-free |
| `pages/canvas/canvas-live-registry.ts` (new) | `canvasId → { getElements, updateScene, flush }` for the mounted editor |
| `pages/canvas/canvas-editor.tsx` (modify) | register/unregister the live handle; report open/close to main |
| `agent-mcp/canvas-write-handler.ts` (new) | live vs headless path selection |
| `App.tsx` (modify) | mount the new responder |

**Docs**
| File | Responsibility |
| --- | --- |
| `apps/docs/src/user-guide/ai/agent-mcp.md` (modify) | tool list, excluded operations + why, flag behaviour |

---

### Task 1: Shared canvas vault key

Behaviour-preserving refactor. `main/ipc/canvas-handlers.ts` caches `vaultKeyPromise` at module scope because only the first `getOrInitializeLocalVaultKey` call in a process can initialize — a second caller throws "verifier exists but master key is missing". The MCP handles (Task 7) would be exactly that second caller, so ownership moves first.

**Files:**

- Create: `apps/desktop/src/main/canvas/vault-key.ts`
- Create: `apps/desktop/src/main/canvas/vault-key.test.ts`
- Modify: `apps/desktop/src/main/ipc/canvas-handlers.ts:54-90` (remove the local cache), `:276-279` (dispose call)

**Interfaces:**

- Consumes: `getOrInitializeLocalVaultKey`, `secureCleanup` from `../crypto`; `requireDatabase`, `DataDb` from `../database`; `getOrCreateVaultUuid` from `../agent/storage/vault-id`
- Produces:

  ```ts
  export async function getCanvasContext(): Promise<{
    db: DataDb
    vaultId: string
    vaultKey: Uint8Array
  }>
  export function disposeCanvasVaultKey(): void
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/canvas/vault-key.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getOrInitializeLocalVaultKey: vi.fn(),
  secureCleanup: vi.fn(),
  requireDatabase: vi.fn(() => ({}) as never),
  getOrCreateVaultUuid: vi.fn(() => 'vault-1')
}))

vi.mock('../crypto', () => ({
  getOrInitializeLocalVaultKey: mocks.getOrInitializeLocalVaultKey,
  secureCleanup: mocks.secureCleanup
}))
vi.mock('../database', () => ({ requireDatabase: mocks.requireDatabase }))
vi.mock('../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: mocks.getOrCreateVaultUuid }))

describe('canvas vault key', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { disposeCanvasVaultKey } = await import('./vault-key')
    disposeCanvasVaultKey()
  })

  it('initializes the vault key exactly once across concurrent callers', async () => {
    mocks.getOrInitializeLocalVaultKey.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const { getCanvasContext } = await import('./vault-key')

    const [a, b] = await Promise.all([getCanvasContext(), getCanvasContext()])

    expect(mocks.getOrInitializeLocalVaultKey).toHaveBeenCalledTimes(1)
    expect(a.vaultKey).toEqual(b.vaultKey)
    expect(a.vaultId).toBe('vault-1')
  })

  it('does not cache a failed resolution so a transient keychain error can retry', async () => {
    mocks.getOrInitializeLocalVaultKey.mockRejectedValueOnce(new Error('keychain busy'))
    mocks.getOrInitializeLocalVaultKey.mockResolvedValueOnce(new Uint8Array([9]))
    const { getCanvasContext } = await import('./vault-key')

    await expect(getCanvasContext()).rejects.toThrow('keychain busy')
    await expect(getCanvasContext()).resolves.toMatchObject({ vaultId: 'vault-1' })
    expect(mocks.getOrInitializeLocalVaultKey).toHaveBeenCalledTimes(2)
  })

  it('zeroes the key on dispose', async () => {
    const key = new Uint8Array([4, 5])
    mocks.getOrInitializeLocalVaultKey.mockResolvedValue(key)
    const { getCanvasContext, disposeCanvasVaultKey } = await import('./vault-key')

    await getCanvasContext()
    disposeCanvasVaultKey()
    await vi.waitFor(() => expect(mocks.secureCleanup).toHaveBeenCalledWith(key))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/canvas/vault-key.test.ts`
Expected: FAIL — `Cannot find module './vault-key'`

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/canvas/vault-key.ts` — move the comment block verbatim from `canvas-handlers.ts:54-79`, it explains the NODE_ENV=test keychain degradation and must not be lost:

```ts
/**
 * The one cached vault-key accessor for canvas code.
 *
 * Resolved once per process, like agent bootstrap (main/agent/bootstrap.ts):
 * getOrInitializeLocalVaultKey consults the OS keychain, and under
 * NODE_ENV=test the keychain degrades to not-found (400ms timeout in
 * crypto/keychain.ts) — so only the first call in a process can initialize;
 * every later call would throw "verifier exists but master key is missing".
 * A failed resolution is not cached so a transient keychain error can retry.
 *
 * Lives here rather than in ipc/canvas-handlers.ts because the agent MCP
 * canvas handles need the same key and a second initializer in the process is
 * exactly the failure above.
 *
 * @module canvas/vault-key
 */

import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import { getOrInitializeLocalVaultKey, secureCleanup } from '../crypto'
import { requireDatabase, type DataDb } from '../database'

let vaultKeyPromise: Promise<Uint8Array> | null = null

function getVaultKeyOnce(db: DataDb, vaultId: string): Promise<Uint8Array> {
  if (!vaultKeyPromise) {
    vaultKeyPromise = getOrInitializeLocalVaultKey(db, vaultId).catch((error: unknown) => {
      vaultKeyPromise = null
      throw error
    })
  }
  return vaultKeyPromise
}

export async function getCanvasContext(): Promise<{
  db: DataDb
  vaultId: string
  vaultKey: Uint8Array
}> {
  const db = requireDatabase()
  const vaultId = getOrCreateVaultUuid(db)
  const vaultKey = await getVaultKeyOnce(db, vaultId)
  return { db, vaultId, vaultKey }
}

export function disposeCanvasVaultKey(): void {
  if (!vaultKeyPromise) return
  void vaultKeyPromise.then((key) => secureCleanup(key)).catch(() => {})
  vaultKeyPromise = null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/canvas/vault-key.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Point canvas-handlers at the shared module**

In `apps/desktop/src/main/ipc/canvas-handlers.ts`: delete the `vaultKeyPromise` variable, its comment block, `getVaultKeyOnce`, and the local `getCanvasContext`. Add the import and replace the dispose block in `unregisterCanvasHandlers`:

```ts
import { getCanvasContext, disposeCanvasVaultKey } from '../canvas/vault-key'
```

```ts
// at the end of unregisterCanvasHandlers, replacing the vaultKeyPromise block
disposeCanvasVaultKey()
```

Remove the now-unused imports: `getOrInitializeLocalVaultKey`, `secureCleanup`, `getOrCreateVaultUuid`, and `requireDatabase` if nothing else in the file uses it (`DataDb` type import goes too if unused).

- [ ] **Step 6: Run the canvas suites to prove nothing changed**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/canvas src/main/ipc`
Expected: PASS, no new failures versus the pre-change run.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm --filter @memry/desktop typecheck:node
git add apps/desktop/src/main/canvas/vault-key.ts apps/desktop/src/main/canvas/vault-key.test.ts apps/desktop/src/main/ipc/canvas-handlers.ts
git commit -m "refactor(canvas): move the cached vault key out of the IPC layer"
```

---

### Task 2: Pure scene summarizer

**Files:**

- Create: `apps/desktop/src/main/canvas/summary.ts`
- Create: `apps/desktop/src/main/canvas/summary.test.ts`

**Interfaces:**

- Consumes: `CanvasEntityRef` from `@memry/contracts/canvas-api`; mirrors the card contract in `scene-refs.ts`
- Produces:

  ```ts
  export const MAX_SUMMARY_TEXTS = 200
  export const MAX_SUMMARY_TEXT_CHARS = 20_000
  export interface CanvasSceneSummary {
    items: CanvasEntityRef[]
    texts: string[]
    elementCount: number
    textsTruncated: boolean
  }
  export function summarizeScene(scene: string): CanvasSceneSummary
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/canvas/summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { summarizeScene, MAX_SUMMARY_TEXTS } from './summary'

function scene(elements: unknown[]): string {
  return JSON.stringify({ type: 'excalidraw', elements })
}

const card = (entityType: string, entityId: string, extra: Record<string, unknown> = {}) => ({
  id: `rect-${entityId}`,
  type: 'rectangle',
  customData: { entityType, entityId },
  ...extra
})

describe('summarizeScene', () => {
  it('returns an empty summary for an empty or unparseable scene', () => {
    expect(summarizeScene('')).toEqual({
      items: [],
      texts: [],
      elementCount: 0,
      textsTruncated: false
    })
    expect(summarizeScene('{not json')).toEqual({
      items: [],
      texts: [],
      elementCount: 0,
      textsTruncated: false
    })
  })

  it('collects deduped entity refs and text, ignoring deleted elements', () => {
    const result = summarizeScene(
      scene([
        card('note', 'n1'),
        card('note', 'n1'),
        card('task', 't1', { isDeleted: true }),
        { id: 'x', type: 'text', text: 'Q3 planning' },
        { id: 'y', type: 'text', text: 'gone', isDeleted: true },
        { id: 'z', type: 'arrow' }
      ])
    )

    expect(result.items).toEqual([{ entityType: 'note', entityId: 'n1' }])
    expect(result.texts).toEqual(['Q3 planning'])
    expect(result.elementCount).toBe(4)
    expect(result.textsTruncated).toBe(false)
  })

  it('ignores rectangles without a valid entity ref', () => {
    const result = summarizeScene(
      scene([
        { id: 'a', type: 'rectangle' },
        { id: 'b', type: 'rectangle', customData: { entityType: 'wat', entityId: 'x' } },
        { id: 'c', type: 'rectangle', customData: { entityType: 'note', entityId: '' } }
      ])
    )
    expect(result.items).toEqual([])
  })

  it('skips blank text and trims what it keeps', () => {
    const result = summarizeScene(
      scene([
        { id: 'a', type: 'text', text: '   ' },
        { id: 'b', type: 'text', text: '  spaced  ' },
        { id: 'c', type: 'text' }
      ])
    )
    expect(result.texts).toEqual(['spaced'])
  })

  it('caps the number of texts and flags truncation', () => {
    const many = Array.from({ length: MAX_SUMMARY_TEXTS + 5 }, (_, i) => ({
      id: `t${i}`,
      type: 'text',
      text: `line ${i}`
    }))
    const result = summarizeScene(scene(many))

    expect(result.texts).toHaveLength(MAX_SUMMARY_TEXTS)
    expect(result.textsTruncated).toBe(true)
  })

  it('caps total text characters and flags truncation', () => {
    const result = summarizeScene(
      scene([
        { id: 'a', type: 'text', text: 'x'.repeat(19_990) },
        { id: 'b', type: 'text', text: 'y'.repeat(100) }
      ])
    )

    expect(result.texts).toHaveLength(1)
    expect(result.textsTruncated).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/canvas/summary.test.ts`
Expected: FAIL — `Cannot find module './summary'`

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/canvas/summary.ts`:

```ts
/**
 * Agent-facing summary of a canvas scene.
 *
 * A serialized Excalidraw scene is mostly geometry, style props and version
 * counters — dumping it into an agent's context is large and almost entirely
 * noise. What an agent actually wants is "which notes/tasks/events live on this
 * canvas" plus whatever the user typed on it. This produces exactly that, and
 * never the raw scene.
 *
 * Excalidraw-free (plain JSON parsing) so it runs in main and unit-tests
 * without the library, mirroring the card contract in scene-refs.ts: a card is
 * a `rectangle` carrying `customData: { entityType, entityId }`.
 *
 * See docs/superpowers/specs/2026-08-03-mcp-canvas-coverage-design.md §3.1.
 *
 * @module canvas/summary
 */

import { CANVAS_ENTITY_TYPES, type CanvasEntityRef } from '@memry/contracts/canvas-api'

/** Most text elements returned for one canvas. */
export const MAX_SUMMARY_TEXTS = 200
/** Most text characters returned for one canvas, summed across elements. */
export const MAX_SUMMARY_TEXT_CHARS = 20_000

export interface CanvasSceneSummary {
  items: CanvasEntityRef[]
  texts: string[]
  /** Live (non-deleted) elements in the scene. */
  elementCount: number
  /** True when either cap stopped text collection. */
  textsTruncated: boolean
}

interface SceneElementLike {
  type?: unknown
  isDeleted?: unknown
  customData?: unknown
  text?: unknown
}

const EMPTY: CanvasSceneSummary = {
  items: [],
  texts: [],
  elementCount: 0,
  textsTruncated: false
}

function isEntityType(value: unknown): value is CanvasEntityRef['entityType'] {
  return typeof value === 'string' && (CANVAS_ENTITY_TYPES as readonly string[]).includes(value)
}

function cardRef(element: SceneElementLike): CanvasEntityRef | null {
  if (element.type !== 'rectangle') return null
  const data = element.customData
  if (!data || typeof data !== 'object') return null
  const entityType = (data as Record<string, unknown>).entityType
  const entityId = (data as Record<string, unknown>).entityId
  if (!isEntityType(entityType) || typeof entityId !== 'string' || entityId.length === 0) {
    return null
  }
  return { entityType, entityId }
}

export function summarizeScene(scene: string): CanvasSceneSummary {
  if (!scene) return { ...EMPTY }

  let elements: unknown
  try {
    const parsed = JSON.parse(scene) as { elements?: unknown }
    elements = parsed.elements
  } catch {
    return { ...EMPTY }
  }
  if (!Array.isArray(elements)) return { ...EMPTY }

  const seen = new Set<string>()
  const items: CanvasEntityRef[] = []
  const texts: string[] = []
  let elementCount = 0
  let textChars = 0
  let textsTruncated = false

  for (const element of elements as SceneElementLike[]) {
    if (element.isDeleted === true) continue
    elementCount++

    const ref = cardRef(element)
    if (ref) {
      const key = `${ref.entityType}:${ref.entityId}`
      if (!seen.has(key)) {
        seen.add(key)
        items.push(ref)
      }
      continue
    }

    if (element.type !== 'text' || typeof element.text !== 'string') continue
    const text = element.text.trim()
    if (!text) continue
    if (texts.length >= MAX_SUMMARY_TEXTS || textChars + text.length > MAX_SUMMARY_TEXT_CHARS) {
      textsTruncated = true
      continue
    }
    texts.push(text)
    textChars += text.length
  }

  return { items, texts, elementCount, textsTruncated }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/canvas/summary.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/canvas/summary.ts apps/desktop/src/main/canvas/summary.test.ts
git commit -m "feat(canvas): summarize a scene into entity refs and text for agents"
```

---

### Task 3: Optimistic update guard + canvas list with counts

**Files:**

- Modify: `packages/contracts/src/canvas-api.ts:69-74` (update schema), and add the update response type
- Modify: `apps/desktop/src/main/canvas/store.ts:84-118` (`updateCanvas`), append `listCanvasesWithCounts`
- Modify: `apps/desktop/src/main/canvas/store.test.ts` (add cases)

**Interfaces:**

- Consumes: `canvases`, `canvasEntityRefs` from `@memry/db-schema/data-schema`
- Produces:
  ```ts
  // contracts
  export type CanvasUpdateFailure = 'not-found' | 'conflict'
  export interface CanvasSummaryWithCount extends CanvasSummary {
    itemCount: number
  }
  // store
  export type CanvasUpdateResult =
    | { ok: true; summary: CanvasSummary }
    | { ok: false; reason: CanvasUpdateFailure }
  export function updateCanvas(db, vaultKey, id, input): CanvasUpdateResult
  export function listCanvasesWithCounts(db: DataDb, vaultId: string): CanvasSummaryWithCount[]
  ```

> **Breaking-return note:** `updateCanvas` currently returns `CanvasSummary | null`. It has exactly one caller (`ipc/canvas-handlers.ts:151`), updated in Task 4. Changing it to a result object is what makes "conflict" distinguishable from "not found" — a `null` for both would make the guard unreportable.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/main/canvas/store.test.ts` (match the existing file's setup helpers — read it first and reuse its db/vaultKey fixtures rather than inventing new ones):

```ts
it('rejects an update whose expectedUpdatedAt does not match the row', () => {
  const created = createCanvas(db, vaultKey, vaultId, { title: 'A', scene: 'v1' })

  const result = updateCanvas(db, vaultKey, created.id, {
    scene: 'v2',
    expectedUpdatedAt: created.updatedAt - 1
  })

  expect(result).toEqual({ ok: false, reason: 'conflict' })
  expect(getCanvas(db, vaultKey, created.id)?.scene).toBe('v1')
})

it('applies an update whose expectedUpdatedAt matches', () => {
  const created = createCanvas(db, vaultKey, vaultId, { title: 'A', scene: 'v1' })

  const result = updateCanvas(db, vaultKey, created.id, {
    scene: 'v2',
    expectedUpdatedAt: created.updatedAt
  })

  expect(result.ok).toBe(true)
  expect(getCanvas(db, vaultKey, created.id)?.scene).toBe('v2')
})

it('applies an update with no expectedUpdatedAt (unchanged legacy behaviour)', () => {
  const created = createCanvas(db, vaultKey, vaultId, { title: 'A', scene: 'v1' })

  const result = updateCanvas(db, vaultKey, created.id, { scene: 'v2' })

  expect(result).toEqual({ ok: true, summary: expect.objectContaining({ id: created.id }) })
  expect(getCanvas(db, vaultKey, created.id)?.scene).toBe('v2')
})

it('reports not-found separately from conflict', () => {
  expect(updateCanvas(db, vaultKey, 'nope', { scene: 'x' })).toEqual({
    ok: false,
    reason: 'not-found'
  })
})

it('lists canvases with their entity-ref counts', () => {
  const a = createCanvas(db, vaultKey, vaultId, { title: 'A', scene: '' })
  const b = createCanvas(db, vaultKey, vaultId, { title: 'B', scene: '' })
  updateCanvas(db, vaultKey, a.id, {
    entityRefs: [
      { entityType: 'note', entityId: 'n1' },
      { entityType: 'task', entityId: 't1' }
    ]
  })

  const listed = listCanvasesWithCounts(db, vaultId)

  expect(listed.find((c) => c.id === a.id)?.itemCount).toBe(2)
  expect(listed.find((c) => c.id === b.id)?.itemCount).toBe(0)
})
```

Add `listCanvasesWithCounts` to the file's import from `./store`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/canvas/store.test.ts`
Expected: FAIL — `listCanvasesWithCounts is not a function`, and the conflict cases fail because the guard does not exist.

- [ ] **Step 3: Extend the contract (additive only)**

In `packages/contracts/src/canvas-api.ts`, replace the `CanvasUpdateSchema` block:

```ts
export const CanvasUpdateSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable().optional(),
  scene: z.string().optional(),
  entityRefs: z.array(CanvasEntityRefSchema).optional(),
  /**
   * Optimistic concurrency guard. When present the store compares it against
   * the stored `updatedAt` INSIDE its update transaction and rejects a
   * mismatch, so a writer that read the canvas earlier cannot clobber a change
   * that landed in between. Omitted — as the renderer's autosave and every
   * pre-existing caller do — means last-write-wins exactly as before.
   */
  expectedUpdatedAt: z.number().int().optional()
})

/** Why an update did not apply. */
export type CanvasUpdateFailure = 'not-found' | 'conflict'
```

And after `CanvasListResponse`:

```ts
/** A canvas summary carrying how many entities are on it (advisory refs). */
export interface CanvasSummaryWithCount extends CanvasSummary {
  itemCount: number
}

/**
 * canvas:update response. `tooLarge` mirrors the CanvasTooLargeEvent for
 * callers with no event subscription (agent MCP): the scene was saved locally
 * but is too large to sync.
 */
export interface CanvasUpdateResponse extends CanvasSummary {
  tooLarge: boolean
}
```

- [ ] **Step 4: Implement the store changes**

In `apps/desktop/src/main/canvas/store.ts`, add `expectedUpdatedAt` to `CanvasUpdateInput`, export the result type, and change `updateCanvas`:

```ts
import { and, count, desc, eq, isNull } from 'drizzle-orm'
import type {
  Canvas,
  CanvasSummary,
  CanvasSummaryWithCount,
  CanvasEntityRef,
  CanvasUpdateFailure
} from '@memry/contracts/canvas-api'
```

```ts
export interface CanvasUpdateInput {
  title?: string | null
  scene?: string
  entityRefs?: CanvasEntityRef[]
  /** Optimistic guard — see CanvasUpdateSchema. */
  expectedUpdatedAt?: number
}

export type CanvasUpdateResult =
  | { ok: true; summary: CanvasSummary }
  | { ok: false; reason: CanvasUpdateFailure }
```

```ts
export function updateCanvas(
  db: DataDb,
  vaultKey: Uint8Array,
  id: string,
  input: CanvasUpdateInput
): CanvasUpdateResult {
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(canvases)
      .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
      .get()
    if (!row) return { ok: false, reason: 'not-found' } as const

    // Compared inside the transaction on purpose: a check outside it would be
    // the same lost-update race wearing a longer coat.
    if (input.expectedUpdatedAt !== undefined && row.updatedAt !== input.expectedUpdatedAt) {
      return { ok: false, reason: 'conflict' } as const
    }

    const now = Date.now()
    const changes: Partial<typeof canvases.$inferInsert> = { updatedAt: now }
    if (input.title !== undefined) changes.title = input.title
    if (input.scene !== undefined) {
      changes.snapshotCiphertext = encryptCanvasSceneForVault(input.scene, vaultKey)
    }
    tx.update(canvases).set(changes).where(eq(canvases.id, id)).run()

    if (input.entityRefs !== undefined) {
      tx.delete(canvasEntityRefs).where(eq(canvasEntityRefs.canvasId, id)).run()
      for (const ref of input.entityRefs) {
        tx.insert(canvasEntityRefs)
          .values({ canvasId: id, entityType: ref.entityType, entityId: ref.entityId })
          .onConflictDoNothing()
          .run()
      }
    }

    return {
      ok: true,
      summary: toSummary({ ...row, title: changes.title ?? row.title, updatedAt: now })
    } as const
  })
}
```

Append the counted list — a left join so a canvas with no cards still appears:

```ts
/**
 * Like listCanvases, plus how many entities each canvas holds. Counted from
 * the advisory canvas_entity_refs rows (maintained on every save and on every
 * sync apply) rather than by decrypting every scene, so listing stays cheap.
 */
export function listCanvasesWithCounts(db: DataDb, vaultId: string): CanvasSummaryWithCount[] {
  return db
    .select({
      id: canvases.id,
      title: canvases.title,
      createdAt: canvases.createdAt,
      updatedAt: canvases.updatedAt,
      itemCount: count(canvasEntityRefs.entityId)
    })
    .from(canvases)
    .leftJoin(canvasEntityRefs, eq(canvasEntityRefs.canvasId, canvases.id))
    .where(and(eq(canvases.vaultId, vaultId), isNull(canvases.deletedAt)))
    .groupBy(canvases.id)
    .orderBy(desc(canvases.updatedAt))
    .all()
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/canvas/store.test.ts`
Expected: PASS. `canvas-handlers.ts` now fails typecheck — Task 4 fixes it.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/canvas-api.ts apps/desktop/src/main/canvas/store.ts apps/desktop/src/main/canvas/store.test.ts
git commit -m "feat(canvas): optimistic update guard and counted canvas list"
```

---

### Task 4: Surface `tooLarge` on canvas:update

**Files:**

- Modify: `apps/desktop/src/main/ipc/canvas-handlers.ts:137-169`
- Modify: `apps/desktop/src/main/ipc/canvas-handlers.test.ts` (note: sits beside the source, not under `__tests__/`)

**Interfaces:**

- Consumes: `updateCanvas` → `CanvasUpdateResult` (Task 3), `CanvasUpdateResponse` (Task 3)
- Produces: `canvas:update` now resolves `CanvasUpdateResponse` (`CanvasSummary & { tooLarge: boolean }`) and throws `Canvas was modified by someone else` on a conflict

- [ ] **Step 1: Write the failing test**

Add to the canvas handler test file:

```ts
it('reports tooLarge when the saved scene could not sync', async () => {
  syncCanvasUpdateMock.mockReturnValue(false)

  const result = await invokeHandler('canvas:update', { id: canvasId, scene: 'huge' })

  expect(result).toMatchObject({ id: canvasId, tooLarge: true })
})

it('throws a distinguishable error when the optimistic guard rejects', async () => {
  await expect(
    invokeHandler('canvas:update', { id: canvasId, scene: 'x', expectedUpdatedAt: 1 })
  ).rejects.toThrow(/modified/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/ipc --testNamePattern="canvas"`
Expected: FAIL — no `tooLarge` key on the result.

- [ ] **Step 3: Update the handler**

In `apps/desktop/src/main/ipc/canvas-handlers.ts`, replace the body of the `UPDATE` handler after `sceneToPersist` is computed:

```ts
const result = updateCanvas(db, vaultKey, input.id, { ...input, scene: sceneToPersist })
if (!result.ok) {
  throw new Error(
    result.reason === 'conflict'
      ? 'Canvas was modified by someone else since it was read'
      : 'Canvas not found'
  )
}
const summary = result.summary
const synced = syncCanvasUpdate(input.id, sceneToPersist)
emitCanvasEvent(CanvasChannels.events.UPDATED, { canvas: summary })
if (!synced) {
  // Saved locally but too large to sync (§5.6) — surface, never silent.
  emitCanvasEvent(CanvasChannels.events.TOO_LARGE, { id: input.id })
}

// GC assets the saved scene no longer references (union protects assets
// still used by other canvases).
if (assetCtx && input.scene !== undefined) {
  await reconcileCanvasAssets(assetCtx, input.id, sceneToPersist ?? '')
}
// tooLarge mirrors the TOO_LARGE event for callers with no subscription
// (agent MCP writes) — the event stays for the renderer toast.
return { ...summary, tooLarge: !synced } satisfies CanvasUpdateResponse
```

Add `type CanvasUpdateResponse` to the `@memry/contracts/canvas-api` import.

- [ ] **Step 4: Run tests, regenerate the IPC map, verify**

```bash
pnpm --filter @memry/desktop exec vitest run src/main/ipc --testNamePattern="canvas"
pnpm ipc:generate
pnpm ipc:check
pnpm --filter @memry/desktop typecheck:node
```

Expected: tests PASS; `ipc:check` PASS; `generated-ipc-invoke-map.ts` diff shows `canvas:update` gaining `tooLarge: boolean`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/canvas-handlers.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts apps/desktop/src/preload/generated-rpc.ts
git add apps/desktop/src/main/ipc/__tests__
git commit -m "feat(canvas): return tooLarge from canvas:update"
```

---

### Task 5: Allowlist the six safe canvas operations

**Files:**

- Modify: `packages/contracts/src/agent-mcp-channels.ts:120-124` (read list tail), `:271-275` (write list tail)
- Modify: `packages/contracts/src/agent-mcp-channels.test.ts`

**Interfaces:**

- Produces: `'canvas.list' | 'canvas.getAsset' | 'canvas.listAssets' | 'canvas.libraryList'` in `AgentMcpDesktopReadOperations`; `'canvas.create' | 'canvas.delete'` in `AgentMcpDesktopWriteOperations`

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/agent-mcp-channels.test.ts`:

```ts
// Canvas coverage (#916). The excluded operations are excluded on purpose —
// see docs/superpowers/specs/2026-08-03-mcp-canvas-coverage-design.md §3.2.
describe('canvas operations', () => {
  it('allowlists the safe canvas reads', () => {
    for (const op of [
      'canvas.list',
      'canvas.getAsset',
      'canvas.listAssets',
      'canvas.libraryList'
    ]) {
      expect(AgentMcpDesktopReadOperations).toContain(op)
    }
  })

  it('allowlists whole-canvas create and delete', () => {
    expect(AgentMcpDesktopWriteOperations).toContain('canvas.create')
    expect(AgentMcpDesktopWriteOperations).toContain('canvas.delete')
  })

  it('never exposes canvas.get — it dumps raw scene geometry; use vault_read_canvas', () => {
    expect(AgentMcpDesktopReadOperations).not.toContain('canvas.get')
    expect(AgentMcpDesktopWriteOperations).not.toContain('canvas.get')
  })

  it('never exposes canvas.update — blind whole-scene replacement clobbers an open editor', () => {
    expect(AgentMcpDesktopWriteOperations).not.toContain('canvas.update')
  })

  it('never exposes canvas.librarySave — a partial list deletes the shape library', () => {
    expect(AgentMcpDesktopWriteOperations).not.toContain('canvas.librarySave')
  })

  it('never exposes canvas.uploadAsset — binary payload, no agent path in v1', () => {
    expect(AgentMcpDesktopWriteOperations).not.toContain('canvas.uploadAsset')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/contracts exec vitest run src/agent-mcp-channels.test.ts`
Expected: FAIL — the four positive assertions fail; the negative ones already pass.

- [ ] **Step 3: Add the operations**

In `packages/contracts/src/agent-mcp-channels.ts`, before the closing `] as const` of `AgentMcpDesktopReadOperations`:

```ts
  // Canvas (#916). canvas.get is deliberately absent — it returns the whole
  // serialized scene, which is the geometry dump vault_read_canvas exists to
  // avoid. See the MCP canvas coverage design §3.2.
  'canvas.list',
  'canvas.getAsset',
  'canvas.listAssets',
  'canvas.libraryList',
```

And before the closing `] as const` of `AgentMcpDesktopWriteOperations`:

```ts
  // Canvas (#916). Whole-canvas lifecycle only. canvas.update (blind
  // whole-scene clobber), canvas.librarySave (a partial list deletes the
  // user's shape library) and canvas.uploadAsset (binary payload) stay out;
  // item add/remove goes through vault_add_canvas_item / vault_remove_canvas_item.
  'canvas.create',
  'canvas.delete',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/contracts exec vitest run src/agent-mcp-channels.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/agent-mcp-channels.ts packages/contracts/src/agent-mcp-channels.test.ts
git commit -m "feat(mcp): allowlist safe canvas operations (#916)"
```

---

### Task 6: Feature-flag reader + `canvas.*` escape-hatch gate

**Files:**

- Modify: `apps/desktop/src/main/ipc/settings-handlers.ts` (near `getCalendarSettings`, ~line 227)
- Modify: `apps/desktop/src/main/agent/mcp/tools/handles-adapter.ts:703-710` (the `desktop` section)
- Modify: `apps/desktop/src/main/agent/mcp/tools/__tests__/handles-adapter.test.ts`

**Interfaces:**

- Produces:

  ```ts
  // settings-handlers.ts
  export function getFeaturesSettings(): FeaturesSettings
  // a small shared guard used by Task 7 too
  export function assertSpatialCanvasEnabled(): void // in agent/mcp/tools/canvas-flag.ts
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/agent/mcp/tools/__tests__/canvas-flag.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AgentToolError } from '../../errors'

const mocks = vi.hoisted(() => ({ getFeaturesSettings: vi.fn() }))
vi.mock('../../../../ipc/settings-handlers', () => ({
  getFeaturesSettings: mocks.getFeaturesSettings
}))

describe('assertSpatialCanvasEnabled', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes when the flag is on', async () => {
    mocks.getFeaturesSettings.mockReturnValue({ spatialCanvas: true })
    const { assertSpatialCanvasEnabled } = await import('../canvas-flag')
    expect(() => assertSpatialCanvasEnabled()).not.toThrow()
  })

  it('throws an actionable error when the flag is off', async () => {
    mocks.getFeaturesSettings.mockReturnValue({ spatialCanvas: false })
    const { assertSpatialCanvasEnabled } = await import('../canvas-flag')

    try {
      assertSpatialCanvasEnabled()
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentToolError)
      expect((error as AgentToolError).message).toMatch(/Settings → Features/)
    }
  })

  it('treats a canvas.* operation as gated and anything else as not', async () => {
    const { isCanvasOperation } = await import('../canvas-flag')
    expect(isCanvasOperation('canvas.list')).toBe(true)
    expect(isCanvasOperation('notes.get')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/tools/__tests__/canvas-flag.test.ts`
Expected: FAIL — `Cannot find module '../canvas-flag'`

- [ ] **Step 3: Export the settings reader**

In `apps/desktop/src/main/ipc/settings-handlers.ts`, beside the existing `getCalendarSettings` / `getInboxReviewSettings` exports:

```ts
/** Synchronous read of feature flags for non-IPC callers (e.g. agent MCP tools). */
export function getFeaturesSettings(): FeaturesSettings {
  return readGroupSettings('features', FEATURES_SETTINGS_DEFAULTS)
}
```

Confirm `FEATURES_SETTINGS_DEFAULTS` is already imported in that file; if not, add it to the existing `@memry/contracts/settings-schemas` import.

- [ ] **Step 4: Write the guard module**

Create `apps/desktop/src/main/agent/mcp/tools/canvas-flag.ts`:

```ts
/**
 * spatialCanvas flag gate for every agent-facing canvas surface.
 *
 * Canvas tools register unconditionally: the MCP tool list is built once at
 * startAgentMcpLifecycle, so gating registration would mean a user who turns
 * the flag on mid-session sees nothing until an app restart. Instead every
 * canvas entry point checks here and fails with an actionable message.
 *
 * The check covers BOTH surfaces — the dedicated vault_*_canvas tools and any
 * `canvas.*` operation reached through the vault_desktop_read/write escape
 * hatch — so there is no gap between them.
 */

import { getFeaturesSettings } from '../../../ipc/settings-handlers'
import { AgentToolError } from '../errors'

export function isCanvasOperation(operation: string): boolean {
  return operation.startsWith('canvas.')
}

export function assertSpatialCanvasEnabled(): void {
  if (getFeaturesSettings().spatialCanvas) return
  throw new AgentToolError(
    'PERMISSION_DENIED',
    'Spatial Canvas is disabled — enable it in Settings → Features.'
  )
}
```

> If `pnpm check:architecture` rejects `main/agent` importing `main/ipc`, move `getFeaturesSettings` into a new `main/settings/features.ts` that both `settings-handlers.ts` and this module import, mirroring the Task 1 vault-key move. Run the check before assuming either shape.

- [ ] **Step 5: Gate the escape hatch**

In `handles-adapter.ts`, replace the `desktop` section:

```ts
    desktop: {
      async read(input, windowId) {
        if (isCanvasOperation(input.operation)) assertSpatialCanvasEnabled()
        return invokeDesktopApiFromWindow(windowId, input)
      },
      async write(input, windowId) {
        if (isCanvasOperation(input.operation)) assertSpatialCanvasEnabled()
        return invokeDesktopApiFromWindow(windowId, input)
      }
    },
```

Import `{ assertSpatialCanvasEnabled, isCanvasOperation } from './canvas-flag'`.

- [ ] **Step 6: Run tests and the architecture check**

```bash
pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp
pnpm check:architecture
```

Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/ipc/settings-handlers.ts apps/desktop/src/main/agent/mcp/tools/canvas-flag.ts apps/desktop/src/main/agent/mcp/tools/__tests__/canvas-flag.test.ts apps/desktop/src/main/agent/mcp/tools/handles-adapter.ts
git commit -m "feat(mcp): gate canvas operations on the spatialCanvas flag"
```

---

### Task 7: Canvas read tools

**Files:**

- Modify: `apps/desktop/src/main/agent/mcp/tools/handles.ts` (add the `canvas` section + types)
- Modify: `apps/desktop/src/main/agent/mcp/tools/handles-adapter.ts` (implement it)
- Modify: `apps/desktop/src/main/agent/mcp/tools/schemas.ts` (two schemas, `READ_TOOL_NAMES`)
- Modify: `apps/desktop/src/main/agent/mcp/tools/read-tools.ts` (two registrations)
- Modify: `apps/desktop/src/main/agent/mcp/tools/__tests__/read-tools.test.ts`

**Interfaces:**

- Consumes: `summarizeScene` (Task 2), `getCanvasContext` (Task 1), `listCanvasesWithCounts` + `getCanvas` (Task 3), `assertSpatialCanvasEnabled` (Task 6), `getNoteById` from `../../../vault/notes-crud`, `getTaskById` from `../../../database/queries/tasks`, `getCalendarEventById` from `../../../calendar/repositories/calendar-events-repository`
- Produces:

  ```ts
  export interface CanvasItemSummary {
    entity_type: 'note' | 'task' | 'calendar_event'
    entity_id: string
    title: string | null
    missing: boolean
  }
  export interface CanvasListEntry {
    id: string; title: string | null; updated_at: number; item_count: number
  }
  export interface CanvasDetail {
    id: string; title: string | null; created_at: number; updated_at: number
    items: CanvasItemSummary[]; texts: string[]
    element_count: number; texts_truncated: boolean
  }
  // on VaultServiceHandles:
  canvas: {
    list(): Promise<CanvasListEntry[]>
    read(id: string): Promise<CanvasDetail | null>
  }
  ```

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/main/agent/mcp/tools/__tests__/read-tools.test.ts` (reuse the file's existing fake-handles factory):

```ts
it('lists canvases through the canvas handle', async () => {
  const handles = makeHandles({
    canvas: {
      list: async () => [{ id: 'c1', title: 'Roadmap', updated_at: 5, item_count: 2 }],
      read: async () => null
    }
  })
  const tool = buildReadTools(handles).find((t) => t.name === 'vault_list_canvases')!

  await expect(tool.handler({}, ctx)).resolves.toEqual([
    { id: 'c1', title: 'Roadmap', updated_at: 5, item_count: 2 }
  ])
})

it('reads a canvas without ever returning the raw scene', async () => {
  const detail = {
    id: 'c1',
    title: 'Roadmap',
    created_at: 1,
    updated_at: 5,
    items: [{ entity_type: 'note' as const, entity_id: 'n1', title: 'Spec', missing: false }],
    texts: ['Q3'],
    element_count: 4,
    texts_truncated: false
  }
  const handles = makeHandles({ canvas: { list: async () => [], read: async () => detail } })
  const tool = buildReadTools(handles).find((t) => t.name === 'vault_read_canvas')!

  const result = await tool.handler({ id: 'c1' }, ctx)

  expect(result).toEqual(detail)
  expect(JSON.stringify(result)).not.toContain('"scene"')
})

it('throws NOT_FOUND for a missing canvas', async () => {
  const handles = makeHandles({ canvas: { list: async () => [], read: async () => null } })
  const tool = buildReadTools(handles).find((t) => t.name === 'vault_read_canvas')!

  await expect(tool.handler({ id: 'nope' }, ctx)).rejects.toThrow(/not found/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/tools/__tests__/read-tools.test.ts`
Expected: FAIL — `vault_list_canvases` is undefined.

- [ ] **Step 3: Add the handle types**

In `handles.ts`, add the exported interfaces from the Interfaces block above, then add to `VaultServiceHandles` (after `tags`):

```ts
  canvas: {
    list(): Promise<CanvasListEntry[]>
    read(id: string): Promise<CanvasDetail | null>
  }
```

- [ ] **Step 4: Implement the handle**

In `handles-adapter.ts`, add imports and a resolver, then the `canvas` section:

```ts
import { getCanvasContext } from '../../../canvas/vault-key'
import { getCanvas, listCanvasesWithCounts } from '../../../canvas/store'
import { summarizeScene } from '../../../canvas/summary'
import { getCalendarEventById } from '../../../calendar/repositories/calendar-events-repository'
import { getTaskById } from '../../../database/queries/tasks'
import { getNoteById } from '../../../vault/notes-crud'
import { assertSpatialCanvasEnabled } from './canvas-flag'
import type { CanvasEntityRef } from '@memry/contracts/canvas-api'
```

```ts
    canvas: {
      async list() {
        assertSpatialCanvasEnabled()
        const { db, vaultId } = await getCanvasContext()
        return listCanvasesWithCounts(db, vaultId).map((canvas) => ({
          id: canvas.id,
          title: canvas.title,
          updated_at: canvas.updatedAt,
          item_count: canvas.itemCount
        }))
      },
      async read(id) {
        assertSpatialCanvasEnabled()
        const { db, vaultKey } = await getCanvasContext()
        const canvas = getCanvas(db, vaultKey, id)
        if (!canvas) return null

        const summary = summarizeScene(canvas.scene)
        const items = await Promise.all(
          summary.items.map((ref) => resolveCanvasItem(dataDb, ref))
        )
        return {
          id: canvas.id,
          title: canvas.title,
          created_at: canvas.createdAt,
          updated_at: canvas.updatedAt,
          items,
          texts: summary.texts,
          element_count: summary.elementCount,
          texts_truncated: summary.textsTruncated
        }
      }
    },
```

And the resolver as a module-level helper in the same file:

```ts
/**
 * Resolve a card's entity to a display title. A card whose entity no longer
 * exists reports missing:true rather than being dropped — an agent should be
 * able to see and report a stale card, not silently under-report the canvas.
 */
async function resolveCanvasItem(dataDb: DataDb, ref: CanvasEntityRef): Promise<CanvasItemSummary> {
  const base = { entity_type: ref.entityType, entity_id: ref.entityId }
  if (ref.entityType === 'note') {
    const note = await getNoteById(ref.entityId)
    return { ...base, title: note?.title ?? null, missing: !note }
  }
  if (ref.entityType === 'task') {
    const task = getTaskById(dataDb, ref.entityId)
    return { ...base, title: task?.title ?? null, missing: !task }
  }
  const event = getCalendarEventById(dataDb, ref.entityId)
  return { ...base, title: event?.title ?? null, missing: !event }
}
```

- [ ] **Step 5: Add the tool schemas**

In `schemas.ts`, add to `TOOL_SCHEMAS`:

```ts
  vault_list_canvases: {
    input: z.object({}).default({}),
    description:
      'List spatial canvases with how many notes/tasks/events sit on each. ' +
      'Never returns scene geometry.'
  },
  vault_read_canvas: {
    input: z.object({ id: idSchema }),
    description:
      'Read one canvas: title, the entities on it (with titles), and any text written on it. ' +
      'Returns no scene geometry — use vault_add_canvas_item to change what is on it.'
  },
```

And add `'vault_list_canvases', 'vault_read_canvas'` to `READ_TOOL_NAMES` (after `vault_get_tags`, before `vault_desktop_read`).

- [ ] **Step 6: Register the tools**

In `read-tools.ts`, add to the `factories` record:

```ts
    vault_list_canvases: {
      name: 'vault_list_canvases',
      description: TOOL_SCHEMAS.vault_list_canvases.description,
      inputSchema: TOOL_SCHEMAS.vault_list_canvases.input,
      handler: async () => handles.canvas.list()
    },
    vault_read_canvas: {
      name: 'vault_read_canvas',
      description: TOOL_SCHEMAS.vault_read_canvas.description,
      inputSchema: TOOL_SCHEMAS.vault_read_canvas.input,
      handler: async (input) => {
        const a = parse<{ id: string }>(TOOL_SCHEMAS.vault_read_canvas.input, input)
        const canvas = await handles.canvas.read(a.id)
        if (!canvas) {
          throw new AgentToolError('NOT_FOUND', `Canvas ${a.id} not found`, { id: a.id })
        }
        return canvas
      }
    },
```

- [ ] **Step 7: Run tests and typecheck**

```bash
pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp
pnpm --filter @memry/desktop typecheck:node
```

Expected: PASS. Any other test constructing a full `VaultServiceHandles` fake will fail to typecheck until it gains a `canvas` stub — add `canvas: { list: async () => [], read: async () => null }` to those fakes.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/tools
git commit -m "feat(mcp): vault_list_canvases and vault_read_canvas (#916)"
```

---

### Task 8: Pure scene edit math

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-scene-edit.ts`
- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-scene-edit.test.ts`

**Interfaces:**

- Consumes: `CardElement`, `getCardRefs`, `findFreeCardCenter`, `makeCardSkeleton`, `cardDefaultSize`, `CARD_PLACEMENT_GAP` from `./canvas-cards`
- Produces:

  ```ts
  export interface SceneEditElement extends CardElement {
    boundElements?: { id: string; type: string }[] | null
    startBinding?: { elementId: string } | null
    endBinding?: { elementId: string } | null
  }
  export function sceneBoundsRect(elements: readonly CardElement[]): SceneRect
  export function planCardPlacements(
    elements: readonly CardElement[],
    items: { entityType: CanvasEntityType; entityId: string; width: number; height: number }[]
  ): CardSkeleton[]
  export function removeCardElements(
    elements: readonly SceneEditElement[],
    ref: CanvasEntityRef
  ): { elements: SceneEditElement[]; removedIds: string[] }
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/pages/canvas/canvas-scene-edit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { planCardPlacements, removeCardElements, sceneBoundsRect } from './canvas-scene-edit'

const rect = (id: string, entityId: string | null, extra = {}) => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 260,
  height: 168,
  angle: 0,
  ...(entityId ? { customData: { entityType: 'note', entityId } } : {}),
  ...extra
})

describe('sceneBoundsRect', () => {
  it('is the origin for an empty scene', () => {
    expect(sceneBoundsRect([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
  })

  it('spans the live elements', () => {
    const bounds = sceneBoundsRect([
      rect('a', 'n1', { x: 10, y: 20 }),
      rect('b', 'n2', { x: 500, y: 300 })
    ])
    expect(bounds.minX).toBe(10)
    expect(bounds.maxX).toBe(760)
  })
})

describe('planCardPlacements', () => {
  it('places a card without overlapping an existing one', () => {
    const existing = [rect('a', 'n1', { x: 0, y: 0 })]
    const [skeleton] = planCardPlacements(existing, [
      { entityType: 'note', entityId: 'n2', width: 260, height: 168 }
    ])

    const overlaps =
      skeleton.x < 260 &&
      0 < skeleton.x + skeleton.width &&
      skeleton.y < 168 &&
      0 < skeleton.y + skeleton.height
    expect(overlaps).toBe(false)
    expect(skeleton.customData).toEqual({ entityType: 'note', entityId: 'n2' })
  })

  it('does not stack two new cards on each other', () => {
    const [first, second] = planCardPlacements(
      [],
      [
        { entityType: 'note', entityId: 'n1', width: 260, height: 168 },
        { entityType: 'note', entityId: 'n2', width: 260, height: 168 }
      ]
    )
    expect({ x: first.x, y: first.y }).not.toEqual({ x: second.x, y: second.y })
  })
})

describe('removeCardElements', () => {
  it('removes every card rectangle for the entity', () => {
    const elements = [rect('a', 'n1'), rect('b', 'n1'), rect('c', 'n2')]

    const result = removeCardElements(elements, { entityType: 'note', entityId: 'n1' })

    expect(result.removedIds.sort()).toEqual(['a', 'b'])
    expect(result.elements.map((e) => e.id)).toEqual(['c'])
  })

  it('clears arrow bindings pointing at a removed card', () => {
    const elements = [
      rect('a', 'n1'),
      {
        id: 'arrow1',
        type: 'arrow',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        angle: 0,
        startBinding: { elementId: 'a' },
        endBinding: { elementId: 'c' }
      },
      rect('c', 'n2')
    ]

    const result = removeCardElements(elements, { entityType: 'note', entityId: 'n1' })
    const arrow = result.elements.find((e) => e.id === 'arrow1')

    expect(arrow?.startBinding).toBeNull()
    expect(arrow?.endBinding).toEqual({ elementId: 'c' })
  })

  it('drops boundElements entries referencing a removed card', () => {
    const elements = [
      rect('a', 'n1'),
      rect('c', 'n2', {
        boundElements: [
          { id: 'a', type: 'arrow' },
          { id: 'keep', type: 'text' }
        ]
      })
    ]

    const result = removeCardElements(elements, { entityType: 'note', entityId: 'n1' })

    expect(result.elements[0].boundElements).toEqual([{ id: 'keep', type: 'text' }])
  })

  it('is a no-op when the entity is not on the canvas', () => {
    const elements = [rect('c', 'n2')]
    const result = removeCardElements(elements, { entityType: 'note', entityId: 'nope' })
    expect(result.removedIds).toEqual([])
    expect(result.elements).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/renderer/src/pages/canvas/canvas-scene-edit.test.ts`
Expected: FAIL — `Cannot find module './canvas-scene-edit'`

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/renderer/src/pages/canvas/canvas-scene-edit.ts`:

```ts
/**
 * Pure scene edits for agent-driven card add/remove.
 *
 * Shared by both MCP write paths (live editor and headless), so it must stay
 * Excalidraw-runtime-free: element minting is the caller's job via
 * convertToExcalidrawElements, which is the only thing that can correctly
 * produce ids, seeds, version counters and fractional indices.
 *
 * See docs/superpowers/specs/2026-08-03-mcp-canvas-coverage-design.md §4.3.
 */

import type { CanvasEntityRef, CanvasEntityType } from '@memry/contracts/canvas-api'
import {
  CARD_DEFAULT_HEIGHT,
  CARD_DEFAULT_WIDTH,
  findFreeCardCenter,
  getCardRefs,
  makeCardSkeleton,
  type CanvasCardRef,
  type CardElement,
  type CardSkeleton,
  type SceneRect
} from './canvas-cards'

/** Element fields the remove path has to rewrite, beyond the card basics. */
export interface SceneEditElement extends CardElement {
  boundElements?: { id: string; type: string }[] | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
}

/**
 * The scene's occupied area, standing in for a viewport the headless path does
 * not have. Placing relative to existing content keeps a new card beside the
 * user's work instead of at an arbitrary origin.
 */
export function sceneBoundsRect(elements: readonly CardElement[]): SceneRect {
  const live = elements.filter((element) => !element.isDeleted)
  if (live.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }

  return live.reduce<SceneRect>(
    (rect, element) => ({
      minX: Math.min(rect.minX, element.x),
      minY: Math.min(rect.minY, element.y),
      maxX: Math.max(rect.maxX, element.x + element.width),
      maxY: Math.max(rect.maxY, element.y + element.height)
    }),
    {
      minX: live[0].x,
      minY: live[0].y,
      maxX: live[0].x + live[0].width,
      maxY: live[0].y + live[0].height
    }
  )
}

export interface CardPlacementInput {
  entityType: CanvasEntityType
  entityId: string
  width?: number
  height?: number
}

/**
 * Skeletons for a batch of new cards, each placed in the first free cell of a
 * grid spiralling out from the scene's centre. Occupancy accumulates across the
 * batch so two cards added in one call never land on each other (#871).
 */
export function planCardPlacements(
  elements: readonly CardElement[],
  items: readonly CardPlacementInput[]
): CardSkeleton[] {
  const rect = sceneBoundsRect(elements)
  const occupied: CanvasCardRef[] = [...getCardRefs(elements)]

  return items.map((item) => {
    const width = item.width ?? CARD_DEFAULT_WIDTH
    const height = item.height ?? CARD_DEFAULT_HEIGHT
    const center = findFreeCardCenter(occupied, rect, { width, height })
    occupied.push({
      elementId: '',
      entityType: item.entityType,
      entityId: item.entityId,
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
      angle: 0
    })
    return makeCardSkeleton({
      entityType: item.entityType,
      entityId: item.entityId,
      centerX: center.x,
      centerY: center.y,
      width,
      height
    })
  })
}

/**
 * Drop every card rectangle for one entity and repair what pointed at it.
 *
 * Three places reference a card: the rectangle itself, the start/end binding on
 * any arrow bound to it, and the boundElements array on elements it was bound
 * to. Missing the last two leaves arrows bound to elements that no longer
 * exist, which Excalidraw either silently repairs or does not.
 */
export function removeCardElements(
  elements: readonly SceneEditElement[],
  ref: CanvasEntityRef
): { elements: SceneEditElement[]; removedIds: string[] } {
  const removedIds = getCardRefs(elements)
    .filter((card) => card.entityType === ref.entityType && card.entityId === ref.entityId)
    .map((card) => card.elementId)

  if (removedIds.length === 0) {
    return { elements: [...elements], removedIds }
  }

  const removed = new Set(removedIds)
  const next = elements
    .filter((element) => !removed.has(element.id))
    .map((element) => {
      const patch: Partial<SceneEditElement> = {}
      if (element.startBinding && removed.has(element.startBinding.elementId)) {
        patch.startBinding = null
      }
      if (element.endBinding && removed.has(element.endBinding.elementId)) {
        patch.endBinding = null
      }
      if (element.boundElements?.some((bound) => removed.has(bound.id))) {
        patch.boundElements = element.boundElements.filter((bound) => !removed.has(bound.id))
      }
      return Object.keys(patch).length > 0 ? { ...element, ...patch } : element
    })

  return { elements: next, removedIds }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop exec vitest run src/renderer/src/pages/canvas/canvas-scene-edit.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-scene-edit.ts apps/desktop/src/renderer/src/pages/canvas/canvas-scene-edit.test.ts
git commit -m "feat(canvas): pure add/remove scene edits for agent writes"
```

---

### Task 9: Live-canvas registries (renderer + main)

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-live-registry.ts`
- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-live-registry.test.ts`
- Create: `apps/desktop/src/main/canvas/live-registry.ts`
- Create: `apps/desktop/src/main/canvas/live-registry.test.ts`
- Modify: `packages/contracts/src/ipc-channels.ts` (canvas invoke channels)
- Modify: `apps/desktop/src/main/ipc/canvas-handlers.ts` (register the two channels)
- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-editor.tsx` (register + report)

**Interfaces:**

- Produces:

  ```ts
  // renderer
  export interface LiveCanvasHandle {
    getElements(): readonly SceneEditElement[]
    updateScene(elements: SceneEditElement[]): void
    flush(): Promise<void>
  }
  export function registerLiveCanvas(canvasId: string, handle: LiveCanvasHandle): void
  export function unregisterLiveCanvas(canvasId: string): void
  export function getLiveCanvas(canvasId: string): LiveCanvasHandle | null
  // main
  export function markCanvasOpen(canvasId: string, windowId: number): void
  export function markCanvasClosed(canvasId: string, windowId: number): void
  export function forgetWindow(windowId: number): void
  export function getCanvasWindowId(canvasId: string): number | null
  // contracts — CanvasChannels.invoke
  LIVE_OPENED: 'canvas:live-opened'
  LIVE_CLOSED: 'canvas:live-closed'
  ```

- [ ] **Step 1: Write the failing main-side test**

Create `apps/desktop/src/main/canvas/live-registry.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { forgetWindow, getCanvasWindowId, markCanvasClosed, markCanvasOpen } from './live-registry'

describe('canvas live registry', () => {
  beforeEach(() => {
    forgetWindow(1)
    forgetWindow(2)
  })

  it('remembers which window has a canvas open', () => {
    markCanvasOpen('c1', 1)
    expect(getCanvasWindowId('c1')).toBe(1)
    expect(getCanvasWindowId('c2')).toBeNull()
  })

  it('lets a second window take over a canvas', () => {
    markCanvasOpen('c1', 1)
    markCanvasOpen('c1', 2)
    expect(getCanvasWindowId('c1')).toBe(2)
  })

  it('ignores a close from a window that no longer owns the canvas', () => {
    markCanvasOpen('c1', 1)
    markCanvasOpen('c1', 2)
    markCanvasClosed('c1', 1)
    expect(getCanvasWindowId('c1')).toBe(2)
  })

  it('drops every entry for a closed window', () => {
    markCanvasOpen('c1', 1)
    markCanvasOpen('c2', 1)
    forgetWindow(1)
    expect(getCanvasWindowId('c1')).toBeNull()
    expect(getCanvasWindowId('c2')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/canvas/live-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the main-side registry**

Create `apps/desktop/src/main/canvas/live-registry.ts`:

```ts
/**
 * Which window currently has a canvas mounted in its editor.
 *
 * An agent write to a canvas the user has open must reach that live Excalidraw
 * instance rather than a headless read-modify-write, or the editor's next
 * autosave serializes its own stale element list and silently overwrites the
 * agent's change (issue #916, hazard 2e).
 *
 * Fed by canvas:live-opened / canvas:live-closed from CanvasEditor. A stale
 * entry is not dangerous: the write falls through to the headless path, which
 * is guarded by expectedUpdatedAt.
 */

const canvasToWindow = new Map<string, number>()

export function markCanvasOpen(canvasId: string, windowId: number): void {
  canvasToWindow.set(canvasId, windowId)
}

/** Only the current owner can release a canvas — a late close must not evict a newer owner. */
export function markCanvasClosed(canvasId: string, windowId: number): void {
  if (canvasToWindow.get(canvasId) === windowId) canvasToWindow.delete(canvasId)
}

export function forgetWindow(windowId: number): void {
  for (const [canvasId, owner] of canvasToWindow) {
    if (owner === windowId) canvasToWindow.delete(canvasId)
  }
}

export function getCanvasWindowId(canvasId: string): number | null {
  return canvasToWindow.get(canvasId) ?? null
}
```

- [ ] **Step 4: Write and pass the renderer registry test**

Create `apps/desktop/src/renderer/src/pages/canvas/canvas-live-registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { getLiveCanvas, registerLiveCanvas, unregisterLiveCanvas } from './canvas-live-registry'

const handle = {
  getElements: () => [],
  updateScene: () => {},
  flush: async () => {}
}

describe('renderer live canvas registry', () => {
  it('returns a registered handle and null after unregister', () => {
    registerLiveCanvas('c1', handle)
    expect(getLiveCanvas('c1')).toBe(handle)

    unregisterLiveCanvas('c1')
    expect(getLiveCanvas('c1')).toBeNull()
  })

  it('unregister by a stale owner does not clear a newer handle', () => {
    const newer = { ...handle }
    registerLiveCanvas('c1', handle)
    registerLiveCanvas('c1', newer)
    unregisterLiveCanvas('c1', handle)
    expect(getLiveCanvas('c1')).toBe(newer)
  })
})
```

Create `apps/desktop/src/renderer/src/pages/canvas/canvas-live-registry.ts`:

```ts
/**
 * The mounted Excalidraw instance for a canvas, reachable from outside React.
 *
 * The agent MCP write handler is not in the canvas component tree, so it needs
 * a way to reach the live editor. Registered by CanvasEditor while mounted.
 */

import type { SceneEditElement } from './canvas-scene-edit'

export interface LiveCanvasHandle {
  getElements(): readonly SceneEditElement[]
  updateScene(elements: SceneEditElement[]): void
  /** Persist immediately rather than waiting out the autosave debounce. */
  flush(): Promise<void>
}

const live = new Map<string, LiveCanvasHandle>()

export function registerLiveCanvas(canvasId: string, handle: LiveCanvasHandle): void {
  live.set(canvasId, handle)
}

/**
 * Pass `handle` so a StrictMode double-mount (cleanup of the FIRST mount runs
 * after the second has registered) cannot unregister the live editor.
 */
export function unregisterLiveCanvas(canvasId: string, handle?: LiveCanvasHandle): void {
  if (handle && live.get(canvasId) !== handle) return
  live.delete(canvasId)
}

export function getLiveCanvas(canvasId: string): LiveCanvasHandle | null {
  return live.get(canvasId) ?? null
}
```

Run: `pnpm --filter @memry/desktop exec vitest run src/renderer/src/pages/canvas/canvas-live-registry.test.ts src/main/canvas/live-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Add the IPC channels**

In `packages/contracts/src/ipc-channels.ts`, inside `CanvasChannels.invoke`:

```ts
    /** Renderer reports the canvas mounted in its editor, so an agent write can reach it. */
    LIVE_OPENED: 'canvas:live-opened',
    LIVE_CLOSED: 'canvas:live-closed',
```

> **These must be `invoke`, not `send`.** `window.api.canvas.*` is produced entirely by
> `apps/desktop/src/preload/generated-rpc.ts`; there is no hand-written canvas section to bolt a
> `send` onto, and `apps/desktop/src/preload/index.ts` wires the generated API wholesale. Registering
> with `ipcMain.handle` means `pnpm ipc:generate` mints `window.api.canvas.liveOpened` /
> `liveClosed` for free. The renderer calls them fire-and-forget with `void`.

- [ ] **Step 6: Register the channels in main**

In `apps/desktop/src/main/ipc/canvas-handlers.ts`, inside `registerCanvasHandlers`. Note these use a
raw `ipcMain.handle` rather than `createStringHandler`, because the handler needs `event` to know
which window is reporting:

```ts
// Live-canvas ownership: which window has this canvas mounted. Raw handle —
// the sender's window id IS the payload we care about.
ipcMain.handle(CanvasChannels.invoke.LIVE_OPENED, (event, canvasId: string) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || typeof canvasId !== 'string' || !canvasId) return { ok: false }
  markCanvasOpen(canvasId, win.id)
  win.once('closed', () => forgetWindow(win.id))
  return { ok: true }
})
ipcMain.handle(CanvasChannels.invoke.LIVE_CLOSED, (event, canvasId: string) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || typeof canvasId !== 'string' || !canvasId) return { ok: false }
  markCanvasClosed(canvasId, win.id)
  return { ok: true }
})
```

Add to `unregisterCanvasHandlers`:

```ts
ipcMain.removeHandler(CanvasChannels.invoke.LIVE_OPENED)
ipcMain.removeHandler(CanvasChannels.invoke.LIVE_CLOSED)
```

Import `{ forgetWindow, markCanvasClosed, markCanvasOpen } from '../canvas/live-registry'`.

- [ ] **Step 7: Regenerate the preload bindings**

```bash
pnpm ipc:generate
pnpm ipc:check
```

Expected: `generated-rpc.ts` gains `canvas.liveOpened` and `canvas.liveClosed`; `ipc:check` PASS.
Inspect the generated signatures — if the generator could not infer `(canvasId: string)` from the raw
handle, give the handler an explicit parameter type annotation and regenerate rather than hand-editing
the generated file.

- [ ] **Step 8: Register from the editor**

In `canvas-editor.tsx`, add an effect after the persister effect. It depends on `api` because the handle needs the Excalidraw instance:

```ts
// Agent MCP writes to THIS canvas must reach this live instance rather than
// a headless read-modify-write, or our next autosave overwrites them.
useEffect(() => {
  if (!api || corrupt) return

  const handle: LiveCanvasHandle = {
    getElements: () => api.getSceneElements() as unknown as SceneEditElement[],
    updateScene: (elements) => {
      api.updateScene({
        elements: elements as never,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
    },
    flush: async () => {
      await persisterRef.current?.flush()
    }
  }
  registerLiveCanvas(canvasId, handle)
  void window.api.canvas.liveOpened(canvasId)

  return () => {
    unregisterLiveCanvas(canvasId, handle)
    void window.api.canvas.liveClosed(canvasId)
  }
}, [api, canvasId, corrupt])
```

Add `CaptureUpdateAction` to the `@excalidraw/excalidraw` import and the registry imports.

- [ ] **Step 9: Verify and commit**

```bash
pnpm --filter @memry/desktop exec vitest run src/main/canvas src/renderer/src/pages/canvas
pnpm ipc:generate && pnpm ipc:check
pnpm typecheck
git add -A
git commit -m "feat(canvas): track which window has a canvas open"
```

---

### Task 10: Renderer write handler (live + headless)

**Files:**

- Create: `apps/desktop/src/renderer/src/agent-mcp/canvas-write-handler.ts`
- Create: `apps/desktop/src/renderer/src/agent-mcp/canvas-write-handler.test.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx:186`
- Modify: `packages/contracts/src/agent-mcp-channels.ts` (request/response contract)

**Interfaces:**

- Consumes: `planCardPlacements`, `removeCardElements` (Task 8); `getLiveCanvas` (Task 9)
- Produces:

  ```ts
  // contracts
  export const AgentMcpCanvasWriteChannel = 'agent_mcp:canvas_write'
  export const AgentMcpCanvasWriteRequestSchema = z.object({
    canvasId: z.string().min(1),
    op: z.enum(['add', 'remove']),
    items: z.array(CanvasEntityRefSchema).min(1).max(20)
  })
  export type AgentMcpCanvasWriteResponse =
    | {
        ok: true
        applied: CanvasEntityRef[]
        skipped: { ref: CanvasEntityRef; reason: string }[]
        updatedAt: number
        tooLarge: boolean
        path: 'live' | 'headless'
      }
    | { ok: false; error: { code: string; message: string } }
  // renderer
  export function useAgentMcpCanvasWriteResponder(opts?: { enabled?: boolean }): void
  ```

- [ ] **Step 1: Add the contract**

In `packages/contracts/src/agent-mcp-channels.ts` (import `CanvasEntityRefSchema` from `./canvas-api.ts` — note the `.ts` extension requirement noted at the top of `canvas-api.ts`):

```ts
export const AgentMcpCanvasWriteChannel = 'agent_mcp:canvas_write'

export const AgentMcpCanvasWriteRequestSchema = z.object({
  canvasId: z.string().min(1),
  op: z.enum(['add', 'remove']),
  items: z.array(CanvasEntityRefSchema).min(1).max(20)
})
export type AgentMcpCanvasWriteRequest = z.infer<typeof AgentMcpCanvasWriteRequestSchema>

export interface AgentMcpCanvasWriteSkip {
  ref: { entityType: string; entityId: string }
  reason: 'already-on-canvas' | 'not-on-canvas'
}

export type AgentMcpCanvasWriteResponse =
  | {
      ok: true
      applied: { entityType: string; entityId: string }[]
      skipped: AgentMcpCanvasWriteSkip[]
      updatedAt: number
      tooLarge: boolean
      /** Which route ran — 'live' means the user has that canvas open. */
      path: 'live' | 'headless'
    }
  | { ok: false; error: { code: string; message: string } }
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/renderer/src/agent-mcp/canvas-write-handler.test.ts`. Cover the four behaviours that matter; mock `@excalidraw/excalidraw` so jsdom never loads the real bundle:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { registerLiveCanvas, unregisterLiveCanvas } from '@/pages/canvas/canvas-live-registry'
import { useAgentMcpCanvasWriteResponder } from './canvas-write-handler'

vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: (skeletons: { customData: unknown }[]) =>
    skeletons.map((s, i) => ({
      id: `new-${i}`,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 260,
      height: 168,
      angle: 0,
      customData: s.customData
    }))
}))

const listeners: ((msg: { requestId: string; channel: string; payload: unknown }) => void)[] = []
const responses = new Map<string, unknown>()

beforeEach(() => {
  listeners.length = 0
  responses.clear()
  window.api = {
    onMainInvoke: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    respondToMainInvoke: (requestId, response) => responses.set(requestId, response),
    canvas: {
      get: vi.fn(),
      update: vi.fn()
    },
    notes: { get: vi.fn(async () => ({ content: '' })) }
  } as never
})

async function send(payload: unknown): Promise<unknown> {
  renderHook(() => useAgentMcpCanvasWriteResponder())
  await listeners[0]({ requestId: 'r1', channel: 'agent_mcp:canvas_write', payload })
  return responses.get('r1')
}

describe('canvas write responder', () => {
  it('applies to the live editor when this window has the canvas open', async () => {
    const updateScene = vi.fn()
    const handle = {
      getElements: () => [],
      updateScene,
      flush: vi.fn(async () => {})
    }
    registerLiveCanvas('c1', handle)

    const result = await send({
      canvasId: 'c1',
      op: 'add',
      items: [{ entityType: 'note', entityId: 'n1' }]
    })

    expect(updateScene).toHaveBeenCalledOnce()
    expect(handle.flush).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ ok: true, path: 'live' })
    expect(window.api.canvas.update).not.toHaveBeenCalled()
    unregisterLiveCanvas('c1')
  })

  it('falls back to the headless path with an optimistic guard', async () => {
    ;(window.api.canvas.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      title: null,
      createdAt: 1,
      updatedAt: 42,
      scene: JSON.stringify({ elements: [] })
    })
    ;(window.api.canvas.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      updatedAt: 43,
      tooLarge: false
    })

    const result = await send({
      canvasId: 'c1',
      op: 'add',
      items: [{ entityType: 'note', entityId: 'n1' }]
    })

    expect(window.api.canvas.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', expectedUpdatedAt: 42 })
    )
    expect(result).toMatchObject({ ok: true, path: 'headless', updatedAt: 43 })
  })

  it('re-derives entityRefs from the mutated scene rather than the request', async () => {
    ;(window.api.canvas.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      updatedAt: 1,
      scene: JSON.stringify({ elements: [] })
    })
    ;(window.api.canvas.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c1',
      updatedAt: 2,
      tooLarge: false
    })

    await send({ canvasId: 'c1', op: 'add', items: [{ entityType: 'note', entityId: 'n1' }] })

    const [arg] = (window.api.canvas.update as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(arg.entityRefs).toEqual([{ entityType: 'note', entityId: 'n1' }])
  })

  it('skips an entity already on the canvas instead of duplicating it', async () => {
    const existing = {
      id: 'rect1',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 260,
      height: 168,
      angle: 0,
      customData: { entityType: 'note', entityId: 'n1' }
    }
    registerLiveCanvas('c1', {
      getElements: () => [existing] as never,
      updateScene: vi.fn(),
      flush: vi.fn(async () => {})
    })

    const result = await send({
      canvasId: 'c1',
      op: 'add',
      items: [{ entityType: 'note', entityId: 'n1' }]
    })

    expect(result).toMatchObject({
      ok: true,
      applied: [],
      skipped: [{ reason: 'already-on-canvas' }]
    })
    unregisterLiveCanvas('c1')
  })

  it('reports not-on-canvas when removing an absent entity', async () => {
    registerLiveCanvas('c1', {
      getElements: () => [],
      updateScene: vi.fn(),
      flush: vi.fn(async () => {})
    })

    const result = await send({
      canvasId: 'c1',
      op: 'remove',
      items: [{ entityType: 'note', entityId: 'ghost' }]
    })

    expect(result).toMatchObject({ ok: true, applied: [], skipped: [{ reason: 'not-on-canvas' }] })
    unregisterLiveCanvas('c1')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/renderer/src/agent-mcp/canvas-write-handler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the handler**

Create `apps/desktop/src/renderer/src/agent-mcp/canvas-write-handler.ts`. Key points the implementation must honour:

- `@excalidraw/excalidraw` is imported **dynamically inside the handler**, never at module scope — `CanvasEditor` is a lazy chunk precisely to keep it out of the main bundle.
- `entityRefs` is always recomputed from the mutated element list with `extractEntityRefs`, never taken from the request.
- Note cards size from the note body (`cardDefaultSize(entityType, markdown)`); everything else takes the compact card.

```ts
import { useEffect } from 'react'
import { getI18n } from 'react-i18next'
import {
  AgentMcpCanvasWriteChannel,
  AgentMcpCanvasWriteRequestSchema,
  type AgentMcpCanvasWriteResponse,
  type AgentMcpCanvasWriteSkip
} from '@memry/contracts/agent-mcp-channels'
import type { CanvasEntityRef } from '@memry/contracts/canvas-api'

import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  cardDefaultSize,
  entityKey,
  extractEntityRefs,
  getCardRefs
} from '@/pages/canvas/canvas-cards'
import { getLiveCanvas } from '@/pages/canvas/canvas-live-registry'
import {
  planCardPlacements,
  removeCardElements,
  type SceneEditElement
} from '@/pages/canvas/canvas-scene-edit'

const log = createLogger('AgentMcpCanvasWrite')

async function sizeFor(ref: CanvasEntityRef): Promise<{ width: number; height: number }> {
  if (ref.entityType !== 'note') return cardDefaultSize(ref.entityType)
  try {
    const note = await window.api.notes.get(ref.entityId)
    return cardDefaultSize('note', note?.content ?? '')
  } catch {
    return cardDefaultSize('note')
  }
}

async function applyAdd(
  elements: readonly SceneEditElement[],
  items: CanvasEntityRef[]
): Promise<{
  elements: SceneEditElement[]
  applied: CanvasEntityRef[]
  skipped: AgentMcpCanvasWriteSkip[]
}> {
  const present = new Set(getCardRefs(elements).map((c) => entityKey(c.entityType, c.entityId)))
  const skipped: AgentMcpCanvasWriteSkip[] = []
  const applied: CanvasEntityRef[] = []

  for (const ref of items) {
    if (present.has(entityKey(ref.entityType, ref.entityId))) {
      skipped.push({ ref, reason: 'already-on-canvas' })
      continue
    }
    present.add(entityKey(ref.entityType, ref.entityId))
    applied.push(ref)
  }
  if (applied.length === 0) return { elements: [...elements], applied, skipped }

  const sized = await Promise.all(applied.map(async (ref) => ({ ...ref, ...(await sizeFor(ref)) })))
  const skeletons = planCardPlacements(elements, sized)
  // Dynamic import: CanvasEditor is a lazy chunk so @excalidraw/excalidraw
  // stays out of the main renderer bundle; this responder is always mounted.
  const { convertToExcalidrawElements } = await import('@excalidraw/excalidraw')
  const created = convertToExcalidrawElements(
    skeletons as unknown as Parameters<typeof convertToExcalidrawElements>[0]
  ) as unknown as SceneEditElement[]

  return { elements: [...elements, ...created], applied, skipped }
}

function applyRemove(
  elements: readonly SceneEditElement[],
  items: CanvasEntityRef[]
): {
  elements: SceneEditElement[]
  applied: CanvasEntityRef[]
  skipped: AgentMcpCanvasWriteSkip[]
} {
  let next = [...elements]
  const applied: CanvasEntityRef[] = []
  const skipped: AgentMcpCanvasWriteSkip[] = []

  for (const ref of items) {
    const result = removeCardElements(next, ref)
    if (result.removedIds.length === 0) {
      skipped.push({ ref, reason: 'not-on-canvas' })
      continue
    }
    next = result.elements
    applied.push(ref)
  }
  return { elements: next, applied, skipped }
}

export function useAgentMcpCanvasWriteResponder({
  enabled = true
}: { enabled?: boolean } = {}): void {
  useEffect(() => {
    if (!enabled) return

    return window.api.onMainInvoke(async ({ requestId, channel, payload }) => {
      if (channel !== AgentMcpCanvasWriteChannel) return

      const parsed = AgentMcpCanvasWriteRequestSchema.safeParse(payload)
      if (!parsed.success) {
        window.api.respondToMainInvoke(requestId, {
          ok: false,
          error: { code: 'VALIDATION', message: 'Invalid canvas write request.' }
        } satisfies AgentMcpCanvasWriteResponse)
        return
      }

      const { canvasId, op, items } = parsed.data
      try {
        const live = getLiveCanvas(canvasId)
        const source = live
          ? live.getElements()
          : await (async () => {
              const canvas = await window.api.canvas.get(canvasId)
              if (!canvas) throw new Error(`Canvas ${canvasId} not found`)
              const scene = canvas.scene
                ? (JSON.parse(canvas.scene) as { elements?: SceneEditElement[] })
                : {}
              return scene.elements ?? []
            })()

        const mutation = op === 'add' ? await applyAdd(source, items) : applyRemove(source, items)

        let updatedAt = 0
        let tooLarge = false

        if (mutation.applied.length === 0) {
          // Nothing changed — do not touch the canvas or bump updatedAt.
          const canvas = live ? null : await window.api.canvas.get(canvasId)
          updatedAt = canvas?.updatedAt ?? 0
        } else if (live) {
          live.updateScene(mutation.elements)
          await live.flush()
          updatedAt = Date.now()
        } else {
          const canvas = await window.api.canvas.get(canvasId)
          if (!canvas) throw new Error(`Canvas ${canvasId} not found`)
          const scene = canvas.scene ? (JSON.parse(canvas.scene) as Record<string, unknown>) : {}
          const result = await window.api.canvas.update({
            id: canvasId,
            scene: JSON.stringify({ ...scene, elements: mutation.elements }),
            // Never trust the caller's view of what is on the canvas.
            entityRefs: extractEntityRefs(mutation.elements),
            expectedUpdatedAt: canvas.updatedAt
          })
          updatedAt = result.updatedAt
          tooLarge = result.tooLarge
        }

        window.api.respondToMainInvoke(requestId, {
          ok: true,
          applied: mutation.applied,
          skipped: mutation.skipped,
          updatedAt,
          tooLarge,
          path: live ? 'live' : 'headless'
        } satisfies AgentMcpCanvasWriteResponse)
      } catch (error) {
        log.error('Canvas write failed', error)
        window.api.respondToMainInvoke(requestId, {
          ok: false,
          error: {
            code: 'CANVAS_WRITE_ERROR',
            message: extractErrorMessage(
              error,
              getI18n().getFixedT(null, 'errors')('generic.operationFailed')
            )
          }
        } satisfies AgentMcpCanvasWriteResponse)
      }
    })
  }, [enabled])
}
```

> **Known simplification, keep it:** the headless path re-reads the canvas after computing the mutation so the `expectedUpdatedAt` it sends is the one it read for the _write_, and the store compares it inside the transaction. The double `canvas.get` is deliberate and cheap; do not "optimize" it into a single read that widens the race.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @memry/desktop exec vitest run src/renderer/src/agent-mcp/canvas-write-handler.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Mount the responder**

In `App.tsx`, beside line 186:

```ts
useAgentMcpCanvasWriteResponder({ enabled: aiEnabled })
```

with the matching import from `@/agent-mcp/canvas-write-handler`.

- [ ] **Step 7: Commit**

```bash
pnpm --filter @memry/desktop typecheck:web
git add packages/contracts/src/agent-mcp-channels.ts apps/desktop/src/renderer/src/agent-mcp apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(canvas): renderer handler for agent canvas item writes"
```

---

### Task 11: Canvas write tools

**Files:**

- Create: `apps/desktop/src/main/agent/mcp/tools/canvas-write.ts`
- Create: `apps/desktop/src/main/agent/mcp/tools/__tests__/canvas-write.test.ts`
- Modify: `handles.ts`, `handles-adapter.ts`, `schemas.ts`, `write-tools.ts`, `__tests__/write-tools.test.ts`

**Interfaces:**

- Consumes: `getCanvasWindowId` (Task 9), `mainToRendererInvoke`, `AgentMcpCanvasWriteChannel` (Task 10), `assertSpatialCanvasEnabled` (Task 6)
- Produces:

  ```ts
  export async function invokeCanvasWrite(
    windowId: string | null,
    request: AgentMcpCanvasWriteRequest
  ): Promise<AgentMcpCanvasWriteResponse & { ok: true }>
  // handles:
  canvas.addItems(input: { canvasId: string; items: CanvasEntityRef[] }, windowId: string | null)
  canvas.removeItem(input: { canvasId: string; item: CanvasEntityRef }, windowId: string | null)
  ```

- [ ] **Step 1: Write the failing routing test**

Create `apps/desktop/src/main/agent/mcp/tools/__tests__/canvas-write.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  mainToRendererInvoke: vi.fn(),
  fromId: vi.fn(),
  getAllWindows: vi.fn(),
  getCanvasWindowId: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: mocks.fromId, getAllWindows: mocks.getAllWindows }
}))
vi.mock('../../../../lib/window-rpc', () => ({
  mainToRendererInvoke: mocks.mainToRendererInvoke
}))
vi.mock('../../../../canvas/live-registry', () => ({
  getCanvasWindowId: mocks.getCanvasWindowId
}))

const win = (id: number) => ({ id, isDestroyed: () => false })
const okResponse = {
  ok: true,
  applied: [],
  skipped: [],
  updatedAt: 1,
  tooLarge: false,
  path: 'live'
}

describe('invokeCanvasWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mainToRendererInvoke.mockResolvedValue(okResponse)
  })

  it('prefers the window that has the canvas open', async () => {
    mocks.getCanvasWindowId.mockReturnValue(7)
    mocks.fromId.mockImplementation((id: number) => (id === 7 ? win(7) : null))
    const { invokeCanvasWrite } = await import('../canvas-write')

    await invokeCanvasWrite('3', { canvasId: 'c1', op: 'add', items: [] })

    expect(mocks.mainToRendererInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      expect.any(String),
      expect.objectContaining({ canvasId: 'c1' }),
      expect.any(Object)
    )
  })

  it('falls back to the calling window when the registry is stale', async () => {
    mocks.getCanvasWindowId.mockReturnValue(7)
    mocks.fromId.mockImplementation((id: number) => (id === 3 ? win(3) : null))
    mocks.getAllWindows.mockReturnValue([win(3)])
    const { invokeCanvasWrite } = await import('../canvas-write')

    await invokeCanvasWrite('3', { canvasId: 'c1', op: 'add', items: [] })

    expect(mocks.mainToRendererInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3 }),
      expect.any(String),
      expect.anything(),
      expect.any(Object)
    )
  })

  it('throws UNAVAILABLE when no window can mint elements', async () => {
    mocks.getCanvasWindowId.mockReturnValue(null)
    mocks.fromId.mockReturnValue(null)
    mocks.getAllWindows.mockReturnValue([])
    const { invokeCanvasWrite } = await import('../canvas-write')

    await expect(invokeCanvasWrite(null, { canvasId: 'c1', op: 'add', items: [] })).rejects.toThrow(
      /window/i
    )
  })

  it('surfaces a renderer error as a tool error', async () => {
    mocks.getCanvasWindowId.mockReturnValue(null)
    mocks.getAllWindows.mockReturnValue([win(1)])
    mocks.fromId.mockReturnValue(null)
    mocks.mainToRendererInvoke.mockResolvedValue({
      ok: false,
      error: { code: 'CANVAS_WRITE_ERROR', message: 'Canvas was modified by someone else' }
    })
    const { invokeCanvasWrite } = await import('../canvas-write')

    await expect(invokeCanvasWrite(null, { canvasId: 'c1', op: 'add', items: [] })).rejects.toThrow(
      /modified/i
    )
  })

  it('throws when the renderer never answers', async () => {
    mocks.getCanvasWindowId.mockReturnValue(null)
    mocks.getAllWindows.mockReturnValue([win(1)])
    mocks.fromId.mockReturnValue(null)
    mocks.mainToRendererInvoke.mockResolvedValue(null)
    const { invokeCanvasWrite } = await import('../canvas-write')

    await expect(invokeCanvasWrite(null, { canvasId: 'c1', op: 'add', items: [] })).rejects.toThrow(
      /timed out|no result/i
    )
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp/tools/__tests__/canvas-write.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the router**

Create `apps/desktop/src/main/agent/mcp/tools/canvas-write.ts`:

```ts
/**
 * Route an agent canvas write to a renderer window.
 *
 * Element minting needs convertToExcalidrawElements, which only exists in the
 * renderer — so every write goes through a window. The window that has the
 * canvas OPEN is preferred: it applies the change to the live Excalidraw
 * instance instead of a headless read-modify-write, which is what stops the
 * editor's next autosave from silently overwriting the agent (#916 §2e).
 */

import { BrowserWindow } from 'electron'
import {
  AgentMcpCanvasWriteChannel,
  type AgentMcpCanvasWriteRequest,
  type AgentMcpCanvasWriteResponse
} from '@memry/contracts/agent-mcp-channels'

import { getCanvasWindowId } from '../../../canvas/live-registry'
import { mainToRendererInvoke } from '../../../lib/window-rpc'
import { AgentToolError } from '../errors'

type OkResponse = Extract<AgentMcpCanvasWriteResponse, { ok: true }>

function resolveWindow(canvasId: string, windowId: string | null): BrowserWindow | null {
  const ownerId = getCanvasWindowId(canvasId)
  const owner = ownerId === null ? null : BrowserWindow.fromId(ownerId)
  if (owner) return owner

  const numericId = windowId === null ? NaN : Number(windowId)
  const caller = Number.isInteger(numericId) ? BrowserWindow.fromId(numericId) : null
  if (caller) return caller

  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null
}

export async function invokeCanvasWrite(
  windowId: string | null,
  request: AgentMcpCanvasWriteRequest
): Promise<OkResponse> {
  const win = resolveWindow(request.canvasId, windowId)
  if (!win) {
    throw new AgentToolError(
      'UNAVAILABLE',
      'Canvas writes need an open memrynote window; none is available.'
    )
  }

  const response = await mainToRendererInvoke<AgentMcpCanvasWriteResponse>(
    win,
    AgentMcpCanvasWriteChannel,
    request,
    { timeoutMs: 15_000 }
  )

  if (!response) {
    throw new AgentToolError('INTERNAL', 'Canvas write timed out or returned no result.', {
      canvasId: request.canvasId
    })
  }
  if (!response.ok) {
    throw new AgentToolError('INTERNAL', response.error.message, {
      canvasId: request.canvasId,
      code: response.error.code
    })
  }
  return response
}
```

- [ ] **Step 4: Add the handle methods**

In `handles.ts`, extend the `canvas` section:

```ts
  canvas: {
    list(): Promise<CanvasListEntry[]>
    read(id: string): Promise<CanvasDetail | null>
    addItems(
      input: { canvasId: string; items: { entityType: string; entityId: string }[] },
      windowId: string | null
    ): Promise<CanvasWriteOutcome>
    removeItem(
      input: { canvasId: string; item: { entityType: string; entityId: string } },
      windowId: string | null
    ): Promise<CanvasWriteOutcome>
  }
```

with

```ts
export interface CanvasWriteOutcome {
  canvas_id: string
  applied: { entity_type: string; entity_id: string }[]
  skipped: { entity_type: string; entity_id: string; reason: string }[]
  updated_at: number
  too_large: boolean
}
```

In `handles-adapter.ts`, implement them — validate the entities exist before minting anything:

```ts
      async addItems(input, windowId) {
        assertSpatialCanvasEnabled()
        for (const item of input.items) {
          await assertEntityExists(dataDb, item as CanvasEntityRef)
        }
        const result = await invokeCanvasWrite(windowId, {
          canvasId: input.canvasId,
          op: 'add',
          items: input.items as CanvasEntityRef[]
        })
        return toCanvasWriteOutcome(input.canvasId, result)
      },
      async removeItem(input, windowId) {
        assertSpatialCanvasEnabled()
        const result = await invokeCanvasWrite(windowId, {
          canvasId: input.canvasId,
          op: 'remove',
          items: [input.item as CanvasEntityRef]
        })
        return toCanvasWriteOutcome(input.canvasId, result)
      }
```

with these module-level helpers (reusing `resolveCanvasItem` from Task 7):

```ts
/** Refuse to mint a card pointing at nothing — the UI picker cannot, so neither can an agent. */
async function assertEntityExists(dataDb: DataDb, ref: CanvasEntityRef): Promise<void> {
  const resolved = await resolveCanvasItem(dataDb, ref)
  if (resolved.missing) {
    throw new AgentToolError('NOT_FOUND', `${ref.entityType} ${ref.entityId} not found`, {
      entityType: ref.entityType,
      entityId: ref.entityId
    })
  }
}

function toCanvasWriteOutcome(
  canvasId: string,
  result: {
    applied: { entityType: string; entityId: string }[]
    skipped: { ref: { entityType: string; entityId: string }; reason: string }[]
    updatedAt: number
    tooLarge: boolean
  }
): CanvasWriteOutcome {
  return {
    canvas_id: canvasId,
    applied: result.applied.map((r) => ({ entity_type: r.entityType, entity_id: r.entityId })),
    skipped: result.skipped.map((s) => ({
      entity_type: s.ref.entityType,
      entity_id: s.ref.entityId,
      reason: s.reason
    })),
    updated_at: result.updatedAt,
    too_large: result.tooLarge
  }
}
```

- [ ] **Step 5: Add the tool schemas**

In `schemas.ts`:

```ts
  vault_add_canvas_item: {
    input: z.object({
      canvas_id: idSchema,
      items: z
        .array(
          z.object({
            entity_type: z.enum(['note', 'task', 'calendar_event']),
            entity_id: idSchema
          })
        )
        .min(1)
        .max(20)
    }),
    description:
      'Put existing notes/tasks/events on a canvas as cards. Applies to the open editor when ' +
      'the user has that canvas open. Requires user approval.'
  },
  vault_remove_canvas_item: {
    input: z.object({
      canvas_id: idSchema,
      entity_type: z.enum(['note', 'task', 'calendar_event']),
      entity_id: idSchema
    }),
    description:
      'Remove an entity’s card from a canvas, clearing any arrows bound to it. ' +
      'The note/task/event itself is not deleted. Requires user approval.'
  },
```

Add both names to `WRITE_TOOL_NAMES` and `UPDATE_TOOL_NAMES` (they mutate an existing canvas, so they belong with the update-style approvals, not `CREATE_TOOL_NAMES`).

- [ ] **Step 6: Register the write tools**

In `write-tools.ts`, following the file's existing `approvedArgs` pattern exactly:

```ts
    vault_add_canvas_item: {
      name: 'vault_add_canvas_item',
      description: TOOL_SCHEMAS.vault_add_canvas_item.description,
      inputSchema: TOOL_SCHEMAS.vault_add_canvas_item.input,
      handler: async (input, ctx) => {
        const parsed = parse<{
          canvas_id: string
          items: { entity_type: 'note' | 'task' | 'calendar_event'; entity_id: string }[]
        }>(TOOL_SCHEMAS.vault_add_canvas_item.input, input)
        const a = await approvedArgs(gate, 'vault_add_canvas_item', parsed, ctx)
        return handles.canvas.addItems(
          {
            canvasId: a.canvas_id,
            items: a.items.map((i) => ({ entityType: i.entity_type, entityId: i.entity_id }))
          },
          ctx.windowId
        )
      }
    },
    vault_remove_canvas_item: {
      name: 'vault_remove_canvas_item',
      description: TOOL_SCHEMAS.vault_remove_canvas_item.description,
      inputSchema: TOOL_SCHEMAS.vault_remove_canvas_item.input,
      handler: async (input, ctx) => {
        const parsed = parse<{
          canvas_id: string
          entity_type: 'note' | 'task' | 'calendar_event'
          entity_id: string
        }>(TOOL_SCHEMAS.vault_remove_canvas_item.input, input)
        const a = await approvedArgs(gate, 'vault_remove_canvas_item', parsed, ctx)
        return handles.canvas.removeItem(
          {
            canvasId: a.canvas_id,
            item: { entityType: a.entity_type, entityId: a.entity_id }
          },
          ctx.windowId
        )
      }
    },
```

- [ ] **Step 7: Add the approval-gate test**

In `__tests__/write-tools.test.ts`, following the file's existing denial test:

```ts
it('refuses a canvas item write when the gate denies', async () => {
  const gate: WriteToolGate = async () => ({ approved: false, reason: 'user denied' })
  const tool = buildWriteTools(handles, gate).find((t) => t.name === 'vault_add_canvas_item')!

  await expect(
    tool.handler(
      { canvas_id: 'c1', items: [{ entity_type: 'note', entity_id: 'n1' }] },
      { conversationId: 'conv1', windowId: '1' }
    )
  ).rejects.toThrow(/denied/i)
  expect(handles.canvas.addItems).not.toHaveBeenCalled()
})
```

- [ ] **Step 8: Run everything and commit**

```bash
pnpm --filter @memry/desktop exec vitest run src/main/agent/mcp
pnpm --filter @memry/desktop typecheck:node
pnpm check:architecture
git add apps/desktop/src/main/agent/mcp
git commit -m "feat(mcp): vault_add_canvas_item and vault_remove_canvas_item (#916)"
```

---

### Task 12: Element-validity round trip

The acceptance criterion that cannot be faked: prove the elements written headlessly are elements Excalidraw accepts. This test uses the **real** `convertToExcalidrawElements` and the real `restore` — a mocked converter would prove nothing about the fields Excalidraw actually mints.

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/canvas/canvas-scene-roundtrip.test.ts`

**Interfaces:**

- Consumes: `planCardPlacements` (Task 8); `extractEntityRefs` from `./canvas-cards`; the real `convertToExcalidrawElements` and `restore` from `@excalidraw/excalidraw` (do **not** mock either — mocking the converter is exactly what would make this test prove nothing)

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'vitest'
import { convertToExcalidrawElements, restore } from '@excalidraw/excalidraw'
import { planCardPlacements } from './canvas-scene-edit'
import { extractEntityRefs, type CardElement } from './canvas-cards'

describe('agent-written card elements round-trip through Excalidraw', () => {
  it('mints every field Excalidraw requires and survives restore unrepaired', () => {
    const skeletons = planCardPlacements(
      [],
      [
        { entityType: 'note', entityId: 'n1', width: 260, height: 168 },
        { entityType: 'task', entityId: 't1', width: 260, height: 168 }
      ]
    )

    const created = convertToExcalidrawElements(
      skeletons as unknown as Parameters<typeof convertToExcalidrawElements>[0]
    )

    for (const element of created) {
      expect(element.id).toBeTruthy()
      expect(typeof element.seed).toBe('number')
      expect(typeof element.version).toBe('number')
      expect(typeof element.versionNonce).toBe('number')
      expect(typeof element.updated).toBe('number')
      expect(element.index).toBeTruthy()
    }

    const restored = restore({ elements: created, appState: {}, files: {} }, null, null)

    expect(restored.elements).toHaveLength(created.length)
    expect(restored.elements.map((e) => e.id)).toEqual(created.map((e) => e.id))
    expect(restored.elements.map((e) => e.customData)).toEqual(created.map((e) => e.customData))
  })

  it('re-derives the same entity refs from the written scene', () => {
    const skeletons = planCardPlacements(
      [],
      [{ entityType: 'note', entityId: 'n1', width: 260, height: 168 }]
    )
    const created = convertToExcalidrawElements(
      skeletons as unknown as Parameters<typeof convertToExcalidrawElements>[0]
    )

    expect(extractEntityRefs(created as unknown as CardElement[])).toEqual([
      { entityType: 'note', entityId: 'n1' }
    ])
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @memry/desktop exec vitest run src/renderer/src/pages/canvas/canvas-scene-roundtrip.test.ts`
Expected: PASS. If `restore` needs browser APIs jsdom lacks, do **not** delete the assertion — narrow it to `restoreElements(created, null)` (also exported) and note the reason in a comment above the call.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-scene-roundtrip.test.ts
git commit -m "test(canvas): prove agent-written card elements survive Excalidraw restore"
```

---

### Task 13: Docs + full verification

**Files:**

- Modify: `apps/docs/src/user-guide/ai/agent-mcp.md`

- [ ] **Step 1: Update the tool list**

Read the file first and match its existing table/section formatting. Add the four tools to the tool list with one-line descriptions, then a short subsection:

```markdown
### Canvas

| Tool                       | What it does                                              |
| -------------------------- | --------------------------------------------------------- |
| `vault_list_canvases`      | Canvases with how many items sit on each                  |
| `vault_read_canvas`        | One canvas: its entities (with titles) and any text on it |
| `vault_add_canvas_item`    | Put notes/tasks/events on a canvas as cards               |
| `vault_remove_canvas_item` | Take a card off a canvas                                  |

Canvas tools require the **Spatial Canvas** feature (Settings → Features). With it off they return a
message saying so.

Reading a canvas never returns the drawing itself — an agent gets what is on the canvas, not the
geometry that draws it. Some canvas operations are deliberately unavailable through
`vault_desktop_read` / `vault_desktop_write`:

- `canvas.get` — returns the whole scene; use `vault_read_canvas`
- `canvas.update` — replaces the entire scene with no version check, which would overwrite whatever
  you have open; use the item tools
- `canvas.librarySave` — saves the shape library as a whole list, so a partial one deletes shapes
- `canvas.uploadAsset` — binary image upload, no agent path yet

Agents cannot draw arrows between cards. An arrow on a canvas is a picture, not a stored relationship,
so an agent drawing one would look like it created a link when it did not. Use wiki links between notes
for real connections.
```

- [ ] **Step 2: Run the docs gate**

```bash
base_commit=$(git merge-base origin/main HEAD)
pnpm docs:impact --base "$base_commit" --strict
pnpm docs:build
```

Expected: PASS. If `missing-docs`, add the missing page sections under `apps/docs/src/**` — do not use `MEMRY_DOCS_IMPACT_SKIP`.

- [ ] **Step 3: Full verification**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm check:architecture
pnpm check:contracts
pnpm ipc:generate && pnpm ipc:check
git diff --check
```

Expected: all PASS. Pre-existing failures in `websocket.test.ts` / `folders.test.ts` are known and unrelated — confirm they fail identically on `origin/main` before dismissing any failure.

- [ ] **Step 4: Commit**

```bash
git add apps/docs/src/user-guide/ai/agent-mcp.md
git commit -m "docs(mcp): document canvas tools and the deliberate exclusions"
```

---

## Manual verification (before opening the PR)

Automated tests cannot prove the live-routing behaviour, which is the whole point of the design. Run
the app and check by hand:

1. `pnpm dev`, enable **Settings → Features → Spatial Canvas**, create a canvas, leave it open.
2. From an Agent Chat conversation, ask the agent to add a note to that canvas. Approve the write.
   **Expect:** the card appears in the open editor without a reload, and the canvas is not duplicated
   or reverted after the autosave debounce (~1s).
3. Switch to another tab so the canvas unmounts, add a second note, then reopen the canvas.
   **Expect:** both cards present.
4. Draw an arrow between two cards, then ask the agent to remove one of them.
   **Expect:** the card goes, the arrow does not keep a stub bound to a missing element.
5. Turn the flag off, ask the agent to list canvases.
   **Expect:** the "enable it in Settings → Features" message, not a crash or an empty list.
