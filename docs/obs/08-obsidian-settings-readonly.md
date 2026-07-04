# Obsidian Settings (Read-Only) — Design

**Date:** 2026-07-05
**Branch:** `obs-settings-readonly`
**Status:** Approved, pending implementation

## Goal

When a vault contains an `.obsidian/` folder, Memry reads the user's Obsidian
configuration and behaves consistently with it — journal location, property
types, attachment/link preferences — while treating the folder as strictly
read-only. `.canvas`/`.base`/media files are never rewritten, moved, or deleted
by any non-user-initiated Memry operation (P2.11, decision locked).

Scope note: Obsidian's "Override config folder" setting can rename `.obsidian/`.
Detecting a renamed config folder is **out of scope**; we support the default
name only. Vaults using an overridden folder simply get no seeding (the folder
is still safe — it is a dotfolder, see below).

## Current behavior (code audit)

Exclusion — already correct, verified:

- `apps/desktop/src/main/vault/init.ts:18` — `DEFAULT_CONFIG.excludePatterns`
  contains `.trash` and `.obsidian` (plus `.git`, `node_modules`, `.memry`).
- `apps/desktop/src/main/vault/indexer.ts:75` — `findVaultFiles` skips every
  entry starting with `.`, independent of `excludePatterns` (line 78). So
  `.obsidian/` and `.trash/` are never scanned even if the user edits patterns.
- `apps/desktop/src/main/vault/watcher.ts:206` — chokidar `ignored` has the
  same dotfile guard; user patterns at 209–214; `isSupportedPath` gate at 218.
- Memry never empties `.trash/` — no code references it beyond the exclude list.

File-type surface (`packages/shared/src/file-types.ts:16–22`): supported types
are `md`, `pdf`, images, audio, video. `.canvas` and `.base` are unsupported →
skipped by both scanner (`indexer.ts:87`) and watcher (`watcher.ts:218`); they
never enter the cache, so no id exists for rename/move/delete IPC to target.
Non-md supported files are indexed **metadata-only** (`indexer.ts:212–259`,
`watcher.ts:486–540`, `661–698` — `stat` + cache row, content never rewritten).
Only `isEditable` type is markdown (`file-types.ts:128`). User-initiated
rename/move of a binary is a pure `fs.rename`
(`apps/desktop/src/main/vault/notes-rename.ts:59–75`, `142–157`) — allowed.

Known md-only write-backs (duplicate-id regeneration: `indexer.ts:172–180`,
`notes-crud.ts:322–347`, `watcher.ts:372–381`) go away with spec 01
(path-as-identity); they never touch non-md files.

Journal config — the mapping target already exists:

- `packages/contracts/src/vault-api.ts:49–57` — `VaultConfig` has
  `journalFolder` + `journalDateFormat` (configurable journal folder work).
- `apps/desktop/src/main/vault/journal-config.ts:11–27` — process-wide holder,
  set from `getConfig()` on vault open. Defaults `journal` / `YYYY-MM-DD`
  (`init.ts:20–21`).
- `init.ts:90` `initVault` writes `DEFAULT_CONFIG` with `flag: 'wx'` — i.e.
  only when `.memry/config.json` does not exist yet. This is the seeding hook.

Property type inference (spec 05 interplay): value-based only today —
`apps/desktop/src/main/vault/frontmatter.ts:396` `inferPropertyType(_name, value)`
(the `_name` param is already there, unused), duplicated in
`apps/desktop/src/main/database/queries/notes/query-helpers.ts:69` and
`packages/app-core/src/folder-view.ts:209`.

## Design

### New module: `apps/desktop/src/main/vault/obsidian-config.ts`

Read-only, best-effort accessors. Every function tolerates a missing folder,
missing file, or malformed JSON by returning `null` (log at debug, never throw).
`workspace.json` is never read (it churns constantly). No write API exists.

```ts
export interface ObsidianDailyNotesConfig {
  folder?: string // relative to vault root
  format?: string // Moment tokens; may contain '/' → subfolders
  template?: string
}

export interface ObsidianAppConfig {
  attachmentFolderPath?: string // '' | 'folder' | './' | './sub' (note-relative)
  newLinkFormat?: 'shortest' | 'relative' | 'absolute'
  useMarkdownLinks?: boolean
}

export type ObsidianPropertyType =
  | 'text'
  | 'multitext'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'datetime'
  | 'tags'

export function hasObsidianDir(vaultPath: string): boolean
export function readDailyNotesConfig(vaultPath: string): ObsidianDailyNotesConfig | null
export function readAppConfig(vaultPath: string): ObsidianAppConfig | null
export function readPropertyTypes(vaultPath: string): Record<string, ObsidianPropertyType> | null
export function mapObsidianType(t: ObsidianPropertyType): PropertyType | null
```

`mapObsidianType`: `text→text`, `number→number`, `checkbox→checkbox`,
`date→date`, `datetime→date`, `multitext→multiselect`, `tags→null` (reserved
key, spec 05 owns tag handling). Unknown strings → `null` (fall through).

### daily-notes.json → journal settings (seed-once precedence)

**On first open of a vault that has `.obsidian/` and no `.memry/config.json`
yet, seed Memry's journal settings from `daily-notes.json`; afterwards Memry's
own config is authoritative.** No live re-sync — the user may reconfigure
either app independently, and last-writer-wins churn would be worse than a
one-time seed. Concretely, in `initVault` (`init.ts:90`), before the `wx`
write: if the config file is absent and `readDailyNotesConfig` returns values,
merge `folder→journalFolder` and `format→journalDateFormat` into the config
being written. Validation: seed `format` only if
`extractDateFromPath(generateJournalPath(date))` round-trips it (covers `/` in
the format creating subfolders); otherwise keep the Memry default and log a
warning. `template` is stored nowhere yet — documented as ignored in v1 (Memry
has its own template system). Absent file (core plugin unconfigured) → no
seeding, Memry defaults apply.

### app.json → read-and-stored

`attachmentFolderPath`, `newLinkFormat`, `useMarkdownLinks` are exposed via
`readAppConfig` but have no consumer today: Memry attachments live in
`.memry/attachments/<noteId>/` (P0.3 non-goal, kept) and link insertion style
is renderer-side. The contract this spec establishes: **any future code path
that writes a user-visible attachment or a new link must consult
`readAppConfig` first.** Accessors ship now so specs 01/05/06 can call them.

### types.json → property type inference

Load `readPropertyTypes` on vault open into a module-level map (same holder
pattern as `journal-config.ts`), refreshed on reindex. Inference order becomes:
**types.json by property name → value inference** in
`frontmatter.ts:inferPropertyType` (finally using its `_name` param) and
`query-helpers.ts:inferPropertyType` (gains a name param). The app-core
duplicate (`folder-view.ts:209`) is out of scope (no Electron main context).
Cross-ref `05-properties-top-level.md` for emit style and reserved keys.

### Never-write guard

Add `assertVaultWritePath(absolutePath)` to
`apps/desktop/src/main/vault/file-ops.ts`, called from `atomicWrite` and
`deleteFile`: throws if the resolved path is inside `<vault>/.obsidian/` or
`<vault>/.trash/`. Cheap invariant; no production path hits it today, so it is
pure regression insurance.

## Implementation plan

1. Create `apps/desktop/src/main/vault/obsidian-config.ts` with the accessors
   above + `obsidian-config.test.ts` (fixture JSON via `mkdtemp`: valid files,
   missing folder, malformed JSON, `workspace.json` present-but-unread).
2. Seed hook in `initVault` (`init.ts:90`): merge validated daily-notes values
   into the first-time config write. Test: temp vault with
   `.obsidian/daily-notes.json` → `readVaultConfig` returns seeded values;
   second `initVault` call never overwrites an existing config.
3. Format round-trip validation helper using `journal.ts` path utils; reject
   unparseable formats with a logged warning (test both branches, incl. a
   `format` containing `/`).
4. Wire types.json holder: load on vault open (next to `setJournalConfig` call
   in `apps/desktop/src/main/vault/index.ts`), thread name-first lookup into
   `frontmatter.ts:396` and `query-helpers.ts:69`. Unit tests for
   `mapObsidianType` and the fallback order.
5. Add `assertVaultWritePath` to `file-ops.ts`, call from `atomicWrite` /
   `deleteFile`; unit test that a path under `.obsidian/` throws.
6. Non-md safety fixture test (extends spec 04's golden vault): vault with
   `.obsidian/*`, `x.canvas`, `x.base`, `img.png`; run `indexVault` + one note
   edit; assert byte-identical `.obsidian/*`/`.canvas`/`.base`, `img.png`
   untouched, and no `.obsidian` paths in the notes cache.

## Verification

- `pnpm typecheck` / `pnpm lint`
- `pnpm test:desktop` — new `obsidian-config.test.ts`, `init` seeding tests,
  `file-ops` guard test, golden non-md fixture test all green
- Manual: open a real Obsidian vault with a configured daily-notes folder →
  Memry journal lands in that folder; `.obsidian/` mtimes unchanged after a
  full session

## Interactions

- **05-properties-top-level.md** — types.json becomes the first step of
  property type inference; 05 owns emit style and reserved keys (`tags`,
  `aliases`, `cssclasses`); this spec only supplies the type map.
- **01-frontmatter-diet.md** — path-as-identity removes the md write-backs
  noted above; the seed-once journal mapping assumes 01's flat-vault-root
  behavior (journal folder is just a configured path, no forced structure).
- **04-byte-preservation.md** — the golden round-trip vault is the natural home
  for the `.obsidian`/`.canvas`/`.base` byte-identity fixtures (step 6).

## Open questions

- Should `newLinkFormat`/`useMarkdownLinks` get a v1 consumer (renderer
  wikilink autocomplete), or wait until spec 06 lands link-style preservation?
  Current plan: accessors only.
- Re-seed affordance: expose a "re-import Obsidian settings" button in vault
  settings later, or keep seed-once forever? Not needed for v1.
- `daily-notes.json` `template` — apply as a Memry journal template when the
  template systems converge? Ignored in v1.
