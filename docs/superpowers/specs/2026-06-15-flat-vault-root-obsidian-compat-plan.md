# Flat Vault Root + Obsidian Compatibility — Implementation Plan

Derived from `2026-06-15-flat-vault-root-obsidian-compat-design.md` (+ revision).
Each phase ends green before the next. `pnpm` runs from the worktree root.

## Phase 1 — `journal-format` util (pure, TDD)

- New `packages/shared/src/journal-format.ts` (shared so storage-vault + desktop +
  app-core can import):
  - `buildJournalRegex(format)` → anchored basename `RegExp`.
  - `parseJournalDate(filename, format)` → ISO `YYYY-MM-DD` | `null`.
  - `formatJournalFilename(dateIso, format)` → string (no extension).
  - tokens `YYYY YY MM M DD D`, separators `- _ . ` + space; unknown = literal.
- Export from `packages/shared` index.
- Test `packages/shared/src/journal-format.test.ts`: round-trips for
  `YYYY-MM-DD`, `DD-MM-YYYY`, `YYYYMMDD`, `YYYY.MM.DD`; non-match → null.
- Verify: `pnpm --filter @memry/shared test` (or vitest for the file).

## Phase 2 — Config schema

- `packages/contracts/src/vault-api.ts`: add `journalDateFormat: string` to
  `VaultConfig` + `UpdateVaultConfigSchema`. (keep `defaultNoteFolder`)
- `packages/app-core/src/paths.ts`: `VaultConfig` + `defaultVaultConfig`
  (`defaultNoteFolder: ''`, add `journalDateFormat: 'YYYY-MM-DD'`,
  excludePatterns += `.obsidian`).
- `apps/desktop/src/main/vault/init.ts` `DEFAULT_CONFIG` + `index.ts` defaults
  (`getConfig` fallback ~line 391): `defaultNoteFolder: ''`,
  `journalDateFormat: 'YYYY-MM-DD'`, excludePatterns += `.obsidian`, `.memry`.
- `apps/desktop/src/preload/index.d.ts`: add `journalDateFormat` to the config type.
- `packages/storage-vault/src/note-content-store.ts`: add `journalDateFormat` to
  `VaultStoreLayout`; `getJournalRelativePath` uses `formatJournalFilename`.
- Verify: `pnpm ipc:generate && pnpm ipc:check`; `pnpm --filter @memry/contracts test`.

## Phase 3 — Journal detection (config-aware)

- `apps/desktop/.../queries/notes/journal-queries.ts`: replace
  `JOURNAL_DATE_PATTERN`/`JOURNAL_PATH_PREFIX`; make `isJournalEntry(path, folder,
format)`, `extractDateFromPath(path, folder, format)`,
  `generateJournalPath(date, folder, format)` config-aware (delegate to
  journal-format). Keep names.
- Update call sites with config from `getConfig()`:
  - `note-sync.ts:148`, `projectors/note-derived-state-projector.ts:52`,
    `queries/notes/index.ts` re-exports.
- Verify: `pnpm --filter @memry/desktop typecheck:node`.

## Phase 4 — Indexer scans whole root

- `apps/desktop/src/main/vault/indexer.ts:311`: `foldersToScan = [vaultPath]`;
  ensure `findVaultFiles` skips `excludePatterns`, dotfolders, and
  `config.attachmentsFolder`. Journal `date` set via config-aware
  `extractDateFromPath`.
- `watcher.ts`: scan whole root (line 198-199), keep `isJournalPath` but make it
  use folder + format consistency.
- Verify: indexer + watcher unit tests.

## Phase 5 — New-note location + journal path

- `notes-io.ts getNotesDir`, `folders.ts`, app-core `notes.ts notePath`,
  `folder-view.ts notesDir/noteFolder` already handle `''` via path.join /
  normalizePath — confirm, add guards only if a test fails.
- Journal create/read path now flows through content-store format (Phase 2).
- Verify: `notes`, `journal`, `folders` unit tests.

## Phase 6 — Sidebar tree re-root + hide journal/attachments

- `apps/desktop/.../hooks/use-note-tree-data.ts` + `components/notes-tree.tsx`:
  tree roots at vault root (root-relative paths already do this once notes index
  from root). Exclude `journalFolder` + `attachmentsFolder` top-level folders.
- Confirm the notes list query is not passing `folder: 'notes'`.
- Verify: `pnpm --filter @memry/desktop test:renderer` for tree.

## Phase 7 — Vault init flat

- `init.ts:7` `VAULT_FOLDERS`: drop `notes`; keep journal + attachments(+sub).
- Verify: `init` unit tests (update expectations).

## Phase 8 — Settings UI

- `pages/settings/journal-section.tsx`: Journal folder + Date format inputs (live
  preview), via `window.api.vault.getConfig/updateConfig`.
- Default new-note folder input (Journal or General section): `defaultNoteFolder`
  (empty = root).
- `en/common.json` keys.
- Verify: renderer settings test; `pnpm --filter @memry/desktop i18n:check`.

## Phase 9 — Re-index on structural config change

- `index.ts updateConfig`: when `journalFolder`/`journalDateFormat`/
  `excludePatterns`/`defaultNoteFolder` change, trigger full re-index.
- Verify: vault index test.

## Phase 10 — Full verification + e2e

- `pnpm lint`, `pnpm typecheck`, `pnpm test:desktop`, `pnpm test` — fix all
  fallout (many existing tests hardcode `notes/` paths + `defaultNoteFolder:'notes'`
  — update fixtures/expectations to the flat model; do NOT break behavior).
- Add Playwright e2e if unit coverage does not exercise open-vault → see-notes.
  Build `out/` first (`pnpm exec electron-vite build`), rebuild:electron as needed.
- `git diff --check`.

## Test-fallout note

Many suites assert `defaultNoteFolder: 'notes'` and `journal/YYYY-MM-DD.md`. These
are fixtures, not behavior contracts — update them to the flat model (root notes,
`defaultNoteFolder: ''`) and config-aware journal helpers. Track that none are
masking a real regression.
