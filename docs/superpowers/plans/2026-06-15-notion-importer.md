# Notion Importer + Import Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users import a Notion HTML export (`.zip`) into Memry as markdown notes — folders mirror the page tree, attachments copied, internal links → wikilinks, DB properties → frontmatter — built on a reusable import framework that future importers plug into.

**Architecture:** Main-process import framework (`registry` + `Importer` interface + streaming `ImportContext`) driven by generic IPC. The Notion importer is its first consumer: pure submodules (parse-info, resolver, convert-to-md) do FS-free work and unit-test against the real export; a thin orchestrator wires them to `createNote`/`saveAttachment`. Renderer is a dedicated Import hub that starts a run, streams progress, and can cancel.

**Tech Stack:** Electron 39 + React 19, TypeScript, Vitest, Zod contracts, `jsdom` (HTML parsing in main, already a dep), `yauzl` (new — zip reading), Drizzle/better-sqlite3 vault.

**Reference (port source, read-only):** `/Users/h4yfans/workspace/obsidian-importer/src/formats/notion/` and `src/formats/notion.ts`. Port logic, adapt to Memry (jsdom instead of obsidian `parseHTML`; `[[wikilinks]]`; frontmatter `properties`; `createNote`/`saveAttachment` instead of `vault.create`/`createBinary`).

**Conventions (all tasks):** Prettier — single quotes, no semicolons, 100 col, no trailing commas. Logging via `createLogger('Scope')`. User-facing errors via `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`. Run commands from the worktree root `/Users/h4yfans/workspace/memry/.worktrees/notion-importer`. Tests: `pnpm --filter @memry/desktop test:main -- <file>`.

---

## File Structure

**Framework — `apps/desktop/src/main/import/`**

- `types.ts` — `Importer`, `ImportContext`, `ImportSummary`, `ImportFileSpec`, `ImportProgress`.
- `registry.ts` — `registerImporter` / `getImporter` / `listImporters`.
- `import-context.ts` — `createImportContext(importId, signal)`: tallies + emits `import:progress` events.
- `runner.ts` — `runImport(input)` / `cancelImport(importId)`: AbortController map, builds ctx, calls importer.
- `register-builtins.ts` — registers the Notion importer once.

**Notion — `apps/desktop/src/main/import/notion/`**

- `notion-utils.ts` — `getNotionId`, `parseParentIds`, `stripNotionId`.
- `parse-info.ts` — `parseFileInfo(info, entry)` (pure; jsdom).
- `resolver.ts` — `NotionResolverInfo` (maps + `getPathForFile`) + `cleanDuplicates`.
- `convert-to-md.ts` — `convertHtmlToMarkdown(info, entry)` (pure; jsdom).
- `notion-zip.ts` — `forEachZipEntry(paths, signal, cb)` (yauzl, nested, zip-slip-safe).
- `notion-importer.ts` — `notionImporter: Importer` orchestrator.

**Contracts — `packages/contracts/src/`**

- `import-channels.ts` — `ImportChannels` (invoke START/CANCEL, events PROGRESS) + Zod schemas + types.
- export from `index.ts`.

**Main IPC — `apps/desktop/src/main/ipc/`**

- `import-handlers.ts` — `registerImportHandlers` / `unregisterImportHandlers`.
- wire into `index.ts` and `index.test.ts` mock.

**Renderer — `apps/desktop/src/renderer/src/`**

- `lib/import-catalog.ts` — UI catalog (`{ id, name, description, icon }`).
- `pages/settings/import-section.tsx` — Settings → Import section (list + launch).
- `components/settings/import-dialog.tsx` — picker + live progress + cancel + summary.
- `hooks/use-import-run.ts` — start/subscribe/cancel state machine.

**Vault (small core change) — `apps/desktop/src/main/vault/`**

- `notes-crud.ts` + `frontmatter.ts` — accept optional `created`/`modified` on `NoteCreateInput`.

---

## Phase 0 — Setup

### Task 0.1: Add `yauzl` dependency

**Files:**

- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Add the dep**

Run:

```bash
pnpm --filter @memry/desktop add yauzl && pnpm --filter @memry/desktop add -D @types/yauzl
```

- [ ] **Step 2: Verify install + types resolve**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "build(notion-import): add yauzl for zip reading"
```

### Task 0.2: Extract real test fixtures from the export zip

The sample export lives at the repo root (one level up from the worktree):
`/Users/h4yfans/workspace/memry/e16ede6b-5bad-4f27-98e4-8851e8f81092_Export-9232703c-69b4-4c73-a025-00815d9e2b3b.zip`. It is a **nested** zip (`Export-….zip` → `…-Part-1.zip`).

**Files:**

- Create: `apps/desktop/src/main/import/notion/__fixtures__/` (the copied zip + an unzipped tree)

- [ ] **Step 1: Copy the zip into fixtures and unzip both levels**

```bash
mkdir -p apps/desktop/src/main/import/notion/__fixtures__
cp "/Users/h4yfans/workspace/memry/e16ede6b-5bad-4f27-98e4-8851e8f81092_Export-9232703c-69b4-4c73-a025-00815d9e2b3b.zip" \
   apps/desktop/src/main/import/notion/__fixtures__/notion-export.zip
cd apps/desktop/src/main/import/notion/__fixtures__ && unzip -o notion-export.zip -d unzipped && \
  unzip -o unzipped/*.zip -d unzipped/part-1 && cd -
```

- [ ] **Step 2: Inspect a page HTML to confirm selectors (title, id, property rows)**

Run: `ls -R apps/desktop/src/main/import/notion/__fixtures__/unzipped/part-1 | head -30`
Then open one `.html` and confirm `<title>`, body element `id` (32-hex), and `tr.property-row-created_time` / `property-row-last_edited_time` exist. Record actual filenames for use in later test assertions.

> If the sample is too small to contain a database, nested page, or attachment, **synthesize** a minimal second fixture zip (`notion-export-synthetic.zip`) with: a parent page + child page (nesting), one page with an internal link to another, one image attachment, and one DB page with a `multi_select` property. Build it by hand-writing HTML matching the selectors observed in Step 2.

- [ ] **Step 3: Commit fixtures**

```bash
git add apps/desktop/src/main/import/notion/__fixtures__
git commit -m "test(notion-import): add real + synthetic export fixtures"
```

---

## Phase 1 — Framework core

### Task 1.1: Framework types

**Files:**

- Create: `apps/desktop/src/main/import/types.ts`

- [ ] **Step 1: Write the types (no test — pure declarations)**

```ts
export interface ImportFileSpec {
  label: string
  extensions: string[]
  allowMultiple: boolean
}

export interface ImportProgress {
  importId: string
  phase: 'scanning' | 'importing' | 'done'
  status: string
  imported: number
  attachments: number
  skipped: number
  failed: number
  completed: number
  total: number
  done: boolean
  summary?: ImportSummary
}

export interface ImportSummary {
  imported: number
  attachments: number
  skipped: number
  failed: { item: string; error: string }[]
}

export interface ImportContext {
  status(message: string): void
  setPhase(phase: ImportProgress['phase']): void
  reportProgress(completed: number, total: number): void
  reportNote(): void
  reportAttachment(): void
  reportSkipped(item: string, reason?: string): void
  reportFailed(item: string, error?: unknown): void
  isCancelled(): boolean
  toSummary(): ImportSummary
}

export interface ImportInput {
  sourcePaths: string[]
  options?: Record<string, unknown>
}

export interface Importer {
  id: string
  name: string
  fileSpec: ImportFileSpec
  run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary>
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/import/types.ts
git commit -m "feat(import): framework types"
```

### Task 1.2: Registry

**Files:**

- Create: `apps/desktop/src/main/import/registry.ts`
- Test: `apps/desktop/src/main/import/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { registerImporter, getImporter, listImporters, __resetRegistry } from './registry'
import type { Importer } from './types'

const fake: Importer = {
  id: 'fake',
  name: 'Fake',
  fileSpec: { label: 'Fake', extensions: ['zip'], allowMultiple: false },
  run: async () => ({ imported: 0, attachments: 0, skipped: 0, failed: [] })
}

describe('importer registry', () => {
  beforeEach(() => __resetRegistry())

  it('registers and looks up by id', () => {
    registerImporter(fake)
    expect(getImporter('fake')).toBe(fake)
  })

  it('lists registered importers', () => {
    registerImporter(fake)
    expect(listImporters().map((i) => i.id)).toEqual(['fake'])
  })

  it('throws on duplicate id', () => {
    registerImporter(fake)
    expect(() => registerImporter(fake)).toThrow(/already registered/)
  })

  it('returns undefined for unknown id', () => {
    expect(getImporter('nope')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- registry.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import type { Importer } from './types'

const importers = new Map<string, Importer>()

export function registerImporter(importer: Importer): void {
  if (importers.has(importer.id)) {
    throw new Error(`Importer "${importer.id}" already registered`)
  }
  importers.set(importer.id, importer)
}

export function getImporter(id: string): Importer | undefined {
  return importers.get(id)
}

export function listImporters(): Importer[] {
  return [...importers.values()]
}

/** Test-only: clear the registry between cases. */
export function __resetRegistry(): void {
  importers.clear()
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/import/registry.ts apps/desktop/src/main/import/registry.test.ts
git commit -m "feat(import): importer registry"
```

### Task 1.3: Import context (tallies + progress emit)

**Files:**

- Create: `apps/desktop/src/main/import/import-context.ts`
- Test: `apps/desktop/src/main/import/import-context.test.ts`

The context emits `import:progress` to all windows. Mock `electron`'s `BrowserWindow` (Memry test pattern — see `apps/desktop/src/main/lib/embeddings.test.ts`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { send } }] }
}))

import { createImportContext } from './import-context'
import { ImportChannels } from '@memry/contracts'

describe('import context', () => {
  beforeEach(() => send.mockClear())

  it('tallies notes/attachments/skipped/failed into summary', () => {
    const ctx = createImportContext('id1', new AbortController().signal)
    ctx.reportNote()
    ctx.reportNote()
    ctx.reportAttachment()
    ctx.reportSkipped('a.html', 'empty')
    ctx.reportFailed('b.html', new Error('boom'))
    const s = ctx.toSummary()
    expect(s).toEqual({
      imported: 2,
      attachments: 1,
      skipped: 1,
      failed: [{ item: 'b.html', error: 'boom' }]
    })
  })

  it('emits a progress event keyed by importId', () => {
    const ctx = createImportContext('id1', new AbortController().signal)
    ctx.reportProgress(3, 10)
    expect(send).toHaveBeenCalledWith(
      ImportChannels.events.PROGRESS,
      expect.objectContaining({ importId: 'id1', completed: 3, total: 10 })
    )
  })

  it('reflects an aborted signal in isCancelled()', () => {
    const ac = new AbortController()
    const ctx = createImportContext('id1', ac.signal)
    expect(ctx.isCancelled()).toBe(false)
    ac.abort()
    expect(ctx.isCancelled()).toBe(true)
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- import-context.test.ts`
Expected: FAIL (module + `ImportChannels` not found — `ImportChannels` lands in Task 5.1; if running this task before contracts, temporarily inline the channel string `'import:progress'` and replace with `ImportChannels.events.PROGRESS` after Task 5.1).

- [ ] **Step 3: Implement**

```ts
import { BrowserWindow } from 'electron'
import { ImportChannels } from '@memry/contracts'
import { createLogger } from '@/main/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { ImportContext, ImportProgress, ImportSummary } from './types'

const logger = createLogger('Import')

export function createImportContext(importId: string, signal: AbortSignal): ImportContext {
  let imported = 0
  let attachments = 0
  let skipped = 0
  let completed = 0
  let total = 0
  let phase: ImportProgress['phase'] = 'scanning'
  let status = ''
  const failed: { item: string; error: string }[] = []

  const emit = (done = false): void => {
    const payload: ImportProgress = {
      importId,
      phase,
      status,
      imported,
      attachments,
      skipped,
      failed: failed.length,
      completed,
      total,
      done,
      summary: done ? toSummary() : undefined
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(ImportChannels.events.PROGRESS, payload)
    }
  }

  const toSummary = (): ImportSummary => ({ imported, attachments, skipped, failed })

  return {
    status: (m) => {
      status = m
      emit()
    },
    setPhase: (p) => {
      phase = p
      emit()
    },
    reportProgress: (c, t) => {
      completed = c
      total = t
      emit()
    },
    reportNote: () => {
      imported++
      emit()
    },
    reportAttachment: () => {
      attachments++
      emit()
    },
    reportSkipped: (item, reason) => {
      skipped++
      logger.info('skipped', { item, reason })
      emit()
    },
    reportFailed: (item, error) => {
      failed.push({ item, error: extractErrorMessage(error, 'Import error') })
      logger.warn('failed', { item })
      emit()
    },
    isCancelled: () => signal.aborted,
    toSummary
  }
}
```

> Confirm the logger import path matches the repo (`grep -rn "createLogger" apps/desktop/src/main/ipc/notes-handlers.ts` shows the exact import). Adjust the `@/main/logger` / `@/lib/ipc-error` aliases to match what that file uses.

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- import-context.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/import/import-context.ts apps/desktop/src/main/import/import-context.test.ts
git commit -m "feat(import): streaming import context"
```

### Task 1.4: Runner (AbortController map)

**Files:**

- Create: `apps/desktop/src/main/import/runner.ts`
- Test: `apps/desktop/src/main/import/runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))
import { runImport, cancelImport } from './runner'
import { registerImporter, __resetRegistry } from './registry'
import type { Importer } from './types'

describe('runner', () => {
  beforeEach(() => __resetRegistry())

  it('runs the named importer and returns its summary', async () => {
    const imp: Importer = {
      id: 'x',
      name: 'X',
      fileSpec: { label: 'X', extensions: ['zip'], allowMultiple: false },
      run: async () => ({ imported: 5, attachments: 0, skipped: 0, failed: [] })
    }
    registerImporter(imp)
    const s = await runImport({ importId: 'r1', importerId: 'x', sourcePaths: ['a.zip'] })
    expect(s.imported).toBe(5)
  })

  it('throws for unknown importer id', async () => {
    await expect(
      runImport({ importId: 'r2', importerId: 'nope', sourcePaths: [] })
    ).rejects.toThrow(/unknown importer/i)
  })

  it('cancel aborts the run signal', async () => {
    let cancelledSeen = false
    const imp: Importer = {
      id: 'y',
      name: 'Y',
      fileSpec: { label: 'Y', extensions: ['zip'], allowMultiple: false },
      run: async (_input, ctx) => {
        cancelImport('r3')
        cancelledSeen = ctx.isCancelled()
        return { imported: 0, attachments: 0, skipped: 0, failed: [] }
      }
    }
    registerImporter(imp)
    await runImport({ importId: 'r3', importerId: 'y', sourcePaths: [] })
    expect(cancelledSeen).toBe(true)
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- runner.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import { getImporter } from './registry'
import { createImportContext } from './import-context'
import type { ImportSummary } from './types'

const controllers = new Map<string, AbortController>()

export interface RunImportInput {
  importId: string
  importerId: string
  sourcePaths: string[]
  options?: Record<string, unknown>
}

export async function runImport(input: RunImportInput): Promise<ImportSummary> {
  const importer = getImporter(input.importerId)
  if (!importer) throw new Error(`Unknown importer: ${input.importerId}`)

  const controller = new AbortController()
  controllers.set(input.importId, controller)
  const ctx = createImportContext(input.importId, controller.signal)
  try {
    return await importer.run({ sourcePaths: input.sourcePaths, options: input.options }, ctx)
  } finally {
    controllers.delete(input.importId)
    ctx.setPhase('done')
  }
}

export function cancelImport(importId: string): void {
  controllers.get(importId)?.abort()
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- runner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/import/runner.ts apps/desktop/src/main/import/runner.test.ts
git commit -m "feat(import): import runner with cancel"
```

---

## Phase 2 — Notion zip reader

### Task 2.1: `notion-zip.ts` (yauzl, nested, zip-slip-safe)

Mirror obsidian `src/zip.ts` + the `processZips` recursion in `notion.ts`. Provide a flat async iterator over entries; recurse into a `.zip` entry only when it sits at the root of its parent zip.

**Files:**

- Create: `apps/desktop/src/main/import/notion/notion-zip.ts`
- Test: `apps/desktop/src/main/import/notion/notion-zip.test.ts`

- [ ] **Step 1: Write the failing test (uses the real fixture zip)**

```ts
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { forEachZipEntry } from './notion-zip'

const FIXTURE = path.join(__dirname, '__fixtures__', 'notion-export.zip')

describe('notion-zip', () => {
  it('recurses into the nested Part-1.zip and yields html entries', async () => {
    const names: string[] = []
    await forEachZipEntry([FIXTURE], new AbortController().signal, async (entry) => {
      names.push(entry.filepath)
    })
    expect(names.some((n) => n.endsWith('.html'))).toBe(true)
  })

  it('rejects a zip-slip entry path', async () => {
    // forEachZipEntry must throw if any entry resolves outside the archive root.
    // Asserted via the guard helper:
    const { assertSafeEntryPath } = await import('./notion-zip')
    expect(() => assertSafeEntryPath('../../etc/passwd')).toThrow(/unsafe/i)
    expect(() => assertSafeEntryPath('a/b/c.html')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- notion-zip.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (port obsidian `zip.ts`, swap to `yauzl`)

```ts
import yauzl from 'yauzl'
import path from 'node:path'

export interface ZipEntry {
  /** Full path within the (possibly nested) archive, e.g. "Part-1/My Page abc.html". */
  filepath: string
  /** Basename, e.g. "My Page abc.html". */
  name: string
  /** Lowercased extension without dot, e.g. "html". */
  extension: string
  /** Parent dir within the archive ("" at root). */
  parent: string
  read(): Promise<Buffer>
  readText(): Promise<string>
}

export function assertSafeEntryPath(entryPath: string): void {
  const normalized = path.normalize(entryPath)
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe zip entry path: ${entryPath}`)
  }
}

type EntryCallback = (entry: ZipEntry) => Promise<void>

/** Iterate all entries across the given zip files, recursing into root-level nested zips. */
export async function forEachZipEntry(
  zipPaths: string[],
  signal: AbortSignal,
  cb: EntryCallback
): Promise<void> {
  for (const zipPath of zipPaths) {
    if (signal.aborted) return
    const buffer = await readFileBuffer(zipPath)
    await iterateBuffer(buffer, '', signal, cb)
  }
}

async function iterateBuffer(
  buffer: Buffer,
  prefix: string,
  signal: AbortSignal,
  cb: EntryCallback
): Promise<void> {
  const entries = await readZipEntries(buffer)
  for (const e of entries) {
    if (signal.aborted) return
    assertSafeEntryPath(e.fileName)
    if (e.fileName.endsWith('/')) continue // directory entry

    const ext = extOf(e.fileName)
    const parent = path.posix.dirname(e.fileName)
    // Recurse into nested zip only when at the root of this archive (obsidian rule).
    if (ext === 'zip' && (parent === '.' || parent === '')) {
      const nested = await e.read()
      await iterateBuffer(nested, joinPrefix(prefix, stripExt(e.fileName)), signal, cb)
      continue
    }
    const filepath = joinPrefix(prefix, e.fileName)
    await cb({
      filepath,
      name: path.posix.basename(e.fileName),
      extension: ext,
      parent: path.posix.dirname(filepath) === '.' ? '' : path.posix.dirname(filepath),
      read: () => e.read(),
      readText: async () => (await e.read()).toString('utf8')
    })
  }
}

// --- yauzl glue (promisified) ---

interface RawEntry {
  fileName: string
  read(): Promise<Buffer>
}

function readZipEntries(buffer: Buffer): Promise<RawEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Failed to open zip'))
      const out: RawEntry[] = []
      zip.on('entry', (entry) => {
        out.push({
          fileName: entry.fileName,
          read: () =>
            new Promise<Buffer>((res, rej) => {
              zip.openReadStream(entry, (e, stream) => {
                if (e || !stream) return rej(e ?? new Error('read stream failed'))
                const chunks: Buffer[] = []
                stream.on('data', (c) => chunks.push(c as Buffer))
                stream.on('end', () => res(Buffer.concat(chunks)))
                stream.on('error', rej)
              })
            })
        })
        zip.readEntry()
      })
      zip.on('end', () => resolve(out))
      zip.on('error', reject)
      zip.readEntry()
    })
  })
}

async function readFileBuffer(p: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises')
  return readFile(p)
}

const extOf = (f: string): string => {
  const i = f.lastIndexOf('.')
  return i < 0 ? '' : f.slice(i + 1).toLowerCase()
}
const stripExt = (f: string): string => f.slice(0, f.lastIndexOf('.'))
const joinPrefix = (prefix: string, rest: string): string =>
  prefix ? path.posix.join(prefix, rest) : rest
```

> Note: `read()` for a nested entry must buffer the full child zip in memory before re-parsing. Notion `Part-N.zip` members are bounded, so this is acceptable.

- [ ] **Step 4: Run — verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- notion-zip.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/import/notion/notion-zip.ts apps/desktop/src/main/import/notion/notion-zip.test.ts
git commit -m "feat(notion-import): nested zip-slip-safe zip reader"
```

---

## Phase 3 — Notion pure converters

### Task 3.1: `notion-utils.ts`

Port obsidian `notion/notion-utils.ts` helpers actually used: `getNotionId`, `parseParentIds`, plus a `stripNotionId`.

**Files:**

- Create: `apps/desktop/src/main/import/notion/notion-utils.ts`
- Test: `apps/desktop/src/main/import/notion/notion-utils.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { getNotionId, parseParentIds, stripNotionId } from './notion-utils'

describe('notion-utils', () => {
  it('extracts the 32-hex id from a notion name', () => {
    expect(getNotionId('My Page 0123456789abcdef0123456789abcdef.html')).toBe(
      '0123456789abcdef0123456789abcdef'
    )
  })
  it('returns undefined when no id', () => {
    expect(getNotionId('index.html')).toBeUndefined()
  })
  it('parses parent ids from a nested path', () => {
    const p = 'Parent 0123456789abcdef0123456789abcdef/Child fedcba9876543210fedcba9876543210.html'
    expect(parseParentIds(p)).toContain('0123456789abcdef0123456789abcdef')
  })
  it('strips the id suffix from a folder/file name', () => {
    expect(stripNotionId('My Page 0123456789abcdef0123456789abcdef')).toBe('My Page')
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- notion-utils.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (port; the id is a 32-char hex run)

```ts
const ID_RE = /([a-f0-9]{32})/

export function getNotionId(name: string): string | undefined {
  return name.match(ID_RE)?.[1]
}

export function parseParentIds(filepath: string): string[] {
  return filepath
    .split('/')
    .map((seg) => getNotionId(seg))
    .filter((id): id is string => Boolean(id))
}

export function stripNotionId(name: string): string {
  return name.replace(/\s*[a-f0-9]{32}$/i, '').trim()
}
```

- [ ] **Step 4: Run — verify it passes** — Run: `pnpm --filter @memry/desktop test:main -- notion-utils.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/import/notion/notion-utils.ts apps/desktop/src/main/import/notion/notion-utils.test.ts
git commit -m "feat(notion-import): notion id/path utils"
```

### Task 3.2: `resolver.ts` (NotionResolverInfo + cleanDuplicates)

Port obsidian `notion/notion-types.ts` (`NotionResolverInfo`, `getPathForFile`) and `notion/clean-duplicates.ts`. Replace `parseFilePath` with `node:path/posix` + `stripNotionId`.

**Files:**

- Create: `apps/desktop/src/main/import/notion/resolver.ts`
- Test: `apps/desktop/src/main/import/notion/resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { NotionResolverInfo } from './resolver'

const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('NotionResolverInfo', () => {
  it('builds a nested folder path from parent ids', () => {
    const info = new NotionResolverInfo()
    info.idsToFileInfo[ID_A] = {
      path: `Parent ${ID_A}.html`,
      parentIds: [],
      title: 'Parent',
      ctime: null,
      mtime: null
    }
    info.idsToFileInfo[ID_B] = {
      path: `Parent ${ID_A}/Child ${ID_B}.html`,
      parentIds: [ID_A],
      title: 'Child',
      ctime: null,
      mtime: null
    }
    expect(info.getPathForFile(info.idsToFileInfo[ID_B])).toBe('Parent/')
  })

  it('falls back to folder structure with stripped ids when no parentIds', () => {
    const info = new NotionResolverInfo()
    const fileInfo = {
      path: `Notes ${ID_A}/Note ${ID_B}.html`,
      parentIds: [],
      title: 'Note',
      ctime: null,
      mtime: null
    }
    expect(info.getPathForFile(fileInfo)).toBe('Notes/')
  })
})
```

- [ ] **Step 2: Run — verify it fails** — Run: `pnpm --filter @memry/desktop test:main -- resolver.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** — port `NotionResolverInfo` from obsidian `notion-types.ts:77-132` and `cleanDuplicates` from `clean-duplicates.ts`, with these adaptations:
  - Drop the `attachmentPath` / `singleLineBreaks` constructor args (Memry doesn't need them; default body separation to two line breaks).
  - Replace `parseFilePath(...).parent` with `path.posix.dirname`.
  - Replace the inline id-strip regex with `stripNotionId`.
  - Keep `idsToFileInfo` / `pathsToAttachmentInfo` shapes from the spec's `NotionFileInfo` / `NotionAttachmentInfo`.
  - `cleanDuplicates(info, targetFolderPath)` resolves attachment `targetParentFolder`, dedupes titles that collide, and marks `fullLinkPathNeeded` (port logic verbatim; it is FS-free).

- [ ] **Step 4: Run — verify it passes** — Run: `pnpm --filter @memry/desktop test:main -- resolver.test.ts` — Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/import/notion/resolver.ts apps/desktop/src/main/import/notion/resolver.test.ts
git commit -m "feat(notion-import): page-tree resolver + dedup"
```

### Task 3.3: `parse-info.ts` (jsdom)

Port obsidian `notion/parse-info.ts`. Replace obsidian `parseHTML` with `jsdom`'s `JSDOM`. Keep `extractTimeFromDOMElement`, title-from-`<title>`, id-from-body-children, attachment branch.

**Files:**

- Create: `apps/desktop/src/main/import/notion/parse-info.ts`
- Test: `apps/desktop/src/main/import/notion/parse-info.test.ts`

- [ ] **Step 1: Write the failing test** (against a real fixture page recorded in Task 0.2; substitute the actual filename + expected title/id)

```ts
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { parsePageInfo } from './parse-info'

function pageHtml(id: string, title: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title></head>
  <body><div id="${id}" class="page">
    <table><tbody>
      <tr class="property-row property-row-created_time"><td><time>@January 1, 2024 10:00 AM</time></td></tr>
      <tr class="property-row property-row-last_edited_time"><td><time>@January 2, 2024 11:00 AM</time></td></tr>
    </tbody></table>
  </div></body></html>`
}

describe('parsePageInfo', () => {
  it('extracts id, title, ctime, mtime', () => {
    const id = '0123456789abcdef0123456789abcdef'
    const dom = new JSDOM(pageHtml(id, 'My Page'))
    const info = parsePageInfo(dom.window.document, `My Page ${id}.html`)
    expect(info.id).toBe(id)
    expect(info.title).toBe('My Page')
    expect(info.ctime?.getFullYear()).toBe(2024)
    expect(info.mtime?.getMonth()).toBe(0) // January
  })
})
```

- [ ] **Step 2: Run — verify it fails** — Run: `pnpm --filter @memry/desktop test:main -- parse-info.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** — port obsidian `parse-info.ts:6-114`, signature `parsePageInfo(doc: Document, filepath: string): { id, title, parentIds, ctime, mtime }`. Use `doc.querySelector('title')`, iterate `doc.body.children` for the id (via `getNotionId(child.id)`), `doc.querySelector('tr.property-row-created_time time')`, and the obsidian `parseDateTime` / `stripTo200` / `sanitizeFileName` helpers (inline `sanitizeFileName` as `.replace(/[\\/:*?"<>|]/g, '')`).

- [ ] **Step 4: Run — verify it passes** — Run: `pnpm --filter @memry/desktop test:main -- parse-info.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/import/notion/parse-info.ts apps/desktop/src/main/import/notion/parse-info.test.ts
git commit -m "feat(notion-import): page info parser (jsdom)"
```

### Task 3.4: `convert-to-md.ts` (jsdom → Memry markdown)

Port obsidian `notion/convert-to-md.ts` (727 lines). It is FS-free. Adaptations:

- Replace obsidian `parseHTML(text)` with `new JSDOM(text).window.document`.
- Internal page links (`<a href>` resolving to a known Notion id) → `[[Title]]` wikilinks (obsidian emits `[[path|alias]]`; Memry uses `[[Title]]`).
- The DB property table → a frontmatter `properties` object (return it separately from the body); `multi_select`/tag → `tags[]`. Obsidian inlines YAML; here, **return `{ body, properties, tags }`** so the orchestrator passes them to `createNote`.
- Keep block conversions (headings, lists, to-do `- [ ]`/`- [x]`, code fences, tables, blockquotes/callouts, images, equations) as-is, targeting CommonMark + Memry callouts.

**Files:**

- Create: `apps/desktop/src/main/import/notion/convert-to-md.ts`
- Test: `apps/desktop/src/main/import/notion/convert-to-md.test.ts`

- [ ] **Step 1: Write failing tests** (focus on the Memry-specific adaptations)

```ts
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { convertHtmlToMarkdown } from './convert-to-md'
import { NotionResolverInfo } from './resolver'

const ID_T = 'cccccccccccccccccccccccccccccccc'

describe('convertHtmlToMarkdown', () => {
  it('converts a to-do list to markdown checkboxes', () => {
    const html = `<body><ul><li class="to-do"><input type="checkbox" checked>done</li>
      <li class="to-do"><input type="checkbox">todo</li></ul></body>`
    const doc = new JSDOM(html).window.document
    const { body } = convertHtmlToMarkdown(new NotionResolverInfo(), doc, 'p.html')
    expect(body).toContain('- [x] done')
    expect(body).toContain('- [ ] todo')
  })

  it('rewrites an internal page link to a wikilink', () => {
    const info = new NotionResolverInfo()
    info.idsToFileInfo[ID_T] = {
      path: `Target ${ID_T}.html`,
      parentIds: [],
      title: 'Target',
      ctime: null,
      mtime: null
    }
    const html = `<body><p><a href="Target%20${ID_T}.html">Target</a></p></body>`
    const doc = new JSDOM(html).window.document
    const { body } = convertHtmlToMarkdown(info, doc, 'src.html')
    expect(body).toContain('[[Target]]')
  })

  it('extracts multi_select property as tags', () => {
    const html = `<body><table class="properties"><tbody>
      <tr class="property-row"><th>Tags</th>
      <td class="multi_select"><span>work</span><span>home</span></td></tr>
      </tbody></table></body>`
    const doc = new JSDOM(html).window.document
    const { tags } = convertHtmlToMarkdown(new NotionResolverInfo(), doc, 'p.html')
    expect(tags).toEqual(['work', 'home'])
  })
})
```

- [ ] **Step 2: Run — verify it fails** — Run: `pnpm --filter @memry/desktop test:main -- convert-to-md.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** — port `convert-to-md.ts`, return `{ body: string; properties: Record<string, unknown>; tags: string[] }`. Link rewrite: when an `<a href>`'s decoded path contains a known id in `info.idsToFileInfo`, emit `[[${info.idsToFileInfo[id].title}]]`; attachment links → `![](relPath)` for images, `[name](relPath)` otherwise; external links stay `[text](href)`. Property table: map each `tr.property-row`; `multi_select` cells → push cell `<span>` texts into `tags`; other types → `properties[propTitle]`.

> This is the largest task. If too large for one TDD cycle, split the per-block converters into a sequence (headings → lists/to-do → code → tables → callouts → links → images → properties), each its own failing test + commit, all in `convert-to-md.ts`.

- [ ] **Step 4: Run — verify it passes** — Run: `pnpm --filter @memry/desktop test:main -- convert-to-md.test.ts` — Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/import/notion/convert-to-md.ts apps/desktop/src/main/import/notion/convert-to-md.test.ts
git commit -m "feat(notion-import): HTML → Memry markdown converter"
```

---

## Phase 4 — Notion orchestrator

### Task 4.0: Optional `created`/`modified` on `NoteCreateInput`

Notion timestamps must survive import. `createNote` auto-sets `created`/`modified` via `createFrontmatter`. Extend it.

**Files:**

- Modify: `apps/desktop/src/main/vault/notes-crud.ts` (`NoteCreateInput` + `createNote`)
- Modify: `apps/desktop/src/main/vault/frontmatter.ts` (`createFrontmatter`)
- Test: `apps/desktop/src/main/vault/notes.test.ts` (add a case)

- [ ] **Step 1: Read `createFrontmatter`**

Run: `grep -n "export function createFrontmatter" apps/desktop/src/main/vault/frontmatter.ts` and read it. Confirm it sets `created`/`modified` to `new Date().toISOString()`.

- [ ] **Step 2: Write the failing test**

```ts
it('preserves explicit created/modified timestamps', async () => {
  const note = await createNote({
    title: 'Imported',
    content: 'x',
    created: '2020-01-01T00:00:00.000Z',
    modified: '2020-02-02T00:00:00.000Z'
  })
  expect(note.created.toISOString()).toBe('2020-01-01T00:00:00.000Z')
  expect(note.modified.toISOString()).toBe('2020-02-02T00:00:00.000Z')
})
```

- [ ] **Step 3: Run — verify it fails** — Run: `pnpm --filter @memry/desktop test:main -- notes.test.ts` — Expected: FAIL (type error / values ignored).

- [ ] **Step 4: Implement** — add `created?: string` and `modified?: string` to `NoteCreateInput`; pass to `createFrontmatter(title, tags, { created, modified })`; in `createFrontmatter`, use the provided values when present else `new Date().toISOString()`.

- [ ] **Step 5: Run — verify it passes** — Run: `pnpm --filter @memry/desktop test:main -- notes.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/vault/notes-crud.ts apps/desktop/src/main/vault/frontmatter.ts apps/desktop/src/main/vault/notes.test.ts
git commit -m "feat(vault): optional created/modified on createNote"
```

### Task 4.1: `notion-importer.ts` orchestrator + integration test

Wire the pure modules to vault writes. Two-pass flow from the spec. Use `saveAttachment(noteId, buffer, filename)` and the new `createNote` timestamps.

**Files:**

- Create: `apps/desktop/src/main/import/notion/notion-importer.ts`
- Test: `apps/desktop/src/main/import/notion/notion-importer.test.ts`

- [ ] **Step 1: Write the failing integration test** (temp vault — follow the harness in `apps/desktop/src/main/vault/notes.test.ts` for vault setup/teardown)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { notionImporter } from './notion-importer'
import { createImportContext } from '../import-context'
// + temp-vault setup helpers used by notes.test.ts (getVaultPath override)

const FIXTURE = path.join(__dirname, '__fixtures__', 'notion-export.zip')

describe('notionImporter (integration)', () => {
  beforeEach(async () => {
    /* set up an isolated temp vault (mirror notes.test.ts) */
  })
  afterEach(async () => {
    /* tear down */
  })

  it('imports pages from the export zip into the Notion folder', async () => {
    const ctx = createImportContext('it1', new AbortController().signal)
    const summary = await notionImporter.run({ sourcePaths: [FIXTURE] }, ctx)
    expect(summary.imported).toBeGreaterThan(0)
    // assert at least one .md created under "Notion/" with frontmatter (query via listNotes/getNoteByPath)
  })

  it('stops early when cancelled', async () => {
    const ac = new AbortController()
    const ctx = createImportContext('it2', ac.signal)
    ac.abort()
    const summary = await notionImporter.run({ sourcePaths: [FIXTURE] }, ctx)
    expect(summary.imported).toBe(0)
  })
})
```

- [ ] **Step 2: Run — verify it fails** — Run: `pnpm --filter @memry/desktop test:main -- notion-importer.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** the orchestrator:

```ts
import { JSDOM } from 'jsdom'
import { createNote } from '@/main/vault/notes-crud'
import { saveAttachment } from '@/main/vault/attachments'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { Importer, ImportContext, ImportSummary } from '../types'
import { forEachZipEntry } from './notion-zip'
import { parsePageInfo } from './parse-info'
import { NotionResolverInfo } from './resolver'
import { convertHtmlToMarkdown } from './convert-to-md'
import { getNotionId, stripNotionId } from './notion-utils'

const ROOT = 'Notion'

export const notionImporter: Importer = {
  id: 'notion',
  name: 'Notion',
  fileSpec: { label: 'Notion HTML export', extensions: ['zip'], allowMultiple: true },
  async run(input, ctx: ImportContext): Promise<ImportSummary> {
    const info = new NotionResolverInfo()

    // Pass 1: scan
    ctx.setPhase('scanning')
    ctx.status('Scanning export…')
    await forEachZipEntry(input.sourcePaths, abortSignalOf(ctx), async (entry) => {
      if (entry.name === 'index.html') return
      if (entry.extension === 'csv') return // skip DB csv (v1)
      if (entry.extension === 'md' && getNotionId(entry.name)) {
        throw new Error('This is a Notion Markdown export. Please re-export as HTML.')
      }
      if (entry.extension === 'html') {
        const doc = new JSDOM(await entry.readText()).window.document
        const page = parsePageInfo(doc, entry.filepath)
        info.idsToFileInfo[page.id] = { ...page, path: entry.filepath }
      } else {
        info.pathsToAttachmentInfo[entry.filepath] = {
          path: entry.filepath,
          parentIds: [],
          nameWithExtension: stripNotionId(entry.name),
          targetParentFolder: ''
        }
      }
      ctx.reportProgress(
        Object.keys(info.idsToFileInfo).length + Object.keys(info.pathsToAttachmentInfo).length,
        0
      )
    })
    if (ctx.isCancelled()) return ctx.toSummary()

    info.cleanDuplicates(`${ROOT}/`)

    // Pass 2: convert + write
    ctx.setPhase('importing')
    const total = Object.keys(info.idsToFileInfo).length
    let done = 0
    await forEachZipEntry(input.sourcePaths, abortSignalOf(ctx), async (entry) => {
      if (ctx.isCancelled()) return
      try {
        if (entry.extension === 'html' && getNotionId(entry.name)) {
          const fileInfo = info.idsToFileInfo[getNotionId(entry.name)!]
          if (!fileInfo) return
          const doc = new JSDOM(await entry.readText()).window.document
          const { body, properties, tags } = convertHtmlToMarkdown(info, doc, entry.filepath)
          const folder = `${ROOT}/${info.getPathForFile(fileInfo)}`.replace(/\/$/, '')
          const note = await createNote({
            title: fileInfo.title,
            content: body,
            folder,
            tags,
            properties,
            created: fileInfo.ctime?.toISOString(),
            modified: fileInfo.mtime?.toISOString()
          })
          // attachments referenced by this page are saved by their own entry pass below
          ctx.reportNote()
          done++
          ctx.reportProgress(done, total)
          markNoteForAttachments(note.id, entry.filepath)
        } else if (info.pathsToAttachmentInfo[entry.filepath]) {
          const data = await entry.read()
          const noteId = ownerNoteIdFor(entry.filepath) // resolved via resolver parent mapping
          const res = await saveAttachment(
            noteId,
            data,
            info.pathsToAttachmentInfo[entry.filepath].nameWithExtension
          )
          if (res.success) ctx.reportAttachment()
          else ctx.reportSkipped(entry.filepath, res.error)
        }
      } catch (e) {
        ctx.reportFailed(entry.filepath, e)
      }
    })
    return ctx.toSummary()
  }
}
```

> **Attachment ownership:** Memry's `saveAttachment` stores under `attachments/<noteId>/`. Notion attachments belong to the page in whose folder they sit. The simplest correct v1: convert the page first, then for each attachment referenced in that page's HTML, read it from the zip and `saveAttachment(note.id, …)`, rewriting the `![](…)` ref to the returned relative path before `createNote`. Restructure Pass 2 to do per-page: gather the page's attachment entries (by `info.pathsToAttachmentInfo` whose `parentIds` match the page), save them, rewrite refs, then `createNote`. Drop the global attachment branch + the `markNoteForAttachments`/`ownerNoteIdFor` placeholders. Implement this concretely; do not ship the placeholder helpers.
>
> Add `abortSignalOf(ctx)`: store the signal on the context (extend `createImportContext` to expose `signal`) or thread the `AbortController` from the runner into the importer. Pick one and wire it; the simplest is to add a `signal: AbortSignal` field to `ImportContext`.

- [ ] **Step 4: Run — verify it passes** — Run: `pnpm --filter @memry/desktop test:main -- notion-importer.test.ts` — Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/import/notion/notion-importer.ts apps/desktop/src/main/import/notion/notion-importer.test.ts apps/desktop/src/main/import/import-context.ts apps/desktop/src/main/import/types.ts
git commit -m "feat(notion-import): orchestrator (two-pass import)"
```

### Task 4.2: Register the built-in importer

**Files:**

- Create: `apps/desktop/src/main/import/register-builtins.ts`

- [ ] **Step 1: Implement**

```ts
import { registerImporter } from './registry'
import { notionImporter } from './notion/notion-importer'

let registered = false
export function registerBuiltinImporters(): void {
  if (registered) return
  registered = true
  registerImporter(notionImporter)
}
```

- [ ] **Step 2: Typecheck** — Run: `pnpm --filter @memry/desktop typecheck:node` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/import/register-builtins.ts
git commit -m "feat(import): register built-in importers"
```

---

## Phase 5 — Contracts + IPC

### Task 5.1: `ImportChannels` contract + schemas

Follow the shape of an existing channels file (e.g. `packages/contracts/src/notes-channels.ts`). Channel prefix `import:`.

**Files:**

- Create: `packages/contracts/src/import-channels.ts`
- Modify: `packages/contracts/src/index.ts` (export it)
- Test: `packages/contracts/src/import-channels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { ImportChannels, ImportStartSchema, ImportCancelSchema } from './import-channels'

describe('ImportChannels', () => {
  it('defines prefixed channels', () => {
    expect(ImportChannels.invoke.START).toBe('import:start')
    expect(ImportChannels.invoke.CANCEL).toBe('import:cancel')
    expect(ImportChannels.events.PROGRESS).toBe('import:progress')
  })
  it('validates a start payload', () => {
    expect(
      ImportStartSchema.safeParse({
        importId: 'x',
        importerId: 'notion',
        sourcePaths: ['a.zip']
      }).success
    ).toBe(true)
  })
  it('rejects an empty cancel payload', () => {
    expect(ImportCancelSchema.safeParse({}).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run — verify it fails** — Run: `pnpm --filter @memry/contracts test -- import-channels.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { z } from 'zod'

export const ImportChannels = {
  invoke: {
    START: 'import:start',
    CANCEL: 'import:cancel'
  },
  events: {
    PROGRESS: 'import:progress'
  }
} as const

export const ImportStartSchema = z.object({
  importId: z.string().min(1),
  importerId: z.string().min(1),
  sourcePaths: z.array(z.string().min(1)),
  options: z.record(z.string(), z.unknown()).optional()
})
export type ImportStartInput = z.infer<typeof ImportStartSchema>

export const ImportCancelSchema = z.object({ importId: z.string().min(1) })
export type ImportCancelInput = z.infer<typeof ImportCancelSchema>

export interface ImportSummaryResult {
  imported: number
  attachments: number
  skipped: number
  failed: { item: string; error: string }[]
}

export interface ImportProgressEvent {
  importId: string
  phase: 'scanning' | 'importing' | 'done'
  status: string
  imported: number
  attachments: number
  skipped: number
  failed: number
  completed: number
  total: number
  done: boolean
  summary?: ImportSummaryResult
}
```

> Use `z.record(z.string(), z.unknown())` (Zod v4 gotcha — the single-arg form throws in safeParse).

- [ ] **Step 4: Export + run** — add `export * from './import-channels'` to `packages/contracts/src/index.ts`. Run: `pnpm --filter @memry/contracts test -- import-channels.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/import-channels.ts packages/contracts/src/import-channels.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): import channels + schemas"
```

### Task 5.2: Main IPC handlers

**Files:**

- Create: `apps/desktop/src/main/ipc/import-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts` (register/unregister)
- Modify: `apps/desktop/src/main/ipc/index.test.ts` (add to the handler mock list)

- [ ] **Step 1: Implement the handlers**

```ts
import { ipcMain } from 'electron'
import { ImportChannels, ImportStartSchema, ImportCancelSchema } from '@memry/contracts'
import { registerCommand } from './lib/register-command'
import { registerBuiltinImporters } from '@/main/import/register-builtins'
import { runImport, cancelImport } from '@/main/import/runner'

export function registerImportHandlers(): void {
  registerBuiltinImporters()

  registerCommand(
    ImportChannels.invoke.START,
    ImportStartSchema,
    async (input) => {
      const summary = await runImport(input)
      return { success: true as const, summary }
    },
    'Import failed'
  )

  ipcMain.handle(ImportChannels.invoke.CANCEL, (_e, raw) => {
    const { importId } = ImportCancelSchema.parse(raw)
    cancelImport(importId)
    return { success: true as const }
  })
}

export function unregisterImportHandlers(): void {
  ipcMain.removeHandler(ImportChannels.invoke.START)
  ipcMain.removeHandler(ImportChannels.invoke.CANCEL)
}
```

- [ ] **Step 2: Wire into `index.ts`** — import `registerImportHandlers` / `unregisterImportHandlers`, call them alongside the others (match the existing register/unregister blocks). Add to `index.test.ts`'s mocked handler list (the test asserts each `register*Handlers` is invoked — see the existing entries).

- [ ] **Step 3: Regenerate + check IPC**

Run:

```bash
pnpm ipc:generate && pnpm ipc:check
```

Expected: PASS (invoke map updated with `import:*`).

- [ ] **Step 4: Run the IPC index test** — Run: `pnpm --filter @memry/desktop test:main -- ipc/index.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/import-handlers.ts apps/desktop/src/main/ipc/index.ts apps/desktop/src/main/ipc/index.test.ts apps/desktop/src/preload/generated-rpc.ts
git commit -m "feat(import): IPC handlers (start/cancel)"
```

---

## Phase 6 — Renderer Import hub

### Task 6.1: Renderer import catalog

**Files:**

- Create: `apps/desktop/src/renderer/src/lib/import-catalog.ts`

- [ ] **Step 1: Implement** (icon from `@tabler/icons-react`, used elsewhere in the app)

```ts
import { FileImport } from '@tabler/icons-react'
import type { Icon } from '@tabler/icons-react'

export interface ImportCatalogItem {
  id: string
  name: string
  description: string
  icon: Icon
  fileLabel: string
  extensions: string[]
}

export const IMPORT_CATALOG: ImportCatalogItem[] = [
  {
    id: 'notion',
    name: 'Notion',
    description: 'Import an HTML export (.zip)',
    icon: FileImport,
    fileLabel: 'Notion HTML export',
    extensions: ['zip']
  }
]
```

- [ ] **Step 2: Typecheck** — Run: `pnpm --filter @memry/desktop typecheck:web` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/import-catalog.ts
git commit -m "feat(import-ui): renderer import catalog"
```

### Task 6.2: `use-import-run` hook

Drives start → progress subscription → cancel. The preload exposes `window.api.import.start/cancel` and `window.api.onImportProgress` (generated from contracts by `ipc:generate`; confirm the generated names and adjust).

**Files:**

- Create: `apps/desktop/src/renderer/src/hooks/use-import-run.ts`
- Test: `apps/desktop/src/renderer/src/hooks/use-import-run.test.ts`

- [ ] **Step 1: Write the failing test** (mock `window.api`)

```tsx
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useImportRun } from './use-import-run'

it('tracks progress events and final summary', async () => {
  let cb: (e: any) => void = () => {}
  ;(window as any).api = {
    onImportProgress: (fn: any) => {
      cb = fn
      return () => {}
    },
    import: {
      start: vi.fn(async () => ({
        success: true,
        summary: { imported: 2, attachments: 0, skipped: 0, failed: [] }
      })),
      cancel: vi.fn()
    }
  }
  const { result } = renderHook(() => useImportRun())
  await act(async () => {
    const p = result.current.start('notion', ['a.zip'])
    cb({ importId: result.current.importId, completed: 1, total: 2, imported: 1, done: false })
    await p
  })
  expect(result.current.summary?.imported).toBe(2)
})
```

- [ ] **Step 2: Run — verify it fails** — Run: `pnpm --filter @memry/desktop test:renderer -- use-import-run.test.ts` (uses `config/vitest.config.ts --project renderer` under the hood) — Expected: FAIL.

- [ ] **Step 3: Implement** — `useImportRun()` returns `{ importId, progress, summary, isRunning, error, start(importerId, paths), cancel() }`. `start` mints a uuid `importId` (use `crypto.randomUUID()`), subscribes via `window.api.onImportProgress` filtering by `importId`, calls `window.api.import.start({ importId, importerId, sourcePaths })`, sets `summary` on resolve, unsubscribes on unmount/finish. `cancel` calls `window.api.import.cancel({ importId })`.

- [ ] **Step 4: Run — verify it passes** — Run: `pnpm --filter @memry/desktop test:renderer -- use-import-run.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-import-run.ts apps/desktop/src/renderer/src/hooks/use-import-run.test.ts
git commit -m "feat(import-ui): use-import-run hook"
```

### Task 6.3: Import dialog (picker + progress + cancel + summary)

**Files:**

- Create: `apps/desktop/src/renderer/src/components/settings/import-dialog.tsx`

- [ ] **Step 1: Implement** — a dialog (reuse the app `Dialog`/`Picker` primitives) that: lists `IMPORT_CATALOG`; on select, opens the native file dialog filtered to the item's `extensions` (reuse the existing open-dialog IPC used elsewhere — `grep -rn "showOpenDialog" apps/desktop/src/main` for the channel); calls `useImportRun().start`; renders a progress bar + `imported / skipped / failed` counts + status + a **Cancel** button; on `done`, shows the summary. **RTL:** use logical Tailwind classes (`ms-*`, `pe-*`, `text-start`). **Submit button gotcha:** if the start button disables on click, fire from `onPointerDown` (see `calendar-quick-create-dialog.tsx`).

- [ ] **Step 2: Typecheck + lint** — Run: `pnpm --filter @memry/desktop typecheck:web && pnpm lint` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/settings/import-dialog.tsx
git commit -m "feat(import-ui): import dialog with live progress + cancel"
```

### Task 6.4: Settings → Import section

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/settings/import-section.tsx`
- Modify: the settings nav/registry that lists sections (find it: `grep -rln "ai-section\|settings.*section" apps/desktop/src/renderer/src/pages/settings`)

- [ ] **Step 1: Implement** — an `ImportSection` that explains one-time imports and renders a button opening `ImportDialog`. Register it in the settings nav next to the other sections, with an i18n label key `settings.import.*` added to `apps/desktop/src/renderer/src/locales/en/common.json` (en only — `i18n:check` gates English only).

- [ ] **Step 2: i18n + typecheck** — Run: `pnpm --filter @memry/desktop i18n:check && pnpm --filter @memry/desktop typecheck:web` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/settings/import-section.tsx apps/desktop/src/renderer/src/locales/en/common.json <settings-nav-file>
git commit -m "feat(import-ui): Settings → Import section"
```

---

## Phase 7 — Full verification

### Task 7.1: Green gates

- [ ] **Step 1: Run the full desktop suite + checks**

Run:

```bash
pnpm --filter @memry/desktop test:main
pnpm --filter @memry/desktop test:renderer
pnpm typecheck
pnpm lint
pnpm ipc:check
git diff --check
```

Expected: all PASS. (Pre-existing failures noted in CLAUDE.md — `websocket.test.ts`, `folders.test.ts` type errors — are exempt; confirm any red is pre-existing on `origin/main`.)

- [ ] **Step 2: Manual GUI QA** — `pnpm dev`, open Settings → Import → Notion, pick the real export zip, watch live progress + cancel, confirm notes land under `Notion/` with nested folders, frontmatter, attachments, and `[[wikilinks]]`. Use the `/verify` skill for a structured run.

- [ ] **Step 3: Docs gate** (desktop change)

Run:

```bash
base=$(git merge-base origin/main HEAD)
pnpm docs:ai-update --base "$base" || true
pnpm docs:impact --base "$base" --strict
pnpm docs:build
```

If `missing-docs`, add a short doc under `apps/docs/src/**` describing the Notion import, then re-run.

- [ ] **Step 4: Final commit (if docs changed)**

```bash
git add apps/docs/src
git commit -m "docs(notion-import): document Notion import"
```

---

## Self-Review (completed during planning)

**Spec coverage:** framework (Tasks 1.1–1.4, 4.2) ✓; zip nested+slip (2.1) ✓; parse/resolver/convert (3.1–3.4) ✓; field mapping — title/folders/timestamps/properties/tags/wikilinks/attachments (3.x + 4.0 + 4.1) ✓; markdown-export rejection (4.1) ✓; index.html + csv skip (4.1) ✓; contracts + IPC streaming + cancel (5.1–5.2) ✓; dedicated Import hub + progress + cancel (6.1–6.4) ✓; error handling per-item (4.1, import-context) ✓; testing (every task) ✓.

**Open items flagged for the implementer (not placeholders — explicit decisions):** attachment-ownership restructure in 4.1 (concrete instruction given), `signal` exposure on `ImportContext` (4.1), and confirming generated preload names (6.2). Each has a stated resolution.

**Type consistency:** `ImportSummary`/`ImportProgress` names match across types.ts (1.1), import-context (1.3), contracts (5.1), and the hook (6.2). `getNotionId`/`stripNotionId`/`parseParentIds` consistent (3.1 → 3.x, 4.1). `NotionResolverInfo.idsToFileInfo`/`getPathForFile`/`cleanDuplicates` consistent (3.2 → 4.1).
