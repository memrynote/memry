# Frontmatter-diet / top-level-properties — code review findings

**Branch:** `obs-properties-top-level` (stacked on frontmatter-diet `5d9ca040`)
**Date:** 2026-07-07
**Review:** xhigh workflow (6 finders → 29 candidates → 23 verifiers → 15 distinct defects; 2 refuted, 3 cleanup dropped under cap)
**Status:** documented, not yet fixed

## Root cause cluster

Frontmatter-diet stopped writing Memry-managed keys to vault files, but the **index-rebuild** and **open-by-path** paths still don't re-source that state from `note_metadata` / sidecar. Findings 1, 2, 5, 6 are all this one gap.

---

## Critical — data loss / privacy / crash

### 1. `apps/desktop/src/main/vault/indexer.ts:177` — index rebuild uploads device-only notes `CONFIRMED`

`indexMarkdownFile` adopts only `id` from `note_metadata`, discards `emoji`/`localOnly`. On rebuild, `saveCanonicalNote` upserts `emoji=null`, `syncPolicy=SYNC`. Every local-only note flips to SYNC → content starts uploading to the server against explicit device-only intent, and every emoji vanishes. Rebuild is a path this branch explicitly supports.

- Also at: `indexer.ts:186`

### 2. `apps/desktop/src/main/vault/notes-crud.ts:407` — open-by-path crashes after rebuild `CONFIRMED`

`getNoteByPath` cache miss mints a fresh `parsed.id`, then upserts with conflict target = `id` for a path that already exists. `note_metadata.path` is `NOT NULL UNIQUE` → `SQLITE_CONSTRAINT_UNIQUE`, note fails to open. Same missing-id-adoption bug as #1.

### 3. `apps/desktop/src/main/vault/rename-tracker.ts:164` / `watcher.ts:351` — identity swap on identical content `CONFIRMED`

`pendingDeletes` now keyed by content hash with FIFO collision resolution, not UUID. Two empty notes: delete one + rename the other within 500ms → renamed file adopts the deleted note's id/history; the note actually renamed is processed as a real delete. Silent loss of version history, task links, reminders.

### 4. `apps/desktop/src/main/vault/notes-crud.ts:506` — save drops unrepresented frontmatter keys `PLAUSIBLE`

`updateNote` builds `applyPropertiesToFrontmatter(merged, newProperties)`, which keeps only non-reserved keys present in `newProperties`. A custom top-level key the property panel doesn't round-trip is silently deleted on the next edit. Old code spread `existing.frontmatter` and preserved it.

---

## High — wrong timestamps / content mutation

### 5. `apps/desktop/src/main/vault/indexer.ts:186` / `frontmatter.ts:95` — created dates overwritten with fs birthtime `CONFIRMED`

On full rebuild every note's `created` is set to filesystem birthtime — restore-time for backup/git/sync-restored vaults, or ctime/1970 where birthtime is unsupported. Discards authored `created` still present in file frontmatter. `?? now` never fires (birthtime is always a Date getter).

### 6. `apps/desktop/src/main/vault/journal.ts:252` — journal timestamps always "now" on read `CONFIRMED`

`parseJournalEntry` takes no fs stats, returns `created/modified = new Date()` unconditionally. Every `journal:getEntry` reports the entry as created/modified now; `writeJournalEntryWithContent` then writes `now` back.

### 7. `apps/desktop/src/main/vault/frontmatter-emit.ts:79` — trailing-whitespace strip mutates block scalars `CONFIRMED`

`.replace(/[ \t]+$/gm,'')` (the `m` flag) strips significant trailing spaces from interior lines of a multi-line `|-` literal value, not just the empty-null trailing space it targets. Property never round-trips.

---

## Medium — ghost diffs / serializer divergence (defeats the branch's stated goal)

### 8. `apps/desktop/src/main/vault/frontmatter.ts:130` — numeric property names reorder `CONFIRMED`

`Object.entries` enumerates integer-like keys first ascending, before `emitFrontmatterBlock` runs. A property like `2024: goals` gets hoisted to the top of the YAML on every edit — the ghost reorder diff the feature promises to avoid. Per-key dump only fixed js-yaml's hoisting, not this. Same pattern in `applyPropertiesToFrontmatter` and app-core `markdown.ts`.

### 9. `packages/app-core/src/markdown.ts:51` — CLI emitter diverges from desktop `CONFIRMED`

`writeMarkdownNote` claims to mirror `emitFrontmatterBlock` but skips both the trailing-space strip and `normalizeValue`. CLI writes `empty: ` (trailing space) vs desktop `empty:`; Date values get a YAML 1.1 tag instead of `YYYY-MM-DD`. Byte-different round-trip → sync churn.

- Also at: `markdown.ts:31`, `markdown.ts:44`

### 10. `packages/app-core/src/notes.ts:501` — CLI journals omit `date:` `CONFIRMED`

`upsertJournal` writes empty frontmatter; app-core reserved set is `{tags,aliases}` not the journal `{date,tags}`. CLI journal has no `date:`; desktop re-adds it (churn) and thereafter app-core surfaces `date` as a user-editable custom property.

### 11. `apps/desktop/scripts/seed-vault/file-writer.ts:23` — seed still uses `matter.stringify` `CONFIRMED`

Seeded frontmatter is YAML 1.1 (`date: '2026-07-05'`); first save re-emits via `emitFrontmatterBlock` (`date: 2026-07-05`) → immediate byte diff + watcher event on untouched files. The one write path this diff didn't migrate.

---

## Lower confidence / likely-intended

### 12. `apps/desktop/src/main/sync/crdt-writeback.ts:367` — duplicate daily note during rebuild `PLAUSIBLE`

Writeback fires while cache empty but file exists on disk → `rowAtPath?.id !== noteId` true → `handleJournalCollision` writes `YYYY-MM-DD-<shortid>.md` instead of merging into the existing entry.

### 13. `packages/app-core/src/note-files.ts:359` — CLI import mints fresh id + mtime created `PLAUSIBLE`

`indexImportedMarkdown` dropped the frontmatter-id reuse guard (`id = createId('note')` always) and sources `createdAt` from `stats.mtime`. Re-importing the same vault duplicates note identities and discards authored `created`.

### 14. `apps/desktop/src/main/vault/frontmatter.ts:270` — legacy Memry keys surface as user properties `CONFIRMED but likely intended`

`RESERVED_FRONTMATTER_KEYS` shrank to `{tags,aliases}`. Pre-diet notes show `id/title/created/modified/emoji/localOnly` as editable properties in the Properties UI, and `updateNote` re-writes them to the file. Verifier flags this may be the commit's designed behavior — **confirm intent** before treating as a bug.

### 15. `apps/desktop/src/main/vault/frontmatter-emit.ts:55` — local-midnight Date day-shift `PLAUSIBLE, low reach`

`normalizeValue` treats only exact `T00:00:00.000Z` as date-only. `new Date(2026,6,5)` in UTC+2 → `toISOString()` `2026-07-04T22:00:00.000Z` → emits `2026-07-04T22:00:00` (day earlier + bogus time). Only triggers if a caller passes a raw Date into properties; `parseNote` (CORE_SCHEMA) never does.

---

## Refuted (not defects)

- `notes-crud.ts:407` duplicate candidate — folded into #2.
- `frontmatter.ts:108` — `extractTitleFromPath` returning verbatim basename is intentional, documented design.

## Fix direction

- **#1, #2, #5** collapse into one change: adopt the full `note_metadata` row (not just `id`) in the rebuild / open-by-path paths.
- **#3, #4, #6, #7** are independent data/timestamp corruption fixes.
- **#8–#11** are serializer-parity fixes (share the `emitFrontmatterBlock` logic to app-core / seed instead of duplicating).
- **#14** — confirm intent first.
