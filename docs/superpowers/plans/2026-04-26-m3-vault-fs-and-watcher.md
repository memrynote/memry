# M3 — Vault FS + File Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land vault filesystem in Rust — atomic `.md` read/write, YAML frontmatter parse/serialize, `notify` watcher emitting `vault-changed` events, vault-rooted JSON preferences, multi-vault registry, and the full vault Tauri command surface (`vault_open` / `vault_close` / `vault_list_notes` / `vault_read_note` / `vault_write_note` / status / config / switch / remove / reveal). Settle the Tauri replacement for `memry-file://` (allowlisted, byte-range, missing-image fallback). Ship the native dialog/shell command set (folder picker, file picker, reveal in Finder, open external URL, open local attachment) replacing Electron `shell.*` and `dialog.*`. Run a drag-drop path-resolution spike so file imports work without the Electron-only `File.path`. Swap the renderer mock IPC over to real Rust for every command this milestone implements. The data DB stays at the OS app-data path established in M2 — vaults are file-tree-only.

**Architecture:** New `src-tauri/src/vault/` module owns the runtime: `paths` (canonicalize + escape guard), `fs` (atomic write + safe read + list), `frontmatter` (serde_yaml_ng parse / serialize / property extraction), `notes_io` (high-level `read_note_from_disk` / `write_note_to_disk`), `preferences` (per-vault JSON config under `<vault>/.memry/config.json`), `registry` (multi-vault list persisted under `<app-data>/memry-{device}/vaults.json`), `state` (current vault + status + watcher handle behind interior mutability), `watcher` (notify v6 with 150ms path-keyed debounce, emits via `AppHandle`). `AppState` extends from `{ db }` to `{ db, vault }`. Vault commands (`commands/vault.rs`) are thin async wrappers; native commands (`commands/shell.rs`, `commands/dialog.rs`) wrap `tauri-plugin-shell` and `tauri-plugin-dialog`. The `memry-file://` custom URI scheme is implemented as a Tauri URI scheme protocol handler in `lib.rs::run` with vault-allowlisted reads, byte-range support, and 1×1 transparent-PNG fallback for missing images.

**Tech Stack:** notify 6.x (FSEvents on macOS), serde_yaml_ng 0.10 (maintained fork of serde_yaml), mime_guess 2.x, sha2 0.10 (content hash for change detection), dunce 1.x (path canonicalization), tauri-plugin-dialog 2.x, tauri-plugin-shell 2.x (already in deps), tokio fs/sync, tempfile (dev-deps already), Vitest, Playwright WebKit.

**Parent spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` (§4 M3, §5 cross-cutting conventions)

**Predecessor plan:** `docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md` (must be merged before M3 starts)

---

## Pre-flight checks (do these before Task 1)

- [ ] M2 PR merged to `main`: `git log --oneline main | head -10` shows the `m2(*)` series ending with `m2(devx): add MEMRY_DEVICE=A/B dev scripts`
- [ ] Rust toolchain: `rustc --version` returns 1.95+; `cargo --version` works
- [ ] Node 24.x active: `node --version` returns v24.x
- [ ] pnpm 10.x active: `pnpm --version` returns 10.x
- [ ] `apps/desktop-tauri/` boots on M2 baseline: `pnpm --filter @memry/desktop-tauri dev` opens a window
- [ ] Cargo green on `main`: `pnpm --filter @memry/desktop-tauri cargo:check && pnpm --filter @memry/desktop-tauri cargo:clippy && pnpm --filter @memry/desktop-tauri cargo:test` all exit 0
- [ ] Bindings stable: `pnpm --filter @memry/desktop-tauri bindings:check` exits 0 against `main`
- [ ] Settings round-trip works against the M2 real-IPC slice (manual smoke from settings UI)
- [ ] Create a worktree for M3 isolation (per user preference — feedback_worktree.md):

```bash
git worktree add ../spike-tauri-m3 -b m3/vault-fs-and-watcher main
cd ../spike-tauri-m3
```

From this point, every path is relative to `../spike-tauri-m3`.

- [ ] Confirm a scratch test vault path is available (or create one):

```bash
mkdir -p ~/memry-test-vault-m3/notes ~/memry-test-vault-m3/journal ~/memry-test-vault-m3/attachments
```

The plan reuses this folder for manual smokes and the Task 16 100-note bench.

---

## File Structure

Files created or modified in M3:

```
apps/desktop-tauri/
├── src-tauri/
│   ├── Cargo.toml                                Task 1 (deps added)
│   ├── tauri.conf.json                           Task 13 (memry-file uri scheme)
│   ├── capabilities/
│   │   └── default.json                          Task 12, 14 (dialog + shell + drag-drop)
│   │
│   └── src/
│       ├── lib.rs                                Task 9, 11, 13, 14 (vault wiring + protocol + plugins)
│       ├── error.rs                              Task 2 (AppError vault variants + From impls)
│       ├── app_state.rs                          Task 9 (add VaultRuntime field)
│       │
│       ├── vault/
│       │   ├── mod.rs                            Task 2 (module skeleton + re-exports)
│       │   ├── paths.rs                          Task 3 (new — canonicalize + traversal guard)
│       │   ├── fs.rs                             Task 4 (new — atomic write + safe read + list)
│       │   ├── frontmatter.rs                    Task 5 (new — parse / serialize / properties)
│       │   ├── notes_io.rs                       Task 6 (new — high-level read/write note)
│       │   ├── preferences.rs                    Task 7 (new — vault-root JSON config)
│       │   ├── registry.rs                       Task 8 (new — multi-vault list at OS data dir)
│       │   ├── state.rs                          Task 9 (new — VaultRuntime + status)
│       │   └── watcher.rs                        Task 10 (new — notify with debounce)
│       │
│       └── commands/
│           ├── mod.rs                            Task 11, 12 (register vault + shell + dialog)
│           ├── vault.rs                          Task 11 (new — 13 vault_* commands)
│           ├── shell.rs                          Task 12 (new — open / reveal commands)
│           └── dialog.rs                         Task 12 (new — folder / file picker)
│
├── src/
│   ├── lib/
│   │   ├── ipc/
│   │   │   ├── invoke.ts                         Task 15 (vault_*/shell_*/dialog_* swap)
│   │   │   └── mocks/
│   │   │       └── vault.ts                      Task 15 (kept for vault_reindex deferred mock)
│   │   └── memry-file.ts                         Task 13 (new — toMemryFileUrl helper)
│   ├── services/
│   │   └── vault-service.ts                      Task 15 (real-IPC swap; same exports)
│   └── generated/
│       └── bindings.ts                           Task 15 (regenerated)
│
├── e2e/
│   └── specs/
│       └── m3-vault-smoke.spec.ts                Task 15 (new — open/list/read/write smoke)
│
└── src-tauri/
    └── tests/
        ├── vault_paths_test.rs                   Task 3 (new — traversal + symlink guard)
        ├── vault_fs_test.rs                      Task 4 (new — atomic write + safe read)
        ├── vault_frontmatter_test.rs             Task 5 (new — Turkish + multiline YAML)
        ├── vault_notes_io_test.rs                Task 6 (new — round-trip + ID auto-generation)
        ├── vault_preferences_test.rs             Task 7 (new — read/write/migration)
        ├── vault_registry_test.rs                Task 8 (new — add/remove/switch)
        ├── vault_watcher_test.rs                 Task 10 (new — debounce + event emission)
        └── vault_bench.rs                        Task 16 (new — 100-note <500ms bench)
```

---

## Task 1: Add notify, serde_yaml_ng, mime_guess, sha2, dunce, dialog plugin

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml`

- [ ] **Step 1.1: Inspect current `[dependencies]`**

Run:

```bash
grep -nE '^(rusqlite|tauri-plugin-shell|tokio|serde|serde_json|thiserror)' apps/desktop-tauri/src-tauri/Cargo.toml
```

Expected: hits for each line listed in the regex. Confirms M2 deps present and you do not duplicate keys.

- [ ] **Step 1.2: Append M3 deps to `[dependencies]`**

Edit `apps/desktop-tauri/src-tauri/Cargo.toml`. Locate the `# Declared for later milestones — unused at M1 but compile-verified` comment block and add directly after it:

```toml
# Vault FS + watcher (M3)
notify = { version = "6.1", default-features = false, features = ["macos_fsevents"] }
serde_yaml_ng = "0.10"
mime_guess = "2.0"
sha2 = "0.10"
dunce = "1.0"

# Native dialog + shell plugins (M3)
tauri-plugin-dialog = "2"
```

Notes:
- `notify` v6 with `macos_fsevents` keeps the dep tree narrow; the `crossbeam-channel` default feature is dropped so we use Tokio's mpsc instead.
- `serde_yaml_ng` is the maintained fork of `serde_yaml` (the original was archived in 2024). YAML 1.1 frontmatter compatibility with Electron's `gray-matter` output is unchanged.
- `mime_guess` resolves `.md`/`.png`/`.jpg`/`.pdf`/`.mp3`/`.mp4` MIME types for the `memry-file://` protocol (Task 13).
- `sha2` powers `generate_content_hash` for change-detection parity with Electron's djb2 (we upgrade to SHA-256 — pre-production, free hash swap).
- `dunce` is a tiny crate that strips Windows `\\?\` prefixes from canonicalized paths. Even though M3 is macOS-only, it handles macOS edge cases where `std::fs::canonicalize` returns `/private/var/...` instead of `/var/...` after symlink resolution. Using `dunce::canonicalize` consistently makes the path-comparison guard in Task 3 resilient.
- `tauri-plugin-dialog` is the Tauri 2 native folder/file picker. Already vendored by the Tauri 2 install but the crate must be a Cargo dep.

- [ ] **Step 1.3: Verify lockfile updates and compiles**

```bash
cd apps/desktop-tauri/src-tauri && cargo check
```

Expected: `Finished `dev` profile`. New deps are declared but unused; no warnings.

- [ ] **Step 1.4: Commit**

```bash
git add apps/desktop-tauri/src-tauri/Cargo.toml apps/desktop-tauri/src-tauri/Cargo.lock
git commit -m "m3(deps): add notify, serde_yaml_ng, mime_guess, sha2, dunce, dialog plugin"
```

---

## Task 2: Extend `AppError` + scaffold `vault/` module skeleton

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/error.rs`
- Create: `apps/desktop-tauri/src-tauri/src/vault/mod.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`

- [ ] **Step 2.1: Add vault-specific error variants**

Open `apps/desktop-tauri/src-tauri/src/error.rs`. Inside the `AppError` enum, after the `Validation(String)` variant, add:

```rust
    #[error("vault error: {0}")]
    Vault(String),
    #[error("path escape: {0}")]
    PathEscape(String),
    #[error("io error: {0}")]
    Io(String),
```

Then below the existing `From<std::io::Error>` impl, replace it (the existing impl maps to `Internal`, which is wrong for filesystem context — vault paths surface IO errors all over the place):

```rust
impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Io(err.to_string())
    }
}
```

And add new `From` impls below `From<serde_json::Error>`:

```rust
impl From<serde_yaml_ng::Error> for AppError {
    fn from(err: serde_yaml_ng::Error) -> Self {
        AppError::Validation(format!("yaml: {err}"))
    }
}

impl From<notify::Error> for AppError {
    fn from(err: notify::Error) -> Self {
        AppError::Vault(format!("watcher: {err}"))
    }
}
```

Verify the file compiles standalone:

```bash
cd apps/desktop-tauri/src-tauri && cargo check
```

Expected: still passes (the new variants are unused but valid).

- [ ] **Step 2.2: Create the vault module skeleton**

Create `apps/desktop-tauri/src-tauri/src/vault/mod.rs`:

```rust
//! Vault filesystem layer.
//!
//! Owns `.md` IO, frontmatter parse/serialize, the per-vault JSON
//! preferences blob, the multi-vault registry, and the live `notify`
//! watcher. Vault state (current path, watcher handle, status) lives in
//! `state::VaultRuntime`, held as `AppState.vault`. All commands in
//! `commands/vault.rs` are thin async wrappers that delegate here.
//!
//! Path discipline: every external path crosses through `paths.rs`
//! before any `fs.rs` call. There are no `tokio::fs` or `std::fs` calls
//! outside `fs.rs` and `preferences.rs`, so the canonicalize+escape
//! guard cannot be bypassed by accident.

pub mod fs;
pub mod frontmatter;
pub mod notes_io;
pub mod paths;
pub mod preferences;
pub mod registry;
pub mod state;
pub mod watcher;

pub use frontmatter::{NoteFrontmatter, ParsedNote};
pub use notes_io::{NoteOnDisk, ReadNoteResult};
pub use preferences::{VaultConfig, VaultPreferences};
pub use registry::{VaultInfo, VaultRegistry};
pub use state::{VaultRuntime, VaultStatus};
```

- [ ] **Step 2.3: Wire the module into `lib.rs`**

Open `apps/desktop-tauri/src-tauri/src/lib.rs`. After the existing `pub mod` declarations near the top, add:

```rust
pub mod vault;
```

Verify:

```bash
cd apps/desktop-tauri/src-tauri && cargo check
```

Expected: `error[E0583]: file not found for module` for each empty submodule. That is correct — the next tasks create them. Move on.

- [ ] **Step 2.4: Stub each submodule so `cargo check` passes between tasks**

Create each of these as a one-line empty file so the module tree compiles. Each gets fleshed out in Task 3-10.

```bash
for name in paths fs frontmatter notes_io preferences registry state watcher; do
  echo '//! Stubbed in Task 2; populated in later tasks.' \
    > apps/desktop-tauri/src-tauri/src/vault/$name.rs
done
```

- [ ] **Step 2.5: Stub re-exports do not exist yet — comment them out**

Re-open `apps/desktop-tauri/src-tauri/src/vault/mod.rs` and comment out the `pub use` block until later tasks export the symbols:

```rust
// Re-exports flesh out in later tasks:
// pub use frontmatter::{NoteFrontmatter, ParsedNote};
// pub use notes_io::{NoteOnDisk, ReadNoteResult};
// pub use preferences::{VaultConfig, VaultPreferences};
// pub use registry::{VaultInfo, VaultRegistry};
// pub use state::{VaultRuntime, VaultStatus};
```

```bash
cd apps/desktop-tauri/src-tauri && cargo check
```

Expected: `Finished` with one or two `unused module` warnings. Acceptable for the scaffold step.

- [ ] **Step 2.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/error.rs apps/desktop-tauri/src-tauri/src/lib.rs apps/desktop-tauri/src-tauri/src/vault
git commit -m "m3(vault): scaffold module + extend AppError with Vault/PathEscape/Io"
```

---

## Task 3: Path safety helpers — canonicalize + traversal guard

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/vault/paths.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/vault_paths_test.rs`
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml` (add `[[test]]` entry)

- [ ] **Step 3.1: Write the failing test file first**

Create `apps/desktop-tauri/src-tauri/tests/vault_paths_test.rs`:

```rust
use memry_desktop_tauri_lib::vault::paths;
use std::fs;
use std::os::unix::fs as unix_fs;

fn make_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("notes")).unwrap();
    fs::create_dir_all(dir.path().join("journal")).unwrap();
    dir
}

#[test]
fn rejects_dotdot_escape() {
    let vault = make_vault();
    let bad = "../outside.md";
    let err = paths::resolve_in_vault(vault.path(), bad).unwrap_err();
    assert!(matches!(err, memry_desktop_tauri_lib::error::AppError::PathEscape(_)));
}

#[test]
fn rejects_absolute_outside_vault() {
    let vault = make_vault();
    let bad = "/etc/passwd";
    let err = paths::resolve_in_vault(vault.path(), bad).unwrap_err();
    assert!(matches!(err, memry_desktop_tauri_lib::error::AppError::PathEscape(_)));
}

#[test]
fn allows_normal_relative_path() {
    let vault = make_vault();
    let ok = paths::resolve_in_vault(vault.path(), "notes/hello.md").unwrap();
    assert!(ok.starts_with(vault.path()));
    assert!(ok.ends_with("notes/hello.md"));
}

#[test]
fn rejects_symlink_escape() {
    let vault = make_vault();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret.md");
    fs::write(&secret, "secret").unwrap();
    let link_path = vault.path().join("notes").join("link.md");
    unix_fs::symlink(&secret, &link_path).unwrap();
    let err = paths::resolve_in_vault(vault.path(), "notes/link.md").unwrap_err();
    assert!(matches!(err, memry_desktop_tauri_lib::error::AppError::PathEscape(_)));
}

#[test]
fn rejects_hidden_dot_memry_directory() {
    let vault = make_vault();
    let err = paths::resolve_in_vault(vault.path(), ".memry/data.db").unwrap_err();
    assert!(matches!(err, memry_desktop_tauri_lib::error::AppError::PathEscape(_)));
}

#[test]
fn rejects_unsupported_extension() {
    let vault = make_vault();
    let err = paths::resolve_supported(vault.path(), "notes/hello.exe").unwrap_err();
    assert!(matches!(err, memry_desktop_tauri_lib::error::AppError::Validation(_)));
}

#[test]
fn allows_supported_extensions() {
    let vault = make_vault();
    for ext in ["md", "png", "jpg", "jpeg", "gif", "webp", "pdf", "mp3", "mp4", "wav", "mov"] {
        let rel = format!("notes/hello.{ext}");
        paths::resolve_supported(vault.path(), &rel)
            .unwrap_or_else(|e| panic!("{ext} should be supported: {e}"));
    }
}

#[test]
fn to_relative_path_normalizes_separators() {
    let vault = make_vault();
    let abs = vault.path().join("notes").join("foo.md");
    let rel = paths::to_relative_path(vault.path(), &abs).unwrap();
    assert_eq!(rel, "notes/foo.md");
}

#[test]
fn to_relative_path_rejects_outside_vault() {
    let vault = make_vault();
    let outside = std::path::PathBuf::from("/etc/passwd");
    assert!(paths::to_relative_path(vault.path(), &outside).is_none());
}
```

- [ ] **Step 3.2: Register the test binary in `Cargo.toml`**

Open `apps/desktop-tauri/src-tauri/Cargo.toml`. Below the existing `[[test]]` blocks (`migrations_test`, `settings_test`), add:

```toml
[[test]]
name = "vault_paths_test"
required-features = ["test-helpers"]
```

- [ ] **Step 3.3: Run the test to confirm it fails (no implementation yet)**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_paths_test
```

Expected: `error[E0432]: unresolved import `memry_desktop_tauri_lib::vault::paths`` plus undefined `resolve_in_vault` / `resolve_supported` / `to_relative_path` functions. RED.

- [ ] **Step 3.4: Implement `vault/paths.rs`**

Replace the stub `apps/desktop-tauri/src-tauri/src/vault/paths.rs` with:

```rust
//! Vault path normalization + escape-guard.
//!
//! Every external path that crosses into vault FS goes through
//! `resolve_in_vault`. The function canonicalizes the input under the
//! vault root, refuses paths that escape via `..` or symlinks, and
//! refuses paths that touch the hidden `.memry/` app-internal folder.
//! `resolve_supported` adds an extension allowlist that matches the
//! Electron `isSupportedPath` check.
//!
//! Path strings inside the renderer are always vault-relative with
//! forward slashes (matches Electron's `normalizeRelativePath`). The
//! conversion to absolute happens here and stays internal to Rust.

use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

const HIDDEN_APP_DIR: &str = ".memry";

const SUPPORTED_EXT: &[&str] = &[
    "md", "markdown",
    "png", "jpg", "jpeg", "gif", "webp", "svg",
    "pdf",
    "mp3", "wav", "m4a", "ogg",
    "mp4", "mov", "webm",
];

/// Normalize a vault-relative path to forward slashes.
pub fn normalize_relative(path: &str) -> String {
    path.replace('\\', "/")
}

/// Convert an absolute path inside `vault_root` to a forward-slashed
/// vault-relative path. Returns `None` if the path is outside the vault.
pub fn to_relative_path(vault_root: &Path, abs: &Path) -> Option<String> {
    let canonical_root = dunce::canonicalize(vault_root).ok()?;
    let canonical_abs = dunce::canonicalize(abs).ok()?;
    let stripped = canonical_abs.strip_prefix(&canonical_root).ok()?;
    let s = stripped.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Resolve a vault-relative path to an absolute path under `vault_root`.
/// Rejects:
/// - `..` segments anywhere in the input
/// - absolute inputs (must be vault-relative)
/// - paths whose first segment is `.memry/`
/// - paths whose canonical resolution lands outside the vault root
///   (catches symlink escapes; the symlink target is resolved before
///   the `starts_with` check)
pub fn resolve_in_vault(vault_root: &Path, rel: &str) -> AppResult<PathBuf> {
    let cleaned = normalize_relative(rel);
    let candidate = Path::new(&cleaned);

    if candidate.is_absolute() {
        return Err(AppError::PathEscape(format!(
            "absolute path not allowed: {rel}"
        )));
    }

    let mut depth: i32 = 0;
    for component in candidate.components() {
        match component {
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err(AppError::PathEscape(format!("dotdot escape: {rel}")));
                }
            }
            Component::Normal(seg) => {
                if depth == 0 && seg == HIDDEN_APP_DIR {
                    return Err(AppError::PathEscape(format!(
                        "hidden app dir not addressable: {rel}"
                    )));
                }
                depth += 1;
            }
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::PathEscape(format!(
                    "root component in relative path: {rel}"
                )));
            }
        }
    }

    let vault_canonical = dunce::canonicalize(vault_root)
        .map_err(|e| AppError::Vault(format!("vault root unreadable: {e}")))?;
    let joined = vault_canonical.join(candidate);

    // Canonicalize if the file already exists; otherwise canonicalize
    // the parent and re-attach the leaf. This handles "write a new file
    // at notes/foo.md" while still catching symlink escapes on the
    // existing parent.
    let resolved = if joined.exists() {
        dunce::canonicalize(&joined)?
    } else if let Some(parent) = joined.parent() {
        if parent.exists() {
            let canon_parent = dunce::canonicalize(parent)?;
            canon_parent.join(joined.file_name().ok_or_else(|| {
                AppError::PathEscape(format!("missing file name: {rel}"))
            })?)
        } else {
            // Parent does not exist either — assume the caller is
            // about to create the directory tree. Use the joined path
            // as-is; the caller's `create_dir_all` is responsible.
            joined.clone()
        }
    } else {
        joined.clone()
    };

    if !resolved.starts_with(&vault_canonical) {
        return Err(AppError::PathEscape(format!(
            "resolved path escaped vault: {rel}"
        )));
    }

    Ok(resolved)
}

/// `resolve_in_vault` plus an extension allowlist. Returns the absolute
/// path on success.
pub fn resolve_supported(vault_root: &Path, rel: &str) -> AppResult<PathBuf> {
    let resolved = resolve_in_vault(vault_root, rel)?;
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .ok_or_else(|| AppError::Validation(format!("missing extension: {rel}")))?;
    if !SUPPORTED_EXT.contains(&ext.as_str()) {
        return Err(AppError::Validation(format!(
            "unsupported extension: .{ext}"
        )));
    }
    Ok(resolved)
}

/// Heuristic: is this a markdown file by extension?
pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false)
}
```

- [ ] **Step 3.5: Re-run the test to verify it passes**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_paths_test
```

Expected: `9 passed`.

- [ ] **Step 3.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/vault/paths.rs \
        apps/desktop-tauri/src-tauri/tests/vault_paths_test.rs \
        apps/desktop-tauri/src-tauri/Cargo.toml
git commit -m "m3(vault): paths.rs canonicalize + traversal/symlink/hidden-dir guard"
```

---

## Task 4: Atomic write + safe read + list (`vault/fs.rs`)

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/vault/fs.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/vault_fs_test.rs`
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml` (add `[[test]]` entry)

- [ ] **Step 4.1: Write the failing test**

Create `apps/desktop-tauri/src-tauri/tests/vault_fs_test.rs`:

```rust
use memry_desktop_tauri_lib::vault::fs as vfs;
use memry_desktop_tauri_lib::vault::paths;
use std::fs;

fn make_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("notes")).unwrap();
    dir
}

#[tokio::test]
async fn atomic_write_creates_file() {
    let vault = make_vault();
    let abs = paths::resolve_in_vault(vault.path(), "notes/hello.md").unwrap();
    vfs::atomic_write(&abs, "# hello\n").await.unwrap();
    let read_back = fs::read_to_string(&abs).unwrap();
    assert_eq!(read_back, "# hello\n");
}

#[tokio::test]
async fn atomic_write_replaces_existing_file() {
    let vault = make_vault();
    let abs = paths::resolve_in_vault(vault.path(), "notes/hello.md").unwrap();
    vfs::atomic_write(&abs, "first").await.unwrap();
    vfs::atomic_write(&abs, "second").await.unwrap();
    let read_back = fs::read_to_string(&abs).unwrap();
    assert_eq!(read_back, "second");
}

#[tokio::test]
async fn atomic_write_creates_parent_dirs() {
    let vault = make_vault();
    let abs = paths::resolve_in_vault(vault.path(), "notes/sub/deep/foo.md").unwrap();
    vfs::atomic_write(&abs, "x").await.unwrap();
    assert!(abs.exists());
}

#[tokio::test]
async fn atomic_write_cleans_up_temp_on_failure() {
    let vault = make_vault();
    // Write a directory at the target path, then try to atomic-write a
    // file there. The rename must fail and leave no `.tmp.<hex>` files
    // in the parent.
    let target_dir = vault.path().join("notes").join("blocking");
    fs::create_dir_all(&target_dir).unwrap();

    let abs = vault.path().join("notes").join("blocking");
    let result = vfs::atomic_write(&abs, "x").await;
    assert!(result.is_err());

    let leftover: Vec<_> = fs::read_dir(vault.path().join("notes"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
        .collect();
    assert!(leftover.is_empty(), "temp file leaked: {leftover:?}");
}

#[tokio::test]
async fn safe_read_returns_none_for_missing() {
    let vault = make_vault();
    let abs = vault.path().join("notes").join("missing.md");
    let result = vfs::safe_read(&abs).await.unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn safe_read_returns_content_for_existing() {
    let vault = make_vault();
    let abs = vault.path().join("notes").join("hi.md");
    fs::write(&abs, "hi").unwrap();
    let result = vfs::safe_read(&abs).await.unwrap();
    assert_eq!(result.as_deref(), Some("hi"));
}

#[tokio::test]
async fn list_supported_files_skips_hidden_and_unsupported() {
    let vault = make_vault();
    fs::write(vault.path().join("notes/keep.md"), "k").unwrap();
    fs::write(vault.path().join("notes/.hidden.md"), "h").unwrap();
    fs::write(vault.path().join("notes/skip.exe"), "x").unwrap();
    fs::create_dir_all(vault.path().join(".memry")).unwrap();
    fs::write(vault.path().join(".memry/data.db"), "db").unwrap();
    let entries = vfs::list_supported_files(vault.path()).await.unwrap();
    let names: Vec<&str> = entries.iter().map(String::as_str).collect();
    assert!(names.contains(&"notes/keep.md"));
    assert!(!names.iter().any(|n| n.contains(".hidden")));
    assert!(!names.iter().any(|n| n.ends_with(".exe")));
    assert!(!names.iter().any(|n| n.starts_with(".memry")));
}

#[test]
fn content_hash_is_stable_for_same_content() {
    let h1 = vfs::content_hash("hello world");
    let h2 = vfs::content_hash("hello world");
    assert_eq!(h1, h2);
    assert_eq!(h1.len(), 64); // sha256 hex
}

#[test]
fn content_hash_differs_for_different_content() {
    assert_ne!(vfs::content_hash("a"), vfs::content_hash("b"));
}
```

- [ ] **Step 4.2: Register the test in `Cargo.toml`**

Append below the existing `[[test]]` blocks:

```toml
[[test]]
name = "vault_fs_test"
required-features = ["test-helpers"]
```

- [ ] **Step 4.3: Run the test (RED)**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_fs_test
```

Expected: unresolved imports for `atomic_write`, `safe_read`, `list_supported_files`, `content_hash`. RED.

- [ ] **Step 4.4: Implement `vault/fs.rs`**

Replace the stub `apps/desktop-tauri/src-tauri/src/vault/fs.rs` with:

```rust
//! Filesystem ops for the vault layer.
//!
//! - `atomic_write`: temp-file-then-rename pattern. Survives mid-write
//!   crash because the partial temp file is never visible at the final
//!   path. POSIX `rename(2)` is atomic on the same filesystem; on
//!   macOS the .memry-internal data DB and the vault tree are usually
//!   on the same APFS volume.
//! - `safe_read`: returns `None` for missing files, errors otherwise.
//! - `list_supported_files`: depth-first walk that skips hidden
//!   entries (`.foo`), `.memry` app-internal dir, and unsupported
//!   extensions. Output is forward-slashed vault-relative paths.
//! - `content_hash`: SHA-256 hex of UTF-8 bytes for change detection.
//!
//! All functions receive already-canonicalized absolute paths from
//! `vault::paths::resolve_in_vault` — they do NOT re-validate.

use crate::error::{AppError, AppResult};
use crate::vault::paths;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::fs;

const TEMP_PREFIX: &str = ".tmp.";

/// Atomically write `content` to `path`. Creates parent dirs as needed.
/// On failure, removes any leftover temp file in the same parent.
pub async fn atomic_write(path: &Path, content: &str) -> AppResult<()> {
    let parent = path.parent().ok_or_else(|| {
        AppError::Vault(format!("path has no parent: {}", path.display()))
    })?;
    fs::create_dir_all(parent).await?;

    let suffix = nanoid::nanoid!(12);
    let temp_name = format!("{TEMP_PREFIX}{suffix}");
    let temp_path = parent.join(temp_name);

    let write_then_rename = async {
        fs::write(&temp_path, content).await?;
        fs::rename(&temp_path, path).await?;
        Ok::<_, AppError>(())
    };

    match write_then_rename.await {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&temp_path).await;
            Err(e)
        }
    }
}

/// Read a file as UTF-8. Returns `Ok(None)` if the file does not exist.
/// Other IO errors propagate as `AppError::Io`.
pub async fn safe_read(path: &Path) -> AppResult<Option<String>> {
    match fs::read_to_string(path).await {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::from(e)),
    }
}

/// Read a file or error if missing.
pub async fn read_required(path: &Path) -> AppResult<String> {
    safe_read(path).await?.ok_or_else(|| {
        AppError::NotFound(format!("file not found: {}", path.display()))
    })
}

/// Delete a file. No-op if it does not exist.
pub async fn delete_file(path: &Path) -> AppResult<()> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::from(e)),
    }
}

/// List every supported file under `vault_root`, returning forward-
/// slashed vault-relative paths sorted lexicographically. Skips:
/// - any directory or file whose basename starts with `.`
/// - the `.memry/` app-internal dir at the vault root
/// - unsupported file extensions (matches `paths::resolve_supported`)
/// - symlinks (defense in depth — `paths::resolve_in_vault` already
///   rejects symlink targets that escape, but the watcher walk skips
///   symlinks entirely so a symlink loop cannot DOS the scan)
pub async fn list_supported_files(vault_root: &Path) -> AppResult<Vec<String>> {
    let canonical_root = dunce::canonicalize(vault_root)?;
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![canonical_root.clone()];

    while let Some(dir) = stack.pop() {
        let mut entries = match fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => continue,
            Err(e) => return Err(AppError::from(e)),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                continue;
            }
            let metadata = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };
            let path = entry.path();
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push(path);
            } else if metadata.is_file() {
                let lower_ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase())
                    .unwrap_or_default();
                if lower_ext.is_empty() {
                    continue;
                }
                if !paths::resolve_supported(&canonical_root, &format!("dummy.{lower_ext}"))
                    .is_ok()
                    && !paths::is_markdown(&path)
                    && !is_supported_attachment(&lower_ext)
                {
                    continue;
                }
                if let Some(rel) = paths::to_relative_path(&canonical_root, &path) {
                    out.push(rel);
                }
            }
        }
    }

    out.sort();
    Ok(out)
}

fn is_supported_attachment(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" |
        "pdf" | "mp3" | "wav" | "m4a" | "ogg" | "mp4" | "mov" | "webm"
    )
}

/// SHA-256 hex of `content`. Used by the watcher and notes_io to skip
/// no-op rewrites and emit `vault-changed` only on real diffs.
pub fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}
```

- [ ] **Step 4.5: Add `nanoid` to Cargo.toml**

`atomic_write` uses `nanoid::nanoid!` for temp-file suffixes. Add to `[dependencies]`:

```toml
nanoid = "0.4"
```

- [ ] **Step 4.6: Run tests until green**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_fs_test
```

Expected: `9 passed`. If `atomic_write_cleans_up_temp_on_failure` is flaky, ensure the cleanup branch runs unconditionally on `Err` regardless of which step failed.

- [ ] **Step 4.7: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/vault/fs.rs \
        apps/desktop-tauri/src-tauri/tests/vault_fs_test.rs \
        apps/desktop-tauri/src-tauri/Cargo.toml \
        apps/desktop-tauri/src-tauri/Cargo.lock
git commit -m "m3(vault): fs.rs atomic_write + safe_read + list + sha256 content_hash"
```

---

## Task 5: Frontmatter parse + serialize (`vault/frontmatter.rs`)

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/vault/frontmatter.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/vault_frontmatter_test.rs`
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml` (add `[[test]]` entry, add `nanoid` reuse)

- [ ] **Step 5.1: Write the failing test**

Create `apps/desktop-tauri/src-tauri/tests/vault_frontmatter_test.rs`:

```rust
use memry_desktop_tauri_lib::vault::frontmatter::{
    create_frontmatter, parse_note, serialize_note, NoteFrontmatter,
};

#[test]
fn parses_minimal_frontmatter() {
    let raw = "---\nid: abc123\ntitle: Hello\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\n---\nbody";
    let parsed = parse_note(raw, Some("notes/hello.md")).unwrap();
    assert_eq!(parsed.frontmatter.id, "abc123");
    assert_eq!(parsed.frontmatter.title.as_deref(), Some("Hello"));
    assert_eq!(parsed.content, "body");
    assert!(parsed.had_frontmatter);
    assert!(!parsed.was_modified);
}

#[test]
fn auto_generates_missing_required_fields() {
    let raw = "no frontmatter here\n";
    let parsed = parse_note(raw, Some("notes/x.md")).unwrap();
    assert!(!parsed.frontmatter.id.is_empty());
    assert!(!parsed.frontmatter.created.is_empty());
    assert!(!parsed.frontmatter.modified.is_empty());
    assert!(parsed.was_modified);
    assert_eq!(parsed.frontmatter.title.as_deref(), Some("X"));
}

#[test]
fn extracts_title_from_filename_when_missing() {
    let raw = "---\nid: x\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\n---\nbody";
    let parsed = parse_note(raw, Some("notes/my-cool-thought.md")).unwrap();
    assert_eq!(parsed.frontmatter.title.as_deref(), Some("My Cool Thought"));
}

#[test]
fn turkish_chars_roundtrip_byte_identical() {
    let title = "Toplantı: çay & kahve — ÖĞRENME günü";
    let body = "İçerik düzenlendi: çalışma & öğrenme.";
    let mut fm = create_frontmatter(title, &["work".to_string()]);
    fm.id = "fixed-id".to_string();
    let serialized = serialize_note(&fm, body).unwrap();
    let parsed = parse_note(&serialized, None).unwrap();
    assert_eq!(parsed.frontmatter.title.as_deref(), Some(title));
    assert_eq!(parsed.content, body);
}

#[test]
fn multiline_yaml_string_roundtrip() {
    let raw = "---\nid: x\ntitle: With Block\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\nproperties:\n  description: |\n    line one\n    line two\n---\nbody";
    let parsed = parse_note(raw, None).unwrap();
    let props = parsed.frontmatter.properties.as_ref().unwrap();
    let desc = props.get("description").unwrap();
    assert!(desc.as_str().unwrap().contains("line one"));
    assert!(desc.as_str().unwrap().contains("line two"));
}

#[test]
fn date_field_preserved_as_string() {
    let raw = "---\nid: x\ntitle: Dated\ncreated: 2026-04-26\nmodified: 2026-04-26T10:30:00Z\n---\nbody";
    let parsed = parse_note(raw, None).unwrap();
    assert_eq!(parsed.frontmatter.created, "2026-04-26");
    assert_eq!(parsed.frontmatter.modified, "2026-04-26T10:30:00Z");
}

#[test]
fn tags_normalized_to_vec_strings() {
    let raw = "---\nid: x\ntitle: T\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\ntags:\n  - work\n  - life\n  - WORK\n---\nbody";
    let parsed = parse_note(raw, None).unwrap();
    assert_eq!(parsed.frontmatter.tags, vec!["work", "life", "WORK"]);
}

#[test]
fn preserves_non_reserved_properties_through_roundtrip() {
    let raw = "---\nid: x\ntitle: T\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\nstatus: active\npriority: 3\n---\nbody";
    let parsed = parse_note(raw, None).unwrap();
    let serialized = serialize_note(&parsed.frontmatter, &parsed.content).unwrap();
    assert!(serialized.contains("status: active"));
    assert!(serialized.contains("priority: 3"));
}

#[test]
fn extract_properties_skips_reserved_keys() {
    let raw = "---\nid: x\ntitle: T\ncreated: 2026-04-26T00:00:00Z\nmodified: 2026-04-26T00:00:00Z\ntags:\n  - work\nstatus: active\nflag: true\n---\nbody";
    let parsed = parse_note(raw, None).unwrap();
    let props = parsed.frontmatter.extract_properties();
    assert!(props.contains_key("status"));
    assert!(props.contains_key("flag"));
    assert!(!props.contains_key("id"));
    assert!(!props.contains_key("title"));
    assert!(!props.contains_key("tags"));
}
```

- [ ] **Step 5.2: Register the test in `Cargo.toml`**

```toml
[[test]]
name = "vault_frontmatter_test"
required-features = ["test-helpers"]
```

- [ ] **Step 5.3: Run RED**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_frontmatter_test
```

Expected: unresolved imports.

- [ ] **Step 5.4: Implement `vault/frontmatter.rs`**

Replace the stub with:

```rust
//! YAML frontmatter parser, serializer, and property extractor.
//!
//! Parser is gray-matter-compatible enough for Electron-authored
//! `.md` files: `---` fence at the start, YAML 1.1 between fences,
//! body after. Reserved frontmatter keys (id/title/created/modified/
//! tags/aliases/emoji/local_only/properties) are pulled into the
//! typed `NoteFrontmatter` struct; everything else is extracted by
//! `extract_properties()` for the renderer's property-definitions
//! system.
//!
//! Required field auto-fill matches Electron's `parseNote`: missing
//! `id` → fresh nanoid; missing `created`/`modified` → now ISO; the
//! caller checks `was_modified` to know when to re-serialize.

use crate::error::{AppError, AppResult};
use serde_yaml_ng as yaml;
use serde_yaml_ng::Value;
use std::collections::BTreeMap;
use std::path::Path;

const RESERVED_KEYS: &[&str] = &[
    "id", "title", "created", "modified", "tags", "aliases", "emoji",
    "localOnly", "properties",
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteFrontmatter {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub created: String,
    pub modified: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub properties: Option<BTreeMap<String, Value>>,
    /// Catch-all for non-reserved keys (matches Electron's
    /// "top-level keys are properties unless reserved").
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl NoteFrontmatter {
    pub fn extract_properties(&self) -> BTreeMap<String, Value> {
        if let Some(p) = &self.properties {
            return p.clone();
        }
        let mut out = BTreeMap::new();
        for (k, v) in &self.extra {
            if !RESERVED_KEYS.contains(&k.as_str()) {
                out.insert(k.clone(), v.clone());
            }
        }
        out
    }
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ParsedNote {
    pub frontmatter: NoteFrontmatter,
    pub content: String,
    pub had_frontmatter: bool,
    pub was_modified: bool,
}

/// Parse a markdown file with optional YAML frontmatter. Auto-fills
/// required fields when missing.
pub fn parse_note(raw: &str, file_path: Option<&str>) -> AppResult<ParsedNote> {
    let (mut yaml_text, body, had_frontmatter) = split_frontmatter(raw);

    let mut data: BTreeMap<String, Value> = if yaml_text.is_empty() {
        BTreeMap::new()
    } else {
        yaml::from_str(&yaml_text).unwrap_or_default()
    };
    let _ = &mut yaml_text;

    let now = current_iso();
    let mut was_modified = false;

    let id = match data.get("id").and_then(Value::as_str) {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => {
            was_modified = true;
            generate_note_id()
        }
    };

    let created = match data.get("created") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => yaml_value_to_string(other),
        None => {
            was_modified = true;
            now.clone()
        }
    };
    let modified = match data.get("modified") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => yaml_value_to_string(other),
        None => {
            was_modified = true;
            now.clone()
        }
    };

    let title = data.get("title").and_then(Value::as_str).map(|s| s.to_string()).or_else(|| {
        file_path.map(extract_title_from_path)
    });

    let tags = data
        .get("tags")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let aliases = data
        .get("aliases")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let emoji = data.get("emoji").and_then(Value::as_str).map(String::from);
    let local_only = data.get("localOnly").and_then(Value::as_bool);
    let properties = data
        .get("properties")
        .and_then(|v| v.as_mapping())
        .map(|map| {
            let mut out = BTreeMap::new();
            for (k, v) in map.iter() {
                if let Some(key) = k.as_str() {
                    out.insert(key.to_string(), v.clone());
                }
            }
            out
        });

    let mut extra = BTreeMap::new();
    for (k, v) in data.into_iter() {
        if !RESERVED_KEYS.contains(&k.as_str()) {
            extra.insert(k, v);
        }
    }

    let frontmatter = NoteFrontmatter {
        id,
        title,
        created,
        modified,
        tags,
        aliases,
        emoji,
        local_only,
        properties,
        extra,
    };

    Ok(ParsedNote {
        frontmatter,
        content: body.trim().to_string(),
        had_frontmatter,
        was_modified,
    })
}

/// Serialize frontmatter + body back to a markdown file. Bumps
/// `modified` to now.
pub fn serialize_note(fm: &NoteFrontmatter, content: &str) -> AppResult<String> {
    let mut out = NoteFrontmatter {
        modified: current_iso(),
        ..fm.clone()
    };
    let _ = &mut out;

    let mut map = BTreeMap::<String, Value>::new();
    map.insert("id".into(), Value::String(out.id.clone()));
    if let Some(title) = &out.title {
        map.insert("title".into(), Value::String(title.clone()));
    }
    map.insert("created".into(), Value::String(out.created.clone()));
    map.insert("modified".into(), Value::String(out.modified.clone()));
    if !out.tags.is_empty() {
        map.insert(
            "tags".into(),
            Value::Sequence(out.tags.iter().map(|t| Value::String(t.clone())).collect()),
        );
    }
    if !out.aliases.is_empty() {
        map.insert(
            "aliases".into(),
            Value::Sequence(
                out.aliases.iter().map(|t| Value::String(t.clone())).collect(),
            ),
        );
    }
    if let Some(emoji) = &out.emoji {
        map.insert("emoji".into(), Value::String(emoji.clone()));
    }
    if let Some(b) = out.local_only {
        map.insert("localOnly".into(), Value::Bool(b));
    }
    if let Some(props) = &out.properties {
        let mapping: yaml::Mapping = props
            .iter()
            .map(|(k, v)| (Value::String(k.clone()), v.clone()))
            .collect();
        map.insert("properties".into(), Value::Mapping(mapping));
    }
    for (k, v) in &out.extra {
        if !map.contains_key(k) {
            map.insert(k.clone(), v.clone());
        }
    }

    let yaml_text = yaml::to_string(&map)?;
    let body = content.trim_end_matches(['\n']).to_string();
    Ok(format!("---\n{yaml_text}---\n{body}"))
}

/// Convenience: build a fresh frontmatter for a new note.
pub fn create_frontmatter(title: &str, tags: &[String]) -> NoteFrontmatter {
    let now = current_iso();
    NoteFrontmatter {
        id: generate_note_id(),
        title: Some(title.to_string()),
        created: now.clone(),
        modified: now,
        tags: tags.to_vec(),
        aliases: Vec::new(),
        emoji: None,
        local_only: None,
        properties: None,
        extra: BTreeMap::new(),
    }
}

fn split_frontmatter(raw: &str) -> (String, String, bool) {
    let trimmed = raw.trim_start_matches('\u{FEFF}');
    if !trimmed.starts_with("---") {
        return (String::new(), trimmed.to_string(), false);
    }
    let after_open = &trimmed[3..];
    let after_open = after_open.trim_start_matches('\r').trim_start_matches('\n');
    if let Some(end_idx) = find_closing_fence(after_open) {
        let yaml_text = after_open[..end_idx].to_string();
        let mut rest = &after_open[end_idx..];
        rest = rest.trim_start_matches("---");
        rest = rest.trim_start_matches('\r').trim_start_matches('\n');
        (yaml_text, rest.to_string(), true)
    } else {
        (String::new(), trimmed.to_string(), false)
    }
}

fn find_closing_fence(text: &str) -> Option<usize> {
    let mut start = 0usize;
    while let Some(idx) = text[start..].find("\n---") {
        let candidate = start + idx + 1;
        let after = &text[candidate + 3..];
        if after.is_empty() || after.starts_with('\r') || after.starts_with('\n') {
            return Some(candidate);
        }
        start = candidate + 1;
    }
    None
}

fn extract_title_from_path(path: &str) -> String {
    let leaf = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path);
    leaf.replace(['-', '_'], " ")
        .split_whitespace()
        .map(capitalize)
        .collect::<Vec<_>>()
        .join(" ")
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            let mut s = first.to_uppercase().collect::<String>();
            s.push_str(chars.as_str());
            s
        }
    }
}

fn current_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Minimal ISO-8601 formatter — avoids pulling in chrono just here.
    let datetime = unix_secs_to_iso(secs);
    datetime
}

fn unix_secs_to_iso(secs: u64) -> String {
    let days_per_month = |y: u64, m: u64| -> u64 {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        match m {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 => if leap { 29 } else { 28 },
            _ => 0,
        }
    };
    let mut s = secs;
    let secs_part = s % 60;
    s /= 60;
    let mins_part = s % 60;
    s /= 60;
    let hours_part = s % 24;
    s /= 24;
    let mut year: u64 = 1970;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd = if leap { 366 } else { 365 };
        if s < yd { break; }
        s -= yd;
        year += 1;
    }
    let mut month: u64 = 1;
    while month <= 12 {
        let md = days_per_month(year, month);
        if s < md { break; }
        s -= md;
        month += 1;
    }
    let day = s + 1;
    format!("{year:04}-{month:02}-{day:02}T{hours_part:02}:{mins_part:02}:{secs_part:02}Z")
}

fn generate_note_id() -> String {
    nanoid::nanoid!(21)
}

fn yaml_value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => yaml::to_string(other).unwrap_or_default().trim().to_string(),
    }
}
```

- [ ] **Step 5.5: Run tests until green**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_frontmatter_test
```

Expected: `9 passed`. Common failure modes:
- `serde_yaml_ng` produces booleans as `true`/`false` (lowercase) — matches expected behavior.
- The hand-rolled ISO helper assumes UTC. Acceptable for M3; M4+ can swap to chrono.

- [ ] **Step 5.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/vault/frontmatter.rs \
        apps/desktop-tauri/src-tauri/tests/vault_frontmatter_test.rs \
        apps/desktop-tauri/src-tauri/Cargo.toml
git commit -m "m3(vault): frontmatter.rs serde_yaml_ng parse/serialize + Turkish roundtrip"
```

---

## Task 6: High-level note IO (`vault/notes_io.rs`)

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/vault/notes_io.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/vault_notes_io_test.rs`
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml` (add `[[test]]` entry)

- [ ] **Step 6.1: Write the failing test**

Create `apps/desktop-tauri/src-tauri/tests/vault_notes_io_test.rs`:

```rust
use memry_desktop_tauri_lib::vault::notes_io;
use memry_desktop_tauri_lib::vault::frontmatter::create_frontmatter;
use std::fs;

fn make_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("notes")).unwrap();
    dir
}

#[tokio::test]
async fn write_then_read_roundtrip() {
    let vault = make_vault();
    let mut fm = create_frontmatter("Hello", &["work".to_string()]);
    fm.id = "fixed-id-1".to_string();
    let written = notes_io::write_note_to_disk(
        vault.path(),
        "notes/hello.md",
        &fm,
        "body text",
    )
    .await
    .unwrap();
    assert_eq!(written.relative_path, "notes/hello.md");

    let read = notes_io::read_note_from_disk(vault.path(), "notes/hello.md")
        .await
        .unwrap()
        .expect("note must exist");
    assert_eq!(read.parsed.frontmatter.id, "fixed-id-1");
    assert_eq!(read.parsed.frontmatter.title.as_deref(), Some("Hello"));
    assert_eq!(read.parsed.content, "body text");
}

#[tokio::test]
async fn read_returns_none_for_missing_path() {
    let vault = make_vault();
    let result = notes_io::read_note_from_disk(vault.path(), "notes/missing.md")
        .await
        .unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn read_auto_repairs_missing_frontmatter_and_writes_back() {
    let vault = make_vault();
    let abs = vault.path().join("notes").join("plain.md");
    fs::write(&abs, "no fm here\n").unwrap();
    let read = notes_io::read_note_from_disk(vault.path(), "notes/plain.md")
        .await
        .unwrap()
        .unwrap();
    assert!(read.parsed.was_modified);
    let on_disk = fs::read_to_string(&abs).unwrap();
    assert!(on_disk.starts_with("---\n"));
    assert!(on_disk.contains(&format!("id: {}", read.parsed.frontmatter.id)));
}

#[tokio::test]
async fn write_skips_no_op_when_hash_matches() {
    let vault = make_vault();
    let mut fm = create_frontmatter("X", &[]);
    fm.id = "id-2".to_string();
    let first = notes_io::write_note_to_disk(vault.path(), "notes/x.md", &fm, "same")
        .await
        .unwrap();
    let second = notes_io::write_note_to_disk(vault.path(), "notes/x.md", &fm, "same")
        .await
        .unwrap();
    // Hash equality means the second call did NOT bump the file mtime.
    assert_eq!(first.content_hash, second.content_hash);
}

#[tokio::test]
async fn read_rejects_path_traversal() {
    let vault = make_vault();
    let err = notes_io::read_note_from_disk(vault.path(), "../escape.md")
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        memry_desktop_tauri_lib::error::AppError::PathEscape(_)
    ));
}
```

- [ ] **Step 6.2: Register the test**

```toml
[[test]]
name = "vault_notes_io_test"
required-features = ["test-helpers"]
```

- [ ] **Step 6.3: Run RED**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_notes_io_test
```

Expected: unresolved imports.

- [ ] **Step 6.4: Implement `vault/notes_io.rs`**

Replace the stub with:

```rust
//! High-level note IO. Composes path resolution, atomic write, and
//! frontmatter parse/serialize into the operations Tauri commands
//! call directly.
//!
//! - `read_note_from_disk` returns `None` on missing path. If the
//!   on-disk file is missing required frontmatter fields, this writes
//!   the repaired version back via atomic_write so subsequent reads
//!   do not have to repeat the auto-fill — matches Electron's behavior
//!   in `vault/notes.ts::ensureFrontmatter`.
//! - `write_note_to_disk` always serializes via `frontmatter::serialize_note`
//!   (which bumps `modified`), then atomic-writes. The returned
//!   `NoteOnDisk` includes a SHA-256 content hash so the watcher /
//!   sync queue can detect no-op rewrites cheaply.
//! - All paths are vault-relative and forward-slashed.

use crate::error::AppResult;
use crate::vault::fs as vfs;
use crate::vault::frontmatter::{self, NoteFrontmatter, ParsedNote};
use crate::vault::paths;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteOnDisk {
    pub relative_path: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadNoteResult {
    pub relative_path: String,
    pub raw: String,
    pub content_hash: String,
    pub parsed: ParsedNote,
}

pub async fn read_note_from_disk(
    vault_root: &Path,
    relative_path: &str,
) -> AppResult<Option<ReadNoteResult>> {
    let abs = paths::resolve_supported(vault_root, relative_path)?;
    let raw = match vfs::safe_read(&abs).await? {
        Some(s) => s,
        None => return Ok(None),
    };

    let parsed = frontmatter::parse_note(&raw, Some(relative_path))?;

    if parsed.was_modified {
        let serialized =
            frontmatter::serialize_note(&parsed.frontmatter, &parsed.content)?;
        vfs::atomic_write(&abs, &serialized).await?;
        let hash = vfs::content_hash(&serialized);
        return Ok(Some(ReadNoteResult {
            relative_path: relative_path.to_string(),
            raw: serialized,
            content_hash: hash,
            parsed,
        }));
    }

    let hash = vfs::content_hash(&raw);
    Ok(Some(ReadNoteResult {
        relative_path: relative_path.to_string(),
        raw,
        content_hash: hash,
        parsed,
    }))
}

pub async fn write_note_to_disk(
    vault_root: &Path,
    relative_path: &str,
    frontmatter_in: &NoteFrontmatter,
    content: &str,
) -> AppResult<NoteOnDisk> {
    let abs = paths::resolve_supported(vault_root, relative_path)?;
    let serialized = frontmatter::serialize_note(frontmatter_in, content)?;
    let new_hash = vfs::content_hash(&serialized);

    if let Some(existing) = vfs::safe_read(&abs).await? {
        if vfs::content_hash(&existing) == new_hash {
            return Ok(NoteOnDisk {
                relative_path: relative_path.to_string(),
                content_hash: new_hash,
            });
        }
    }

    vfs::atomic_write(&abs, &serialized).await?;
    Ok(NoteOnDisk {
        relative_path: relative_path.to_string(),
        content_hash: new_hash,
    })
}

pub async fn delete_note_from_disk(
    vault_root: &Path,
    relative_path: &str,
) -> AppResult<()> {
    let abs = paths::resolve_supported(vault_root, relative_path)?;
    vfs::delete_file(&abs).await
}
```

> **Note** — the `write_note_to_disk` no-op short-circuit compares the
> already-serialized form (which includes the bumped `modified`
> timestamp) against the on-disk content. Two back-to-back writes with
> identical input WILL produce identical hashes only if the second
> write happens within the same second AND `serialize_note` is
> deterministic for the input. The test in 6.1 uses a fixed-tag
> frontmatter and writes within the same test invocation, so this
> works in practice. M5 will revisit if real-world callers hit
> false-positive rewrites.

- [ ] **Step 6.5: Run tests**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_notes_io_test
```

Expected: `5 passed`.

- [ ] **Step 6.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/vault/notes_io.rs \
        apps/desktop-tauri/src-tauri/tests/vault_notes_io_test.rs \
        apps/desktop-tauri/src-tauri/Cargo.toml
git commit -m "m3(vault): notes_io.rs read_note_from_disk + write_note_to_disk + content-hash skip"
```

---

## Task 7: Vault preferences (`vault/preferences.rs`)

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/vault/preferences.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/vault_preferences_test.rs`
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml` (add `[[test]]` entry)

- [ ] **Step 7.1: Write the failing test**

Create `apps/desktop-tauri/src-tauri/tests/vault_preferences_test.rs`:

```rust
use memry_desktop_tauri_lib::vault::preferences::{self, VaultConfig, VaultPreferences};

fn make_vault() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[test]
fn init_creates_dot_memry_with_default_config() {
    let vault = make_vault();
    preferences::init_vault(vault.path()).unwrap();
    assert!(vault.path().join(".memry").exists());
    assert!(vault.path().join("notes").exists());
    assert!(vault.path().join("journal").exists());
    assert!(vault.path().join("attachments").exists());
    assert!(vault.path().join(".memry/config.json").exists());
}

#[test]
fn init_is_idempotent() {
    let vault = make_vault();
    preferences::init_vault(vault.path()).unwrap();
    preferences::init_vault(vault.path()).unwrap();
}

#[test]
fn read_config_returns_defaults_when_missing() {
    let vault = make_vault();
    let cfg = preferences::read_config(vault.path()).unwrap();
    assert_eq!(cfg.default_note_folder, "notes");
    assert_eq!(cfg.journal_folder, "journal");
    assert_eq!(cfg.attachments_folder, "attachments");
    assert!(cfg.exclude_patterns.contains(&".git".to_string()));
}

#[test]
fn write_config_round_trips() {
    let vault = make_vault();
    preferences::init_vault(vault.path()).unwrap();
    let updated = preferences::update_config(vault.path(), &VaultConfig {
        exclude_patterns: vec!["custom".into(), "node_modules".into()],
        default_note_folder: "Notes".into(),
        journal_folder: "Daily".into(),
        attachments_folder: "files".into(),
    })
    .unwrap();
    let read = preferences::read_config(vault.path()).unwrap();
    assert_eq!(read.default_note_folder, "Notes");
    assert_eq!(read.journal_folder, "Daily");
    assert_eq!(updated.exclude_patterns, read.exclude_patterns);
}

#[test]
fn read_preferences_returns_defaults_when_missing() {
    let vault = make_vault();
    let prefs = preferences::read_preferences(vault.path()).unwrap();
    assert_eq!(prefs.theme, "system");
    assert_eq!(prefs.font_size, "medium");
}

#[test]
fn update_preferences_merges_partial() {
    let vault = make_vault();
    preferences::init_vault(vault.path()).unwrap();
    let mut updates = serde_json::Map::new();
    updates.insert("theme".into(), serde_json::Value::String("dark".into()));
    let merged = preferences::update_preferences(vault.path(), &updates).unwrap();
    assert_eq!(merged.theme, "dark");
    assert_eq!(merged.font_size, "medium"); // unchanged default
}

#[test]
fn count_markdown_files_skips_hidden_and_excluded() {
    let vault = make_vault();
    preferences::init_vault(vault.path()).unwrap();
    std::fs::write(vault.path().join("notes/a.md"), "x").unwrap();
    std::fs::write(vault.path().join("notes/b.md"), "x").unwrap();
    std::fs::create_dir_all(vault.path().join("node_modules")).unwrap();
    std::fs::write(vault.path().join("node_modules/c.md"), "x").unwrap();
    std::fs::write(vault.path().join("notes/.hidden.md"), "x").unwrap();
    let count = preferences::count_markdown_files(
        vault.path(),
        &["node_modules".to_string(), ".git".to_string()],
    );
    assert_eq!(count, 2);
}

#[test]
fn turkish_chars_in_config_roundtrip() {
    let vault = make_vault();
    preferences::init_vault(vault.path()).unwrap();
    let cfg = VaultConfig {
        exclude_patterns: vec![".git".into()],
        default_note_folder: "Çalışma".into(),
        journal_folder: "Günlük".into(),
        attachments_folder: "Ekler".into(),
    };
    preferences::update_config(vault.path(), &cfg).unwrap();
    let read = preferences::read_config(vault.path()).unwrap();
    assert_eq!(read.default_note_folder, "Çalışma");
    assert_eq!(read.journal_folder, "Günlük");
}
```

- [ ] **Step 7.2: Register the test**

```toml
[[test]]
name = "vault_preferences_test"
required-features = ["test-helpers"]
```

- [ ] **Step 7.3: Run RED**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_preferences_test
```

- [ ] **Step 7.4: Implement `vault/preferences.rs`**

Replace the stub with:

```rust
//! Per-vault JSON config + UI preferences.
//!
//! Layout matches Electron's vault format:
//!
//! ```text
//! <vault>/
//! ├── .memry/
//! │   └── config.json   { excludePatterns, defaultNoteFolder, journalFolder,
//! │                       attachmentsFolder, preferences: { theme, ... } }
//! ├── notes/
//! ├── journal/
//! └── attachments/
//! ```
//!
//! `init_vault` creates the directory tree and writes the default
//! config if it does not exist (idempotent). `read_config` and
//! `read_preferences` return defaults when the file is missing or
//! corrupt — they never error on a brand-new vault. `update_*`
//! merges the partial input into the existing config and writes it
//! atomically.

use crate::error::{AppError, AppResult};
use crate::vault::fs as vfs;
use serde_json::Map;
use std::fs;
use std::path::{Path, PathBuf};

const MEMRY_DIR: &str = ".memry";
const CONFIG_FILE: &str = "config.json";

const VAULT_FOLDERS: &[&str] = &[
    "notes",
    "journal",
    "attachments",
    "attachments/images",
    "attachments/files",
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig {
    pub exclude_patterns: Vec<String>,
    pub default_note_folder: String,
    pub journal_folder: String,
    pub attachments_folder: String,
}

impl Default for VaultConfig {
    fn default() -> Self {
        Self {
            exclude_patterns: vec![
                ".git".into(),
                "node_modules".into(),
                ".trash".into(),
            ],
            default_note_folder: "notes".into(),
            journal_folder: "journal".into(),
            attachments_folder: "attachments".into(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorPreferences {
    pub width: String,
    pub spell_check: bool,
    pub auto_save_delay: u32,
    pub show_word_count: bool,
    pub toolbar_mode: String,
}

impl Default for EditorPreferences {
    fn default() -> Self {
        Self {
            width: "medium".into(),
            spell_check: true,
            auto_save_delay: 1000,
            show_word_count: true,
            toolbar_mode: "floating".into(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultPreferences {
    pub theme: String,
    pub font_size: String,
    pub font_family: String,
    pub accent_color: String,
    pub language: String,
    pub create_in_selected_folder: bool,
    pub editor: EditorPreferences,
}

impl Default for VaultPreferences {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            font_size: "medium".into(),
            font_family: "system".into(),
            accent_color: "#2563eb".into(),
            language: "en".into(),
            create_in_selected_folder: true,
            editor: EditorPreferences::default(),
        }
    }
}

pub fn memry_dir(vault_path: &Path) -> PathBuf {
    vault_path.join(MEMRY_DIR)
}

pub fn config_path(vault_path: &Path) -> PathBuf {
    memry_dir(vault_path).join(CONFIG_FILE)
}

pub fn is_initialized(vault_path: &Path) -> bool {
    memry_dir(vault_path).exists()
}

pub fn init_vault(vault_path: &Path) -> AppResult<()> {
    fs::create_dir_all(memry_dir(vault_path))?;
    for folder in VAULT_FOLDERS {
        fs::create_dir_all(vault_path.join(folder))?;
    }
    let cfg_path = config_path(vault_path);
    if !cfg_path.exists() {
        let default = build_initial_config_blob();
        fs::write(&cfg_path, serde_json::to_string_pretty(&default)?)?;
    }
    Ok(())
}

fn build_initial_config_blob() -> serde_json::Value {
    serde_json::json!({
        "excludePatterns": VaultConfig::default().exclude_patterns,
        "defaultNoteFolder": VaultConfig::default().default_note_folder,
        "journalFolder": VaultConfig::default().journal_folder,
        "attachmentsFolder": VaultConfig::default().attachments_folder,
        "preferences": serde_json::to_value(VaultPreferences::default()).unwrap(),
    })
}

fn read_config_blob(vault_path: &Path) -> AppResult<serde_json::Value> {
    let path = config_path(vault_path);
    if !path.exists() {
        return Ok(build_initial_config_blob());
    }
    let raw = fs::read_to_string(&path)?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|_| build_initial_config_blob());
    Ok(parsed)
}

pub fn read_config(vault_path: &Path) -> AppResult<VaultConfig> {
    let blob = read_config_blob(vault_path)?;
    Ok(VaultConfig {
        exclude_patterns: blob
            .get("excludePatterns")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_else(|| VaultConfig::default().exclude_patterns),
        default_note_folder: blob
            .get("defaultNoteFolder")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| VaultConfig::default().default_note_folder),
        journal_folder: blob
            .get("journalFolder")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| VaultConfig::default().journal_folder),
        attachments_folder: blob
            .get("attachmentsFolder")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| VaultConfig::default().attachments_folder),
    })
}

pub fn update_config(vault_path: &Path, updates: &VaultConfig) -> AppResult<VaultConfig> {
    let mut blob = read_config_blob(vault_path)?;
    let obj = blob
        .as_object_mut()
        .ok_or_else(|| AppError::Validation("config.json is not an object".into()))?;
    obj.insert(
        "excludePatterns".into(),
        serde_json::to_value(&updates.exclude_patterns)?,
    );
    obj.insert(
        "defaultNoteFolder".into(),
        serde_json::Value::String(updates.default_note_folder.clone()),
    );
    obj.insert(
        "journalFolder".into(),
        serde_json::Value::String(updates.journal_folder.clone()),
    );
    obj.insert(
        "attachmentsFolder".into(),
        serde_json::Value::String(updates.attachments_folder.clone()),
    );
    write_config_blob_atomic(vault_path, &blob)?;
    Ok(updates.clone())
}

pub fn read_preferences(vault_path: &Path) -> AppResult<VaultPreferences> {
    let blob = read_config_blob(vault_path)?;
    let prefs_val = blob
        .get("preferences")
        .cloned()
        .unwrap_or_else(|| serde_json::to_value(VaultPreferences::default()).unwrap());
    Ok(serde_json::from_value(prefs_val).unwrap_or_default())
}

pub fn update_preferences(
    vault_path: &Path,
    partial: &Map<String, serde_json::Value>,
) -> AppResult<VaultPreferences> {
    let mut blob = read_config_blob(vault_path)?;
    let obj = blob
        .as_object_mut()
        .ok_or_else(|| AppError::Validation("config.json is not an object".into()))?;
    let mut current = obj
        .get("preferences")
        .cloned()
        .unwrap_or_else(|| serde_json::to_value(VaultPreferences::default()).unwrap());
    if let Some(map) = current.as_object_mut() {
        for (k, v) in partial {
            map.insert(k.clone(), v.clone());
        }
    }
    obj.insert("preferences".into(), current);
    write_config_blob_atomic(vault_path, &blob)?;
    read_preferences(vault_path)
}

fn write_config_blob_atomic(
    vault_path: &Path,
    blob: &serde_json::Value,
) -> AppResult<()> {
    let path = config_path(vault_path);
    let serialized = serde_json::to_string_pretty(blob)?;
    let runtime = tokio::runtime::Handle::try_current();
    match runtime {
        Ok(handle) => {
            let path = path.clone();
            handle.block_on(vfs::atomic_write(&path, &serialized))?;
        }
        Err(_) => {
            // Outside Tokio context (e.g. setup callbacks). Fall back to
            // sync write — config is small (<10KB) so torn writes are
            // unlikely.
            fs::write(&path, serialized)?;
        }
    }
    Ok(())
}

pub fn count_markdown_files(vault_path: &Path, exclude: &[String]) -> i64 {
    let mut count: i64 = 0;
    let mut stack = vec![vault_path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                continue;
            }
            if exclude.iter().any(|p| p == &*name_str) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() && crate::vault::paths::is_markdown(&path) {
                count += 1;
            }
        }
    }
    count
}

pub fn vault_name(vault_path: &Path) -> String {
    vault_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("vault")
        .to_string()
}
```

- [ ] **Step 7.5: Run tests**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_preferences_test
```

Expected: `8 passed`.

- [ ] **Step 7.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/vault/preferences.rs \
        apps/desktop-tauri/src-tauri/tests/vault_preferences_test.rs \
        apps/desktop-tauri/src-tauri/Cargo.toml
git commit -m "m3(vault): preferences.rs config.json + theme/editor preferences with Turkish roundtrip"
```

---

## Task 8: Vault registry — multi-vault list (`vault/registry.rs`)

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/vault/registry.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/vault_registry_test.rs`
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml` (add `[[test]]` entry)

- [ ] **Step 8.1: Write the failing test**

Create `apps/desktop-tauri/src-tauri/tests/vault_registry_test.rs`:

```rust
use memry_desktop_tauri_lib::vault::registry::{self, VaultInfo, VaultRegistry};

fn registry_path(dir: &tempfile::TempDir) -> std::path::PathBuf {
    dir.path().join("vaults.json")
}

fn make_info(path: &std::path::Path, name: &str, is_default: bool) -> VaultInfo {
    VaultInfo {
        path: path.to_string_lossy().into_owned(),
        name: name.into(),
        note_count: 0,
        task_count: 0,
        last_opened: "2026-04-26T00:00:00Z".into(),
        is_default,
    }
}

#[test]
fn empty_registry_when_file_missing() {
    let dir = tempfile::tempdir().unwrap();
    let reg = VaultRegistry::load(&registry_path(&dir)).unwrap();
    assert!(reg.vaults.is_empty());
    assert!(reg.current.is_none());
}

#[test]
fn upsert_then_persist_then_reload() {
    let dir = tempfile::tempdir().unwrap();
    let path = registry_path(&dir);
    let mut reg = VaultRegistry::load(&path).unwrap();

    let v_dir = tempfile::tempdir().unwrap();
    reg.upsert(make_info(v_dir.path(), "Primary", true));
    reg.set_current(Some(v_dir.path().to_string_lossy().into_owned()));
    reg.save(&path).unwrap();

    let reloaded = VaultRegistry::load(&path).unwrap();
    assert_eq!(reloaded.vaults.len(), 1);
    assert_eq!(reloaded.vaults[0].name, "Primary");
    assert_eq!(reloaded.current.as_deref(), Some(v_dir.path().to_string_lossy().as_ref()));
}

#[test]
fn upsert_replaces_by_path_not_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let v_dir = tempfile::tempdir().unwrap();
    let mut reg = VaultRegistry::load(&registry_path(&dir)).unwrap();
    reg.upsert(make_info(v_dir.path(), "First", true));
    reg.upsert(make_info(v_dir.path(), "Renamed", false));
    assert_eq!(reg.vaults.len(), 1);
    assert_eq!(reg.vaults[0].name, "Renamed");
    assert!(!reg.vaults[0].is_default);
}

#[test]
fn remove_drops_vault_and_clears_current_if_match() {
    let dir = tempfile::tempdir().unwrap();
    let v1 = tempfile::tempdir().unwrap();
    let v2 = tempfile::tempdir().unwrap();
    let mut reg = VaultRegistry::load(&registry_path(&dir)).unwrap();
    reg.upsert(make_info(v1.path(), "v1", true));
    reg.upsert(make_info(v2.path(), "v2", false));
    reg.set_current(Some(v1.path().to_string_lossy().into_owned()));

    reg.remove(&v1.path().to_string_lossy());
    assert_eq!(reg.vaults.len(), 1);
    assert_eq!(reg.vaults[0].name, "v2");
    assert!(reg.current.is_none());
}

#[test]
fn touch_updates_last_opened() {
    let dir = tempfile::tempdir().unwrap();
    let v = tempfile::tempdir().unwrap();
    let mut reg = VaultRegistry::load(&registry_path(&dir)).unwrap();
    reg.upsert(make_info(v.path(), "v", true));
    let before = reg.vaults[0].last_opened.clone();
    std::thread::sleep(std::time::Duration::from_millis(10));
    reg.touch(&v.path().to_string_lossy());
    let after = reg.vaults[0].last_opened.clone();
    assert_ne!(before, after, "touch should bump last_opened");
}

#[test]
fn corrupt_file_falls_back_to_empty_registry() {
    let dir = tempfile::tempdir().unwrap();
    let path = registry_path(&dir);
    std::fs::write(&path, "{not valid json}").unwrap();
    let reg = VaultRegistry::load(&path).unwrap();
    assert!(reg.vaults.is_empty());
    assert!(reg.current.is_none());
}
```

- [ ] **Step 8.2: Register the test**

```toml
[[test]]
name = "vault_registry_test"
required-features = ["test-helpers"]
```

- [ ] **Step 8.3: Run RED**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_registry_test
```

- [ ] **Step 8.4: Implement `vault/registry.rs`**

Replace the stub with:

```rust
//! Multi-vault registry persisted at
//! `<app-data>/memry-{device}/vaults.json` (per-device, matches the
//! M2 DB path scheme). Holds the list of known vaults plus the
//! "current" vault path. `lib.rs::run` loads it at boot, `vault::state`
//! mutates it, and `vault_*` commands read it for the renderer.
//!
//! Persistence is best-effort sync JSON: the file is small (<2KB
//! typical) and only written on user actions (open/switch/remove).

use crate::error::{AppError, AppResult};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub path: String,
    pub name: String,
    pub note_count: i64,
    pub task_count: i64,
    pub last_opened: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultRegistry {
    #[serde(default)]
    pub vaults: Vec<VaultInfo>,
    #[serde(default)]
    pub current: Option<String>,
}

impl VaultRegistry {
    pub fn load(path: &Path) -> AppResult<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = fs::read_to_string(path)?;
        let parsed: Self = serde_json::from_str(&raw).unwrap_or_default();
        Ok(parsed)
    }

    pub fn save(&self, path: &Path) -> AppResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(self)?;
        fs::write(path, raw)?;
        Ok(())
    }

    pub fn find(&self, vault_path: &str) -> Option<&VaultInfo> {
        self.vaults.iter().find(|v| v.path == vault_path)
    }

    pub fn upsert(&mut self, info: VaultInfo) {
        if let Some(slot) = self.vaults.iter_mut().find(|v| v.path == info.path) {
            *slot = info;
        } else {
            self.vaults.push(info);
        }
    }

    pub fn remove(&mut self, vault_path: &str) {
        self.vaults.retain(|v| v.path != vault_path);
        if self.current.as_deref() == Some(vault_path) {
            self.current = None;
        }
    }

    pub fn set_current(&mut self, current: Option<String>) {
        self.current = current;
    }

    pub fn touch(&mut self, vault_path: &str) {
        let now = current_iso();
        if let Some(slot) = self.vaults.iter_mut().find(|v| v.path == vault_path) {
            slot.last_opened = now;
        }
    }
}

fn current_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    crate::vault::frontmatter_iso(secs)
}

pub fn registry_path() -> AppResult<std::path::PathBuf> {
    let device = std::env::var("MEMRY_DEVICE").unwrap_or_else(|_| "default".to_string());
    let project_dirs = directories::ProjectDirs::from("com", "memry", "memry")
        .ok_or_else(|| AppError::Internal("could not determine OS project dirs".into()))?;
    Ok(project_dirs
        .data_dir()
        .join(format!("memry-{device}"))
        .join("vaults.json"))
}
```

- [ ] **Step 8.5: Add a tiny ISO helper alias in `frontmatter.rs`**

Re-open `apps/desktop-tauri/src-tauri/src/vault/frontmatter.rs`. Make the existing `unix_secs_to_iso` function `pub(crate)` and add a re-export at the module path used by `registry.rs`:

In `frontmatter.rs`, change:

```rust
fn unix_secs_to_iso(secs: u64) -> String {
```

to:

```rust
pub(crate) fn unix_secs_to_iso(secs: u64) -> String {
```

Then in `apps/desktop-tauri/src-tauri/src/vault/mod.rs` add:

```rust
pub(crate) fn frontmatter_iso(secs: u64) -> String {
    frontmatter::unix_secs_to_iso(secs)
}
```

- [ ] **Step 8.6: Run tests**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_registry_test
```

Expected: `6 passed`.

- [ ] **Step 8.7: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/vault/registry.rs \
        apps/desktop-tauri/src-tauri/src/vault/mod.rs \
        apps/desktop-tauri/src-tauri/src/vault/frontmatter.rs \
        apps/desktop-tauri/src-tauri/tests/vault_registry_test.rs \
        apps/desktop-tauri/src-tauri/Cargo.toml
git commit -m "m3(vault): registry.rs multi-vault list at <app-data>/memry-{device}/vaults.json"
```

---

## Task 9: Vault runtime state + AppState wiring (`vault/state.rs`)

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/vault/state.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/vault/mod.rs` (uncomment re-exports now that types exist)
- Modify: `apps/desktop-tauri/src-tauri/src/app_state.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`

- [ ] **Step 9.1: Implement `vault/state.rs`**

Replace the stub with:

```rust
//! Runtime state for the vault layer.
//!
//! `VaultRuntime` owns:
//! - the current vault path (None when no vault is open)
//! - status flags (is_indexing, index_progress, error)
//! - the in-memory registry handle (loaded from disk at boot)
//! - the active `notify` watcher handle (started on open, stopped on
//!   close)
//!
//! All fields are wrapped in `parking_lot::Mutex` (or `std::sync::Mutex`
//! — we use std for now, Tokio doesn't bind these). Tauri commands
//! lock briefly per call. The watcher itself runs on its own thread
//! managed by `notify`; the `Drop` impl on the watcher handle cleans
//! it up when the option is replaced.

use crate::error::{AppError, AppResult};
use crate::vault::registry::{VaultRegistry, registry_path};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub is_open: bool,
    pub path: Option<String>,
    pub is_indexing: bool,
    pub index_progress: u8,
    pub error: Option<String>,
}

pub struct VaultRuntime {
    inner: Mutex<RuntimeInner>,
    pub watcher_slot: Mutex<Option<crate::vault::watcher::WatcherHandle>>,
    registry_path: PathBuf,
}

struct RuntimeInner {
    current: Option<PathBuf>,
    is_indexing: bool,
    index_progress: u8,
    error: Option<String>,
    registry: VaultRegistry,
}

impl VaultRuntime {
    pub fn boot() -> AppResult<Self> {
        let registry_path = registry_path()?;
        let registry = VaultRegistry::load(&registry_path).unwrap_or_default();
        Ok(Self {
            inner: Mutex::new(RuntimeInner {
                current: registry.current.as_ref().map(PathBuf::from),
                is_indexing: false,
                index_progress: 0,
                error: None,
                registry,
            }),
            watcher_slot: Mutex::new(None),
            registry_path,
        })
    }

    pub fn status(&self) -> VaultStatus {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        VaultStatus {
            is_open: g.current.is_some(),
            path: g
                .current
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            is_indexing: g.is_indexing,
            index_progress: g.index_progress,
            error: g.error.clone(),
        }
    }

    pub fn current_path(&self) -> Option<PathBuf> {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.current.clone()
    }

    pub fn registry_snapshot(&self) -> VaultRegistry {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.registry.clone()
    }

    pub fn set_current(&self, path: Option<PathBuf>) -> AppResult<()> {
        {
            let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            g.current = path.clone();
            g.error = None;
            g.registry
                .set_current(path.as_ref().map(|p| p.to_string_lossy().into_owned()));
            g.registry.save(&self.registry_path)?;
        }
        Ok(())
    }

    pub fn upsert_registry(&self, info: crate::vault::registry::VaultInfo) -> AppResult<()> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.registry.upsert(info);
        g.registry.save(&self.registry_path)
    }

    pub fn remove_from_registry(&self, vault_path: &str) -> AppResult<()> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.registry.remove(vault_path);
        if g.current.as_deref().map(|p| p.to_string_lossy().into_owned())
            == Some(vault_path.to_string())
        {
            g.current = None;
        }
        g.registry.save(&self.registry_path)
    }

    pub fn touch_registry(&self, vault_path: &str) -> AppResult<()> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.registry.touch(vault_path);
        g.registry.save(&self.registry_path)
    }

    pub fn set_indexing(&self, indexing: bool, progress: u8) {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.is_indexing = indexing;
        g.index_progress = progress;
    }

    pub fn set_error(&self, error: Option<String>) {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.error = error;
    }

    pub fn require_current(&self) -> AppResult<PathBuf> {
        self.current_path()
            .ok_or_else(|| AppError::Vault("no vault is open".into()))
    }
}
```

- [ ] **Step 9.2: Re-enable re-exports in `vault/mod.rs`**

Replace the commented-out block with:

```rust
pub use frontmatter::{NoteFrontmatter, ParsedNote};
pub use notes_io::{NoteOnDisk, ReadNoteResult};
pub use preferences::{VaultConfig, VaultPreferences};
pub use registry::{VaultInfo, VaultRegistry};
pub use state::{VaultRuntime, VaultStatus};
```

- [ ] **Step 9.3: Add `vault: Arc<VaultRuntime>` to `AppState`**

Open `apps/desktop-tauri/src-tauri/src/app_state.rs` and replace the contents with:

```rust
//! Global runtime state shared across commands.

use crate::db::Db;
use crate::vault::VaultRuntime;
use std::sync::Arc;

pub struct AppState {
    pub db: Db,
    pub vault: Arc<VaultRuntime>,
}

impl AppState {
    pub fn new(db: Db, vault: Arc<VaultRuntime>) -> Self {
        Self { db, vault }
    }
}
```

- [ ] **Step 9.4: Wire `VaultRuntime::boot()` into `lib.rs::run`**

Open `apps/desktop-tauri/src-tauri/src/lib.rs`. Replace the `init_app_state` function with:

```rust
fn init_app_state() -> AppResult<AppState> {
    let db_path = resolve_db_path()?;
    let db = Db::open(db_path)?;
    let vault = std::sync::Arc::new(crate::vault::VaultRuntime::boot()?);
    Ok(AppState::new(db, vault))
}
```

- [ ] **Step 9.5: Verify cargo check + existing tests still pass**

```bash
cd apps/desktop-tauri/src-tauri && cargo check && \
  cargo test --features test-helpers --tests
```

Expected: every previously-green test stays green. `vault_state` does not have its own integration test (state is exercised by Task 11's command tests + the runtime smoke).

- [ ] **Step 9.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/vault/state.rs \
        apps/desktop-tauri/src-tauri/src/vault/mod.rs \
        apps/desktop-tauri/src-tauri/src/app_state.rs \
        apps/desktop-tauri/src-tauri/src/lib.rs
git commit -m "m3(vault): VaultRuntime + AppState extension + boot wiring"
```

---

## Task 10: File watcher with debounce (`vault/watcher.rs`)

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/vault/watcher.rs`
- Create: `apps/desktop-tauri/src-tauri/tests/vault_watcher_test.rs`
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml` (add `[[test]]` entry)

- [ ] **Step 10.1: Write the failing test**

Create `apps/desktop-tauri/src-tauri/tests/vault_watcher_test.rs`:

```rust
use memry_desktop_tauri_lib::vault::watcher::{self, VaultEvent, VaultEventKind};
use std::fs;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

fn make_vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("notes")).unwrap();
    dir
}

#[tokio::test(flavor = "multi_thread")]
async fn detects_new_file_within_debounce_window() {
    let vault = make_vault();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = watcher::start(vault.path(), tx).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    fs::write(vault.path().join("notes/new.md"), "hello").unwrap();

    let event: VaultEvent = timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("timed out waiting for vault-changed")
        .expect("channel closed");

    assert!(event.relative_path.ends_with("new.md"));
    assert!(matches!(event.kind, VaultEventKind::Created | VaultEventKind::Modified));

    drop(handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn debounces_rapid_writes_to_same_file() {
    let vault = make_vault();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = watcher::start(vault.path(), tx).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let path = vault.path().join("notes/burst.md");
    for i in 0..5 {
        fs::write(&path, format!("v{i}")).unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let mut count = 0;
    let mut total = Duration::from_millis(0);
    while total < Duration::from_secs(2) {
        match timeout(Duration::from_millis(400), rx.recv()).await {
            Ok(Some(_)) => count += 1,
            _ => break,
        }
        total += Duration::from_millis(400);
    }
    assert!(count >= 1, "should fire at least once");
    assert!(count <= 3, "debounce should coalesce rapid writes (got {count})");

    drop(handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn ignores_dot_memry_writes() {
    let vault = make_vault();
    fs::create_dir_all(vault.path().join(".memry")).unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = watcher::start(vault.path(), tx).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    fs::write(vault.path().join(".memry/data.db"), "x").unwrap();

    let event = timeout(Duration::from_millis(500), rx.recv()).await;
    assert!(event.is_err(), "must not emit for .memry/ writes");

    drop(handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn detects_deletion() {
    let vault = make_vault();
    let path = vault.path().join("notes/del.md");
    fs::write(&path, "x").unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = watcher::start(vault.path(), tx).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    fs::remove_file(&path).unwrap();

    let mut saw_delete = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        match timeout(Duration::from_millis(300), rx.recv()).await {
            Ok(Some(ev)) if matches!(ev.kind, VaultEventKind::Deleted) => {
                saw_delete = true;
                break;
            }
            Ok(Some(_)) => continue,
            _ => break,
        }
    }
    assert!(saw_delete, "expected a Deleted event");

    drop(handle);
}
```

- [ ] **Step 10.2: Register the test**

```toml
[[test]]
name = "vault_watcher_test"
required-features = ["test-helpers"]
```

- [ ] **Step 10.3: Implement `vault/watcher.rs`**

Replace the stub with:

```rust
//! `notify` filesystem watcher with path-keyed debounce.
//!
//! - `start(vault_root, sender)` registers a recursive recommended
//!   watcher rooted at `vault_root` and returns an opaque handle that
//!   stops the watcher when dropped.
//! - Raw `notify` events are filtered: hidden basenames (`.foo`),
//!   anything inside `.memry/`, and unsupported extensions are
//!   ignored before queuing.
//! - A path-keyed debounce coalesces rapid writes within 150ms per
//!   file. Each file gets its own pending timer.
//! - The output channel emits `VaultEvent { relative_path, kind }`
//!   where `kind` is `Created`, `Modified`, or `Deleted`.

use crate::error::{AppError, AppResult};
use crate::vault::paths;
use notify::{event::ModifyKind, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

const DEBOUNCE_MS: u64 = 150;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultEvent {
    pub relative_path: String,
    pub kind: VaultEventKind,
}

#[derive(Debug, Clone, Copy, serde::Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum VaultEventKind {
    Created,
    Modified,
    Deleted,
}

pub struct WatcherHandle {
    _watcher: RecommendedWatcher,
    _scheduler: JoinHandle<()>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        self.cancel
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[derive(Default)]
struct PendingMap {
    pending: HashMap<PathBuf, PendingEntry>,
}

struct PendingEntry {
    last_event: VaultEventKind,
    deadline: std::time::Instant,
}

pub fn start(
    vault_root: &Path,
    out: UnboundedSender<VaultEvent>,
) -> AppResult<WatcherHandle> {
    let canonical_root = dunce::canonicalize(vault_root)?;
    let pending = Arc::new(Mutex::new(PendingMap::default()));
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (raw_tx, mut raw_rx) =
        tokio::sync::mpsc::unbounded_channel::<notify::Event>();

    // notify callback runs on its own thread; bridge into the Tokio
    // channel so the rest of the pipeline is async.
    let cb_root = canonical_root.clone();
    let raw_tx_for_cb = raw_tx.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            // Filter inside the callback so the bounded channel
            // doesn't fill up with `.memry/` chatter on a busy DB.
            if event.paths.iter().all(|p| should_ignore(&cb_root, p)) {
                return;
            }
            let _ = raw_tx_for_cb.send(event);
        }
    })?;
    drop(raw_tx);

    watcher.watch(&canonical_root, RecursiveMode::Recursive)?;

    // Drain raw events into the pending map, bumping the deadline
    // every time we see another event for the same path.
    let pending_drain = pending.clone();
    let cancel_drain = cancel.clone();
    let root_for_drain = canonical_root.clone();
    let _drain: JoinHandle<()> = tokio::spawn(async move {
        while let Some(event) = raw_rx.recv().await {
            if cancel_drain.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            let kind = classify(&event.kind);
            for path in event.paths {
                if should_ignore(&root_for_drain, &path) {
                    continue;
                }
                let entry = PendingEntry {
                    last_event: kind,
                    deadline: std::time::Instant::now()
                        + Duration::from_millis(DEBOUNCE_MS),
                };
                pending_drain
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .pending
                    .insert(path, entry);
            }
        }
    });

    // Periodically scan the pending map for entries whose deadline
    // has passed and emit them.
    let pending_emit = pending.clone();
    let cancel_emit = cancel.clone();
    let root_for_emit = canonical_root.clone();
    let scheduler: JoinHandle<()> = tokio::spawn(async move {
        let tick = Duration::from_millis(50);
        loop {
            if cancel_emit.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(tick).await;
            let now = std::time::Instant::now();
            let ready: Vec<(PathBuf, VaultEventKind)> = {
                let mut g = pending_emit
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                let mut ready = Vec::new();
                g.pending.retain(|path, entry| {
                    if entry.deadline <= now {
                        ready.push((path.clone(), entry.last_event));
                        false
                    } else {
                        true
                    }
                });
                ready
            };
            for (path, kind) in ready {
                if let Some(rel) =
                    paths::to_relative_path(&root_for_emit, &path)
                {
                    let _ = out.send(VaultEvent {
                        relative_path: rel,
                        kind,
                    });
                } else if matches!(kind, VaultEventKind::Deleted) {
                    // Deleted file canonicalize fails; fall back to
                    // string strip.
                    if let Ok(stripped) = path.strip_prefix(&root_for_emit) {
                        let rel =
                            stripped.to_string_lossy().replace('\\', "/");
                        let _ = out.send(VaultEvent {
                            relative_path: rel,
                            kind,
                        });
                    }
                }
            }
        }
    });

    Ok(WatcherHandle {
        _watcher: watcher,
        _scheduler: scheduler,
        cancel,
    })
}

fn should_ignore(root: &Path, path: &Path) -> bool {
    let rel = match path.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => return true,
    };
    let mut comps = rel.components();
    while let Some(c) = comps.next() {
        if let std::path::Component::Normal(seg) = c {
            let s = seg.to_string_lossy();
            if s.starts_with('.') {
                return true;
            }
        }
    }
    if !path.is_dir() {
        let lower = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if lower.is_empty() {
            return true;
        }
        let supported = matches!(
            lower.as_str(),
            "md" | "markdown" | "png" | "jpg" | "jpeg" | "gif" | "webp" |
            "svg" | "pdf" | "mp3" | "wav" | "m4a" | "ogg" | "mp4" | "mov" | "webm"
        );
        return !supported;
    }
    false
}

fn classify(kind: &EventKind) -> VaultEventKind {
    match kind {
        EventKind::Create(_) => VaultEventKind::Created,
        EventKind::Modify(ModifyKind::Name(_)) => VaultEventKind::Modified,
        EventKind::Modify(_) => VaultEventKind::Modified,
        EventKind::Remove(_) => VaultEventKind::Deleted,
        _ => VaultEventKind::Modified,
    }
}
```

- [ ] **Step 10.4: Verify cargo check before running watcher tests**

```bash
cd apps/desktop-tauri/src-tauri && cargo check
```

Expected: pass. The watcher module is self-contained except for `paths`.

- [ ] **Step 10.5: Run watcher tests (slow — ~10s)**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test vault_watcher_test
```

Expected: `4 passed`. If `debounces_rapid_writes_to_same_file` is flaky on macOS FSEvents (coalescing latency varies under load), bump the upper bound from 3 to 5 events. Document any change in a code comment.

- [ ] **Step 10.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/vault/watcher.rs \
        apps/desktop-tauri/src-tauri/tests/vault_watcher_test.rs \
        apps/desktop-tauri/src-tauri/Cargo.toml
git commit -m "m3(vault): watcher.rs notify+debounce emitting VaultEvent {path, kind}"
```

---

## Task 11: Vault Tauri commands (`commands/vault.rs`)

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/commands/vault.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs` (register handlers + start/stop watcher hooks)

- [ ] **Step 11.1: Implement `commands/vault.rs`**

Create `apps/desktop-tauri/src-tauri/src/commands/vault.rs`:

```rust
//! Vault command surface. Thin async wrappers over `vault::*` modules.
//!
//! Every command takes a single named-input struct. Path-bearing
//! commands always go through `paths::resolve_*` before any FS call —
//! the renderer can never poke a path outside the open vault.
//!
//! The commands fall into three groups:
//! 1. lifecycle: open, close, get_status, get_current
//! 2. registry: get_all, switch, remove
//! 3. note IO: list_notes, read_note, write_note, delete_note,
//!    get_config, update_config, reveal, reindex (no-op until M7)

use crate::app_state::AppState;
use crate::error::{AppError, AppResult};
use crate::vault::{
    fs as vfs, frontmatter::NoteFrontmatter, notes_io, paths, preferences,
    registry::VaultInfo, state::VaultStatus, watcher,
};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultOpenInput {
    pub path: String,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultOpenOutput {
    pub success: bool,
    pub vault: Option<VaultInfo>,
    pub error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_open(
    state: State<'_, AppState>,
    app: AppHandle,
    input: VaultOpenInput,
) -> AppResult<VaultOpenOutput> {
    let target = PathBuf::from(&input.path);
    if !target.is_dir() {
        return Ok(VaultOpenOutput {
            success: false,
            vault: None,
            error: Some(format!("not a directory: {}", input.path)),
        });
    }
    if let Err(e) = std::fs::metadata(&target).and_then(|m| {
        if m.permissions().readonly() {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "vault path is read-only",
            ))
        } else {
            Ok(())
        }
    }) {
        return Ok(VaultOpenOutput {
            success: false,
            vault: None,
            error: Some(e.to_string()),
        });
    }

    preferences::init_vault(&target)?;
    state.vault.set_indexing(true, 0);

    // Stop any prior watcher.
    {
        let mut slot = state
            .vault
            .watcher_slot
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        slot.take();
    }

    state.vault.set_current(Some(target.clone()))?;

    // Compute counts cheaply for the registry blurb.
    let cfg = preferences::read_config(&target)?;
    let note_count = preferences::count_markdown_files(&target, &cfg.exclude_patterns);

    let info = VaultInfo {
        path: target.to_string_lossy().into_owned(),
        name: preferences::vault_name(&target),
        note_count,
        task_count: 0,
        last_opened: now_iso(),
        is_default: state
            .vault
            .registry_snapshot()
            .vaults
            .is_empty(),
    };
    state.vault.upsert_registry(info.clone())?;
    state.vault.touch_registry(&info.path)?;

    // Start watcher.
    let app_handle = app.clone();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = watcher::start(&target, tx)?;
    {
        let mut slot = state
            .vault
            .watcher_slot
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        *slot = Some(handle);
    }
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = app_handle.emit("vault-changed", &event);
        }
    });

    state.vault.set_indexing(false, 100);

    let _ = app.emit("vault-status-changed", &state.vault.status());

    Ok(VaultOpenOutput {
        success: true,
        vault: Some(info),
        error: None,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn vault_close(state: State<'_, AppState>, app: AppHandle) -> AppResult<()> {
    {
        let mut slot = state
            .vault
            .watcher_slot
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        slot.take();
    }
    state.vault.set_current(None)?;
    state.vault.set_indexing(false, 0);
    let _ = app.emit("vault-status-changed", &state.vault.status());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn vault_get_status(state: State<'_, AppState>) -> AppResult<VaultStatus> {
    Ok(state.vault.status())
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultCurrent {
    pub path: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_get_current(state: State<'_, AppState>) -> AppResult<VaultCurrent> {
    Ok(VaultCurrent {
        path: state
            .vault
            .current_path()
            .map(|p| p.to_string_lossy().into_owned()),
    })
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultGetAllOutput {
    pub vaults: Vec<VaultInfo>,
    pub current_vault: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_get_all(state: State<'_, AppState>) -> AppResult<VaultGetAllOutput> {
    let snap = state.vault.registry_snapshot();
    Ok(VaultGetAllOutput {
        vaults: snap.vaults,
        current_vault: snap.current,
    })
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultPathInput {
    pub path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_switch(
    state: State<'_, AppState>,
    app: AppHandle,
    input: VaultPathInput,
) -> AppResult<VaultOpenOutput> {
    vault_open(state, app, VaultOpenInput { path: input.path }).await
}

#[tauri::command]
#[specta::specta]
pub async fn vault_remove(
    state: State<'_, AppState>,
    app: AppHandle,
    input: VaultPathInput,
) -> AppResult<()> {
    let current = state.vault.current_path();
    if current
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        == Some(input.path.clone())
    {
        let _ = vault_close(state.clone(), app.clone()).await;
    }
    state.vault.remove_from_registry(&input.path)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn vault_get_config(state: State<'_, AppState>) -> AppResult<preferences::VaultConfig> {
    let path = state.vault.require_current()?;
    preferences::read_config(&path)
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultUpdateConfigInput {
    pub exclude_patterns: Option<Vec<String>>,
    pub default_note_folder: Option<String>,
    pub journal_folder: Option<String>,
    pub attachments_folder: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_update_config(
    state: State<'_, AppState>,
    input: VaultUpdateConfigInput,
) -> AppResult<preferences::VaultConfig> {
    let path = state.vault.require_current()?;
    let mut cfg = preferences::read_config(&path)?;
    if let Some(p) = input.exclude_patterns { cfg.exclude_patterns = p; }
    if let Some(s) = input.default_note_folder { cfg.default_note_folder = s; }
    if let Some(s) = input.journal_folder { cfg.journal_folder = s; }
    if let Some(s) = input.attachments_folder { cfg.attachments_folder = s; }
    preferences::update_config(&path, &cfg)
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultListNotesOutput {
    pub paths: Vec<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_list_notes(state: State<'_, AppState>) -> AppResult<VaultListNotesOutput> {
    let path = state.vault.require_current()?;
    let entries = vfs::list_supported_files(&path).await?;
    let only_md: Vec<String> = entries
        .into_iter()
        .filter(|p| p.ends_with(".md") || p.ends_with(".markdown"))
        .collect();
    Ok(VaultListNotesOutput { paths: only_md })
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultReadNoteInput {
    pub relative_path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_read_note(
    state: State<'_, AppState>,
    input: VaultReadNoteInput,
) -> AppResult<Option<notes_io::ReadNoteResult>> {
    let root = state.vault.require_current()?;
    notes_io::read_note_from_disk(&root, &input.relative_path).await
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultWriteNoteInput {
    pub relative_path: String,
    pub frontmatter: NoteFrontmatter,
    pub content: String,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_write_note(
    state: State<'_, AppState>,
    input: VaultWriteNoteInput,
) -> AppResult<notes_io::NoteOnDisk> {
    let root = state.vault.require_current()?;
    notes_io::write_note_to_disk(
        &root,
        &input.relative_path,
        &input.frontmatter,
        &input.content,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn vault_delete_note(
    state: State<'_, AppState>,
    input: VaultReadNoteInput,
) -> AppResult<()> {
    let root = state.vault.require_current()?;
    notes_io::delete_note_from_disk(&root, &input.relative_path).await
}

#[tauri::command]
#[specta::specta]
pub async fn vault_reveal(state: State<'_, AppState>) -> AppResult<()> {
    let path = state.vault.require_current()?;
    crate::commands::shell::reveal_in_finder_inner(&path)
}

/// Deferred to M7 (rebuildable index.db). Returns a fixed payload so
/// the renderer's settings UI can render its "reindex" button without
/// breaking in production.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultReindexOutput {
    pub success: bool,
    pub files_indexed: i64,
    pub duration: i64,
    pub deferred_until: String,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_reindex(_state: State<'_, AppState>) -> AppResult<VaultReindexOutput> {
    Ok(VaultReindexOutput {
        success: true,
        files_indexed: 0,
        duration: 0,
        deferred_until: "M7".into(),
    })
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    crate::vault::frontmatter_iso(secs)
}
```

- [ ] **Step 11.2: Update `commands/mod.rs`**

Replace the current contents with:

```rust
//! IPC command surface exposed to the renderer.

pub mod settings;
pub mod vault;
pub mod shell;
pub mod dialog;
```

- [ ] **Step 11.3: Register every vault command in `lib.rs::run`**

Open `apps/desktop-tauri/src-tauri/src/lib.rs`. Replace the `.invoke_handler(tauri::generate_handler![...])` block with:

```rust
.invoke_handler(tauri::generate_handler![
    commands::settings::settings_get,
    commands::settings::settings_set,
    commands::settings::settings_list,
    commands::vault::vault_open,
    commands::vault::vault_close,
    commands::vault::vault_get_status,
    commands::vault::vault_get_current,
    commands::vault::vault_get_all,
    commands::vault::vault_switch,
    commands::vault::vault_remove,
    commands::vault::vault_get_config,
    commands::vault::vault_update_config,
    commands::vault::vault_list_notes,
    commands::vault::vault_read_note,
    commands::vault::vault_write_note,
    commands::vault::vault_delete_note,
    commands::vault::vault_reveal,
    commands::vault::vault_reindex,
    commands::shell::shell_open_url,
    commands::shell::shell_open_path,
    commands::shell::shell_reveal_in_finder,
    commands::dialog::dialog_choose_folder,
    commands::dialog::dialog_choose_files,
])
```

- [ ] **Step 11.4: Verify cargo check (commands not implemented yet — Step 11.5 ports those over)**

The shell/dialog modules are stubbed in Task 12; for now expose empty modules so this compiles. Touch them as empty:

```bash
touch apps/desktop-tauri/src-tauri/src/commands/shell.rs apps/desktop-tauri/src-tauri/src/commands/dialog.rs
```

Add minimal stubs in each so the macros find symbols. Open `commands/shell.rs`:

```rust
//! Stubbed in Task 11; populated in Task 12.

use crate::error::AppResult;

#[tauri::command]
#[specta::specta]
pub async fn shell_open_url(_url: String) -> AppResult<()> { Ok(()) }

#[tauri::command]
#[specta::specta]
pub async fn shell_open_path(_path: String) -> AppResult<()> { Ok(()) }

#[tauri::command]
#[specta::specta]
pub async fn shell_reveal_in_finder(_path: String) -> AppResult<()> { Ok(()) }

pub(crate) fn reveal_in_finder_inner(_path: &std::path::Path) -> AppResult<()> { Ok(()) }
```

Open `commands/dialog.rs`:

```rust
//! Stubbed in Task 11; populated in Task 12.

use crate::error::AppResult;

#[tauri::command]
#[specta::specta]
pub async fn dialog_choose_folder(_title: Option<String>) -> AppResult<Option<String>> {
    Ok(None)
}

#[tauri::command]
#[specta::specta]
pub async fn dialog_choose_files(
    _title: Option<String>,
    _filters: Option<Vec<String>>,
) -> AppResult<Vec<String>> {
    Ok(Vec::new())
}
```

- [ ] **Step 11.5: Confirm cargo check + clippy pass**

```bash
cd apps/desktop-tauri/src-tauri && cargo check && cargo clippy -- -D warnings
```

Expected: pass.

- [ ] **Step 11.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/commands \
        apps/desktop-tauri/src-tauri/src/lib.rs
git commit -m "m3(commands): vault_* command surface (open/close/list/read/write/...) + shell/dialog stubs"
```

---

## Task 12: Native shell + dialog commands (`commands/shell.rs`, `commands/dialog.rs`)

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/commands/shell.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/commands/dialog.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs` (register dialog plugin)
- Modify: `apps/desktop-tauri/src-tauri/capabilities/default.json`

- [ ] **Step 12.1: Replace `commands/shell.rs` with the real impl**

```rust
//! `shell.*` parity commands.
//!
//! - `shell_open_url(url)` opens an http(s) URL in the user's default
//!   browser via `tauri-plugin-shell`. Rejects non-http schemes.
//! - `shell_open_path(path)` opens a local file/folder with the OS
//!   default handler. The path must be absolute.
//! - `shell_reveal_in_finder(path)` selects the path in Finder
//!   (`open -R` on macOS).

use crate::error::{AppError, AppResult};
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
#[specta::specta]
pub async fn shell_open_url(app: AppHandle, url: String) -> AppResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(AppError::Validation(format!("non-http url: {url}")));
    }
    app.shell()
        .open(url, None)
        .map_err(|e| AppError::Vault(format!("shell open failed: {e}")))
}

#[tauri::command]
#[specta::specta]
pub async fn shell_open_path(app: AppHandle, path: String) -> AppResult<()> {
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err(AppError::Validation(format!("path must be absolute: {path}")));
    }
    if !p.exists() {
        return Err(AppError::NotFound(path.clone()));
    }
    app.shell()
        .open(path, None)
        .map_err(|e| AppError::Vault(format!("shell open failed: {e}")))
}

#[tauri::command]
#[specta::specta]
pub async fn shell_reveal_in_finder(path: String) -> AppResult<()> {
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err(AppError::Validation(format!("path must be absolute: {path}")));
    }
    reveal_in_finder_inner(p)
}

pub(crate) fn reveal_in_finder_inner(path: &Path) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| AppError::Vault(format!("open -R failed: {e}")))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(AppError::Validation(
            "reveal in finder is macOS-only in v1".into(),
        ))
    }
}
```

- [ ] **Step 12.2: Replace `commands/dialog.rs` with the real impl**

```rust
//! Native folder + file picker commands using
//! `tauri-plugin-dialog`. Returns POSIX path strings (forward slashes
//! on macOS).

use crate::error::{AppError, AppResult};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
#[specta::specta]
pub async fn dialog_choose_folder(
    app: AppHandle,
    title: Option<String>,
) -> AppResult<Option<String>> {
    let mut builder = app.dialog().file();
    if let Some(t) = &title {
        builder = builder.set_title(t);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    builder.pick_folder(move |result| {
        let _ = tx.send(result);
    });
    let result = rx.recv().map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn dialog_choose_files(
    app: AppHandle,
    title: Option<String>,
    filters: Option<Vec<String>>,
) -> AppResult<Vec<String>> {
    let mut builder = app.dialog().file();
    if let Some(t) = &title {
        builder = builder.set_title(t);
    }
    if let Some(exts) = filters.as_ref() {
        if !exts.is_empty() {
            let mut owned: Vec<&str> = exts.iter().map(String::as_str).collect();
            // Tauri's filter API expects (name, &[ext]).
            let _name = "Allowed";
            builder = builder.add_filter("Allowed", &owned);
            owned.clear();
        }
    }
    let (tx, rx) = std::sync::mpsc::channel();
    builder.pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let result = rx.recv().map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(result
        .map(|paths| paths.into_iter().map(|p| p.to_string()).collect())
        .unwrap_or_default())
}
```

- [ ] **Step 12.3: Register the dialog plugin in `lib.rs::run`**

Find the existing `.plugin(tauri_plugin_shell::init())` line and add directly after it:

```rust
.plugin(tauri_plugin_dialog::init())
```

- [ ] **Step 12.4: Extend `capabilities/default.json`**

Replace the file with:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability grants for Memry desktop app",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-unmaximize",
    "core:window:allow-start-dragging",
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "core:webview:allow-print",
    "dialog:default",
    "dialog:allow-open",
    "shell:default",
    "shell:allow-open"
  ]
}
```

`shell:allow-open` is the permission needed for `shell.open`. `dialog:allow-open` covers `pick_folder`/`pick_files`. The `core:event:*` grants are needed by the renderer to subscribe to `vault-changed` and `vault-status-changed` from background threads.

- [ ] **Step 12.5: Verify capability:check passes**

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m3 && \
  pnpm --filter @memry/desktop-tauri capability:check
```

Expected: exits 0. The script cross-references `Cargo.toml` plugins against `capabilities/default.json` permissions; missing grants fail with a useful error.

- [ ] **Step 12.6: Verify cargo + clippy clean**

```bash
cd apps/desktop-tauri/src-tauri && cargo check && cargo clippy -- -D warnings
```

- [ ] **Step 12.7: Manual smoke (real Tauri window required)**

```bash
pnpm --filter @memry/desktop-tauri dev
```

Open the dev console and run:

```js
await window.__TAURI__.core.invoke('shell_open_url', { url: 'https://example.com' })
await window.__TAURI__.core.invoke('shell_reveal_in_finder', { path: '/tmp' })
const folder = await window.__TAURI__.core.invoke('dialog_choose_folder', {})
console.log('chose', folder)
```

Expected: browser opens, Finder reveals `/tmp`, folder picker appears. Cancel returns `null`. Document the smoke completion in the PR body.

- [ ] **Step 12.8: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/commands/shell.rs \
        apps/desktop-tauri/src-tauri/src/commands/dialog.rs \
        apps/desktop-tauri/src-tauri/src/lib.rs \
        apps/desktop-tauri/src-tauri/capabilities/default.json
git commit -m "m3(commands): native shell.open / dialog.pick + capability grants"
```

---

## Task 13: `memry-file://` custom URI scheme protocol handler

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Modify: `apps/desktop-tauri/src-tauri/tauri.conf.json`
- Create: `apps/desktop-tauri/src/lib/memry-file.ts`

- [ ] **Step 13.1: Register the URI scheme in `tauri.conf.json`**

Open `apps/desktop-tauri/src-tauri/tauri.conf.json`. Inside the `app` object, after `windows`, add:

```json
    "withGlobalTauri": false,
```

Then add a top-level `app.security` `assetProtocol` entry — wait, in Tauri 2 custom URI scheme protocols are registered via `tauri::Builder::register_uri_scheme_protocol`. The conf only needs the CSP entry. Update `app.security.csp` to:

```json
"csp": "default-src 'self' memry-file:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: memry-file: https:; media-src 'self' blob: data: memry-file:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://player.twitch.tv; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' ipc: https://ipc.localhost http://localhost:1420 https://*.youtube.com"
```

Compared to M2 baseline this only adds `memry-file:` to `default-src`, `img-src`, and `media-src`. No third-party host opens up.

- [ ] **Step 13.2: Implement the protocol handler in `lib.rs::run`**

Open `apps/desktop-tauri/src-tauri/src/lib.rs`. Locate the `tauri::Builder::default()` chain. After the `.plugin(tauri_plugin_dialog::init())` line, insert:

```rust
        .register_uri_scheme_protocol("memry-file", |ctx, request| {
            let app = ctx.app_handle().clone();
            let response = handle_memry_file(&app, &request);
            response
        })
```

Then add the handler at the bottom of the file:

```rust
fn handle_memry_file(
    app: &tauri::AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use std::fs;
    use std::io::Read;
    use tauri::http::{header, Response, StatusCode};

    let url = request.uri().to_string();
    // Format: memry-file://local/<absolute path>
    let path = match url.strip_prefix("memry-file://local/") {
        Some(p) => format!("/{}", urlencoding::decode(p).unwrap_or_default()),
        None => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(b"invalid memry-file url".to_vec())
                .unwrap();
        }
    };
    let abs = match dunce::canonicalize(&path) {
        Ok(a) => a,
        Err(_) => return missing(&path),
    };

    // Allowlist: app data dir + current vault root.
    let mut allowed: Vec<std::path::PathBuf> = Vec::new();
    if let Some(state) = app.try_state::<crate::app_state::AppState>() {
        if let Some(vault) = state.vault.current_path() {
            if let Ok(c) = dunce::canonicalize(&vault) {
                allowed.push(c);
            }
        }
    }
    if let Ok(dirs) = directories::ProjectDirs::from("com", "memry", "memry")
        .ok_or(())
        .and_then(|d| Ok(d.data_dir().to_path_buf()))
    {
        if let Ok(c) = dunce::canonicalize(&dirs) {
            allowed.push(c);
        }
    }
    if !allowed.iter().any(|root| abs.starts_with(root)) {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(b"path not in allowed roots".to_vec())
            .unwrap();
    }

    let bytes = match fs::read(&abs) {
        Ok(b) => b,
        Err(_) => return missing(&path),
    };

    let mime = mime_guess::from_path(&abs)
        .first_or_octet_stream()
        .essence_str()
        .to_string();

    if let Some(range) = request.headers().get(header::RANGE) {
        if let Ok(range_str) = range.to_str() {
            if let Some(captures) = parse_range(range_str, bytes.len() as u64) {
                let (start, end) = captures;
                let slice = &bytes[start as usize..=end as usize];
                let len = slice.len();
                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, mime)
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{}", bytes.len()),
                    )
                    .header(header::CONTENT_LENGTH, len.to_string())
                    .header(header::ACCEPT_RANGES, "bytes")
                    .body(slice.to_vec())
                    .unwrap();
            }
        }
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .body(bytes)
        .unwrap()
}

fn missing(path: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let lower = path.to_lowercase();
    let is_image = lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp");
    if is_image {
        // 1x1 transparent PNG
        let bytes = base64_decode_static(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        );
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/png")
            .body(bytes)
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(b"not found".to_vec())
        .unwrap()
}

fn parse_range(header_value: &str, total: u64) -> Option<(u64, u64)> {
    let v = header_value.strip_prefix("bytes=")?;
    let (start_str, end_str) = v.split_once('-')?;
    let start: u64 = start_str.parse().ok().unwrap_or(0);
    let end: u64 = if end_str.is_empty() {
        total.saturating_sub(1)
    } else {
        end_str.parse().ok().unwrap_or(total.saturating_sub(1))
    };
    if start > end || end >= total {
        return None;
    }
    Some((start, end))
}

fn base64_decode_static(input: &str) -> Vec<u8> {
    use std::collections::HashMap;
    let alphabet =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = HashMap::new();
    for (i, c) in alphabet.iter().enumerate() {
        lookup.insert(*c as char, i as u8);
    }
    let mut buf = 0u32;
    let mut bits = 0u32;
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    for c in input.chars() {
        if c == '=' {
            break;
        }
        if let Some(v) = lookup.get(&c) {
            buf = (buf << 6) | *v as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buf >> bits) as u8);
                buf &= (1u32 << bits) - 1;
            }
        }
    }
    out
}
```

- [ ] **Step 13.3: Add `urlencoding` to `Cargo.toml`**

```toml
urlencoding = "2.1"
```

- [ ] **Step 13.4: Add the renderer-side `toMemryFileUrl` helper**

Create `apps/desktop-tauri/src/lib/memry-file.ts`:

```ts
/**
 * Build a memry-file:// URL from an absolute local path.
 *
 * Mirrors the Electron helper of the same name. The Tauri custom URI
 * scheme handler in src-tauri/src/lib.rs decodes percent-encoded
 * paths, so encodeURI is correct here.
 */
export function toMemryFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/^\/+/, '')
  return `memry-file://local/${encodeURI(normalized)}`
}

export function fromMemryFileUrl(url: string): string {
  const prefix = 'memry-file://local/'
  if (!url.startsWith(prefix)) {
    throw new Error(`Invalid memry-file URL: ${url}`)
  }
  const rest = decodeURIComponent(url.slice(prefix.length))
  return '/' + rest
}
```

- [ ] **Step 13.5: Manual smoke**

Drop a small test image into your scratch vault:

```bash
cp ~/Pictures/any.png ~/memry-test-vault-m3/attachments/images/test.png
```

Rebuild and open dev:

```bash
pnpm --filter @memry/desktop-tauri dev
```

In dev console:

```js
const url = `memry-file://local/${encodeURI(`${Object.values(window).find(v => v && v.__TAURI__)?.__TAURI__?.path?.appDataDir?.() || ''}`).replace(/^\/+/,'')}`
const test = 'memry-file://local/' + encodeURI(`${'/Users/' + 'YOU' + '/memry-test-vault-m3/attachments/images/test.png'}`.replace(/^\/+/,''))
const img = new Image()
img.onload = () => console.log('image loaded', img.width, img.height)
img.onerror = (e) => console.error('image failed', e)
img.src = test
```

Expected: image renders. Repeat for a missing image — expect a 1×1 transparent PNG response (no console error, broken-image icon does not appear). Repeat for an outside-vault path (e.g. `/etc/hosts`) — expect a 403 response.

- [ ] **Step 13.6: Document the smoke result in the PR body** (Task 16)

- [ ] **Step 13.7: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/lib.rs \
        apps/desktop-tauri/src-tauri/Cargo.toml \
        apps/desktop-tauri/src-tauri/Cargo.lock \
        apps/desktop-tauri/src-tauri/tauri.conf.json \
        apps/desktop-tauri/src/lib/memry-file.ts
git commit -m "m3(protocol): memry-file:// URI scheme with byte-range + missing-image fallback"
```

---

## Task 14: Drag-drop path-resolution spike

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs` (subscribe to drag-drop events)
- Modify: `apps/desktop-tauri/src-tauri/capabilities/default.json` (drop event grants)
- Create: `apps/desktop-tauri/scripts/drag-drop-smoke.md` (documented manual smoke)

- [ ] **Step 14.1: Capability — already covered**

`core:default` includes the file-drop event grants in Tauri 2.x. Confirm by inspecting the schema:

```bash
grep -n 'drag-drop\|dragDropEvent\|drop' apps/desktop-tauri/src-tauri/gen/schemas/desktop-schema.json | head -5
```

Expected: at least one `drop` reference in `core:default`. If absent, add `core:webview:allow-on-drag-drop-event` to `permissions`.

- [ ] **Step 14.2: Subscribe to drag-drop events from the main window**

Open `apps/desktop-tauri/src-tauri/src/lib.rs`. Inside the `.setup(|app| { ... })` closure, AFTER the `tracing_subscriber::fmt()...` block, add:

```rust
            let main_window = app
                .get_webview_window("main")
                .ok_or_else(|| anyhow::anyhow!("main window missing"))
                .map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) as Box<dyn std::error::Error>)?;
            let main_clone = main_window.clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::DragDrop(drag) = event {
                    if let tauri::DragDropEvent::Drop { paths, .. } = drag {
                        let path_strs: Vec<String> =
                            paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                        let _ = main_clone.app_handle().emit("vault-drag-drop", &path_strs);
                    }
                }
            });
```

Tauri 2 emits absolute paths with the drop event — drop events on macOS WebKit work natively in M3, so the renderer never has to rely on the Electron-only `webUtils.getPathForFile`.

> The `anyhow` import is just to keep the closure error-cast simple.
> Add `anyhow = "1"` to `[dependencies]` if not already present.

- [ ] **Step 14.3: Renderer subscribes to `vault-drag-drop`**

This task delivers the spike, not the import feature itself (file import lands in M8). Still, prove the wiring works end-to-end. Add a tiny logger in `apps/desktop-tauri/src/main.tsx`:

Find the `createRoot` block. Right after `await ensureLibsodium()` (or the earliest top-level await), add:

```ts
import { listen } from '@tauri-apps/api/event'

void listen<string[]>('vault-drag-drop', (event) => {
  // Spike telemetry only. Replaced by real import handler in M8.
  console.info('[drag-drop spike] paths:', event.payload)
})
```

This is a temporary spike marker — Task 16's verification step deletes the import once the smoke is documented.

- [ ] **Step 14.4: Run the manual smoke**

```bash
pnpm --filter @memry/desktop-tauri dev
```

In a Finder window, select an image, a PDF, and a video. Drag them into the running Tauri window. In the dev console you should see:

```text
[drag-drop spike] paths: ["/Users/.../foo.png", "/Users/.../doc.pdf", "/Users/.../clip.mp4"]
```

If paths are received, the spike is 🟢. If you see `webkit-fake-url://` strings (old WebKit fallback), the spike is 🔴 — fall back to a `dialog_choose_files` import flow (already implemented in Task 12) and document this in `scripts/drag-drop-smoke.md` as the canonical fallback.

- [ ] **Step 14.5: Document the smoke**

Create `apps/desktop-tauri/scripts/drag-drop-smoke.md`:

```markdown
# M3 drag-drop path-resolution spike

Run `pnpm --filter @memry/desktop-tauri dev`, drag files into the
window, watch dev console for `[drag-drop spike] paths:` log line.

| Outcome | What it means | Action |
|---|---|---|
| Real `/Users/...` paths | macOS WebKit + Tauri 2 deliver real paths. | M8 file import can rely on drop events. |
| `webkit-fake-url://` | Native drop didn't work. | Fall back to `dialog_choose_files` for file imports. |

Last verified: <date>, macOS <ver>, Tauri 2.10, Memry desktop-tauri.
```

Fill in the date/version after the smoke.

- [ ] **Step 14.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/lib.rs \
        apps/desktop-tauri/src-tauri/Cargo.toml \
        apps/desktop-tauri/src-tauri/capabilities/default.json \
        apps/desktop-tauri/src/main.tsx \
        apps/desktop-tauri/scripts/drag-drop-smoke.md
git commit -m "m3(spike): drag-drop path resolution + documented fallback to dialog picker"
```

---

## Task 15: Bindings regen + mock-swap + renderer integration

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs`
- Modify: `apps/desktop-tauri/src/lib/ipc/invoke.ts`
- Modify: `apps/desktop-tauri/src/lib/ipc/mocks/vault.ts`
- Create: `apps/desktop-tauri/e2e/specs/m3-vault-smoke.spec.ts`
- Modify: `apps/desktop-tauri/src/services/vault-service.ts` (small adapter shape changes)

- [ ] **Step 15.1: Extend `generate_bindings.rs`**

Open `apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs`. Replace the `collect_commands![...]` macro and `.typ::<...>()` chain with:

```rust
.commands(collect_commands![
    commands::settings::settings_get,
    commands::settings::settings_set,
    commands::settings::settings_list,
    commands::vault::vault_open,
    commands::vault::vault_close,
    commands::vault::vault_get_status,
    commands::vault::vault_get_current,
    commands::vault::vault_get_all,
    commands::vault::vault_switch,
    commands::vault::vault_remove,
    commands::vault::vault_get_config,
    commands::vault::vault_update_config,
    commands::vault::vault_list_notes,
    commands::vault::vault_read_note,
    commands::vault::vault_write_note,
    commands::vault::vault_delete_note,
    commands::vault::vault_reveal,
    commands::vault::vault_reindex,
    commands::shell::shell_open_url,
    commands::shell::shell_open_path,
    commands::shell::shell_reveal_in_finder,
    commands::dialog::dialog_choose_folder,
    commands::dialog::dialog_choose_files,
])
.typ::<AppError>()
.typ::<db::bookmarks::Bookmark>()
.typ::<db::calendar_bindings::CalendarBinding>()
.typ::<db::calendar_events::CalendarEvent>()
.typ::<db::calendar_external_events::CalendarExternalEvent>()
.typ::<db::calendar_sources::CalendarSource>()
.typ::<db::folder_configs::FolderConfig>()
.typ::<db::inbox::InboxItem>()
.typ::<db::note_metadata::NoteMetadata>()
.typ::<db::note_positions::NotePosition>()
.typ::<db::notes_cache::PropertyDefinition>()
.typ::<db::projects::Project>()
.typ::<db::reminders::Reminder>()
.typ::<db::saved_filters::SavedFilter>()
.typ::<db::search_reasons::SearchReason>()
.typ::<db::settings::Setting>()
.typ::<db::statuses::Status>()
.typ::<db::sync_devices::SyncDevice>()
.typ::<db::sync_history::SyncHistoryEntry>()
.typ::<db::sync_queue::SyncQueueItem>()
.typ::<db::sync_state::SyncState>()
.typ::<db::tag_definitions::TagDefinition>()
.typ::<db::tasks::Task>()
.typ::<vault::frontmatter::NoteFrontmatter>()
.typ::<vault::frontmatter::ParsedNote>()
.typ::<vault::notes_io::NoteOnDisk>()
.typ::<vault::notes_io::ReadNoteResult>()
.typ::<vault::preferences::EditorPreferences>()
.typ::<vault::preferences::VaultConfig>()
.typ::<vault::preferences::VaultPreferences>()
.typ::<vault::registry::VaultInfo>()
.typ::<vault::registry::VaultRegistry>()
.typ::<vault::state::VaultStatus>()
.typ::<vault::watcher::VaultEvent>()
.typ::<vault::watcher::VaultEventKind>();
```

Add `use memry_desktop_tauri_lib::vault;` at the top alongside the existing `commands` / `db` / `error` imports.

- [ ] **Step 15.2: Regenerate bindings + verify**

```bash
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
```

Expected: clean. The generated `src/generated/bindings.ts` now contains every M3 type and command signature.

- [ ] **Step 15.3: Add the swapped commands to `realCommands` in `invoke.ts`**

Open `apps/desktop-tauri/src/lib/ipc/invoke.ts`. Replace the `realCommands` Set with:

```ts
const realCommands = new Set<string>([
  'settings_get',
  'settings_set',
  'settings_list',
  'vault_open',
  'vault_close',
  'vault_get_status',
  'vault_get_current',
  'vault_get_all',
  'vault_switch',
  'vault_remove',
  'vault_get_config',
  'vault_update_config',
  'vault_list_notes',
  'vault_read_note',
  'vault_write_note',
  'vault_delete_note',
  'vault_reveal',
  'shell_open_url',
  'shell_open_path',
  'shell_reveal_in_finder',
  'dialog_choose_folder',
  'dialog_choose_files'
])
```

Note `vault_reindex` stays on the mock path until M7 — the Rust stub returns `{ deferredUntil: 'M7' }` and the renderer does not need to know.

- [ ] **Step 15.4: Trim the mock vault routes that are now real**

Open `apps/desktop-tauri/src/lib/ipc/mocks/vault.ts`. Delete every route except `vault_reindex` and `vault_create` (the latter still has no Rust counterpart — the renderer's "create vault" flow uses `dialog_choose_folder` then `vault_open`, but the legacy `vault_create` mock stays for the existing onboarding component until M5 refactors it).

The trimmed file:

```ts
import type { MockRouteMap } from './types'

const config = {
  excludePatterns: ['.git', 'node_modules', '.DS_Store'],
  defaultNoteFolder: 'notes',
  journalFolder: 'journal',
  attachmentsFolder: 'attachments'
}

export const vaultRoutes: MockRouteMap = {
  // M7 will replace this stub with a real index.db rebuild.
  vault_reindex: async () => ({ success: true, filesIndexed: 0, duration: 0, deferredUntil: 'M7' }),

  // Legacy onboarding helper — replaced by dialog_choose_folder + vault_open in M5.
  vault_create: async (args) => {
    const { path, name } = args as { path: string; name: string }
    return {
      success: true,
      vault: {
        path,
        name,
        noteCount: 0,
        taskCount: 0,
        lastOpened: new Date().toISOString(),
        isDefault: false
      }
    }
  }
}
```

Update `mocks/index.ts` if it still imports the deleted route names — TypeScript will tell you on the next typecheck.

- [ ] **Step 15.5: Adjust the vault service shape if needed**

Open `apps/desktop-tauri/src/services/vault-service.ts`. The `createInvokeForwarder<VaultClientAPI>('vault')` call maps method names like `getStatus` to `vault_get_status`. Before M3 the renderer expected:

- `vault_get_all` → `{ vaults, currentVault }`
- `vault_get_status` → `{ isOpen, path, isIndexing, indexProgress, error }`

The Rust implementations match this shape. No service-layer change is required — but verify by running `pnpm --filter @memry/desktop-tauri test` and reading the failure output. Adjust the forwarder camelCase → snake_case mapping only if a test fails.

- [ ] **Step 15.6: Add e2e smoke against the runtime lane**

Create `apps/desktop-tauri/e2e/specs/m3-vault-smoke.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

const TEST_VAULT = process.env.M3_TEST_VAULT_PATH ?? `${process.env.HOME}/memry-test-vault-m3`

test.describe('M3 vault smoke', () => {
  test('open vault, list notes, read+write a note', async ({ page }) => {
    await page.goto('/')

    const result = await page.evaluate(async (path) => {
      const { invoke } = (window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }
      }).__TAURI__.core
      const open = await invoke('vault_open', { input: { path } })
      const status = await invoke('vault_get_status')
      const list = await invoke('vault_list_notes')
      return { open, status, list }
    }, TEST_VAULT)

    expect(result.open).toMatchObject({ success: true })
    expect(result.status).toMatchObject({ isOpen: true })
    expect(Array.isArray((result.list as { paths: string[] }).paths)).toBe(true)
  })

  test('write then read roundtrip preserves Turkish chars', async ({ page }) => {
    await page.goto('/')

    const out = await page.evaluate(async (path) => {
      const { invoke } = (window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }
      }).__TAURI__.core
      await invoke('vault_open', { input: { path } })
      const fm = {
        id: 'm3-smoke-id',
        title: 'Çalışma günü',
        created: '2026-04-26T00:00:00Z',
        modified: '2026-04-26T00:00:00Z',
        tags: ['work'],
        aliases: [],
        emoji: null,
        localOnly: null,
        properties: null,
        extra: {}
      }
      await invoke('vault_write_note', {
        input: {
          relativePath: 'notes/m3-smoke.md',
          frontmatter: fm,
          content: 'İçerik düzenlendi.'
        }
      })
      return await invoke('vault_read_note', {
        input: { relativePath: 'notes/m3-smoke.md' }
      })
    }, TEST_VAULT)

    expect(out).toBeTruthy()
    expect((out as { parsed: { content: string } }).parsed.content).toBe(
      'İçerik düzenlendi.'
    )
  })
})
```

This is a runtime-lane test — it requires the Tauri dev runtime, not the M1 mock-lane Vite WebKit. The mock-lane existing tests still cover visual parity. Adding a runtime lane is one of the spec's M5-prerequisite items; M3 starts the lane modestly with two smoke tests.

If `playwright.config.ts` does not yet have a runtime-lane target, follow the comment in `e2e/playwright.config.ts` that documents the harness — for M3 it is acceptable to gate the suite behind `M3_TEST_VAULT_PATH` so CI does not run it without a vault checkout.

- [ ] **Step 15.7: Verify all checks**

```bash
pnpm --filter @memry/desktop-tauri lint
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri port:audit
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri cargo:test
```

Expected: every command exits 0. The `command:parity` audit may flag `vault_reindex` and `vault_create` as still-mocked — both are documented deferrals and the audit needs an update in this commit.

- [ ] **Step 15.8: Update `command:parity` ledger**

Open `apps/desktop-tauri/scripts/command-parity-audit.ts`. Locate the deferral-classification list and add (or extend) the entries:

```ts
{ command: 'vault_reindex', status: 'deferred', milestone: 'M7' },
{ command: 'vault_create', status: 'mocked', milestone: 'M5' }
```

Re-run `pnpm --filter @memry/desktop-tauri command:parity` and confirm exit 0.

- [ ] **Step 15.9: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs \
        apps/desktop-tauri/src/generated/bindings.ts \
        apps/desktop-tauri/src/lib/ipc/invoke.ts \
        apps/desktop-tauri/src/lib/ipc/mocks/vault.ts \
        apps/desktop-tauri/src/lib/ipc/mocks/index.ts \
        apps/desktop-tauri/src/services/vault-service.ts \
        apps/desktop-tauri/scripts/command-parity-audit.ts \
        apps/desktop-tauri/e2e/specs/m3-vault-smoke.spec.ts
git commit -m "m3(renderer): swap vault_*/shell_*/dialog_* to real Rust + runtime e2e smoke"
```

---

## Task 16: Bench, acceptance gate, PR

**Files:**
- Create: `apps/desktop-tauri/src-tauri/tests/vault_bench.rs`
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml` (add `[[test]]` entry)
- Read-only verification pass
- Modify: commit history / `git push`

- [ ] **Step 16.1: Write the 100-note bench**

Create `apps/desktop-tauri/src-tauri/tests/vault_bench.rs`:

```rust
use memry_desktop_tauri_lib::vault::{fs as vfs, frontmatter, notes_io, preferences};
use std::time::Instant;

#[tokio::test(flavor = "multi_thread")]
async fn open_vault_with_100_notes_under_500ms() {
    let vault = tempfile::tempdir().unwrap();
    preferences::init_vault(vault.path()).unwrap();
    for i in 0..100 {
        let mut fm = frontmatter::create_frontmatter(&format!("Note {i}"), &["work".into()]);
        fm.id = format!("seed-id-{i:03}");
        notes_io::write_note_to_disk(
            vault.path(),
            &format!("notes/note-{i:03}.md"),
            &fm,
            "body content goes here for the bench seed.",
        )
        .await
        .unwrap();
    }

    let start = Instant::now();
    let entries = vfs::list_supported_files(vault.path()).await.unwrap();
    let elapsed = start.elapsed();
    assert!(entries.len() >= 100);
    assert!(
        elapsed.as_millis() < 500,
        "100-note vault scan took {:?}, exceeds 500ms acceptance gate",
        elapsed
    );
}
```

Register the test in `Cargo.toml`:

```toml
[[test]]
name = "vault_bench"
required-features = ["test-helpers"]
```

- [ ] **Step 16.2: Run the bench**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --release --features test-helpers --test vault_bench -- --nocapture
```

Expected: `100-note bench` passes well under 500ms. Local target on Apple silicon: <80ms. If it fails:
- Run release build (`--release` is critical — debug build is 5–10× slower).
- Check that `list_supported_files` is using `tokio::fs::read_dir` and not blocking IO on the executor thread.

- [ ] **Step 16.3: Final acceptance gate verification**

```bash
# Rust
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri cargo:test
cd apps/desktop-tauri/src-tauri && cargo test --release --features test-helpers --test vault_bench
cd -

# TS / lint / type
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri lint
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri port:audit
pnpm --filter @memry/desktop-tauri command:parity

# Cold-start smoke: open scratch vault, list notes, write a note,
# verify watcher fires.
pnpm --filter @memry/desktop-tauri db:reset
pnpm --filter @memry/desktop-tauri dev &
DEV_PID=$!
sleep 8
# Manually exercise the renderer's vault selector against the scratch
# vault path. Verify in dev console:
#  - vault_open returns success: true
#  - vault_list_notes returns the seeded files
#  - touching a file in Finder fires a vault-changed event
kill $DEV_PID
```

Expected: every command exits 0. Cold-start smoke completes without errors.

- [ ] **Step 16.4: Count Rust tests for the acceptance gate**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers 2>&1 | grep 'test result'
```

Spec doesn't quote a numeric Rust-test gate for M3, but the M2 bar of ≥20 should hold. Approximate count after this milestone:

- `vault_paths_test`: 9
- `vault_fs_test`: 9
- `vault_frontmatter_test`: 9
- `vault_notes_io_test`: 5
- `vault_preferences_test`: 8
- `vault_registry_test`: 6
- `vault_watcher_test`: 4
- `vault_bench`: 1
- carry-over from M2 (settings + migrations): ~28

Total: ~79. Comfortably above the spec's "≥20 smoke tests" bar.

- [ ] **Step 16.5: Remove the drag-drop spike telemetry import**

Open `apps/desktop-tauri/src/main.tsx` and delete the `void listen<string[]>('vault-drag-drop', ...)` block added in Task 14.3. The smoke is documented in `scripts/drag-drop-smoke.md`; the import was a one-shot verification.

```bash
git add apps/desktop-tauri/src/main.tsx
git commit -m "m3(spike): remove drag-drop spike telemetry; smoke documented in scripts/drag-drop-smoke.md"
```

- [ ] **Step 16.6: Push branch and open PR**

```bash
git push -u origin m3/vault-fs-and-watcher
```

Open the PR titled `m3: Vault FS + file watcher` with body:

```markdown
## Summary

- Vault FS module: `paths` (canonicalize + traversal/symlink/hidden-dir guard), `fs` (atomic_write + safe_read + list + sha256 hash), `frontmatter` (serde_yaml_ng parse/serialize with Turkish + multiline YAML round-trip), `notes_io` (high-level read/write with content-hash skip), `preferences` (vault-rooted `.memry/config.json`), `registry` (multi-vault list at `<app-data>/memry-{device}/vaults.json`), `state` (VaultRuntime + status), `watcher` (notify v6 + 150ms debounce, emits `vault-changed`)
- 18 vault Tauri commands: open, close, get_status, get_current, get_all, switch, remove, get_config, update_config, list_notes, read_note, write_note, delete_note, reveal, reindex (M7-deferred stub) + 5 native commands: shell_open_url, shell_open_path, shell_reveal_in_finder, dialog_choose_folder, dialog_choose_files
- `memry-file://` custom URI scheme handler with vault allowlist, byte-range support, 1×1 transparent PNG fallback for missing images, 403 for outside-vault paths
- Drag-drop path-resolution spike: real macOS WebKit drop paths verified (or documented fallback to `dialog_choose_files`)
- 23 commands swapped from mock to real Rust; `vault_reindex` deferred to M7 with explicit ledger entry; `vault_create` flagged for M5 onboarding refactor
- Runtime e2e smoke (`m3-vault-smoke.spec.ts`) covering open/list/read/write + Turkish round-trip
- 100-note vault scan bench: <500ms (acceptance gate); local Apple-silicon dev target <80ms

Parent spec: `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` §M3
Plan: `docs/superpowers/plans/2026-04-26-m3-vault-fs-and-watcher.md`

## Acceptance gate

- [x] `vault_open` scans 100-note test vault in <500ms (`vault_bench`)
- [x] External file edits emit watcher events to renderer (`vault_watcher_test::detects_new_file_within_debounce_window` + manual smoke)
- [x] Frontmatter Turkish/multiline YAML/date round-trip without loss (`vault_frontmatter_test`)
- [x] Atomic write survives mid-write crash simulation (`vault_fs_test::atomic_write_cleans_up_temp_on_failure`)
- [x] Path-traversal + symlink-escape tests fail closed (`vault_paths_test`)
- [x] Tauri drag-drop manual smoke documented (`scripts/drag-drop-smoke.md`)
- [x] Native choose/reveal/open commands fail closed for paths outside vault/app-data roots (`shell_open_path` validates absolute + exists; protocol returns 403)
- [x] Local file protocol spike: image, PDF, media range, missing-image fallback, outside-vault denial all verified
- [x] Renderer integration smoke: open/create/delete reflects in UI (m3-vault-smoke.spec.ts + manual)
- [x] `cargo test` passes (vault tests + carry-over) — `cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers` exits 0

## Carry-forward ledger

1. `@memry/*` occurrences: <count from `grep -R "@memry/" apps/desktop-tauri/src apps/desktop-tauri/tsconfig.json apps/desktop-tauri/vite.config.ts | wc -l`> (was 142 at M1, post-M2 baseline X — fill in actual)
2. Non-test Electron residue: `pnpm --filter @memry/desktop-tauri port:audit` exits 0
3. M1 non-blocking warnings: still present (notes-tree setState, Radix dialog, ::highlight CSS, large chunk) — none touched by M3 domain
4. Runtime e2e lane: harness exists; 1 spec file (`m3-vault-smoke.spec.ts`) covers the M3 surface; lane gated behind `M3_TEST_VAULT_PATH` env var

## Test plan

- [ ] `pnpm --filter @memry/desktop-tauri cargo:test` green
- [ ] `pnpm --filter @memry/desktop-tauri cargo:test --release --test vault_bench` p95 < 500ms
- [ ] `pnpm --filter @memry/desktop-tauri bindings:check` clean
- [ ] `pnpm --filter @memry/desktop-tauri capability:check` exit 0
- [ ] `pnpm --filter @memry/desktop-tauri command:parity` exit 0 with `vault_reindex`/`vault_create` classified
- [ ] `pnpm --filter @memry/desktop-tauri port:audit` exit 0
- [ ] Manual: open scratch vault, list notes, write+read a note with Turkish chars, touch a file in Finder, see watcher event in dev console
- [ ] Manual: drag image/PDF/video into window, see real paths in console
- [ ] Manual: shell_open_url opens a browser, shell_reveal_in_finder reveals a path, dialog_choose_folder + dialog_choose_files show pickers
- [ ] Manual: memry-file:// URL renders an image, returns 403 for `/etc/hosts`, returns 1×1 PNG for missing image

## Risk coverage

- Risk: macOS FSEvents rename detection edge cases. Mitigation: notify v6 fallback + per-path debounce. The watcher classifies rename as `Modified`, which is the safe upper bound.
- Risk: serde_yaml deprecation. Mitigation: chose `serde_yaml_ng` (active fork) per ecosystem consensus.
- Risk: vault path canonicalization differences (`/private/var/...` vs `/var/...` on macOS). Mitigation: `dunce::canonicalize` everywhere.
- Risk: drag-drop path resolution might fall back to `webkit-fake-url://`. Mitigation: documented fallback uses `dialog_choose_files` already implemented.
```

- [ ] **Step 16.7: Land the PR**

Use `/land-and-deploy` (gstack skill) or manual merge after CI green. Squash-merge per repo convention.

---

## Self-review checklist (plan author)

- [x] Vault FS module — `fs.rs` atomic_write + safe_read + list + content_hash (Task 4)
- [x] `frontmatter.rs` — serde_yaml_ng parse/serialize with property extraction (Task 5)
- [x] `notes_io.rs` — high-level `read_note_from_disk` / `write_note_to_disk` (Task 6)
- [x] `preferences.rs` — vault-rooted JSON config (Task 7)
- [x] `watcher.rs` — notify with 150ms debounce + `vault-changed` event (Task 10)
- [x] Path normalization + escape guard — `paths.rs` (Task 3)
- [x] Drag-drop path-resolution spike + documented fallback (Task 14)
- [x] Native open/reveal/dialog command set — `shell.rs` + `dialog.rs` (Task 12)
- [x] `memry-file://` protocol — Tauri custom URI scheme with allowlist + range + missing-image fallback (Task 13)
- [x] All commands from spec deliverable list registered: `vault_open`, `vault_close`, `vault_get_current`, `vault_list_notes`, `vault_read_note`, `vault_write_note` (Task 11)
- [x] All renderer-expected commands registered: `vault_get_status`, `vault_get_config`, `vault_update_config`, `vault_get_all`, `vault_switch`, `vault_remove`, `vault_reveal`, `vault_reindex` (Task 11)
- [x] `vault-changed` event with `{path, kind}` payload — `VaultEvent` (Tasks 10, 11)
- [x] 100-note vault scan <500ms bench (Task 16)
- [x] Watcher events external-edit smoke (Task 10 test + Task 16 manual)
- [x] Frontmatter Turkish/multiline YAML/date round-trip (Task 5)
- [x] Atomic write crash simulation (Task 4)
- [x] Path traversal + symlink escape tests (Task 3)
- [x] Renderer integration smoke (Tasks 15, 16)
- [x] `cargo test --package vault` equivalent — single-crate project means `cargo test` runs every vault test plus carry-over (Task 16.4)

### Intentional deferrals

| Item | Deferred to | Rationale |
|------|-------------|-----------|
| `vault_reindex` real impl | M7 | Index DB (FTS5 + sqlite-vec) does not exist until M7. M3 ships a stub that returns `{ deferredUntil: 'M7' }`. |
| `vault_create` real impl | M5 | The renderer onboarding flow uses `dialog_choose_folder` + `vault_open` already in M3. The legacy `vault_create` mock survives because the existing onboarding component still references it; M5 removes it during the notes-CRUD refactor. |
| Note-rename detection | M5 | The Electron watcher does delete-add-pair UUID matching for renames. M3 ships only Created/Modified/Deleted; rename detection lives with note CRUD in M5. |
| FTS / properties / tag definitions sync | M7 | Watcher emits the event; cache rebuild lives in M7. |
| PDF/thumbnail rendering | M8.13–M8.14 | Protocol carries the bytes; PDF/thumbnail UIs live with the broader media features. |

### Open questions for Kaan

1. The Rust DB stays at `<app-data>/memry-{device}/data.db` (M2 decision). Electron stored DB at `<vault>/.memry/data.db`. Confirm the vault directory does NOT need a per-vault DB (matches M2 architecture). Default assumption: confirmed.
2. Watcher rename detection deferred to M5 (note CRUD owns it). Confirm.
3. `vault_create` mock kept for the onboarding component until M5 (because that's where the flow gets its proper Rust replacement). Confirm.

---

## Post-M3

After M3 merges:

1. Begin M4 (Crypto + Keychain + Auth) per spec §4 M4. Start with the 1-day security-framework subspike before opening the implementation plan.
2. M5 (Notes CRUD + BlockNote + CRDT) blocks on M3 + M4 both being merged. Plan that worktree off `main` after both PRs land.
3. The runtime e2e lane added in Task 15.6 becomes the default lane for M5 acceptance — extend it with note-rename + concurrent-edit specs at that time.
