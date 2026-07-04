# Frontmatter Diet — Design

**Date:** 2026-07-05
**Branch:** `obs-frontmatter-diet`
**Status:** Approved, pending implementation

## Goal

MemryNote stops writing any default frontmatter keys into vault `.md` files: no
`id`, no `title`, no `created`/`modified`, no empty `tags: []`, and no
Memry-claimed keys (`emoji`, `localOnly`). Title derives from the filename. From
the vault's perspective the **file path is the note's identity**; the internal
stable id lives only in the `.memry/` sidecar databases. Every frontmatter key
the user writes is a plain user property, exactly like Obsidian.

Pre-production: no migration code for files written by older Memry versions.

## Current behavior

- `apps/desktop/src/main/vault/frontmatter.ts:161` — `createFrontmatter` injects
  `id`, `title`, `created`, `modified`, `tags: []`.
- `frontmatter.ts:140` — `serializeNote` bumps `modified` to now on **every**
  save and re-stringifies through gray-matter.
- `frontmatter.ts:54` — `parseNote` auto-generates missing `id`/`created`/
  `modified` in memory and flags `wasModified` (read itself is non-destructive).
- `frontmatter.ts:119` — `extractTitleFromPath` mangles the basename
  (kebab/snake → Title Case), so title does not round-trip to the filename.
- `frontmatter.ts:326` — `RESERVED_FRONTMATTER_KEYS`
  (`id,title,created,modified,tags,aliases,emoji,localOnly`) are hidden from the
  properties panel.
- `apps/desktop/src/main/vault/notes-crud.ts:196` — `createNote` writes full
  default frontmatter plus a nested `properties:` object; `getNoteById`
  (`notes-crud.ts:297`) returns `created`/`modified`/`title` from frontmatter and
  contains a duplicate-id repair that **rewrites the file** (`:322-347`).
- `apps/desktop/src/main/vault/notes-rename.ts:34,116` — rename/move rewrite the
  whole file to update `title`/`modified` in frontmatter.
- `apps/desktop/src/main/vault/watcher.ts:335` — external add keys rename
  detection on `parsed.frontmatter.id` (`rename-tracker.ts`, UUID-keyed 500 ms
  unlink→add window) and **writes a regenerated id into copied files**
  (`watcher.ts:372-381`).
- `apps/desktop/src/main/sync/item-handlers/note-handler.ts:415-428` — incoming
  sync create writes full default frontmatter; rename/move/tag branches
  (`:222-309`) rewrite frontmatter `title`/`emoji`.
- `packages/app-core/src/markdown.ts:16` — duplicated `writeMarkdownNote`
  (gray-matter) used by app-core/CLI `notes.ts`, `templates.ts`, `folder-view.ts`.
- Sidecar already holds the mapping both ways: `.memry/data.db`
  `note_metadata` (`packages/storage-data/src/note-metadata-repository.ts` —
  `getNoteMetadataById/ByPath`) and `.memry/index.db` `note_cache`
  (`apps/desktop/src/main/database/queries/notes/note-crud.ts` —
  `getNoteCacheById/ByPath`, both with `createdAt`/`modifiedAt` columns).

## Design

### 1. Path ↔ internal-id mapping lifecycle (sidecar only)

No new sidecar file. The existing `note_metadata` (data DB) + `note_cache`
(index DB) rows **are** the mapping; the diet just removes the copy in the file.

- **Created in Memry** — `createNote` generates the id, writes the file with
  user keys only (empty frontmatter → no YAML block at all), records id + path
  via `syncNoteToCache`/`syncCanonicalMetadata` as today.
- **Renamed/moved in Memry** — pure `fs.rename` for markdown (same as the
  binary branch today); update `path`/`title`/`modifiedAt` in both DBs. File
  bytes untouched — this is the first concrete win for spec 04.
- **External rename/move (watcher)** — keep the unlink→add window in
  `rename-tracker.ts` but key `pendingDeletes` by **content hash** instead of
  frontmatter UUID: `handleFileDelete` passes `cached.contentHash` (already a
  `note_cache` column); `handleMarkdownFileAdd` computes
  `generateContentHash(content)` and matches. Hash hit → same internal id, path
  updated in sidecar. Multiple pending deletes with equal hashes match FIFO
  (oldest first). If content changed inside the 500 ms window the match misses
  and it degrades to delete+create — accepted; today's id-match had the same
  failure whenever frontmatter was stripped.
- **Deleted then recreated (beyond the window)** — real delete processed (sync
  delete, cache row removed); recreation is a new note with a fresh id.
  Accepted pre-production.
- **Copies** — a copied file simply gets a fresh id in the sidecar. Delete the
  copy-repair write in `watcher.ts:372-381` and the duplicate-id repair in
  `getNoteById` (`notes-crud.ts:322-347`, plus `findDuplicateId`) — without ids
  in files, duplicate file ids cannot exist.

### 2. created/modified/title sources + blast radius

- **title** = exact basename without `.md`, verbatim (fix
  `extractTitleFromPath` to stop Title-Casing). Stored in both DB rows; renaming
  the title renames the file, as today.
- **created** — internal create: `now` (importers keep passing
  `input.created`); external add: `fs.stat` `birthtime`. Persisted in
  `note_metadata.createdAt`/`note_cache.createdAt`, never re-derived from the
  file (`insertNoteCache` already never overwrites `createdAt` on conflict).
- **modified** — internal writes: `now` at write time; external change: `mtime`.

Blast radius: the renderer only ever reads `note.created`/`note.modified`/
`note.title` as top-level fields of the `Note`/`NoteListItem` IPC objects — the
contract shape does not change, only the main-process source does:
`getNoteById` returns them from the `note_cache` row instead of frontmatter;
watcher events (`watcher.ts:405-415, 622-654`, incl. journal entry events) use
fs stats/cache; `syncNoteToCache` (`note-sync.ts:178`) takes explicit
`title/createdAt/modifiedAt/localOnly/emoji` fields in `NoteSyncInput` instead
of deriving them from a frontmatter object. `NoteFrontmatter` in
`packages/contracts/src/notes-api.ts:18` and `packages/rpc/src/notes.ts:15`
loses required `id/created/modified` (all keys optional user props);
`Note.frontmatter` stays as the raw user-property record.

### 3. Legacy Memry keys already in files

`id:`, `created:`, `modified:`, `title:`, `emoji:`, `localOnly:` found in
existing files (old Memry, Dendron, anything) are **plain user properties**:
surfaced in the properties panel, never interpreted, never rewritten, never
stripped (byte-preservation, spec 04). `RESERVED_FRONTMATTER_KEYS` shrinks to
`{ tags, aliases }` — the two keys with Obsidian-defined semantics that Memry
reads (and writes only on explicit user edit, spec 05). `emoji`/`localOnly`
become sidecar-only state (both already have columns in both DBs); no writes to
files, no special-cased reads.

### 4. Sync implications

The sync item id never comes from the file — confirmed:

- `buildNotePushPayload` (`note-handler-sync-helpers.ts:29`) resolves the file
  via `note_metadata.path` and reads only `content` + `tags` from it; the
  payload carries no id field.
- `fetchLocalNote` (`:22`) and `seedUnclockedNotes` (`:81`) are DB-only.
- Incoming `applyUpsert` create (`note-handler.ts:413-467`) writes the file at a
  generated path and stores `itemId` in both DBs — change it to write user keys
  only (`tags` when non-empty, `properties` in the current nested style until
  spec 05 lands).
- Incoming rename/move (`:222-309`): stop setting `frontmatter.title`/`emoji`;
  rewrite file content only when `tags`/`properties` actually changed, else pure
  `fs.rename`.

No payload schema or server change.

### 5. Attachments

`.memry/attachments/<noteId>/` keys on the internal id, which stays stable
across Memry renames/moves, external renames (hash match), and sync. Unaffected.
A true delete+recreate orphans the folder — same consequence as today when a
user strips frontmatter; accepted.

### 6. parseNote — in-memory defaults, never written back

`parseNote(rawContent, filePath?, stats?)` keeps generating defaults **in
memory only**: id only when the caller has no sidecar row (callers that know the
id from cache use it), title from the filename, `created`/`modified` from
`stats` when provided, else `now`. Drop `wasModified` and the unused
`ensureFrontmatter`. `serializeNote` stops bumping `modified`, serializes only
user keys, and returns bare content when no keys remain (explicit guard — do not
rely on gray-matter's empty-object behavior).

## Implementation plan

1. `apps/desktop/src/main/vault/frontmatter.ts` — make `NoteFrontmatter` an
   all-optional user-property record; `parseNote` per §6; `extractTitleFromPath`
   → verbatim basename; `serializeNote` per §6; delete `createFrontmatter` and
   `ensureFrontmatter`; shrink `RESERVED_FRONTMATTER_KEYS` to `tags`/`aliases`.
2. `apps/desktop/src/main/vault/note-sync.ts` — `NoteSyncInput` gains explicit
   `title`, `createdAt`, `modifiedAt`, `localOnly`, `emoji`; stop reading them
   off `frontmatter`. Update all `syncNoteToCache` callers mechanically.
3. `apps/desktop/src/main/vault/notes-crud.ts` — `createNote` writes user keys
   only; `getNoteById` returns title/dates from the cache row; delete the
   duplicate-id repair and `findDuplicateId`
   (`database/queries/notes/note-crud.ts:81`).
4. `apps/desktop/src/main/vault/notes-rename.ts` — markdown rename/move →
   `fs.rename` + DB updates only; no `serializeNote`.
5. `apps/desktop/src/main/vault/rename-tracker.ts` + `watcher.ts` — hash-keyed
   pending deletes (FIFO on collision); `handleMarkdownFileAdd` matches by hash,
   uses fs stats for dates, generates ids for unmatched adds, and loses the
   copy-rewrite branch (`watcher.ts:372-381`). No watcher path writes files.
6. `apps/desktop/src/main/sync/item-handlers/note-handler.ts` — clean incoming
   create; rewrite file only on tag/property change; drop `title`/`emoji`
   frontmatter writes. Grep remaining `frontmatter.emoji`/`frontmatter.localOnly`
   writers (settings `setLocalOnly` path, `crdt-writeback.ts`) and route them to
   the DBs.
7. `packages/app-core/src/markdown.ts` + `notes.ts`/`templates.ts`/
   `folder-view.ts` — `writeMarkdownNote` empty-frontmatter guard; callers pass
   user keys only; `NoteRecord` dates from the metadata repository.
8. `packages/contracts/src/notes-api.ts`, `packages/rpc/src/notes.ts` — relax
   `NoteFrontmatter`; run `pnpm ipc:generate`.
9. `apps/desktop/scripts/seed-data`/`seed-vault.ts` — seed files emit clean
   markdown (no Memry keys).
10. Tests (see Verification), then full gates.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test:desktop
pnpm ipc:generate && pnpm ipc:check
```

- `frontmatter.test.ts` (update) — no key injection; no modified bump; empty
  frontmatter serializes to bare content; parseNote in-memory defaults with
  stats; verbatim title.
- `rename-tracker.test.ts` (update) — hash-keyed match, FIFO collision, window
  expiry → real delete.
- `watcher.test.ts` (update/new) — frontmatter-less external add gets id +
  fs-stat dates with **zero file writes**; external rename keeps the internal id.
- `note-handler.test.ts` (update) — incoming create writes a clean file; push
  payload built without a file id.
- New: `notes-crud` create/rename round-trip asserting the on-disk file contains
  no Memry keys and rename leaves bytes identical.

## Interactions

- `04-byte-preservation.md` — this spec removes the _reasons_ to rewrite files
  (modified-bump, title rewrite, id repair); 04 makes remaining writes splice
  the frontmatter block verbatim (until then, `crdt-writeback.ts` writebacks
  still round-trip user frontmatter through gray-matter). Execute 01 → 04.
- `05-properties-top-level.md` — property _emit style_ (top-level keys, Obsidian
  formatting) is out of scope here; steps 3/6 keep the current nested
  `properties:` writer and 05 replaces it.
- `07-filename-sanitization.md` — title→filename mapping tightens there; this
  spec only fixes filename→title (verbatim basename).

## Open questions

- Hash-collision policy: FIFO-oldest on identical-content simultaneous renames
  is proposed — fine, or should ties also compare directory proximity?
- `localOnly` becomes invisible to external tools (sidecar-only). Acceptable for
  a Memry-internal privacy flag, or does it need a vault-visible marker later?
- Should Memry eventually _read_ a user's own `created:` property as display
  metadata (common Obsidian convention)? Deferred; not needed for the diet.
