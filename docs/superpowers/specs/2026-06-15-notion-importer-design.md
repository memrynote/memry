# Notion Importer + Extensible Import Framework — Design

Date: 2026-06-15
Status: Approved design (pending implementation plan)
Branch: `notion-importer`

## Goal

Let users bring their Notion workspace into Memry. A user exports their Notion
content as **HTML** (Notion → Settings → Export → "HTML", which produces a
`.zip`), points Memry at the `.zip`, and gets their pages as Markdown notes in
the vault — with the page hierarchy preserved as folders, attachments copied,
internal page links rewritten to wikilinks, and database page properties carried
into frontmatter.

This is an onboarding wedge (lower switching cost off Notion), and it is the
**first consumer of a reusable import framework** so the next importers (Google
Keep, Todoist, TickTick) plug in without re-plumbing FS/IPC/progress.

## Decisions (locked)

| Question       | Decision                                                                  |
| -------------- | ------------------------------------------------------------------------- |
| Notion source  | **HTML export `.zip`** (not the Notion API/OAuth path)                    |
| Scope          | Reusable import framework **+ the Notion importer only** (no other ports) |
| UI entry point | **Dedicated Import hub** (Settings → Import section + modal)              |
| Progress UX    | **Streaming progress + cancel** (live IPC events, Cancel button)          |
| Process model  | Main-process framework; renderer is a thin UI driving it via IPC          |
| Zip handling   | `yauzl`, zip-slip-safe, **nested-zip aware** (export is zip-in-zip)       |

## Source data format (from a real export)

A Notion HTML export is a `.zip`. The real sample in this repo is **nested**:
`Export-<uuid>.zip` contains `Export-<uuid>-Part-1.zip` (Notion splits large
exports into `Part-N.zip` members). The importer must recurse into zips that sit
at the root of a parent zip.

Inside, each page is an `.html` file whose name ends with a 32-hex Notion id
(e.g. `My Page 1a2b…f9.html`). Pages nest in folders named `Title <id>/`.
Alongside live attachments (images/files) and, for databases, a `<Title>.csv`
plus per-row page `.html` files. There is also a top-level `index.html` summary.

Key facts (validated against obsidian-importer's Notion HTML importer):

- Page **id** is the 32-hex suffix on the file/folder name, also present as an
  element `id` in the HTML body.
- Full **title** is read from the HTML `<title>` (Notion truncates filenames).
- `created_time` / `last_edited_time` live in property rows
  (`tr.property-row-created_time` / `tr.property-row-last_edited_time`).
- Folder hierarchy encodes the **page tree** (parent pages → subfolders).
- Internal links are `<a href>` to other exported pages (by id) or attachments.
- Database **page properties** render as an HTML property table on each page.
- A **Markdown** export (instead of HTML) is detectable (`.md` files with Notion
  ids) and must be rejected with a clear "export as HTML" message.

## Architecture

### Approach

Main-process import framework behind generic IPC. The renderer only picks files
and renders progress; all FS, zip extraction, parse, conversion, and vault
writes (`createNote` / `saveAttachment`) stay in the main process, where vault
writes already live. Pure converters take no FS so they unit-test against the
real export.

This mirrors obsidian-importer's `FormatImporter` + `ImportContext` + registry,
adapted to Memry's React+IPC split: obsidian couples per-format UI into the
importer via its `Setting` DSL; Memry keeps UI in the renderer and the importer
free of UI.

Rejected:

- **Renderer-side parsing** — crosses the FS/IPC boundary, can't unzip, no clean
  test seam (same reasoning as the Keep spec).
- **Notion API/OAuth importer** — ~7k LOC in obsidian, needs a Notion OAuth app
  and token handling; deferred (the framework leaves room for it later).
- **A separate npm package** (`@memry/notion-import`) — not needed; the importer
  lives in `apps/desktop/src/main/import/` with pure, testable submodules. A
  package only earns its keep if the CLI needs the importer too (out of scope).

### Components

**Framework — `apps/desktop/src/main/import/`**

- `types.ts`

  ```ts
  export interface ImportFileSpec {
    label: string // e.g. "Notion HTML export"
    extensions: string[] // e.g. ['zip']
    allowMultiple: boolean
  }

  export interface ImportContext {
    status(message: string): void
    reportProgress(completed: number, total: number): void
    reportNote(): void
    reportAttachment(): void
    reportSkipped(item: string, reason?: string): void
    reportFailed(item: string, error?: unknown): void
    isCancelled(): boolean
  }

  export interface ImportSummary {
    imported: number
    attachments: number
    skipped: number
    failed: { item: string; error: string }[]
  }

  export interface Importer {
    id: string // 'notion'
    name: string // 'Notion'
    fileSpec: ImportFileSpec
    run(
      input: { sourcePaths: string[]; options?: Record<string, unknown> },
      ctx: ImportContext
    ): Promise<ImportSummary>
  }
  ```

- `registry.ts` — `registerImporter(importer)`, `getImporter(id)`,
  `listImporters()`. Built-ins registered once at startup. **This is the
  extensibility seam**: a new importer = a new module + one `registerImporter`
  call; nothing else in the framework changes.

- `import-context.ts` — concrete `ImportContext` that (a) tallies
  notes/attachments/skipped/failed, (b) emits `ImportChannels.events.PROGRESS`
  via `webContents.send` keyed by `importId` (matching Memry's existing
  progress-event pattern, e.g. `EMBEDDING_PROGRESS`, `VOICE_MODEL_PROGRESS`), and
  (c) returns `true` from `isCancelled()` once its `AbortSignal` fires.

- `runner.ts` — `getImporter(importerId)`, mint `importId` + `AbortController`,
  build the context, `await importer.run(...)`, return the `ImportSummary`.
  `import:cancel` aborts the matching controller. Logs via
  `createLogger('Import')`.

**Notion importer — `apps/desktop/src/main/import/notion/`**

- `notion-importer.ts` — implements `Importer`. Two-pass flow (below).
- `parse-info.ts` _(pure)_ — from each page's HTML: extract 32-hex id, full
  `<title>`, `created`/`last_edited` times, `parentIds`; build attachment
  entries. Port of obsidian's `parse-info.ts`.
- `resolver.ts` _(pure)_ — port of `NotionResolverInfo`: `idsToFileInfo` +
  `pathsToAttachmentInfo` maps, nested-page → subfolder path resolution
  (`getPathForFile`), strip `<id>` suffixes from names, filename de-dupe, and
  internal-link target resolution.
- `convert-to-md.ts` _(pure)_ — Notion page HTML → Memry markdown: headings,
  lists, code blocks, tables, images, callouts, to-dos, equations. **Internal
  page links → `[[Title]]` wikilinks** (first-class in Memry). **DB page
  property table → frontmatter properties**, with `multi_select` / Notion tag
  properties → `tags[]`.
- `notion-zip.ts` — streaming reader over `yauzl` with a **zip-slip guard** and
  **nested-zip recursion** (recurse into a `.zip` entry only when it sits at the
  root of its parent zip; deeper `.zip`s are treated as attachments — matches
  obsidian).
- Vault writes: `createNote({ title, content, folder, tags, properties })` then
  `saveAttachment(noteId, buffer, filename)`. Because `NoteCreateInput` does not
  accept `created`/`modified`, Notion's `ctime`/`mtime` are applied **after**
  creation by patching frontmatter (lower-risk default; the plan may instead
  extend `createNote` to accept optional timestamps).

**Contracts — `packages/contracts`**

- New `ImportChannels`:
  - command `import:start` — request `{ importerId: string; sourcePaths: string[]; options?: Record<string, unknown> }`, response `{ importId: string }` (the run streams progress and ends with a `done` event carrying the summary). _Alternatively the invoke resolves with the final `ImportSummary`; the plan picks one — streaming-end event is preferred so the renderer has a single progress channel._
  - command `import:cancel` — request `{ importId: string }`.
  - event `import:progress` — `{ importId, phase, status, imported, attachments, skipped, failed, percent, done?, summary? }`.
- Zod schemas for each; then `pnpm ipc:generate` + `pnpm ipc:check`.
- Register handlers in a new `apps/desktop/src/main/ipc/import-handlers.ts` (add
  to the IPC index + its test mock).

**Renderer — Import hub**

- A small renderer-side catalog `import-catalog.ts`:
  `{ id: 'notion', name: 'Notion', description: 'Import an HTML export (.zip)', icon }`.
- **Entry point**: a Settings → **Import** section that opens an Import modal
  listing the catalog. (Reuses the file-picker dialog path; not the
  `integration-registry` rows — that registry stays for connect-style
  integrations.)
- Flow: pick importer → choose `.zip` → `import:start` → subscribe to
  `import:progress` (preload `onImportProgress`) → live UI (status line, progress
  bar, imported / skipped / failed counts, **Cancel** button) → on `done`, show
  the summary. Unsubscribe on unmount.

### Data flow (Notion)

1. Iterate zip entries (nested-zip aware), with zip-slip guard.
2. **Pass 1** — `parse-info` on every `.html` page builds the `resolver`
   (id→fileinfo, path→attachment). `ctx.reportProgress` updates the total.
3. Resolve folders + internal links + de-dupe filenames (`resolver`); create the
   target folders under the chosen root (default `Notion/`).
4. **Pass 2** — per page: `convert-to-md` → `createNote(folder, tags,
properties)`, then patch `created`/`modified`; per attachment:
   `saveAttachment`. Emit progress and check `isCancelled()` each item.
5. Skip `index.html`. Skip database `.csv` files in v1 (record the count in the
   summary; pages still import). Reject Notion **Markdown** exports up front with
   a clear "please export as HTML" message.
6. Return the `ImportSummary`.

## Field mapping (Notion → Memry)

| Notion                               | Memry                                                |
| ------------------------------------ | ---------------------------------------------------- |
| page `<title>`                       | note title                                           |
| page hierarchy (parent ids)          | nested folders under chosen root (default `Notion/`) |
| `created_time`                       | note `created`                                       |
| `last_edited_time`                   | note `modified`                                      |
| DB page property table               | frontmatter properties                               |
| `multi_select` / tag property        | frontmatter `tags[]`                                 |
| internal page link                   | `[[Title]]` wikilink                                 |
| image / file attachment              | `saveAttachment()` → `![](rel)` / link               |
| callout / to-do / code / table / eqn | Memry-markdown equivalents                           |
| `index.html`, database `.csv`        | skipped (v1)                                         |

## Error handling

- Per-item `try/catch`: a malformed page, conversion error, or write failure
  records `{ item, error }` and the batch continues (one bad page never aborts).
- A missing attachment logs a warning, skips the ref, does not fail the page.
- Zip-slip or corrupt archive aborts **before any write** and returns an error.
- Markdown-export detection cancels with a clear message.
- Temp extraction dir removed in a `finally`.
- Logging via `createLogger('NotionImport')` / `createLogger('Import')`;
  user-facing strings via `extractErrorMessage(err, fallback)`.

## Extensibility (how the next importer plugs in)

Adding Keep / Todoist / TickTick later:

1. New module under `apps/desktop/src/main/import/<source>/` implementing
   `Importer` (pure parser + a thin `run()` that calls `createNote` /
   `saveAttachment` through `ctx`).
2. One `registerImporter(...)` call.
3. One renderer `import-catalog.ts` entry.

No framework change. The Keep spec's pure `parseKeepNote` parser drops in behind
`run()` unchanged.

## Testing (TDD — write tests first)

- **Pure unit** (`vitest`, main project): `parse-info.test.ts`,
  `resolver.test.ts`, `convert-to-md.test.ts` against real fixtures extracted
  from the sample export `.zip` (id/title/timestamp extraction, nested-folder
  path resolution, id-suffix stripping, link→wikilink, property→frontmatter,
  markdown-export rejection).
- **Integration** (`notion-importer.test.ts`, temp vault): feed a fixture zip;
  assert notes created in the correct nested folders with frontmatter/tags,
  patched timestamps, attachments copied + referenced, internal links rewritten
  to wikilinks, **nested-zip handling**, **zip-slip guard**, **cancel mid-run**,
  and summary counts.
- **Framework** (`registry.test.ts`, `runner.test.ts`): registration lookup,
  progress emission, and cancel.
- Verify: `pnpm --filter @memry/desktop test:main`, `pnpm typecheck`,
  `pnpm lint`, `pnpm ipc:check`.

## Out of scope (YAGNI)

- Notion API / OAuth importer (later, same framework).
- Database `.csv` → Memry tables/Task DB rows (v1 imports pages only).
- Re-import dedup / incremental sync (one-shot; collisions get unique-path
  suffixes).
- Porting Keep / Todoist / TickTick (framework is ready; not this branch).
- Notion-specific blocks with no Memry equivalent (e.g. synced blocks, embeds)
  degrade to plain content; no special handling.

## New dependency

- `yauzl` (apps/desktop) — mature streaming zip reader; used with a zip-slip-safe
  extraction routine and nested-zip recursion (same choice as the Keep spec).
