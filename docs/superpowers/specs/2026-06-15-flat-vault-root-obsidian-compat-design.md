# Flat Vault Root + Obsidian Compatibility — Design

Date: 2026-06-15
Branch: `feat/flat-vault-root`
Status: Approved (brainstorm) → implementation

## Problem

Memry assumes a fixed three-folder vault layout (`notes/`, `journal/`, `attachments/`).
When a user points Memry at an existing Obsidian vault:

- The collection sidebar shows **zero items**, because the indexer only scans
  `notes/` + `journal/` (`apps/desktop/src/main/vault/indexer.ts:310`) and the
  notes query hard-filters `path LIKE 'notes/%'`
  (`apps/desktop/src/main/database/queries/notes/note-crud.ts:114`). Markdown at
  the vault root or in arbitrary subfolders is never indexed.
- Existing journals are **invisible**, because journal detection is a hardcoded
  folder + filename regex `^journal\/(\d{4}-\d{2}-\d{2})\.md$`
  (`apps/desktop/src/main/database/queries/notes/journal-queries.ts:11`). Obsidian
  daily notes live in a user-chosen folder with a user-chosen date format.

Pre-production, no users → no migration or backward-compatibility constraints.
We make the vault structure Obsidian-like: every `.md` under the vault root is a
note; the journal folder + date format are user-configurable.

## Goals

1. Memry reads **every `.md` under the vault root** (root + all subfolders), not a
   fixed `notes/` folder. The `notes/` folder is deprecated.
2. The journal folder path **and** filename date format are user-configurable in
   Settings (Obsidian Daily Notes parity). Memry respects that format both to
   **detect** existing journals and to **name** new ones.
3. Journal entries are **hidden from the collection** (they appear in the Journal
   view only) once a journal folder is configured.
4. The collection sidebar shows an **Obsidian-style collapsible folder tree**
   rooted at the vault root, with the journal/attachments folders hidden.
5. New notes are written to a **configurable default location** (default: vault
   root).
6. Brand-new vaults are created **flat** (no `notes/` folder).

## Non-Goals

- No migration / back-compat (no users).
- No auto-detection of the journal folder on import — the user sets it manually in
  Settings.
- No change to attachments handling beyond keeping the existing
  `attachmentsFolder` skip behavior.
- Nested date-folder formats (e.g. `YYYY/MM/DD` that creates subfolders) are out
  of scope; v1 supports a journal folder + a flat date filename format.
- Indexing arbitrary non-`.md` files at the root as standalone collection items is
  out of scope; only `.md` files are notes.

## Architecture

### B1. Config schema

`VaultConfig` (`packages/contracts/src/vault-api.ts`) — **remove** `defaultNoteFolder`,
**add** the new fields:

```ts
interface VaultConfig {
  excludePatterns: string[] // default + '.obsidian', '.memry', '.trash'
  journalFolder: string // default 'journal'; '' disables journals
  journalDateFormat: string // NEW — default 'YYYY-MM-DD' (Obsidian tokens)
  newNoteLocation: 'root' | 'current-folder' | 'folder' // NEW — default 'root'
  newNoteFolder?: string // NEW — used only when newNoteLocation === 'folder'
  attachmentsFolder: string // unchanged, default 'attachments'
}
```

- `UpdateVaultConfigSchema` (zod) extended to validate the new fields.
- `DEFAULT_CONFIG` (`apps/desktop/src/main/vault/init.ts`) and the hardcoded
  defaults in `apps/desktop/src/main/vault/index.ts:391` updated to match.
- Preload types + `window.api.vault` already round-trip `getConfig`/`updateConfig`
  (`vault:get-config` / `vault:update-config`). Run `pnpm ipc:generate` then
  `pnpm ipc:check` after editing the contract.

### B2. Journal format util

New module `apps/desktop/src/main/vault/journal-format.ts`:

```ts
buildJournalRegex(format: string): RegExp        // detection (anchored basename)
parseJournalDate(filename: string, format: string): string | null  // → ISO 'YYYY-MM-DD'
formatJournalFilename(dateIso: string, format: string): string     // naming new entries
```

- Supported tokens: `YYYY`, `YY`, `MM`, `M`, `DD`, `D`, plus literal separators
  `-`, `_`, `.`, and space. Unknown tokens are treated as literals.
- `parseJournalDate` converts the user's format to the canonical ISO date stored in
  the `date` / `journal_date` columns (e.g. `15-06-2026.md` + `DD-MM-YYYY` →
  `2026-06-15`). Returns `null` on no match.
- Implementation prefers the date library already in the repo if it supports
  custom parse tokens; otherwise a self-contained token→regex map. Decision made at
  implementation time; either way the public surface above is identical and unit
  tested.

`journal-queries.ts` drops the hardcoded `JOURNAL_PATH_PREFIX` /
`JOURNAL_DATE_PATTERN`. New config-aware predicate:

```ts
isJournalEntry(path: string, config: VaultConfig): boolean
// true iff journalFolder !== '' AND path is inside journalFolder
//      AND basename matches buildJournalRegex(journalDateFormat)
```

`extractDateFromPath(path, config)` delegates to `parseJournalDate` on the
basename when `isJournalEntry` is true.

### B3. Indexer

`indexer.ts` (`indexVault`, ~line 299) stops building `foldersToScan` from
`defaultNoteFolder` + `journalFolder`. Instead it walks the **entire vault root**
recursively, skipping:

- `excludePatterns` (incl. `.git`, `node_modules`, `.trash`, `.obsidian`, `.memry`),
- any dotfolder,
- the configured `attachmentsFolder`.

Every `.md` is indexed as a note. Files matched by `isJournalEntry(path, config)`
get their `date` (`note_cache.date`) / `journal_date` (`note_metadata`) column
populated via `extractDateFromPath`. Non-journal `.md` get `date = null`.

Re-index triggers: changing `journalFolder`, `journalDateFormat`, or
`excludePatterns` via `updateConfig` (`index.ts:412`) must run a full re-index so
the collection/journal split updates live.

### B4. Queries

`note-crud.ts:114` (`listNotesFromCache`) drops the `like(noteCache.path,
'${folder}/%')` constraint when no explicit `folder` is requested. Collection =
all notes with `date IS NULL` (journals already excluded by the `date` column —
existing mechanism, unchanged). The optional `folder` filter remains for subtree
listing.

Journal path construction (`apps/desktop/src/main/vault/journal.ts`,
`getJournalPath` / `getJournalRelativePath`, and the content store) uses
`journalFolder` + `formatJournalFilename(date, journalDateFormat)` instead of the
hardcoded `journal/YYYY-MM-DD.md`. Journal date-range queries (heatmap, month,
year) read the indexed `date` column and are unaffected.

### B5. Sidebar folder tree

`buildTreeFromNotes` / `useNoteFoldersQuery`
(`apps/desktop/src/renderer/src/hooks/use-note-tree-data.ts`,
`components/notes-tree.tsx`) are re-rooted at the **vault root** instead of
`notes/`. The configured `journalFolder` and `attachmentsFolder` are excluded from
the tree so they do not appear as folders. Journals continue to render in the
Journal view.

Target shape:

```
Collection
  ▾ Projects
      • spec
      ▾ 2026
          • research
  • Welcome
  • meeting
        (Daily/ hidden → Journal view)
```

### B6. Settings UI

- **Settings → Journal** (`pages/settings/journal-section.tsx`, extend existing):
  add **Journal folder** (text input) and **Date format** (text input) with a live
  preview line (`{folder}/{formattedToday}.md`). Reads/writes via
  `window.api.vault.getConfig` / `updateConfig`. Empty folder disables journals.
- **Settings → General** (`pages/settings/general-section.tsx`): add **Default
  location for new notes** — select of `root` / `current-folder` / `folder`, with a
  folder text input shown when `folder` is chosen.
- New `en/common.json` keys (only `en` is gated by `i18n:check`).

### B7. New-note location

`apps/desktop/src/main/vault/notes-crud.ts` (`generateNotePath`, ~line 216)
resolves the base directory from `newNoteLocation`:

- `root` → vault root,
- `current-folder` → folder of the active/contextual note (passed through the
  create input; falls back to root when absent),
- `folder` → `newNoteFolder` (falls back to root when empty).

Existing explicit `folder` argument on create still wins when provided (e.g.
"new note in this folder" from the tree context menu).

### B8. Vault init

`init.ts:7` `VAULT_FOLDERS` no longer creates `notes/`. A fresh vault is created
flat: the configured `journalFolder` (default `journal/`) + `attachmentsFolder`
(+ its `images`/`files` subfolders) only.

## Edge Cases

- `journalFolder === ''` → journals disabled; every `.md` is a note.
- A date-format that matches nothing → those files remain normal notes (no crash).
- A date-named file **outside** the journal folder (e.g. `Projects/2026-06-15.md`)
  → normal note.
- `.obsidian` / `.memry` / `.git` / `node_modules` / `.trash` never indexed.
- Changing `journalDateFormat` re-indexes; files that no longer match move from the
  Journal view back into the collection (and vice-versa).

## Testing

Unit (vitest, main project):

- `journal-format`: round-trip `parseJournalDate ↔ formatJournalFilename` for
  `YYYY-MM-DD`, `DD-MM-YYYY`, `YYYYMMDD`, `YYYY.MM.DD`; non-match returns null.
- `isJournalEntry`: in-folder match true; wrong folder false; non-date basename
  false; empty journalFolder false.
- Indexer: temp vault with root `.md`, nested `.md`, journal-folder date files,
  `.obsidian/` → asserts note/journal split and that excluded dirs are skipped.
- `listNotesFromCache`: rows with no `notes/` prefix are listed; journals
  (`date != null`) excluded.
- `generateNotePath`: each `newNoteLocation` mode resolves the expected directory.

E2E (Playwright, `apps/desktop`) — added if the unit + integration coverage does
not exercise the full open-vault → see-notes flow:

- Open a fixture flat vault (root note + nested note + a `Daily/` journal folder),
  assert the collection tree shows the notes/folders and hides `Daily/`, and the
  Journal view shows the daily entry.
- Set a custom journal folder/format in Settings, assert re-index moves entries
  correctly.

## Implementation Phases

1. `journal-format` util + unit tests.
2. Config schema: `VaultConfig` + `UpdateVaultConfigSchema` + defaults + preload
   types; `pnpm ipc:generate && pnpm ipc:check`.
3. Indexer walk-whole-root + config-aware journal detection (`journal-queries.ts`).
4. Query (`note-crud.ts`) + journal path construction (`journal.ts`, content store).
5. Sidebar tree re-root + hide journal/attachments folders.
6. Settings UI: Journal folder/format + default new-note location.
7. Vault init flat + re-index-on-config-change.
8. Verify: lint, typecheck, unit/integration tests; add e2e if needed;
   `docs:impact` / `docs:build`.
