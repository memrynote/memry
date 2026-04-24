# M2 Phase D — Calendar + User Collections Structs

Temiz session prompt. 9 tablo için struct + smoke test. Aynı mekanik pattern, Phase C'nin devamı.

---

## PROMPT START

You are implementing **Phase D of Milestone M2** for Memry's Electron→Tauri migration. Phase C added core domain structs (projects/statuses/tasks + note metadata). Phase D adds 9 more: calendar (4 tables) + user collections (inbox, bookmarks, reminders, tag_definitions, folder_configs).

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2`
**Branch:** `m2/db-schemas-migrations`
**Plan:** `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Prompts README:** `prompts/m2/README.md`

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Phase C complete — 6 structs + migrations all green
test -f apps/desktop-tauri/src-tauri/src/db/projects.rs
test -f apps/desktop-tauri/src-tauri/src/db/tasks.rs
test -f apps/desktop-tauri/src-tauri/src/db/notes_cache.rs
test -f apps/desktop-tauri/src-tauri/src/db/note_metadata.rs
test -f apps/desktop-tauri/src-tauri/src/db/note_positions.rs
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -5
# Expect: all passing
```

If any fails, STOP.

### Your scope

Execute **Tasks 10, 11** from the plan:

- **Task 10:** Calendar — `db/calendar_events.rs` (`CalendarEvent`), `db/calendar_sources.rs` (`CalendarSource`), `db/calendar_external_events.rs` (`CalendarExternalEvent`), `db/calendar_bindings.rs` (`CalendarBinding`). Each with smoke test.
- **Task 11:** User collections — `db/inbox.rs` (`InboxItem`), `db/bookmarks.rs` (`Bookmark`), `db/reminders.rs` (`Reminder`), `db/tag_definitions.rs` (`TagDefinition`), `db/folder_configs.rs` (`FolderConfig`). Each with smoke test.

### Canonical struct names (Phase F generator depends on these)

| Module | Struct | Primary migration | Later ALTER migrations |
|--------|--------|-------------------|------------------------|
| `db/calendar_events.rs` | `CalendarEvent` | `0024_google_calendar_foundation.sql` | `0025_event_target_calendar.sql`, `0026_calendar_field_clocks.sql`, `0027_calendar_rich_fields.sql` |
| `db/calendar_sources.rs` | `CalendarSource` | `0024_google_calendar_foundation.sql` | `0028_calendar_source_last_error.sql` |
| `db/calendar_external_events.rs` | `CalendarExternalEvent` | `0024_google_calendar_foundation.sql` | `0027_calendar_rich_fields.sql` |
| `db/calendar_bindings.rs` | `CalendarBinding` | `0024_google_calendar_foundation.sql` | — |
| `db/inbox.rs` | `InboxItem` | `0000_thankful_luke_cage.sql` | `0002_broken_sleeper.sql`, `0005_old_mac_gargan.sql`, `0011_silent_shooting_star.sql`, `0018_greedy_stepford_cuckoos.sql`, `0019_material_lethal_legion.sql` |
| `db/bookmarks.rs` | `Bookmark` | `0001_married_shadow_king.sql` | `0018_greedy_stepford_cuckoos.sql` |
| `db/reminders.rs` | `Reminder` | `0004_odd_silver_sable.sql` | `0018_greedy_stepford_cuckoos.sql` |
| `db/tag_definitions.rs` | `TagDefinition` | `0007_safe_sunspot.sql` | `0016_lovely_mastermind.sql`, `0018_greedy_stepford_cuckoos.sql` |
| `db/folder_configs.rs` | `FolderConfig` | `0023_folder_configs.sql` | — |

**Do not deviate from these struct names.** Phase F's Task 14 generator references them literally.

(Filename references use Electron source numbering after Phase B's one-to-one port. If Phase B normalized any filename stems, cat the actual files in `apps/desktop-tauri/src-tauri/migrations/` first and use current filenames with the same source numbers.)

### Methodology — verification-before-completion per struct

1. **Invoke `superpowers:using-superpowers` and `superpowers:verification-before-completion`** first.
2. **Per-struct workflow (identical to Phase C):**
   - Cat all listed migration files for the struct (primary + ALTERs) to enumerate the **final** column set.
   - Optionally cross-reference `packages/db-schema/src/schema/<table>.ts`.
   - Write struct with derives + field mapping + `from_row`:
     - `#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]`
     - `#[serde(rename_all = "camelCase")]`
     - Fields in CREATE TABLE column order.
     - Type mapping: `TEXT NOT NULL → String`, `TEXT → Option<String>`, `INTEGER NOT NULL → i64`, `INTEGER → Option<i64>`, boolean `INTEGER → bool`.
     - `impl`: `pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self>` with one `row.get("col")?` per field.
   - Add `pub mod <table>;` export to `db/mod.rs` (keep alphabetical ordering).
   - Add roundtrip smoke test to `tests/migrations_test.rs` — insert minimal row, select, assert field.
   - `cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers` → must PASS.
   - `cargo clippy -- -D warnings` → clean.
   - Commit per batch (Task 10 = 1 commit, Task 11 = 1 commit; optionally split Task 10 calendar + Task 11 collections as finer if debugging).

### Column quirks to watch

- **`calendar_events` rich fields (from 0027):** May add `location`, `attendees` (JSON), `recurrence_rule`, etc. Treat JSON columns as `Option<String>` in M2.
- **`calendar_events.field_clocks` (from 0026):** Same JSON string treatment as tasks' field_clocks.
- **`calendar_events.target_calendar_*` (from 0025):** May add columns for sync to Google Calendar. Include in struct as nullable.
- **`calendar_sources.last_error` (from 0028):** `TEXT` nullable. Plain `Option<String>`.
- **`calendar_sources` OAuth fields (from 0024):** `provider`, `provider_account_id`, `access_token_encrypted`, `refresh_token_encrypted`, `token_expires_at` — cat the file, include all.
- **`inbox` columns:** base table starts in `0000`, then later source migrations alter it. `0019` may add `inbox_jobs` as a separate table — if so, **do not create a struct for `inbox_jobs` in Phase D**; that's an M8.7 concern (snooze scheduler). Only `inbox` proper.
- **`bookmarks` minimal schema:** cat `0001` and `0018`; expect columns like `id`, `item_type`, `item_id`, `position`, `created_at`, plus any sync metadata from later ALTERs.
- **`reminders` columns:** cat `0004` and `0018`, expect fields like `id`, `target_type`, `target_id`, `remind_at`, `completed_at`, `created_at`, possibly sync metadata.
- **`tag_definitions`:** cat `0007`, `0016`, and `0018`; confirm whether it has `color`, `icon`, `description`, `created_at` — column set varies.
- **`folder_configs`:** per-folder preferences; `folder_path`, `config` (JSON), `modified_at` likely.

### Critical gotchas

1. **ALTER TABLE ADD COLUMN default NULL:** SQLite's ALTER TABLE ADD COLUMN without a default value means existing rows have NULL for that column. Your struct must use `Option<T>` for ANY column added by ALTER, even if the base CREATE TABLE says NOT NULL. Why: the NOT NULL constraint applies only to new inserts, not backfilled rows from before the ALTER. Since in M2 we seed nothing and test inserts set all non-null fields, practically this won't bite — but the correct type is still `Option<T>`.
2. **JSON column masquerading as TEXT:** Drizzle's `text('col', { mode: 'json' })` compiles to `TEXT` in SQL. You won't see JSON hints from cat'ing the SQL. Cross-check `packages/db-schema/src/schema/*.ts` to identify JSON columns; treat them as `Option<String>` (not parsed).
3. **Turkish character roundtrip:** At least one smoke test should insert a string with Turkish diacritics (`çğıöşü` / uppercase variants) and assert it roundtrips byte-identical. Protects against encoding bugs. Not a separate test — embed in one existing smoke test.
4. **Table naming drift:** If Phase B normalized a migration filename stem because the table is named differently, the struct module name still follows the canonical table above. DB column names + table names come from the SQL, not the TS schema.
5. **`folder_configs` vs `folders`:** There is NO `folders` table in Electron (folders are filesystem dirs). `folder_configs` is only per-folder settings. Do NOT try to create a `Folder` struct in M2 (deferred to M3 when vault FS lands).

### Constraints

- Same as Phase C: no CRUD helpers beyond `from_row`, no custom `FromSql` impls, no premature generics, no new dependencies, no mutations to Electron/packages.
- **Commit granularity:** Task 10 = 1 commit (calendar batch). Task 11 = 1 commit (collections batch). If debugging requires finer grain, split into 2-3 commits per task max.

### Acceptance criteria (Phase D done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Files exist
for f in calendar_events calendar_sources calendar_external_events calendar_bindings \
         inbox bookmarks reminders tag_definitions folder_configs; do
  test -f apps/desktop-tauri/src-tauri/src/db/$f.rs || echo "MISSING: $f.rs"
done

# Module exports
grep -c '^pub mod' apps/desktop-tauri/src-tauri/src/db/mod.rs
# Expect >= 16 (1 migrations + 6 from Phase C + 9 new)

# Canonical struct names present
for pair in \
  "calendar_events:CalendarEvent" \
  "calendar_sources:CalendarSource" \
  "calendar_external_events:CalendarExternalEvent" \
  "calendar_bindings:CalendarBinding" \
  "inbox:InboxItem" \
  "bookmarks:Bookmark" \
  "reminders:Reminder" \
  "tag_definitions:TagDefinition" \
  "folder_configs:FolderConfig"; do
  file="${pair%%:*}"
  struct="${pair##*:}"
  grep -q "pub struct $struct\b" apps/desktop-tauri/src-tauri/src/db/$file.rs || echo "WRONG: $struct in $file.rs"
done

# Compile + clippy + tests
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -5
# Expect: passed count += 9 (one roundtrip per new struct)

# Commits
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
git log --oneline | grep -cE "m2\(db\)"
# expect ≥ 4 (Phase C was 2, Phase D adds 2)

# Electron untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ | wc -l
# expect 0
```

### When done

Report:

```
Phase D complete.
Tasks covered: 10, 11
Commits: <N> (<first_hash>..<last_hash>)
Structs added: CalendarEvent, CalendarSource, CalendarExternalEvent, CalendarBinding, InboxItem, Bookmark, Reminder, TagDefinition, FolderConfig (9)
Rust tests: <total passed>

Next: Phase E — prompts/m2/m2-phase-e-sync-foundation-structs.md
Blockers: <none | list>
```

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:verification-before-completion`.
2. Read plan Tasks 10, 11 fully.
3. Run prerequisite verification.
4. Task 10 calendar batch: cat `0024` + `0025` + `0026` + `0027` + `0028` migrations → write 4 structs → exports → smoke tests → commit.
5. Task 11 collections batch: cat the listed source-numbered migrations for inbox/bookmarks/reminders/tags/folder configs → write 5 structs → exports → smoke tests → commit.

## PROMPT END
