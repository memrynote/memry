# Raindrop Import — Design

**Date:** 2026-06-27
**Branch:** `raindrop-import`
**Status:** Approved, pending implementation

## Goal

Import a [Raindrop.io](https://raindrop.io) bookmark CSV export so every bookmark
lands in the Memry **inbox** as a `link` item. Mirrors the existing CSV importers
(Todoist, TickTick) but applies rows to the inbox instead of the tasks domain.

## Source format

Raindrop CSV export, header row:

```
id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite
```

- `url` — the bookmark URL (required; rows without it are skipped)
- `title` — display title (may be empty)
- `note` — user note
- `excerpt` — auto-extracted summary
- `folder` — Raindrop collection name (`Unsorted` for uncategorised)
- `tags` — comma-separated tags (often empty)
- `created` — ISO-8601 timestamp
- `cover` — hero image URL (often an expiring CDN link)
- `highlights` — saved highlights
- `favorite` — `true`/`false`

## Approach

**Direct CSV insert** (decided over per-URL link-capture): the CSV already carries
title, excerpt, note, cover URL, tags, and created date, so the import is offline,
deterministic, and fast — no network per row, no rate limits, no dead-link fragility.

Same two-layer split as the other CSV importers:

1. **Pure parse package** — `@memry/importers/raindrop` (no Electron deps, unit-tested).
2. **Thin desktop importer** — reads files, calls the pure mapper, inserts inbox items,
   streams progress through the generic import framework.

## Components

### 1. Pure package — `packages/importers/src/raindrop/`

| File               | Responsibility                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `types.ts`         | `RaindropRow`, `InboxItemPlan`, `RaindropImportPlan`                                                                  |
| `parse-csv.ts`     | RFC-4180 tokenizer (reuse the proven `tokenizeCsv` from ticktick/todoist), header-keyed column read → `RaindropRow[]` |
| `map-rows.ts`      | `mapRows(rows): RaindropImportPlan`                                                                                   |
| `index.ts`         | re-exports `parseRaindropCsv`, `mapRows`, types                                                                       |
| `map-rows.test.ts` | unit check (the one runnable verification)                                                                            |

**Types**

```ts
export interface RaindropRow {
  id: string
  title: string
  note: string
  excerpt: string
  url: string
  folder: string
  tags: string[]
  created: string
  cover: string
  highlights: string
  favorite: boolean
}

export interface InboxItemPlan {
  title: string
  content: string | null
  sourceUrl: string
  createdAt: string
  tags: string[]
  metadata: {
    url: string
    excerpt: string
    folder: string
    favorite: boolean
    heroImage: string
    highlights: string
  }
}

export interface RaindropImportPlan {
  items: InboxItemPlan[]
  stats: { bookmarks: number; withTags: number; skipped: number }
  sampleTitles: string[]
  warnings: { message: string }[]
}
```

**Mapping rules (`mapRows`)**

- `title` ← `row.title || row.url`
- `content` ← `[note, excerpt].filter(Boolean).join('\n\n')` → `null` when empty
- `sourceUrl` ← `row.url`
- `createdAt` ← `row.created` if a valid ISO timestamp, else `opts.now`
- `tags` ← `row.tags` + folder-as-tag, **`Unsorted` dropped**, trimmed, lowercased, deduped
- `metadata` ← `{ url, excerpt, folder, favorite, heroImage: cover, highlights }`
- rows with empty `url` → **skipped** (counted in `stats.skipped`, never failed)
- `stats.withTags` = items whose resolved tag list is non-empty
- `sampleTitles` = first 5 item titles

`mapRows` takes `{ now: string }` so the importer can inject a deterministic
timestamp (tests + reproducibility), matching the ticktick pattern.

**Package export:** add a `./raindrop` entry to `packages/importers/package.json`
`exports` (and any matching `typesVersions`/tsconfig path), mirroring `./ticktick`.

### 2. Desktop importer — `apps/desktop/src/main/import/raindrop/raindrop-importer.ts`

```ts
export const raindropImporter: Importer = {
  id: 'raindrop',
  name: 'Raindrop',
  descriptionKey: 'import.sources.raindrop',
  fileSpec: { label: 'Raindrop CSV export', extensions: ['csv'], allowMultiple: true },
  preview: (input, signal) => buildRaindropPreview(input.sourcePaths, nowIso(), signal),
  run: async (input, ctx) => {
    ctx.setPhase('importing')
    ctx.status('Importing Raindrop bookmarks…')
    const deps = await defaultDeps()
    await runRaindropImport(input.sourcePaths, deps, ctx, nowIso())
    return ctx.toSummary()
  }
}
```

- **Apply deps** (lazy, db-backed): `requireDatabase`, `insertItemWithTags` +
  `emitCapturedAndSync` from `main/inbox/domain`, `generateId`. Kept as an injected
  `ApplyDeps` interface so the importer is unit-testable without Electron.
- **`run` loop:** per file → read → `parseRaindropCsv` → `mapRows`; per item →
  `insertItemWithTags(db, { id, type: 'link', title, content, sourceUrl, createdAt,
modifiedAt, processingStatus: 'complete', captureSource: 'api', metadata }, tags)`
  then `emitCapturedAndSync(row, appliedTags)`; call `ctx.reportImported()` /
  `ctx.reportSkipped()` / `ctx.reportProgress(done, total)`.
- **Failure isolation:** a bad file is `reportFailed` and skipped; a bad row is
  `reportFailed` but never aborts the run. Respect `ctx.isCancelled()`.
- **`captureSource`:** reuse the existing `'api'` value — no new `CaptureSource`
  enum member.
- **`preview`:** one group per file with counts
  `import.stats.bookmarks / import.stats.withTags / import.stats.skipped`,
  sample titles, and warnings.

### 3. Wiring

- `apps/desktop/src/main/import/register-builtins.ts`: import `raindropImporter` and
  add `registerImporter(raindropImporter)`.
- i18n (`packages/i18n`): add `import.sources.raindrop`; add `import.stats.bookmarks`
  (+ reuse `import.stats.withTags` / `import.stats.skipped`, adding any that are missing).
- `apps/desktop/src/main/import/registry.test.ts`: update if it asserts importer ids
  or count.
- Settings → Import catalog surfaces the importer automatically (registry-driven, no
  renderer changes needed).

## Data flow

```
Settings → Import → pick CSV(s)
  → import:preview  → buildRaindropPreview → parse + mapRows → counts (no writes)
  → import:start    → runRaindropImport
        per file: read → parseRaindropCsv → mapRows
          per item: insertItemWithTags(type:'link') → emitCapturedAndSync
        → stream import:progress (imported / skipped / total)
  → ImportSummary
```

## Error handling

- Missing/!= 11 columns or absent header → parser throws → file isolated as a failed
  preview/summary group (other files still import).
- Row with empty `url` → skipped, counted, not an error.
- Invalid `created` timestamp → fall back to `now`.
- Per-row DB failure → `reportFailed`, continue.

## Testing

- `packages/importers/src/raindrop/map-rows.test.ts` — header parse, url-fallback
  title, note+excerpt join, `Unsorted` drop + folder-as-tag, tag dedup/lowercase,
  empty-url skip, `created` fallback, stats. (Primary verification.)
- Optional `raindrop-importer` main test with a fake `ApplyDeps` (mirrors
  ticktick/todoist) asserting one `insertItemWithTags` call per valid row + skip count.

## Deliberately out of scope (lazy, all reversible)

- **No cover download / no per-URL fetch + article-extract / no dedup** — CSV is the
  source of truth; import stays offline and fast.
- **`emitCapturedAndSync` fires per row** — acceptable at export scale; a `// ponytail:`
  comment names the ceiling, batch the projection/sync refresh only if a very large
  export visibly stutters.

## Verification gates

`pnpm typecheck`, `pnpm lint`, `pnpm test:desktop` (raindrop package + importer),
`pnpm --filter @memry/desktop i18n:check`, `pnpm ipc:check` (no contract change
expected, run to confirm), docs gate per CLAUDE.md.
