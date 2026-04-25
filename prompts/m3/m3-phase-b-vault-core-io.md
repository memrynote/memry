# M3 Phase B — Vault Core IO (fs.rs + frontmatter.rs + notes_io.rs, full TDD)

Temiz session prompt. **Bu phase TAM TDD** — her modül RED-GREEN-REFACTOR. 23 test toplam.

---

## PROMPT START

You are implementing **Phase B of Milestone M3** for Memry's Electron→Tauri migration. This phase fleshes out the three core IO modules of the vault layer: atomic filesystem ops + SHA-256 hash, YAML frontmatter parse/serialize with Turkish + multiline-YAML round-trip, and high-level note IO with content-hash skip.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3`
**Branch:** `m3/vault-fs-and-watcher`
**Plan:** `docs/superpowers/plans/2026-04-26-m3-vault-fs-and-watcher.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` (§4 M3, §5 cross-cutting)
**Prompts README:** `prompts/m3/README.md`

Phase A landed deps + `AppError` extensions + `vault/` module skeleton + `paths.rs` (9 tests). Phase B implements the three modules that build on `paths.rs`: `fs.rs`, `frontmatter.rs`, `notes_io.rs`.

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git rev-parse --abbrev-ref HEAD                        # expect: m3/vault-fs-and-watcher

# Phase A complete
test -f apps/desktop-tauri/src-tauri/src/vault/paths.rs
test -f apps/desktop-tauri/src-tauri/tests/vault_paths_test.rs
grep -q 'Vault(String)' apps/desktop-tauri/src-tauri/src/error.rs
grep -q 'PathEscape(String)' apps/desktop-tauri/src-tauri/src/error.rs
grep -q 'Io(String)' apps/desktop-tauri/src-tauri/src/error.rs
grep -q '^notify' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q '^serde_yaml_ng' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q '^sha2' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q '^dunce' apps/desktop-tauri/src-tauri/Cargo.toml

# All Phase A + M2 tests still green
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3
# expect: ~37 passed, 0 failed (28 M2 carry-over + 9 paths_test)

# Phase A commits present
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git log --oneline | grep -cE 'm3\((deps|vault)\)'
# expect: ≥ 3 (1 deps + 2 vault commits)
```

If any fails, STOP. Phase A must complete before Phase B starts.

### Your scope

Execute **Tasks 4, 5, 6** from the plan in this order. Each is a full RED-GREEN cycle.

- **Task 4 — `vault/fs.rs`** (atomic write + safe read + list + content_hash):
  - Add `nanoid = "0.4"` to `[dependencies]` (used by `atomic_write` for temp-file suffix).
  - Write 9 failing tests in `tests/vault_fs_test.rs`:
    - `atomic_write_creates_file`, `atomic_write_replaces_existing_file`, `atomic_write_creates_parent_dirs`, `atomic_write_cleans_up_temp_on_failure` (rename-fails-leaves-no-temp), `safe_read_returns_none_for_missing`, `safe_read_returns_content_for_existing`, `list_supported_files_skips_hidden_and_unsupported`, `content_hash_is_stable_for_same_content`, `content_hash_differs_for_different_content`.
  - Register `[[test]] name = "vault_fs_test" required-features = ["test-helpers"]`.
  - Implement `fs.rs` per plan Step 4.4: `atomic_write` (temp-then-rename + cleanup on fail), `safe_read` (`Ok(None)` for missing), `read_required`, `delete_file`, `list_supported_files` (DFS, skip dotfiles + `.memry/` + symlinks + unsupported extensions), `content_hash` (SHA-256 hex 64 chars), `is_supported_attachment`.

- **Task 5 — `vault/frontmatter.rs`** (parse / serialize / property extraction):
  - Write 9 failing tests in `tests/vault_frontmatter_test.rs`:
    - `parses_minimal_frontmatter`, `auto_generates_missing_required_fields`, `extracts_title_from_filename_when_missing`, `turkish_chars_roundtrip_byte_identical`, `multiline_yaml_string_roundtrip`, `date_field_preserved_as_string`, `tags_normalized_to_vec_strings`, `preserves_non_reserved_properties_through_roundtrip`, `extract_properties_skips_reserved_keys`.
  - Register `[[test]] name = "vault_frontmatter_test" required-features = ["test-helpers"]`.
  - Implement `frontmatter.rs` per plan Step 5.4: `NoteFrontmatter` struct (id/title/created/modified/tags/aliases/emoji/local_only/properties + `#[serde(flatten)] extra`), `ParsedNote` struct, `parse_note(raw, file_path)`, `serialize_note(fm, content)`, `create_frontmatter(title, tags)`, `extract_properties` method, `RESERVED_KEYS` const = `["id","title","created","modified","tags","aliases","emoji","localOnly","properties"]`.

- **Task 6 — `vault/notes_io.rs`** (high-level read/write):
  - Write 5 failing tests in `tests/vault_notes_io_test.rs`:
    - `write_then_read_roundtrip`, `read_returns_none_for_missing_path`, `read_auto_repairs_missing_frontmatter_and_writes_back`, `write_skips_no_op_when_hash_matches`, `read_rejects_path_traversal`.
  - Register `[[test]] name = "vault_notes_io_test" required-features = ["test-helpers"]`.
  - Implement `notes_io.rs` per plan Step 6.4: `NoteOnDisk` struct (relative_path/content_hash), `ReadNoteResult` struct (parsed/abs_path/content_hash), `read_note_from_disk(vault_root, rel)`, `write_note_to_disk(vault_root, rel, fm, content)`, `delete_note_from_disk(vault_root, rel)`. Auto-repair logic: if `parsed.was_modified`, write the canonical form back to disk. No-op skip: compute hash of new content, compare to disk hash; if equal, skip the rename.

### Methodology — TDD mandatory for all 3 tasks

1. **Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`** first.
2. **Three full RED-GREEN cycles. One commit per task.**
3. For each task:
   - Step X.1: write the test file verbatim from the plan (lines listed below).
   - Step X.2: register the `[[test]]` block in `Cargo.toml`.
   - Step X.3: run `cargo test --features test-helpers --test <name>` → must FAIL with "unresolved import" / "no function named ...". Confirm RED.
   - Step X.4: implement the module per plan verbatim.
   - Step X.5 (Task 4 only): add the `nanoid` dep — do this BEFORE `cargo check` post-impl, otherwise the macro fails to resolve.
   - Step X.6: re-run test → all PASS.
   - Step X.7: `cargo test --features test-helpers` (no `--test` filter) → no regression in carry-over.
   - Step X.8: commit per plan verbatim message.

**Test source line ranges in plan (read them VERBATIM, do not paraphrase):**
- Task 4 test file: plan lines ~609–716
- Task 4 impl file: plan lines ~738–900
- Task 5 test file: plan lines ~941–1032
- Task 5 impl file: plan lines ~1054–1300+ (continues into Task 5 detail block)
- Task 6 test file: plan lines ~1452–1539
- Task 6 impl file: plan lines ~1550–1690 (read continues from line 1690 of plan)

### Critical gotchas

1. **`nanoid` dep order:** `atomic_write` uses `nanoid::nanoid!(12)` at compile time. Add `nanoid = "0.4"` to `Cargo.toml` BEFORE running `cargo check` on the new `fs.rs` — otherwise you'll see `error[E0433]: failed to resolve: use of undeclared crate`. Plan Step 4.5 covers this; don't skip.
2. **Atomic write cleanup branch is critical:** Plan Step 4.4's `atomic_write` uses an `async` block + `match` — if `Err`, unconditionally `let _ = fs::remove_file(&temp_path).await;` then return the error. The test `atomic_write_cleans_up_temp_on_failure` proves no `.tmp.<hex>` files leak when the rename fails (target is a directory). Do not factor this into a `?`-chain — the cleanup must run on the failure branch regardless of which step failed.
3. **`safe_read` distinguishes NotFound from other IO errors:** `Ok(None)` for `ErrorKind::NotFound`, else `Err(AppError::Io(...))` via `From<std::io::Error>` (Phase A remapped this to `Io`, not `Internal`). Plan Step 4.4 handles this in 3 branches; reproduce exactly.
4. **`list_supported_files` must skip symlinks:** Even though `paths::resolve_in_vault` rejects symlink targets, the *list walk* skips symlinks entirely so a symlink loop can't DOS the scan. Use `metadata.file_type().is_symlink()` BEFORE recursing or pushing to output. Plan Step 4.4 guards this; the tests don't exercise it directly but the watcher Phase D depends on the contract.
5. **`list_supported_files` extension check:** The plan calls `paths::resolve_supported(&canonical_root, &format!("dummy.{lower_ext}"))` to validate the extension. This is a hack — it builds a fake path just to reuse the allowlist. Do NOT replace with a separate const; the test relies on `resolve_supported`'s allowlist behavior matching `list_supported_files`. The fallback `paths::is_markdown(&path) || is_supported_attachment(&lower_ext)` covers edge cases.
6. **`serialize_note` bumps `modified`:** Plan Step 5.4 explicitly sets `modified: current_iso()` in `serialize_note`. The `turkish_chars_roundtrip_byte_identical` test compares parsed-after-write content but NOT byte-for-byte — title and body must match, but `modified` will differ from input. Do not skip this bump.
7. **`extra` field with `#[serde(flatten)]`:** This is what catches non-reserved frontmatter keys like `status: active` and `priority: 3`. The serializer iterates `out.extra` and writes any keys not already in the reserved set. Plan Step 5.4 emits these AFTER the reserved keys; preserve order.
8. **`RESERVED_KEYS` casing:** Use `"localOnly"` not `"local_only"`. The struct field is `local_only` with `#[serde(rename_all = "camelCase")]` so YAML serializes as `localOnly`. The `RESERVED_KEYS` array must match the serialized casing.
9. **`extract_title_from_path` titlecase:** `extract_title_from_path("notes/my-cool-thought.md")` returns `"My Cool Thought"` — split on `-`/`_`, capitalize first letter of each word. Test `extracts_title_from_filename_when_missing` verifies this.
10. **`create_frontmatter` test stability:** Tests fix `fm.id = "fixed-id-1"` after `create_frontmatter` returns. Don't make `id` non-public — keep it as `pub id: String`. The test sets it directly.
11. **`write_skips_no_op_when_hash_matches`:** Compute SHA-256 of the about-to-write serialized content. If it matches the on-disk hash (read-then-hash), return the existing `NoteOnDisk` without rewriting. The test asserts `first.content_hash == second.content_hash`. Plan Step 6.4 handles this; read carefully and replicate.
12. **`read_auto_repairs_missing_frontmatter_and_writes_back`:** When `parsed.was_modified`, `read_note_from_disk` writes the canonical form back so the next read is stable. The test reads a plain `"no fm here\n"` file and asserts the on-disk file now starts with `"---\n"`. The `parsed.was_modified` check after `parse_note` is the trigger.
13. **`read_rejects_path_traversal`:** Calls `read_note_from_disk(vault.path(), "../escape.md")`. `paths::resolve_in_vault` errors with `PathEscape`. The error must propagate verbatim — don't wrap it in `Vault` or `Validation`.
14. **`tokio::test` flavor:** Phase B's tests don't need `multi_thread`; default `tokio::test` is fine. (Phase D's watcher tests require `multi_thread`.)
15. **`Cargo.toml` `[[test]]` ordering:** Add new `[[test]]` blocks AT THE END of the file (not interleaved). Phase A added `vault_paths_test`; Phase B appends `vault_fs_test`, `vault_frontmatter_test`, `vault_notes_io_test` in that order.

### Constraints

- **No scope creep:** Do not implement `preferences.rs`, `registry.rs`, `state.rs`, `watcher.rs`, or any command in Phase B. Stubs untouched. Phase C-E handle them.
- **No additional crates beyond Phase A allow-list + `nanoid`:** No `chrono`, no `time`, no `regex`. The plan uses `chrono::Utc::now()` for `current_iso()` — `chrono` was already in M2 deps via `tauri-plugin-window-state` transitive or similar; verify with `cargo tree | grep chrono`. If not present, the plan's `current_iso()` helper falls back to `std::time::SystemTime` formatting. Do not add `chrono` as a direct dep just for this — use `std::time::SystemTime` + manual ISO format.
- **`extract_properties` returns owned `BTreeMap`:** Tests call `parsed.frontmatter.extract_properties()` and inspect keys. Make it `pub fn extract_properties(&self) -> BTreeMap<String, Value>`. Don't return `&BTreeMap` — the test mutates the result (`contains_key`).
- **No `unwrap()` in production paths:** All `parse_note`/`serialize_note`/`read_note_from_disk`/`write_note_to_disk` paths return `AppResult`. Test code may use `unwrap()` freely.
- **Rust style:** `cargo clippy -- -D warnings` clean at each task boundary. Format with `cargo fmt`.

### Acceptance criteria (Phase B done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3

# Files exist
test -f apps/desktop-tauri/src-tauri/src/vault/fs.rs
test -f apps/desktop-tauri/src-tauri/src/vault/frontmatter.rs
test -f apps/desktop-tauri/src-tauri/src/vault/notes_io.rs
test -f apps/desktop-tauri/src-tauri/tests/vault_fs_test.rs
test -f apps/desktop-tauri/src-tauri/tests/vault_frontmatter_test.rs
test -f apps/desktop-tauri/src-tauri/tests/vault_notes_io_test.rs

# Files have content (not just stubs)
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/vault/fs.rs)" -gt 100 ]
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/vault/frontmatter.rs)" -gt 150 ]
[ "$(wc -l < apps/desktop-tauri/src-tauri/src/vault/notes_io.rs)" -gt 50 ]

# `nanoid` dep present
grep -q '^nanoid' apps/desktop-tauri/src-tauri/Cargo.toml

# Tests registered
grep -q 'name = "vault_fs_test"' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q 'name = "vault_frontmatter_test"' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q 'name = "vault_notes_io_test"' apps/desktop-tauri/src-tauri/Cargo.toml

# Each test file passes
cd apps/desktop-tauri/src-tauri
cargo test --features test-helpers --test vault_fs_test 2>&1 | tail -3          # 9 passed
cargo test --features test-helpers --test vault_frontmatter_test 2>&1 | tail -3 # 9 passed
cargo test --features test-helpers --test vault_notes_io_test 2>&1 | tail -3    # 5 passed

# Full carry-over
cargo test --features test-helpers 2>&1 | tail -3
# expect: ~60 passed (28 M2 + 9 paths + 9 fs + 9 frontmatter + 5 notes_io)

# Rust hygiene
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy

# Commits
git log --oneline | grep -cE 'm3\(vault\)'   # expect ≥ 5 (Phase A 2 + Phase B 3)

# Electron / packages / specs / plans untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ docs/superpowers/specs/ docs/superpowers/plans/ | wc -l
# expect 0
```

### When done

Report to user:

```
Phase B complete.
Tasks covered: 4, 5, 6
Commits: 3 (<first_hash>..<last_hash>)
Rust tests: 23 new (9 fs + 9 frontmatter + 5 notes_io) + 9 paths + 28 M2 = ~60 passed
Verification:
  - cargo check: clean
  - cargo clippy -- -D warnings: clean
  - cargo test --features test-helpers: ~60 passed, 0 failed
  - Electron/packages/specs/plans untouched: 0 files

Next: Phase C — prompts/m3/m3-phase-c-preferences-registry.md
Blockers: <none | list>
```

If blocker:
- Frontmatter Turkish round-trip fail → check the `serde_yaml_ng::to_string` writes UTF-8 bytes (it does by default). Inspect the serialized output with `println!`. Likely culprit: missing `Value::String` wrapping for non-ASCII titles.
- Atomic-write temp leak test fail → cleanup branch missed an error path. Re-read plan Step 4.4 — the `match write_then_rename.await` block must `let _ = fs::remove_file(&temp_path).await;` before returning the error.
- `notes_io::write_skips_no_op_when_hash_matches` fail → hash comparison happened post-write instead of pre-write. The skip must short-circuit BEFORE the rename, otherwise the test hash equality is trivially true.

If still blocked: invoke `superpowers:systematic-debugging`. Report + wait for approval.

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 4, 5, 6 fully (lines ~600–1697 of the plan file).
3. Run prerequisite verification. Report results.
4. Task 4 RED-GREEN: nanoid dep → failing fs_test → impl fs.rs → 9 passed → commit `m3(vault): fs.rs atomic_write + safe_read + list + sha256 content_hash`.
5. Task 5 RED-GREEN: failing frontmatter_test → impl frontmatter.rs → 9 passed → commit `m3(vault): frontmatter.rs serde_yaml_ng parse/serialize + Turkish/multiline/date round-trip`.
6. Task 6 RED-GREEN: failing notes_io_test → impl notes_io.rs → 5 passed → commit `m3(vault): notes_io.rs read/write/delete with content-hash skip + auto-repair`.

## PROMPT END
