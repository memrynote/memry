# Unified Pluggable Import Framework

**Date:** 2026-06-16
**Status:** Approved
**Branch:** `unify-import-framework`

## Problem

Memry has two importers built at different times:

- **Notion** (PR #578) introduced a reusable framework: an `Importer` contract, a
  registry, a streaming `ImportContext` (progress + cancel), generic IPC
  (`import:pick-files` / `import:start` / `import:cancel` / `import:progress`),
  and a generic `ImportDialog`.
- **Todoist** (PR #577) predates the framework and is fully bespoke: its own pure
  package (`@memry/todoist-import`), its own desktop service
  (`previewTodoistImport` / `runTodoistImport`), its own IPC channels
  (`todoist-import:preview` / `todoist-import:run`), its own preload API
  (`window.api.todoistImport`), its own renderer hook (`useTodoistImport`), and a
  hardcoded Settings section.

Adding the next importer (Google Keep, Evernote, Roam, Bear, …) currently means
duplicating the whole bespoke Todoist stack. The goal is a single contract both
Notion and Todoist satisfy, where **a new importer = one `Importer` object + one
register line (+ optional icon)** and nothing else.

## Goals

- Todoist runs on the same framework as Notion.
- The framework supports an **optional preview step** (Todoist has one; Notion
  does not) without forcing preview onto importers that don't need it.
- The Settings import list is **registry-derived**: the registry is the single
  source of truth, so a new importer needs no renderer catalog edit.
- Delete all bespoke Todoist plumbing (pre-production — no back-compat).

## Non-Goals

- TickTick (#576) is an unmerged worktree draft; it is **out of scope** and will
  adopt this contract when it lands.
- No change to the pure `@memry/todoist-import` transform package (it stays a
  pure, electron-free parsing/mapping library and is reused as-is).
- No new importers are added in this work.

## Key Constraints Discovered

1. **Two clashing `ImportSummary` types.** The framework's aggregate
   `{ imported, attachments, skipped, failed: {item,error}[] }` vs the Todoist
   service's `{ files: ImportFileResult[] }`. The framework type wins; Todoist
   rolls its per-file results up into it. Per-file detail (project name,
   warnings) surfaces at **preview** time instead of in the post-run summary.
2. **Todoist preview is per-file and rich** — `{ fileName, projectName, stats,
sampleTitles, warnings }`, not a simple count. The generic preview type must
   carry labeled stats + sample titles + warnings per group.
3. Icons are React components and cannot cross IPC, so the renderer keeps a small
   `id → AppIcon` map with a default fallback; all other catalog metadata
   (name, description key, file spec, preview capability) comes from the registry.

## Design

### 1. Extend the `Importer` contract — `apps/desktop/src/main/import/types.ts`

```ts
export interface Importer {
  id: string
  name: string // brand name, raw (e.g. 'Todoist')
  descriptionKey: string // NEW — i18n key, moved off the renderer catalog
  fileSpec: ImportFileSpec
  preview?(input: ImportInput, signal: AbortSignal): Promise<ImportPreview> // NEW, optional
  run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary>
}

// NEW — generic, importer-agnostic preview shape
export interface ImportPreview {
  groups: ImportPreviewGroup[]
}
export interface ImportPreviewGroup {
  label: string // file name / project name
  counts: { labelKey: string; value: number }[] // renderer does t(labelKey, { count: value })
  sampleTitles?: string[]
  warnings?: string[]
  error?: string
}
```

`ImportFileSpec`, `ImportInput`, `ImportProgress`, `ImportSummary` are unchanged.

**Rename** `ImportContext.reportNote()` → `reportImported()`. The underlying
counter is already `imported`; "note" is misleading now that tasks flow through
the same context. One Notion call site updates.

### 2. Registry metadata projection — `apps/desktop/src/main/import/registry.ts`

Add:

```ts
export interface ImporterMeta {
  id: string
  name: string
  descriptionKey: string
  fileSpec: ImportFileSpec
  supportsPreview: boolean
}

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

`registerImporter` / `getImporter` / `listImporters` / `__resetRegistry`
unchanged.

### 3. Generic IPC — `packages/contracts/src/import-channels.ts`

Add to `ImportChannels.invoke`:

```ts
LIST: 'import:list',
PREVIEW: 'import:preview'
```

- `LIST` → no args → `ImporterMeta[]`.
- `PREVIEW` → `{ importId, importerId, sourcePaths, options? }` →
  `ImportPreviewResult` (`{ groups }` or per-group `error`). Preview reuses the
  same `importId` AbortController registry as `START`, so the existing `CANCEL`
  channel cancels a preview too.

Add Zod schemas (`ImportPreviewSchema`) and exported types
(`ImporterMeta`, `ImportPreviewResult`, `ImportPreviewGroupResult`). Run
`pnpm ipc:generate` then `pnpm ipc:check`.

### 4. Runner — `apps/desktop/src/main/import/runner.ts`

Add `previewImport(input)` mirroring `runImport`: look up importer (error if it
has no `preview`), register an `AbortController` under `importId`, call
`importer.preview(input, signal)`, clean up in `finally`. `cancelImport` already
covers both flows.

### 5. Todoist as a framework importer

- **Keep** `@memry/todoist-import` untouched.
- **Replace** `apps/desktop/src/main/import/todoist/todoist-import-service.ts`
  with `apps/desktop/src/main/import/todoist/todoist-importer.ts` exporting
  `todoistImporter: Importer`:
  - `id: 'todoist'`, `name: 'Todoist'`, `descriptionKey: 'import.sources.todoist'`,
    `fileSpec: { label: 'Todoist CSV export', extensions: ['csv'], allowMultiple: true }`.
  - `preview(input, signal)` — reuse the existing per-file parse logic
    (`parseTodoistCsv` + `mapRows`) and map each file to an `ImportPreviewGroup`:
    `label = project name`, `counts` from `ImportStats` (tasks, subtasks, with
    due date, …), `sampleTitles`, `warnings`; parse failure → `group.error`.
  - `run(input, ctx)` — reuse the existing apply logic against the tasks domain
    (create project, create tasks parents-first via temp-id map). Per created
    task: `ctx.reportImported()` + `ctx.reportProgress(done, total)`. Per failed
    file: `ctx.reportFailed(fileName, err)` and continue. Return
    `ctx.toSummary()`.
  - Keep the testable `ImportTasksDomain` seam and lazy `defaultDomain()` exactly
    as today so the import stays light and unit-testable with a fake domain.
- Register one line in `register-builtins.ts`:
  `registerImporter(todoistImporter)`.

### 6. Renderer — registry-derived catalog + preview step

- `apps/desktop/src/renderer/src/lib/import-catalog.ts` shrinks to an icon map:
  `export const IMPORT_ICONS: Record<string, AppIcon>` + a default icon.
- New hook `useImporters()` calls `window.api.import.list()` on mount and merges
  each `ImporterMeta` with its icon (default when absent).
- `apps/desktop/src/renderer/src/pages/settings/import-section.tsx` maps over the
  fetched importers; **the bespoke Todoist section is deleted.**
- `apps/desktop/src/renderer/src/components/settings/import-dialog.tsx`:
  - If `item.supportsPreview`: choosing files triggers `runPreview` → render the
    `ImportPreviewGroup[]` (label, counts via `t(labelKey,{count})`, sample
    titles, warnings, per-group error) → a confirm button (`Import N`) runs the
    import → progress → summary.
  - If not: the current one-shot pick → start → progress → summary flow is
    unchanged (Notion).
- `apps/desktop/src/renderer/src/hooks/use-import-run.ts` gains `preview`,
  `isPreviewing`, and `runPreview(importerId, paths)` alongside the existing
  start/progress/cancel/summary state.

### 7. Delete bespoke Todoist plumbing (pre-production, no back-compat)

- `apps/desktop/src/main/import/todoist/todoist-import-service.ts` (replaced)
- `apps/desktop/src/main/ipc/todoist-import-handlers.ts`
- `packages/contracts/src/todoist-import-api.ts` + `TodoistImportChannels` in
  `packages/contracts/src/ipc-channels.ts`
- `apps/desktop/src/preload/api/todoist-import.ts` + `todoistImport` on the
  preload `api` object + its `window.api` type entry
- `apps/desktop/src/renderer/src/components/import/use-todoist-import.ts`
- Their tests; new tests replace them.

## Data Flow

**Preview-capable importer (Todoist):**
renderer picks files → `import:preview {importId,importerId,paths}` → runner
registers controller → `importer.preview(input, signal)` → `ImportPreview` back →
dialog renders groups → user confirms → `import:start` → `importer.run(input,ctx)`
streams `import:progress` → `ImportSummary`.

**One-shot importer (Notion):**
renderer picks files → `import:start` → `importer.run(input,ctx)` streams
progress → summary. (unchanged)

**Catalog:** renderer `import:list` → `listImporterMeta()` → merge with icon map.

## Error Handling

- Per-file run failure: caught, `ctx.reportFailed(fileName, message)`, import
  continues (matches today's behavior).
- Per-file preview parse failure: `group.error` on that file's group; other files
  still preview.
- Cancellation: `signal` / `isCancelled()` honored in both preview and run; the
  single `import:cancel` channel aborts whichever is in flight for that
  `importId`.
- IPC errors flow through the existing `registerCommand` error envelope.

## Testing

- `todoist-importer.test.ts` — preview shape (groups/counts/samples/warnings) and
  run via a fake `ImportTasksDomain` (porting the existing service tests, plus a
  failing-file case). Add the new test path to the hardcoded shared vitest
  include + coverage globs (per repo gotcha).
- `runner` / `registry` — `previewImport` happy path + unknown/no-preview error;
  `listImporterMeta` reflects registered importers and `supportsPreview`.
- `apps/desktop/src/main/ipc/index.test.ts` — update the handler mock for the new
  `LIST` / `PREVIEW` registrations; remove Todoist-channel handler assertions.
- Remove `@memry/todoist-import` package tests only if they tested deleted desktop
  glue — the pure package tests stay.

## Gates

`pnpm ipc:generate && pnpm ipc:check`, `pnpm typecheck`, `pnpm lint`,
`pnpm test:desktop`, `pnpm --filter @memry/desktop i18n:check`,
`pnpm docs:impact --base <base> --strict`, `pnpm docs:build`, `git diff --check`.

i18n: add `import.sources.todoist` (en) and preview-related keys
(`import.preview.*`, stat `labelKey`s) in `packages/i18n` settings namespace
(en-only is the gate; other locales are non-fatal warnings).

## Result for the Next Importer (e.g. Bear)

1. New folder `apps/desktop/src/main/import/bear/bear-importer.ts` with one
   `Importer` object (+ optionally a pure parse package).
2. One line in `register-builtins.ts`.
3. Optional: one entry in `IMPORT_ICONS`.

No new IPC, no new contract, no new preload API, no new hook, no Settings edit.
