# M3 Phase A — Foundation (Deps + AppError + Module Skeleton + Paths, TDD)

Temiz session prompt. **Bu phase Task 3 için TDD gerektirir** — `paths.rs` baştan sona RED-GREEN.

---

## PROMPT START

You are implementing **Phase A of Milestone M3** for Memry's Electron→Tauri migration. This phase lands the vault FS foundation: new Cargo deps, extended `AppError` variants for filesystem context, the `vault/` module skeleton (8 stubbed submodules), and the first real implementation — `vault/paths.rs` with canonicalize + escape guard.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3`
**Branch:** `m3/vault-fs-and-watcher` (must already exist — see README worktree setup)
**Parent spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` (M3 section §4, cross-cutting §5)
**Implementation plan:** `docs/superpowers/plans/2026-04-26-m3-vault-fs-and-watcher.md`
**Prompts README:** `prompts/m3/README.md`

Memry: desktop notes app, Electron→Tauri migration, pre-production, no backward compat. M1 landed the Tauri skeleton with mock IPC; M2 wired SQLite + the settings IPC slice. M3 lands the vault file tree — `.md` IO, YAML frontmatter, multi-vault registry, `notify` watcher, the full vault/shell/dialog command surface, and the `memry-file://` URI scheme. This phase opens the milestone with deps + `paths.rs`.

### Prerequisite verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git rev-parse --abbrev-ref HEAD                       # expect: m3/vault-fs-and-watcher
git log --oneline main | head -10                     # expect M2 commits ending with `m2(devx): add MEMRY_DEVICE=A/B dev scripts`
test -d apps/desktop-tauri/src-tauri/src
test -f apps/desktop-tauri/src-tauri/Cargo.toml
test -f apps/desktop-tauri/src-tauri/src/error.rs     # M2 created this
test -f apps/desktop-tauri/src-tauri/src/app_state.rs # M2 created this
pnpm --filter @memry/desktop-tauri cargo:check        # must exit 0 on M2 baseline
pnpm --filter @memry/desktop-tauri cargo:clippy       # must exit 0
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3 && cd -
# expect: test result ok, all M2 carry-over tests passing (~28)
pnpm --filter @memry/desktop-tauri bindings:check     # must exit 0
test -d ~/memry-test-vault-m3                          # scratch vault for later phases (created in README setup)
```

If any fails, STOP and report. Do not improvise the worktree, branch, or M2 baseline.

### Your scope

Execute **Tasks 1, 2, 3** from the plan:

- **Task 1:** Append M3 deps to `[dependencies]` in `apps/desktop-tauri/src-tauri/Cargo.toml`:
  - `notify = { version = "6.1", default-features = false, features = ["macos_fsevents"] }`
  - `serde_yaml_ng = "0.10"`
  - `mime_guess = "2.0"`
  - `sha2 = "0.10"`
  - `dunce = "1.0"`
  - `tauri-plugin-dialog = "2"`

- **Task 2:** Extend `AppError` enum + scaffold `vault/` module:
  - Add `Vault(String)`, `PathEscape(String)`, `Io(String)` variants to `AppError` in `src/error.rs`.
  - REPLACE existing `From<std::io::Error>` impl: it currently maps to `Internal`; remap to `AppError::Io` (filesystem context surfaces IO errors everywhere — vault layer needs them typed).
  - Add `From<serde_yaml_ng::Error>` → `AppError::Validation(format!("yaml: {err}"))`.
  - Add `From<notify::Error>` → `AppError::Vault(format!("watcher: {err}"))`.
  - Create `src/vault/mod.rs` with 8 `pub mod` declarations (paths, fs, frontmatter, notes_io, preferences, registry, state, watcher) + commented-out re-exports (re-enabled in Phase D Task 9).
  - Stub each submodule with a one-line comment so the tree compiles between tasks.
  - Wire `pub mod vault;` into `src/lib.rs` near the existing `pub mod` declarations.

- **Task 3:** Implement `vault/paths.rs` (canonicalize + traversal/symlink/hidden-dir guard) full TDD:
  - Write failing test file `tests/vault_paths_test.rs` with **9 tests** (rejects_dotdot_escape, rejects_absolute_outside_vault, allows_normal_relative_path, rejects_symlink_escape, rejects_hidden_dot_memry_directory, rejects_unsupported_extension, allows_supported_extensions, to_relative_path_normalizes_separators, to_relative_path_rejects_outside_vault).
  - Register `[[test]] name = "vault_paths_test" required-features = ["test-helpers"]` in `Cargo.toml`.
  - Run RED → unresolved imports.
  - Implement `paths.rs` per plan Step 3.4 (uses `dunce::canonicalize`, supports `resolve_in_vault`, `resolve_supported`, `to_relative_path`, `is_markdown`, `normalize_relative`).
  - Run GREEN → 9 passed.

### Methodology — TDD mandatory for Task 3

1. **Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`** first.
2. **Task 1 (deps):** Not TDD — `cargo check` is the verification. Add deps + run check + commit.
3. **Task 2 (errors + skeleton):** Not TDD in the RED-GREEN sense. Verify with `cargo check && cargo clippy -- -D warnings` after each substep. The stubbed submodules must compile — `cargo check` will warn about unused modules, that is OK.
4. **Task 3 (paths.rs):**
   - Plan Step 3.1 lists every test verbatim. Copy the test file as written; do NOT skip the symlink test (it uses `std::os::unix::fs::symlink` and must run on macOS).
   - Step 3.2: register the `[[test]]` block.
   - Step 3.3: RED → `cargo test --features test-helpers --test vault_paths_test` must fail with unresolved imports for `paths`, `resolve_in_vault`, `resolve_supported`, `to_relative_path`. Confirm before moving to Step 3.4.
   - Step 3.4: implement `paths.rs` per plan verbatim.
   - Step 3.5: re-run → 9 passed.
   - Step 3.6: commit per plan verbatim message: `m3(vault): paths.rs canonicalize + traversal/symlink/hidden-dir guard`.

### Critical gotchas

1. **`From<std::io::Error>` REPLACE, not ADD:** M2's `error.rs` has an `impl From<std::io::Error> for AppError` returning `Internal`. Vault FS surfaces IO errors all over — Phase A maps them to `Io`. The plan uses the word "replace" deliberately. Adding a second impl will fail to compile (duplicate `From`). Edit, don't append.
2. **Submodule stubs are required:** `cargo check` after Step 2.4 expects 8 files at `src/vault/{paths,fs,frontmatter,notes_io,preferences,registry,state,watcher}.rs` each with a comment line. If any is missing, `cargo check` errors with `error[E0583]: file not found for module`. The bash `for name in ...; do echo "//! Stubbed in Task 2; populated in later tasks." > apps/desktop-tauri/src-tauri/src/vault/$name.rs; done` loop in Step 2.4 is the canonical setup.
3. **Comment out re-exports until Phase D:** `mod.rs` declares `pub mod fs; pub mod frontmatter; ...` but the `pub use frontmatter::{NoteFrontmatter, ParsedNote}; ...` block must be commented. Phase D (Task 9) re-enables them once the types exist. Leaving them uncommented in Phase A breaks `cargo check` because the symbols don't exist yet.
4. **`dunce::canonicalize` on macOS:** macOS resolves symlinks differently — `/var` vs `/private/var`. The plan uses `dunce::canonicalize` everywhere, including for the vault root + the joined candidate path, so `starts_with` comparisons are byte-stable. Don't substitute `std::fs::canonicalize` even if it "looks fine" locally — symlink test will flake on different macOS major versions.
5. **`resolve_in_vault` must handle non-existing leaf:** `atomic_write` (Phase B) calls `resolve_in_vault` for paths that don't exist yet. The plan handles this in Step 3.4: if `joined.exists()` then canonicalize the full path, else canonicalize the parent and re-attach the leaf. This is critical for the "write a new file" path-safety case.
6. **Hidden-dir check uses `.memry`, not `.git`:** The escape guard rejects `.memry/data.db` because that is the Electron-era reserved app folder. `.git` and other generic hidden dirs are skipped at *list* time (`fs.rs::list_supported_files`, Phase B), not rejected by `resolve_in_vault`.
7. **Symlink test is unix-specific:** `tests/vault_paths_test.rs` uses `std::os::unix::fs as unix_fs;` and `unix_fs::symlink(...)`. Plan assumes macOS dev. If cargo test runs on a non-unix host the test won't compile — guard with `#[cfg(unix)]` only if tests are run cross-platform; M3 dev is macOS-only so the unconditional import is fine.
8. **`SUPPORTED_EXT` allowlist:** `md, markdown, png, jpg, jpeg, gif, webp, svg, pdf, mp3, wav, m4a, ogg, mp4, mov, webm`. Match exactly. The plan's Step 3.4 lists these; the test `allows_supported_extensions` enumerates 11 of them — ensure both lists agree.

### Constraints

- **No scope creep:** Do not implement `fs.rs`, `frontmatter.rs`, or any other vault submodule in Phase A. Stubs only. Phase B-D handle them.
- **No additional crates beyond Phase A list:** notify, serde_yaml_ng, mime_guess, sha2, dunce, tauri-plugin-dialog. `nanoid` and `anyhow` come in Phases B and F respectively. Do NOT pre-add them.
- **No new error variants beyond the 3 listed:** Vault, PathEscape, Io. Do not invent `Permission`, `Locked`, `Encoding`, etc. — Phase B's `notes_io.rs` and Phase D's `state.rs` reuse existing variants (`NotFound`, `Validation`).
- **`AppError` ordering:** Insert new variants AFTER `Validation(String)` per plan Step 2.1. Don't re-sort the enum — that would break specta-generated TS bindings ordering and force a regen with no value.
- **Rust style:** `rustfmt` before commit. `cargo clippy -- -D warnings` must be clean at Task 1, 2, 3 boundaries. The unused-module warnings after Task 2.4 are acceptable (they go away after Task 3 implements `paths.rs`).

### Acceptance criteria (Phase A done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3

# Files exist
test -f apps/desktop-tauri/src-tauri/src/vault/mod.rs
for name in paths fs frontmatter notes_io preferences registry state watcher; do
  test -f apps/desktop-tauri/src-tauri/src/vault/$name.rs || { echo "MISSING vault/$name.rs"; exit 1; }
done
test -f apps/desktop-tauri/src-tauri/tests/vault_paths_test.rs

# Deps present
grep -q '^notify' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q '^serde_yaml_ng' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q '^mime_guess' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q '^sha2' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q '^dunce' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q '^tauri-plugin-dialog' apps/desktop-tauri/src-tauri/Cargo.toml

# AppError variants
grep -q 'Vault(String)' apps/desktop-tauri/src-tauri/src/error.rs
grep -q 'PathEscape(String)' apps/desktop-tauri/src-tauri/src/error.rs
grep -q 'Io(String)' apps/desktop-tauri/src-tauri/src/error.rs
grep -q 'From<serde_yaml_ng::Error>' apps/desktop-tauri/src-tauri/src/error.rs
grep -q 'From<notify::Error>' apps/desktop-tauri/src-tauri/src/error.rs

# vault module wired
grep -q 'pub mod vault' apps/desktop-tauri/src-tauri/src/lib.rs

# Re-exports still commented (Phase D enables them)
grep -E '^//.*pub use frontmatter' apps/desktop-tauri/src-tauri/src/vault/mod.rs

# Test registered
grep -q 'name = "vault_paths_test"' apps/desktop-tauri/src-tauri/Cargo.toml

# Rust compiles + clippy clean
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy

# Tests pass — paths_test green + M2 carry-over still green
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_paths_test 2>&1 | tail -3
# Expect: test result: ok. 9 passed
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | tail -3
# Expect: total ~37 passed (9 new + ~28 carry-over). 0 failed.

# Commits
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3
git log --oneline | grep -cE 'm3\((deps|vault)\)'   # expect ≥ 3 (1 deps + 2 vault)

# Electron / packages untouched
git diff --name-only main..HEAD -- apps/desktop/ apps/sync-server/ packages/ docs/superpowers/specs/ docs/superpowers/plans/ | wc -l
# expect 0
```

### When done

Report to user:

```
Phase A complete.
Tasks covered: 1, 2, 3
Commits: <N> (<first_hash>..<last_hash>)
Rust tests: 9 new (vault_paths_test) + ~28 M2 carry-over = ~37 passed
Verification:
  - cargo check: clean
  - cargo clippy -- -D warnings: clean
  - cargo test --features test-helpers: ~37 passed, 0 failed
  - Electron/packages/specs/plans untouched: 0 files

Next: Phase B — prompts/m3/m3-phase-b-vault-core-io.md
Blockers: <none | list>
```

If blocker: do not guess. Invoke `superpowers:systematic-debugging`. Check plan §"Risk coverage" + README §"Emergency stop" trip-wires. Report + wait for approval.

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 1, 2, 3 fully (lines 110–597 of the plan file).
3. Run prerequisite verification. Report results.
4. Task 1: append deps → `cargo check` → commit `m3(deps): add notify, serde_yaml_ng, mime_guess, sha2, dunce, dialog plugin`.
5. Task 2: extend `AppError` + create `vault/mod.rs` + 8 stubs + wire into `lib.rs` → `cargo check` → commit `m3(vault): scaffold module + extend AppError with Vault/PathEscape/Io`.
6. Task 3: full RED-GREEN — failing test → impl `paths.rs` → 9 passed → commit `m3(vault): paths.rs canonicalize + traversal/symlink/hidden-dir guard`.

## PROMPT END
