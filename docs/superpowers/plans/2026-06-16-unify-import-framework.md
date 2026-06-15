# Unified Pluggable Import Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the bespoke Todoist importer onto the Notion reusable import framework, add an optional preview step + registry-derived catalog, so future importers (Keep, Evernote, Bear…) need only one `Importer` object + one register line.

**Architecture:** Extend the existing `Importer` contract (`apps/desktop/src/main/import`) with `descriptionKey` + optional `preview()`; add generic `import:list` / `import:preview` IPC; make the renderer Settings list registry-driven. Delete all bespoke Todoist plumbing (pre-production, no back-compat). The pure `@memry/todoist-import` package is reused unchanged.

**Tech Stack:** Electron main/renderer/preload, React 19, Zod contracts, Vitest, electron-log, i18n via `@memry/i18n`.

**Spec:** `docs/superpowers/specs/2026-06-16-unify-import-framework-design.md`

**Verify env note:** main/preload/shared tests → `pnpm --filter @memry/desktop test:main` (or `vitest run --config config/vitest.config.ts --project main <file>`); renderer → `--project renderer`; contracts → `--project shared`. After contract/handler/preload edits run `pnpm ipc:generate` then `pnpm ipc:check`.

---

### Task 1: Contracts — generic preview + list channels, types, schema

**Files:**

- Modify: `packages/contracts/src/import-channels.ts`
- Test: `packages/contracts/src/import-channels.test.ts` (create)

- [ ] **Step 1: Add channels, metadata + preview types, preview schema, response types.**

In `ImportChannels.invoke` add after `CANCEL`:

```ts
    /** Run an importer's optional preview (no writes). */
    PREVIEW: 'import:preview',
    /** List registered importers' metadata for the Settings catalog. */
    LIST: 'import:list'
```

Append to the file:

```ts
export interface ImporterMeta {
  id: string
  name: string
  descriptionKey: string
  fileSpec: { label: string; extensions: string[]; allowMultiple: boolean }
  supportsPreview: boolean
}

export interface ImportPreviewGroup {
  label: string
  counts: { labelKey: string; value: number }[]
  sampleTitles?: string[]
  warnings?: string[]
  error?: string
}

export interface ImportPreview {
  groups: ImportPreviewGroup[]
}

export const ImportPreviewSchema = z.object({
  importId: z.string().min(1),
  importerId: z.string().min(1),
  sourcePaths: z.array(z.string().min(1)),
  options: z.record(z.string(), z.unknown()).optional()
})
export type ImportPreviewInput = z.infer<typeof ImportPreviewSchema>

export interface ImportPreviewSuccess {
  success: true
  preview: ImportPreview
}
export type ImportPreviewResponse = ImportPreviewSuccess | ImportErrorResult
```

(`ImportErrorResult` already exists in this file.)

- [ ] **Step 2: Write the failing test.**

`packages/contracts/src/import-channels.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ImportChannels, ImportPreviewSchema } from './import-channels'

describe('import channels', () => {
  it('exposes preview + list invoke channels', () => {
    expect(ImportChannels.invoke.PREVIEW).toBe('import:preview')
    expect(ImportChannels.invoke.LIST).toBe('import:list')
  })

  it('validates a preview request', () => {
    const ok = ImportPreviewSchema.safeParse({
      importId: 'i1',
      importerId: 'todoist',
      sourcePaths: ['/a.csv']
    })
    expect(ok.success).toBe(true)
  })

  it('rejects an empty importerId', () => {
    const bad = ImportPreviewSchema.safeParse({
      importId: 'i1',
      importerId: '',
      sourcePaths: ['/a.csv']
    })
    expect(bad.success).toBe(false)
  })
})
```

- [ ] **Step 3: Run** `vitest run --config config/vitest.config.ts --project shared src/.../import-channels.test.ts` from `apps/desktop` (or `pnpm --filter @memry/desktop test`) — Expected: PASS.

- [ ] **Step 4: Commit** `git add packages/contracts/src/import-channels.* && git commit -m "feat(contracts): generic import preview + list channels"`

---

### Task 2: Framework types + context rename + Notion update

**Files:**

- Modify: `apps/desktop/src/main/import/types.ts`
- Modify: `apps/desktop/src/main/import/import-context.ts:60-63`
- Modify: `apps/desktop/src/main/import/import-context.test.ts:16-17`
- Modify: `apps/desktop/src/main/import/notion/notion-importer.ts:103` + the importer object literal

- [ ] **Step 1:** In `types.ts` import the preview type and extend `Importer`; rename `reportNote`:

```ts
import type { ImportPreview } from '@memry/contracts/import-channels'
```

In `ImportContext` replace `reportNote(): void` with `reportImported(): void`.
Replace the `Importer` interface with:

```ts
export interface Importer {
  id: string
  name: string
  descriptionKey: string
  fileSpec: ImportFileSpec
  preview?(input: ImportInput, signal: AbortSignal): Promise<ImportPreview>
  run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary>
}
```

Re-export the preview types for main-side consumers (append):

```ts
export type { ImportPreview, ImportPreviewGroup } from '@memry/contracts/import-channels'
```

- [ ] **Step 2:** In `import-context.ts` rename the method (lines 60-63):

```ts
    reportImported: () => {
      imported++
      emit()
    },
```

- [ ] **Step 3:** In `import-context.test.ts` change the two `ctx.reportNote()` calls (lines 16-17) to `ctx.reportImported()`.

- [ ] **Step 4:** In `notion/notion-importer.ts`: add `descriptionKey: 'import.sources.notion',` to the importer object (after `name: 'Notion',`); change `ctx.reportNote()` (line 103) to `ctx.reportImported()`.

- [ ] **Step 5: Run** `pnpm --filter @memry/desktop typecheck:node` and the main import-context test — Expected: PASS (no `reportNote` references remain).

- [ ] **Step 6: Commit** `git add apps/desktop/src/main/import && git commit -m "feat(import): extend Importer with descriptionKey + optional preview; rename reportNote→reportImported"`

---

### Task 3: Registry metadata projection

**Files:**

- Modify: `apps/desktop/src/main/import/registry.ts`
- Test: `apps/desktop/src/main/import/registry.test.ts` (create)

- [ ] **Step 1:** Append to `registry.ts`:

```ts
import type { ImporterMeta } from '@memry/contracts/import-channels'

export function listImporterMeta(): ImporterMeta[] {
  return listImporters().map((i) => ({
    id: i.id,
    name: i.name,
    descriptionKey: i.descriptionKey,
    fileSpec: i.fileSpec,
    supportsPreview: typeof i.preview === 'function'
  }))
}
```

(Move the existing `import type { Importer } from './types'` and the new `import type { ImporterMeta }` to the top.)

- [ ] **Step 2: Failing test** `registry.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { registerImporter, listImporterMeta, __resetRegistry } from './registry'
import type { Importer } from './types'

const base: Importer = {
  id: 'a',
  name: 'A',
  descriptionKey: 'k.a',
  fileSpec: { label: 'A', extensions: ['a'], allowMultiple: false },
  run: async (_i, ctx) => ctx.toSummary()
}

afterEach(() => __resetRegistry())

describe('listImporterMeta', () => {
  it('reflects registered importers and preview capability', () => {
    registerImporter(base)
    registerImporter({ ...base, id: 'b', name: 'B', preview: async () => ({ groups: [] }) })
    const meta = listImporterMeta()
    expect(meta.map((m) => m.id)).toEqual(['a', 'b'])
    expect(meta.find((m) => m.id === 'a')?.supportsPreview).toBe(false)
    expect(meta.find((m) => m.id === 'b')?.supportsPreview).toBe(true)
  })
})
```

- [ ] **Step 3: Run** main project for `registry.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit** `git add apps/desktop/src/main/import/registry.* && git commit -m "feat(import): registry metadata projection (listImporterMeta)"`

---

### Task 4: Runner previewImport

**Files:**

- Modify: `apps/desktop/src/main/import/runner.ts`
- Test: `apps/desktop/src/main/import/runner.test.ts` (create)

- [ ] **Step 1:** In `runner.ts` add (reuse the existing `controllers` map + imports; add `ImportPreview` to the type import):

```ts
import type { ImportPreview, ImportSummary } from './types'

export interface PreviewImportInput {
  importId: string
  importerId: string
  sourcePaths: string[]
  options?: Record<string, unknown>
}

export async function previewImport(input: PreviewImportInput): Promise<ImportPreview> {
  const importer = getImporter(input.importerId)
  if (!importer) throw new Error(`Unknown importer: ${input.importerId}`)
  if (!importer.preview) throw new Error(`Importer "${input.importerId}" has no preview`)

  const controller = new AbortController()
  controllers.set(input.importId, controller)
  try {
    return await importer.preview(
      { sourcePaths: input.sourcePaths, options: input.options },
      controller.signal
    )
  } finally {
    controllers.delete(input.importId)
  }
}
```

- [ ] **Step 2: Failing test** `runner.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { registerImporter, __resetRegistry } from './registry'
import { previewImport } from './runner'
import type { Importer } from './types'

const importer: Importer = {
  id: 'p',
  name: 'P',
  descriptionKey: 'k.p',
  fileSpec: { label: 'P', extensions: ['p'], allowMultiple: true },
  preview: async () => ({ groups: [{ label: 'g', counts: [{ labelKey: 'k', value: 2 }] }] }),
  run: async (_i, ctx) => ctx.toSummary()
}

afterEach(() => __resetRegistry())

describe('previewImport', () => {
  it('returns the importer preview', async () => {
    registerImporter(importer)
    const out = await previewImport({ importId: 'i', importerId: 'p', sourcePaths: ['/x.p'] })
    expect(out.groups[0].counts[0].value).toBe(2)
  })

  it('throws when the importer has no preview', async () => {
    registerImporter({ ...importer, id: 'np', preview: undefined })
    await expect(
      previewImport({ importId: 'i', importerId: 'np', sourcePaths: [] })
    ).rejects.toThrow(/no preview/)
  })
})
```

- [ ] **Step 3: Run** main project for `runner.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit** `git add apps/desktop/src/main/import/runner.* && git commit -m "feat(import): previewImport runner"`

---

### Task 5: Todoist framework importer (replaces bespoke service)

**Files:**

- Create: `apps/desktop/src/main/import/todoist/todoist-importer.ts`
- Test: `apps/desktop/src/main/import/todoist/todoist-importer.test.ts` (create)
- Delete: `apps/desktop/src/main/import/todoist/todoist-import-service.ts`
- Delete: `apps/desktop/src/main/import/todoist/todoist-import-service.test.ts`

- [ ] **Step 1: Write `todoist-importer.ts`.** Port the service's domain seam + `planForFile`, expose testable inner functions + the `Importer`:

```ts
/**
 * Todoist CSV importer (framework-native).
 *
 * Reuses the pure `@memry/todoist-import` package, applies plans through the
 * tasks domain, and plugs into the generic import framework.
 *
 * @module main/import/todoist/todoist-importer
 */
import { readFile } from 'fs/promises'
import { basename } from 'path'
import { parseTodoistCsv, mapRows, type ImportPlan } from '@memry/todoist-import'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportPreview, ImportSummary } from '../types'

const logger = createLogger('TodoistImport')

export interface ImportTasksDomain {
  createProject(input: { name: string }): Promise<{ project: { id: string } }>
  createTask(input: {
    projectId: string
    parentId: string | null
    title: string
    description: string | null
    priority: number
    dueDate: string | null
    dueTime: string | null
    position: number
  }): Promise<{ task: { id: string } }>
}

async function defaultDomain(): Promise<ImportTasksDomain> {
  const { requireDatabase } = await import('../../database')
  const { createDesktopTasksDomain } = await import('../../tasks/domain')
  const { createTasksPublisher } = await import('../../tasks/publisher')
  const { generateId } = await import('../../lib/id')
  return createDesktopTasksDomain(requireDatabase(), createTasksPublisher(), generateId)
}

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : err ? String(err) : fallback

function projectNameFromPath(p: string): string {
  return (
    basename(p)
      .replace(/\.csv$/i, '')
      .trim() || 'Imported Todoist Project'
  )
}

async function planForFile(filePath: string, now: Date): Promise<ImportPlan> {
  const raw = await readFile(filePath, 'utf-8')
  return mapRows(parseTodoistCsv(raw), projectNameFromPath(filePath), { now })
}

/** Parse each file into preview groups — performs no writes. */
export async function buildTodoistPreview(
  filePaths: string[],
  now: Date,
  signal?: AbortSignal
): Promise<ImportPreview> {
  const groups: ImportPreview['groups'] = []
  for (const fp of filePaths) {
    if (signal?.aborted) break
    try {
      const plan = await planForFile(fp, now)
      groups.push({
        label: plan.project.name || basename(fp),
        counts: [
          { labelKey: 'import.stats.tasks', value: plan.stats.tasks },
          { labelKey: 'import.stats.subtasks', value: plan.stats.subtasks },
          { labelKey: 'import.stats.withDueDate', value: plan.stats.withDueDate },
          { labelKey: 'import.stats.comments', value: plan.stats.comments },
          { labelKey: 'import.stats.skipped', value: plan.stats.skipped }
        ],
        sampleTitles: plan.sampleTitles,
        warnings: plan.warnings.map((w) => w.message)
      })
    } catch (err) {
      groups.push({
        label: basename(fp),
        counts: [],
        error: errorMessage(err, 'Failed to read file')
      })
    }
  }
  return { groups }
}

/** Apply each file's plan via the domain, streaming progress through ctx. */
export async function applyTodoistImport(
  filePaths: string[],
  domain: ImportTasksDomain,
  ctx: ImportContext,
  now: Date
): Promise<void> {
  const parsed: { fileName: string; plan?: ImportPlan; error?: string }[] = []
  for (const fp of filePaths) {
    try {
      parsed.push({ fileName: basename(fp), plan: await planForFile(fp, now) })
    } catch (err) {
      parsed.push({ fileName: basename(fp), error: errorMessage(err, 'Import failed') })
    }
  }

  const total = parsed.reduce((n, p) => n + (p.plan?.tasks.length ?? 0), 0)
  let done = 0
  ctx.reportProgress(0, total)

  for (const entry of parsed) {
    if (ctx.isCancelled()) return
    if (!entry.plan) {
      logger.error('Todoist import failed for file', entry.fileName, entry.error)
      ctx.reportFailed(entry.fileName, entry.error)
      continue
    }
    try {
      const { project } = await domain.createProject({ name: entry.plan.project.name })
      const idMap = new Map<string, string>()
      for (const tk of entry.plan.tasks) {
        if (ctx.isCancelled()) return
        const parentId = tk.parentTempId ? (idMap.get(tk.parentTempId) ?? null) : null
        const { task } = await domain.createTask({
          projectId: project.id,
          parentId,
          title: tk.title,
          description: tk.description,
          priority: tk.priority,
          dueDate: tk.dueDate,
          dueTime: tk.dueTime,
          position: tk.position
        })
        idMap.set(tk.tempId, task.id)
        done++
        ctx.reportImported()
        ctx.reportProgress(done, total)
      }
    } catch (err) {
      logger.error('Todoist import failed for file', entry.fileName, err)
      ctx.reportFailed(entry.fileName, err)
    }
  }
}

export const todoistImporter: Importer = {
  id: 'todoist',
  name: 'Todoist',
  descriptionKey: 'import.sources.todoist',
  fileSpec: { label: 'Todoist CSV export', extensions: ['csv'], allowMultiple: true },
  preview: (input, signal) => buildTodoistPreview(input.sourcePaths, new Date(), signal),
  run: async (input, ctx) => {
    ctx.setPhase('importing')
    ctx.status('Importing Todoist tasks…')
    const domain = await defaultDomain()
    await applyTodoistImport(input.sourcePaths, domain, ctx, new Date())
    return ctx.toSummary() as ImportSummary
  }
}
```

- [ ] **Step 2: Write `todoist-importer.test.ts`** (ports the old service test; uses a real `ImportContext`):

```ts
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createImportContext } from '../import-context'
import {
  buildTodoistPreview,
  applyTodoistImport,
  type ImportTasksDomain
} from './todoist-importer.ts'

const HEADER =
  'TYPE,CONTENT,DESCRIPTION,IS_COLLAPSED,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG'

function writeFixture(): string {
  const csv =
    HEADER +
    '\n' +
    'meta,view_style=list,,,,,,,,,,,,,\n' +
    'task,parent,,,4,1,Kaan,,,,,,,,\n' +
    'task,child,,,1,2,Kaan,,,,,,,,\n' +
    'task,repair home,,,2,1,Kaan,,2026-12-31,en,Europe/Istanbul,,,,\n'
  const dir = mkdtempSync(join(tmpdir(), 'todoist-'))
  const file = join(dir, 'Kişisel.csv')
  writeFileSync(file, csv, 'utf-8')
  return file
}

function createFakeDomain() {
  const projects: Array<{ id: string; name: string }> = []
  const tasks: Array<{
    id: string
    projectId: string
    parentId: string | null
    title: string
    position: number
  }> = []
  const domain: ImportTasksDomain = {
    async createProject({ name }) {
      const project = { id: `p${projects.length}`, name }
      projects.push(project)
      return { project }
    },
    async createTask(input) {
      const task = { id: `t${tasks.length}`, ...input }
      tasks.push(task)
      return { task }
    }
  }
  return { projects, tasks, domain }
}

const ctx = () => createImportContext('test', new AbortController().signal)
const now = new Date(2026, 5, 15, 9, 0, 0)

describe('todoist importer', () => {
  it('previews counts without writing', async () => {
    const preview = await buildTodoistPreview([writeFixture()], now)
    expect(preview.groups[0].label).toBe('Kişisel')
    const tasks = preview.groups[0].counts.find((c) => c.labelKey === 'import.stats.tasks')
    expect(tasks?.value).toBe(3)
    expect(preview.groups[0].error).toBeUndefined()
  })

  it('reports a group error when a file cannot be read', async () => {
    const preview = await buildTodoistPreview(['/no/such/file.csv'], now)
    expect(preview.groups[0].error).toBeTruthy()
  })

  it('creates project + tasks + subtask and summarizes imported count', async () => {
    const { projects, tasks, domain } = createFakeDomain()
    const c = ctx()
    await applyTodoistImport([writeFixture()], domain, c, now)
    expect(projects).toHaveLength(1)
    expect(tasks).toHaveLength(3)
    expect(tasks[1]).toMatchObject({ title: 'child', parentId: tasks[0].id })
    expect(c.toSummary()).toMatchObject({ imported: 3, failed: [] })
  })

  it('isolates a failing file without aborting the batch', async () => {
    const { domain } = createFakeDomain()
    const c = ctx()
    await applyTodoistImport(['/no/such/file.csv', writeFixture()], domain, c, now)
    const summary = c.toSummary()
    expect(summary.imported).toBe(3)
    expect(summary.failed).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Delete** old service + its test:

```bash
git rm apps/desktop/src/main/import/todoist/todoist-import-service.ts \
       apps/desktop/src/main/import/todoist/todoist-import-service.test.ts
```

- [ ] **Step 4: Run** main project for `todoist-importer.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `git add apps/desktop/src/main/import/todoist && git commit -m "feat(import): Todoist framework importer (preview + run)"`

---

### Task 6: Register the Todoist importer

**Files:** Modify `apps/desktop/src/main/import/register-builtins.ts`

- [ ] **Step 1:** Add the import + registration:

```ts
import { todoistImporter } from './todoist/todoist-importer'
```

and inside `registerBuiltinImporters` after the Notion line:

```ts
registerImporter(todoistImporter)
```

- [ ] **Step 2: Run** `pnpm --filter @memry/desktop typecheck:node` — Expected: PASS.

- [ ] **Step 3: Commit** `git add apps/desktop/src/main/import/register-builtins.ts && git commit -m "feat(import): register Todoist importer"`

---

### Task 7: Generic IPC handlers (add LIST + PREVIEW; delete Todoist handlers)

**Files:**

- Modify: `apps/desktop/src/main/ipc/import-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts`
- Modify: `apps/desktop/src/main/ipc/index.test.ts`
- Delete: `apps/desktop/src/main/ipc/todoist-import-handlers.ts`

- [ ] **Step 1:** In `import-handlers.ts` extend imports + handlers. Add to the contracts import: `ImportPreviewSchema`. Add `previewImport` to the runner import + `listImporterMeta` from `'../import/registry'`. Add a `z` import for the LIST schema (`import { z } from 'zod'`). After the CANCEL `registerCommand` add:

```ts
registerCommand(
  ImportChannels.invoke.PREVIEW,
  ImportPreviewSchema,
  async (input) => {
    const preview = await previewImport(input)
    return { success: true as const, preview }
  },
  'Preview failed'
)

registerCommand(
  ImportChannels.invoke.LIST,
  z.unknown(),
  () => listImporterMeta(),
  'Failed to list importers'
)
```

In `unregisterImportHandlers` add:

```ts
ipcMain.removeHandler(ImportChannels.invoke.PREVIEW)
ipcMain.removeHandler(ImportChannels.invoke.LIST)
```

- [ ] **Step 2: Delete** the Todoist handlers file:

```bash
git rm apps/desktop/src/main/ipc/todoist-import-handlers.ts
```

- [ ] **Step 3:** In `ipc/index.ts` remove the Todoist wiring: the import block (lines 4-7), the `registerTodoistImportHandlers()` call (~81) + comment, the `unregisterTodoistImportHandlers()` call (~170), and the re-export block (~208-211).

- [ ] **Step 4:** In `ipc/index.test.ts` remove the two `registerTodoistImportHandlers`/`unregister…` hoisted entries (lines 10-11), and the entire `vi.mock('./todoist-import-handlers', …)` block (lines 70-73).

- [ ] **Step 5: Run** main project for `ipc/index.test.ts` + `pnpm --filter @memry/desktop typecheck:node` — Expected: PASS (no `todoist-import-handlers` references remain).

- [ ] **Step 6: Commit** `git add -A apps/desktop/src/main/ipc && git commit -m "feat(import): generic preview + list IPC; remove bespoke Todoist handlers"`

---

### Task 8: Preload (add list/preview; delete Todoist API)

**Files:**

- Modify: `apps/desktop/src/preload/api/import.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Delete: `apps/desktop/src/preload/api/todoist-import.ts`

- [ ] **Step 1:** In `api/import.ts` extend the contracts type import with `ImporterMeta, ImportPreviewInput, ImportPreviewResponse` and add methods to `importApi`:

```ts
  preview: (input: ImportPreviewInput): Promise<ImportPreviewResponse> =>
    invoke<ImportPreviewResponse>(ImportChannels.invoke.PREVIEW, input),
  list: (): Promise<ImporterMeta[]> => invoke<ImporterMeta[]>(ImportChannels.invoke.LIST)
```

- [ ] **Step 2: Delete** the bespoke preload API + its wiring:

```bash
git rm apps/desktop/src/preload/api/todoist-import.ts
```

In `preload/index.ts` remove `import { todoistImportApi } from './api/todoist-import'` (line 29) and the `todoistImport: todoistImportApi,` entry (line 110).

- [ ] **Step 3:** In `preload/index.d.ts`: remove the `TodoistImport*` type import block (lines 8-12) and the `todoistImport: { … }` block (lines 1751-1754). Add the new methods to the `import: {…}` block:

```ts
  import: {
    pickFiles: (input: ImportPickFilesInput) => Promise<ImportPickFilesResult>
    start: (input: ImportStartInput) => Promise<ImportStartResponse>
    cancel: (input: ImportCancelInput) => Promise<{ success: true }>
    preview: (input: ImportPreviewInput) => Promise<ImportPreviewResponse>
    list: () => Promise<ImporterMeta[]>
  }
```

Ensure `ImporterMeta`, `ImportPreviewInput`, `ImportPreviewResponse` are imported from `@memry/contracts/import-channels` (extend the existing import that already brings in `ImportPickFilesInput` etc., or add one).

- [ ] **Step 4: Run** `pnpm --filter @memry/desktop typecheck:node` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A apps/desktop/src/preload && git commit -m "feat(import): preload list/preview; remove todoistImport API"`

---

### Task 9: Contracts cleanup (delete Todoist contract + channel)

**Files:**

- Delete: `packages/contracts/src/todoist-import-api.ts`
- Modify: `packages/contracts/src/ipc-channels.ts` (remove `TodoistImportChannels` block, lines 29-38)

- [ ] **Step 1:** Confirm no remaining references:

```bash
grep -rn "TodoistImportChannels\|todoist-import-api" apps packages --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v generated-ipc-invoke-map
```

Expected: no matches (the generated map is regenerated in Task 13).

- [ ] **Step 2: Delete + remove channel:**

```bash
git rm packages/contracts/src/todoist-import-api.ts
```

Remove the `// Todoist Import Channels` section + `export const TodoistImportChannels = {…}` from `ipc-channels.ts`.

- [ ] **Step 3: Run** `pnpm --filter @memry/desktop typecheck:node` — Expected: PASS.

- [ ] **Step 4: Commit** `git add -A packages/contracts && git commit -m "refactor(contracts): drop bespoke Todoist import contract"`

---

### Task 10: i18n (en) — Todoist source, preview stat keys, generic summary

**Files:** Modify `packages/i18n/src/locales/en/settings.json` (`import` block)

- [ ] **Step 1:** Under `import.sources` add: `"todoist": "Import a project CSV export (.csv)"`.

- [ ] **Step 2:** Change `import.dialog.summary.imported` to a generic noun:

```json
"imported": "{count, plural, one {# item imported} other {# items imported}}",
```

- [ ] **Step 3:** Add a `stats` block + a `preview` block under `import`:

```json
"stats": {
  "tasks": "{count, plural, one {# task} other {# tasks}}",
  "subtasks": "{count, plural, one {# sub-task} other {# sub-tasks}}",
  "withDueDate": "{count} dated",
  "comments": "{count, plural, one {# comment} other {# comments}}",
  "skipped": "{count} skipped"
},
"preview": {
  "warnings": "Warnings",
  "confirm": "Import"
},
```

- [ ] **Step 4:** Remove the now-unused `import.todoist` block from `en/settings.json`.

- [ ] **Step 5: Run** `pnpm --filter @memry/desktop i18n:check` — Expected: exit 0 (en consistent). If it flags removed-key references, fix the referencing renderer code (Task 12) first, then re-run.

- [ ] **Step 6: Commit** `git add packages/i18n/src/locales/en/settings.json && git commit -m "i18n: Todoist import source + preview stat keys; generic summary noun"`

---

### Task 11: Renderer — useImportRun preview, useImporters, icon map

**Files:**

- Modify: `apps/desktop/src/renderer/src/hooks/use-import-run.ts`
- Modify: `apps/desktop/src/renderer/src/lib/import-catalog.ts`
- Create: `apps/desktop/src/renderer/src/hooks/use-importers.ts`

- [ ] **Step 1:** Extend `use-import-run.ts`. Add to `UseImportRun`:

```ts
preview: import('@memry/contracts/import-channels').ImportPreview | null
isPreviewing: boolean
runPreview: (importerId: string, sourcePaths: string[]) => Promise<void>
```

(Prefer a top-level `import type { ImportPreview } from '@memry/contracts/import-channels'` and use `ImportPreview | null`.) Add state `const [preview, setPreview] = useState<ImportPreview | null>(null)` and `const [isPreviewing, setIsPreviewing] = useState(false)`. Reset them in `reset()`. Add:

```ts
const runPreview = useCallback(async (importerId: string, sourcePaths: string[]): Promise<void> => {
  const id = crypto.randomUUID()
  activeIdRef.current = id
  setImportId(id)
  setPreview(null)
  setError(null)
  setIsPreviewing(true)
  try {
    const res = await window.api.import.preview({ importId: id, importerId, sourcePaths })
    if (res.success) setPreview(res.preview)
    else setError(res.error ?? 'Preview failed')
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Preview failed')
  } finally {
    setIsPreviewing(false)
  }
}, [])
```

Return `preview, isPreviewing, runPreview` alongside the existing fields.

- [ ] **Step 2:** Replace `import-catalog.ts` with an icon map (the catalog metadata now comes from the registry):

```ts
import { Import } from '@/lib/icons'
import type { AppIcon } from '@/lib/icons/types'

/** Per-importer icon override (keyed by importer id). Falls back to DEFAULT_IMPORT_ICON. */
export const IMPORT_ICONS: Record<string, AppIcon> = {}

export const DEFAULT_IMPORT_ICON: AppIcon = Import
```

- [ ] **Step 3:** Create `use-importers.ts`:

```ts
import { useEffect, useState } from 'react'
import type { ImporterMeta } from '@memry/contracts/import-channels'
import type { AppIcon } from '@/lib/icons/types'
import { IMPORT_ICONS, DEFAULT_IMPORT_ICON } from '@/lib/import-catalog'

export interface ImporterItem extends ImporterMeta {
  icon: AppIcon
}

/** Fetches registered importers from the registry and merges per-id icons. */
export function useImporters(): { importers: ImporterItem[]; isLoading: boolean } {
  const [importers, setImporters] = useState<ImporterItem[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let active = true
    void window.api.import
      .list()
      .then((meta) => {
        if (!active) return
        setImporters(meta.map((m) => ({ ...m, icon: IMPORT_ICONS[m.id] ?? DEFAULT_IMPORT_ICON })))
      })
      .finally(() => active && setIsLoading(false))
    return () => {
      active = false
    }
  }, [])

  return { importers, isLoading }
}
```

- [ ] **Step 4: Run** `pnpm --filter @memry/desktop typecheck:web` — Expected: PASS.

- [ ] **Step 5: Commit** `git add apps/desktop/src/renderer/src/hooks/use-import-run.ts apps/desktop/src/renderer/src/hooks/use-importers.ts apps/desktop/src/renderer/src/lib/import-catalog.ts && git commit -m "feat(import): renderer preview hook + registry-driven importer list"`

---

### Task 12: Renderer — import dialog preview step + generic summary

**Files:** Modify `apps/desktop/src/renderer/src/components/settings/import-dialog.tsx`

- [ ] **Step 1:** Change the `item` prop type from `ImportCatalogItem` to `ImporterItem` (from `@/hooks/use-importers`). Update field reads: `item.fileLabel`→`item.fileSpec.label`, `item.extensions`→`item.fileSpec.extensions`, `item.allowMultiple`→`item.fileSpec.allowMultiple`. `item.descriptionKey` and `item.name` are unchanged.

- [ ] **Step 2:** After choosing files, branch on `item.supportsPreview`. Update `choose()`:

```ts
const choose = async () => {
  if (!item) return
  const result = await window.api.import.pickFiles({
    label: item.fileSpec.label,
    extensions: item.fileSpec.extensions,
    allowMultiple: item.fileSpec.allowMultiple
  })
  if (result.canceled || result.filePaths.length === 0) return
  setPaths(result.filePaths)
  if (item.supportsPreview) void run.runPreview(item.id, result.filePaths)
}
```

- [ ] **Step 3:** Render the preview groups (port the old Todoist section markup) between the choose button and the start footer, shown when `run.preview && !summary`:

```tsx
{
  run.preview && !summary && (
    <div className="mt-1 flex flex-col gap-3">
      {run.preview.groups.map((g, gi) => (
        <div key={gi} className="rounded-md border border-border p-3">
          <div className="font-medium text-[13px]/4 text-foreground">{g.label}</div>
          {g.error ? (
            <div className="text-destructive mt-1 text-xs/4">{g.error}</div>
          ) : (
            <>
              <div className="text-muted-foreground mt-1 text-xs/4">
                {g.counts.map((c) => t(c.labelKey, { count: c.value })).join(' · ')}
              </div>
              {g.sampleTitles && g.sampleTitles.length > 0 && (
                <div className="text-muted-foreground mt-1 truncate text-xs/4">
                  {g.sampleTitles.join(' · ')}
                </div>
              )}
              {g.warnings && g.warnings.length > 0 && (
                <details className="mt-1 text-xs/4">
                  <summary className="cursor-pointer">
                    {t('import.preview.warnings')} ({g.warnings.length})
                  </summary>
                  <ul className="mt-1 ps-4 list-disc">
                    {g.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4:** Gate the summary attachments line on `summary.attachments > 0` (so Todoist's 0 doesn't show):

```tsx
{
  summary.attachments > 0 && (
    <p className="text-xs/4 text-muted-foreground">
      {t('import.dialog.summary.attachments', { count: summary.attachments })}
    </p>
  )
}
```

- [ ] **Step 5:** Footer start button — when preview-capable, require a preview before enabling and use the confirm label; otherwise unchanged. Replace the `else` (start) footer branch:

```tsx
<Button
  size="sm"
  disabled={paths.length === 0 || run.isPreviewing || (item?.supportsPreview && !run.preview)}
  onPointerDown={startImport}
  onClick={startImport}
>
  {item?.supportsPreview ? t('import.preview.confirm') : t('import.dialog.start')}
</Button>
```

- [ ] **Step 6: Run** `pnpm --filter @memry/desktop typecheck:web` + renderer project (if any import-dialog test) — Expected: PASS.

- [ ] **Step 7: Commit** `git add apps/desktop/src/renderer/src/components/settings/import-dialog.tsx && git commit -m "feat(import): preview step in generic import dialog"`

---

### Task 13: Renderer — registry-driven Settings section; delete bespoke Todoist UI

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/settings/import-section.tsx`
- Delete: `apps/desktop/src/renderer/src/components/import/use-todoist-import.ts`
- Delete: `apps/desktop/src/renderer/src/components/import/use-todoist-import.test.ts`

- [ ] **Step 1:** Rewrite `import-section.tsx` to drive the list from `useImporters()` and drop the bespoke Todoist `SettingsGroup`:

```tsx
import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { SettingsHeader } from '@/components/settings/settings-primitives'
import { Button } from '@/components/ui/button'
import { ImportDialog } from '@/components/settings/import-dialog'
import { useImporters, type ImporterItem } from '@/hooks/use-importers'

export function ImportSettings() {
  const { t } = useT('settings')
  const { importers } = useImporters()
  const [active, setActive] = useState<ImporterItem | null>(null)

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('import.header.title')} subtitle={t('import.header.subtitle')} />
      <p className="pb-6 text-xs/4 text-muted-foreground">{t('import.intro')}</p>

      <div className="mb-6 flex flex-col rounded-lg overflow-clip border border-border bg-surface-active">
        {importers.map((item, index) => {
          const Icon = item.icon
          return (
            <div key={item.id}>
              {index > 0 && <div className="h-px bg-border" />}
              <div className="flex items-center justify-between h-12 py-3 px-4">
                <div className="flex items-center gap-3 min-w-0">
                  <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="flex flex-col gap-px min-w-0">
                    <span className="font-medium text-[13px]/4 text-foreground">{item.name}</span>
                    <span className="text-xs/4 text-muted-foreground truncate">
                      {t(item.descriptionKey)}
                    </span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="ms-4 shrink-0"
                  onClick={() => setActive(item)}
                >
                  {t('import.action')}
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      <ImportDialog
        item={active}
        open={active !== null}
        onOpenChange={(open) => {
          if (!open) setActive(null)
        }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Delete** the bespoke hook + its test:

```bash
git rm apps/desktop/src/renderer/src/components/import/use-todoist-import.ts \
       apps/desktop/src/renderer/src/components/import/use-todoist-import.test.ts
```

- [ ] **Step 3: Run** `pnpm --filter @memry/desktop typecheck:web` + renderer test project — Expected: PASS (no `useTodoistImport` references remain).

- [ ] **Step 4: Commit** `git add -A apps/desktop/src/renderer/src && git commit -m "feat(import): registry-driven Settings list; remove bespoke Todoist UI"`

---

### Task 14: Regenerate IPC map + full gates

- [ ] **Step 1:** `pnpm ipc:generate` then `pnpm ipc:check` — Expected: map updated (no `todoist-import:*`, now has `import:preview` + `import:list`), check passes. Commit the regenerated `generated-ipc-invoke-map.ts` (and any rpc artifacts).

- [ ] **Step 2:** Full gates:

```bash
pnpm typecheck
pnpm lint
pnpm test:desktop
pnpm --filter @memry/desktop i18n:check
git diff --check
```

Expected: all green.

- [ ] **Step 3:** Docs gate (desktop change):

```bash
base=$(git merge-base origin/main HEAD)
pnpm docs:impact --base "$base" --strict || pnpm docs:ai-update --base "$base"
pnpm docs:build
```

If `missing-docs`, update `apps/docs/src/**` (importing notes/tasks page) or run `docs:ai-update`, then re-run `docs:impact --strict`.

- [ ] **Step 4: Commit** `git add -A && git commit -m "chore(import): regenerate IPC map + docs"`

---

## Self-Review

- **Spec coverage:** Importer contract extension (T2), preview type (T1), registry-derived catalog (T1/T3/T11/T13), optional preview flow (T4/T7/T8/T12), Todoist migration (T5/T6), clean-cut deletion (T5/T7/T8/T9/T13), tests (T1-T5), gates+i18n+docs (T10/T14). All covered.
- **Type consistency:** `ImportPreview`/`ImportPreviewGroup`/`ImporterMeta`/`ImportPreviewInput`/`ImportPreviewResponse` defined once in contracts (T1), imported by main types (T2), registry (T3), runner (T4), preload (T8), renderer hook (T11). `reportImported` renamed consistently (T2). `ImporterItem = ImporterMeta & {icon}` used in dialog (T12) + section (T13).
- **Placeholders:** none — every code step shows the code.
- **Risk note:** `i18n:check` must stay en-consistent after removing `import.todoist` (T10) — referencing code is removed in T12/T13, so order T10 before re-checking, or run i18n:check in T14 after all renderer edits.
