# M2 Phase E — Sync Foundation Structs

Temiz session prompt. 5 tablo (sync altyapısı + search_reasons). Phase F'nin settings IPC slice'ından önce son struct phase.

---

## PROMPT START

You are implementing **Phase E of Milestone M2** for Memry's Electron→Tauri migration. This phase defines the sync foundation structs used by M6 (sync engine). At M2 we only need the types + `from_row` — CRUD helpers come in M6.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2`
**Branch:** `m2/db-schemas-migrations`
**Plan:** `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` (§4 M2, §4 M6 for future context)
**Prompts README:** `prompts/m2/README.md`

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Phase D complete — 15 structs across Phases C+D
grep -c '^pub mod' apps/desktop-tauri/src-tauri/src/db/mod.rs
# Expect >= 16

# Migrations + all smoke tests green
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -5
# Expect all passing
```

If any fails, STOP.

### Your scope

Execute **Task 12** from the plan:

- `db/sync_queue.rs` (`SyncQueueItem`)
- `db/sync_devices.rs` (`SyncDevice`)
- `db/sync_state.rs` (`SyncState`)
- `db/sync_history.rs` (`SyncHistoryEntry`)
- `db/search_reasons.rs` (`SearchReason`)

Each with smoke roundtrip test.

### Canonical struct names (Phase F generator depends on these)

| Module | Struct | Migration |
|--------|--------|-----------|
| `db/sync_queue.rs` | `SyncQueueItem` | `0008_blushing_magma.sql`, `0009_lumpy_gladiator.sql` |
| `db/sync_devices.rs` | `SyncDevice` | `0008_blushing_magma.sql`, `0009_lumpy_gladiator.sql`, `0012_lush_veda.sql`, `0013_last_guardian.sql`, `0014_dazzling_leopardon.sql` |
| `db/sync_state.rs` | `SyncState` | `0008_blushing_magma.sql` |
| `db/sync_history.rs` | `SyncHistoryEntry` | `0008_blushing_magma.sql` |
| `db/search_reasons.rs` | `SearchReason` | `0020_search_reasons.sql` |

### Methodology — identical pattern to Phase C/D

1. **Invoke `superpowers:using-superpowers` and `superpowers:verification-before-completion`** first.
2. Per-struct:
   - Cat the migration file.
   - Cross-reference `packages/db-schema/src/schema/sync-*.ts` / `search-reasons.ts` for JSON-column clarification.
   - Write struct with standard derives + field mapping + `from_row` (see Phase C prompt for full recipe).
   - Export from `db/mod.rs`.
   - Add one roundtrip smoke test to `tests/migrations_test.rs`.
   - `cargo test --features test-helpers` → PASS.
   - `cargo clippy -- -D warnings` → clean.
3. Single commit at end: `m2(db): add sync_{queue,devices,state,history}/search_reasons structs`.

### Column specifics to anticipate

**`sync_queue` (from 0008/0009):**
- Cat the source files for truth. Expect columns like `id`, `item_type`, `item_id`, `operation` (CREATE/UPDATE/DELETE), `payload` (JSON string), `clock` (JSON), `status` (pending/processing/done/failed), `retry_count`, `next_retry_at`, `error_message`, `created_at`, `processed_at`, with possible follow-up ALTERs in `0009`.
- `payload` and `clock` are JSON strings → `Option<String>` in M2.
- `status` is a TEXT enum → `String` in M2. Domain enum (`#[repr(u8)]` with specta-compatible discriminant) is a future refactor.

**`sync_devices` (from 0008/0009/0012/0013/0014):**
- Cat all listed source files for truth. Expect `device_id`, `device_name`, `public_key`, `user_id`, `last_seen_at`, `created_at`, possibly `platform`, `app_version`, and later metadata columns.
- `public_key` may be base64-encoded `TEXT` → `String`. Raw bytes is an M4 (crypto) concern.

**`sync_state` (from 0008):**
- Likely: `key` (PK), `value` (opaque), `modified_at`. Maps vault-level sync cursors.
- Alternatively per-type cursor rows: `item_type` + `last_pulled_cursor` + `last_pushed_cursor` + `updated_at`. Cat to confirm.

**`sync_history` (from 0008):**
- Audit log: `id`, `started_at`, `ended_at`, `items_pulled`, `items_pushed`, `items_conflicted`, `error_message`, `status`. Informational only — M2 just defines the struct.

**`search_reasons` (from 0020):**
- Hand-written migration — simple structure. Likely `id`, `query`, `reason`, `created_at` (tracking why a result was surfaced). Cat to confirm.

### Critical gotchas

1. **JSON payloads in sync_queue:** Do not attempt JSON parsing into typed structs here. M6 introduces the `SyncPayload` enum and parse logic. M2 sees bytes-as-string.
2. **`sync_state` key/value pattern:** If 0016 uses a KV pattern like `settings`, the struct is similar: `key: String, value: String, modified_at: String`. If it uses row-per-item-type, the struct is wider. Cat first.
3. **Clock columns everywhere:** Expect `clock` JSON in `sync_queue`, possibly `sync_history`. Always `Option<String>` in M2.
4. **Retry exponential backoff:** `retry_count` and `next_retry_at` are data fields only; the retry policy (exponential backoff formula) lives in M6 `sync/retry.rs`. Don't inline policy here.
5. **search_reasons purpose:** Per MEMORY.md, Phase 3 review findings included T125 adding search reasons table for explaining why search results appear. It's small and often overlooked in docs. Read migration to get actual shape.

### Constraints

- Same as Phase C/D: no CRUD helpers, no custom `FromSql`, no premature generics.
- **No trait definitions.** The `SyncItemHandler` trait mentioned in spec §M6 is defined in M6's handlers module, not M2.
- **Commit granularity:** Single commit for all 5 structs.

### Acceptance criteria (Phase E done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2

# Files exist
for f in sync_queue sync_devices sync_state sync_history search_reasons; do
  test -f apps/desktop-tauri/src-tauri/src/db/$f.rs || echo "MISSING: $f.rs"
done

# Canonical struct names
for pair in \
  "sync_queue:SyncQueueItem" \
  "sync_devices:SyncDevice" \
  "sync_state:SyncState" \
  "sync_history:SyncHistoryEntry" \
  "search_reasons:SearchReason"; do
  file="${pair%%:*}"
  struct="${pair##*:}"
  grep -q "pub struct $struct\b" apps/desktop-tauri/src-tauri/src/db/$file.rs || echo "WRONG: $struct in $file.rs"
done

# Module exports
grep -c '^pub mod' apps/desktop-tauri/src-tauri/src/db/mod.rs
# Expect >= 21 (migrations + 6 Phase C + 9 Phase D + 5 Phase E)

# Compile + clippy + tests
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -5
# Expect: passed count += 5 vs Phase D end

# Commits
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m2
git log --oneline | grep -cE "m2\(db\)"
# expect ≥ 5 (2 Phase C + 2 Phase D + 1 Phase E)

# Electron untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ | wc -l
# expect 0
```

### When done

Report:

```
Phase E complete.
Tasks covered: 12
Commits: <N> (<first_hash>..<last_hash>)
Structs added: SyncQueueItem, SyncDevice, SyncState, SyncHistoryEntry, SearchReason (5)
Rust tests: <total passed>

Phase-so-far summary:
- Phase C structs: 6 (Project, Status, Task, PropertyDefinition, NoteMetadata, NotePosition)
- Phase D structs: 9 (4 calendar + 5 collections)
- Phase E structs: 5 (sync + search_reasons)
- Running total: 20 structs, canonical names ready for Phase F bindings

Next: Phase F — prompts/m2/m2-phase-f-settings-ipc-slice.md
Blockers: <none | list>
```

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:verification-before-completion`.
2. Read plan Task 12 fully.
3. Run prerequisite verification.
4. Cat 5 migration files. For each: cat → struct → export → smoke test. Single commit at end.

## PROMPT END
